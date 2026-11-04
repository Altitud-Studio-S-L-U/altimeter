import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentProbe, SiteFacts } from '../../src/core/facts.ts';
import type { Severity } from '../../src/core/types.ts';
import { browserAgent, googlebotSmartphone } from '../../src/data/agents.ts';
import { findingMessage } from '../../src/i18n/messages.ts';
import { implementations } from '../../src/rules/crawl/index.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { evaluate, page, response, site, type ResponseSpec, type SiteSpec } from '../support/facts.ts';

function run(id: string, facts: SiteFacts | SiteSpec) {
  const implementation = implementations.find(entry => entry.id === id);
  assert.ok(implementation, `${id} is implemented`);
  const { findings, evidence } = evaluate(implementation, facts.pages instanceof Map ? facts as SiteFacts : site(facts as SiteSpec));
  return { finding: findings[0]!, findings, excerpts: (finding: Finding = findings[0]!) => finding.evidence.map(ref => evidence.get(ref)?.excerpt ?? '') };
}

function assertFail(finding: Finding, severity: Severity, reason?: string, needsJudgment = false) {
  assert.equal(finding.outcome, 'fail', JSON.stringify(finding));
  assert.equal(finding.severity, severity);
  assert.equal(finding.reason, reason);
  assert.equal(finding.needsJudgment ?? false, needsJudgment);
  const message = findingMessage('en', finding.ruleId, 'fail', finding.reason, finding.params);
  assert.ok(message !== undefined && !/\{[a-zA-Z]+\}/u.test(message), message);
}

function assertOutcome(finding: Finding, outcome: Finding['outcome'], reason?: string) {
  assert.equal(finding.outcome, outcome, JSON.stringify(finding));
  if (reason !== undefined) assert.equal(finding.reason, reason);
}

const origin = 'https://example.com';
const url = `${origin}/products`;
const doc = (body: string, title = 'Products', head = '') => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const prose = (count: number, word = 'catalogue') => Array.from({ length: count }, (_, index) => `${word}${index}`).join(' ');
const one = (spec: Parameters<typeof page>[1], rest: Partial<SiteSpec> = {}): SiteSpec => ({ pages: [page(url, spec)], ...rest });

describe('crawl-robots-blocks-render-resources', () => {
  const id = 'crawl-robots-blocks-render-resources';
  const body = `<main><h1>Products</h1><p>${prose(60)}</p></main>`;
  test('passes when the blocked requests change nothing, such as analytics', () => {
    const facts = one({ html: doc(body), rendered: { html: doc(body), blockedByRobots: [`${origin}/analytics.js`] }, unblockedRender: doc(body) });
    const { finding, excerpts } = run(id, facts);
    assertOutcome(finding, 'pass');
    assert.deepEqual(excerpts(), [`${origin}/analytics.js`]);
  });
  test('fails high when the title changes without the blocked requests', () => {
    const facts = one({ html: doc(body), rendered: { html: doc(body, 'Loading'), blockedByRobots: [`${origin}/app.js`] }, unblockedRender: doc(body) });
    const { finding, excerpts } = run(id, facts);
    assertFail(finding, 'high', 'metadata-changed');
    assert.deepEqual(excerpts(), [`${origin}/app.js`, 'Loading | Products']);
  });
  test('fails high when the main text needs the blocked requests', () => {
    const facts = one({ html: doc('<main></main>'), rendered: { html: doc('<main><h1>Products</h1></main>'), blockedByRobots: [`${origin}/api/items`] }, unblockedRender: doc(body) });
    assertFail(run(id, facts).finding, 'high', 'content-missing');
  });
  test('does not apply when nothing was blocked and is not evaluated without the unblocked render', () => {
    assertOutcome(run(id, one({ html: doc(body), rendered: doc(body) })).finding, 'not_applicable', 'nothing-blocked');
    assertOutcome(run(id, one({ html: doc(body), rendered: { html: doc(body), blockedByRobots: [`${origin}/app.js`] } })).finding, 'not_evaluated', 'no-unblocked-render');
  });
});

describe('crawl-js-links-crawlable', () => {
  const id = 'crawl-js-links-crawlable';
  test('passes when navigation uses <a href>', () => {
    assertOutcome(run(id, one({ html: doc(''), rendered: doc('<nav><a href="/a">A</a><a href="#pricing">Pricing</a></nav>') })).finding, 'pass');
  });
  test('hands navigation without hrefs to the analyst', () => {
    const rendered = doc('<nav><a>Shop</a><a href="#">Blog</a><a href="javascript:go(3)">Contact</a></nav>');
    const { finding, excerpts } = run(id, one({ html: doc(''), rendered }));
    assertFail(finding, 'medium', 'navigation', true);
    assert.deepEqual(excerpts(), ['<a>Shop', '<a href="#">Blog', '<a href="javascript:go(3)">Contact']);
  });
  test('reports an isolated case as low', () => {
    assertFail(run(id, one({ html: doc(''), rendered: doc('<p><span role="link">Read more</span></p>') })).finding, 'low', 'isolated', true);
  });
  test('is not evaluated without a render', () => {
    assertOutcome(run(id, one({ html: doc('') })).finding, 'not_evaluated', 'missing-input:rendered-dom');
  });
});

describe('crawl-js-fragment-routing', () => {
  const id = 'crawl-js-fragment-routing';
  test('passes on in-page anchors such as a /#contact section', () => {
    assertOutcome(run(id, one({ html: doc('<a href="/#contact">Contact</a><a href="#pricing">Pricing</a>') })).finding, 'pass');
  });
  test('fails high on routes in the fragment', () => {
    const { finding, excerpts } = run(id, one({ html: doc('<a href="#/products">Products</a><a href="/#/about">About</a>') }));
    assertFail(finding, 'high', 'hash-routes');
    assert.deepEqual(excerpts(), ['#/products', '/#/about']);
  });
  test('reports a single route as low', () => {
    assertFail(run(id, one({ html: doc('<a href="#!/item">Item</a>') })).finding, 'low', 'single-hash-route');
  });
  test('counts only links to the audited site, as the base URL resolves them', () => {
    const app = '<a href="https://app.example-saas.io/#/login">Log in</a><a href="https://app.example-saas.io/#/signup">Sign up</a>';
    assertOutcome(run(id, one({ html: doc(app) })).finding, 'pass');
    assertOutcome(run(id, one({ html: doc('<a href="#/login">Log in</a><a href="#/signup">Sign up</a>', 'Products', '<base href="https://app.example-saas.io/">') })).finding, 'pass');
    const { finding, excerpts } = run(id, one({ html: doc(`${app}<a href="https://www.example.com/#/about">About</a><a href="#/team">Team</a>`) }));
    assertFail(finding, 'high', 'hash-routes');
    assert.deepEqual(excerpts(), ['https://www.example.com/#/about', '#/team']);
  });
  test('does not apply without documents', () => {
    assertOutcome(run(id, one({})).finding, 'not_applicable', 'no-documents');
  });
});

describe('crawl-js-content-dependency', () => {
  const id = 'crawl-js-content-dependency';
  const body = `<main><p>${prose(50)}</p></main>`;
  test('passes when the raw HTML carries the content, with analytics injected only after consent', () => {
    const rendered = doc(`${body}<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>`, 'Products', '<script>window.dataLayer=[]</script>');
    assertOutcome(run(id, one({ html: doc(body), rendered })).finding, 'pass');
  });
  test('fails medium when most text comes from JavaScript', () => {
    const { finding, excerpts } = run(id, one({ html: doc('<div id="app"></div>'), rendered: doc(body) }));
    assertFail(finding, 'medium', 'content-after-js');
    assert.deepEqual(excerpts(), ['100%']);
  });
  test('fails medium when links come from JavaScript', () => {
    const links = Array.from({ length: 6 }, (_, index) => `<a href="/p/${index}">Item</a>`).join('');
    assertFail(run(id, one({ html: doc(body), rendered: doc(`${body}${links}`) })).finding, 'medium', 'links-after-js');
  });
  test('fails medium when the title differs', () => {
    const { finding, excerpts } = run(id, one({ html: doc(body, 'App'), rendered: doc(body, 'Products') }));
    assertFail(finding, 'medium', 'metadata-differs');
    assert.deepEqual(excerpts(), ['App | Products']);
  });
  test('does not apply to pages with little rendered text', () => {
    assertOutcome(run(id, one({ html: doc('<p>Hi</p>'), rendered: doc('<p>Hi</p>') })).finding, 'not_applicable', 'little-rendered-text');
  });
});

describe('crawl-js-lazy-content', () => {
  const id = 'crawl-js-lazy-content';
  const body = `<main><section data-reveal style="opacity:0"><h2>Work</h2><p>${prose(60)}</p></section></main>`;
  test('passes on [data-reveal] sections at opacity 0 that the tall render already holds', () => {
    const rendered = { html: doc(body), textBlocks: [{ selector: 'section[data-reveal]', text: prose(60), hidden: 'opacity-zero' as const, fontSize: 16, top: 900, inMain: true }] };
    assertOutcome(run(id, one({ html: doc(body), rendered, userRender: doc(body) })).finding, 'pass');
  });
  test('hands text that appears only after scrolling to the analyst', () => {
    const { finding, excerpts } = run(id, one({ html: doc('<main></main>'), rendered: doc('<main><h1>Products</h1></main>'), userRender: doc(body) }));
    assertFail(finding, 'medium', 'content-after-scroll', true);
    assert.equal(excerpts()[0], '100%');
  });
  test('reports images without a src as low', () => {
    const lazy = doc(`<main><p>${prose(10)}</p><img data-src="/a.jpg" alt="A"></main>`);
    const { finding, excerpts } = run(id, one({ html: lazy, rendered: lazy, userRender: lazy }));
    assertFail(finding, 'low', 'images-without-src');
    assert.deepEqual(excerpts(), ['<img data-src="/a.jpg">']);
  });
  test('is not evaluated without the scrolling render', () => {
    assertOutcome(run(id, one({ html: doc(body), rendered: doc(body) })).finding, 'not_evaluated', 'missing-input:user-render');
  });
});

describe('crawl-dynamic-rendering', () => {
  const id = 'crawl-dynamic-rendering';
  const probe = (agent: AgentProbe['agent'], spec: ResponseSpec): AgentProbe => ({ agent, url: `${origin}/`, fetch: response(`${origin}/`, spec) });
  const full = doc(`<main><h1>Studio</h1><p>${prose(80, 'design')}</p></main>`);
  const probes = (bot: ResponseSpec, browser: ResponseSpec) => ({ pages: [page(`${origin}/`, { html: full })], agentProbes: [probe(googlebotSmartphone, bot), probe(browserAgent, browser)] });
  test('passes when both user agents receive the same HTML', () => {
    assertOutcome(run(id, probes({ body: full }, { body: full })).finding, 'pass');
  });
  test('fails low when the crawler gets a prerendered page and the browser a shell', () => {
    const { finding, excerpts } = run(id, probes({ body: full }, { body: doc('<div id="root"></div>') }));
    assertFail(finding, 'low', 'prerendered-for-bots');
    assert.deepEqual(excerpts(), ['81 | 0', '100% | 0%']);
  });
  test('hands different content to the analyst', () => {
    assertFail(run(id, probes({ body: full }, { body: doc(`<main><p>${prose(80, 'offer')}</p></main>`) })).finding, 'low', 'different-content', true);
  });
  test('is not evaluated when the crawler user agent is blocked, since spoofed agents may be blocked on purpose', () => {
    assertOutcome(run(id, probes({ status: 403, body: 'Forbidden' }, { body: full })).finding, 'not_evaluated', 'probe-not-200');
    assertOutcome(run(id, { pages: [page(`${origin}/`, { html: full })] }).finding, 'not_evaluated', 'missing-input:ua-probe');
  });
  test('is not evaluated when the crawler user agent gets a challenge page with 200', () => {
    const challenge = doc('<h1>Just a moment...</h1><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>', 'Just a moment...');
    assertOutcome(run(id, probes({ body: challenge }, { body: full })).finding, 'not_evaluated', 'challenge-page');
  });
});

describe('crawl-parameter-urls', () => {
  const id = 'crawl-parameter-urls';
  test('passes on clean internal links, and on a tracking variant that canonicalises to the clean URL', () => {
    const variants = [{ label: 'tracking-parameter', url: `${url}?utm_source=altimeter`, body: doc('', 'Products', `<link rel="canonical" href="${url}">`) }];
    assertOutcome(run(id, one({ html: doc('<a href="/a?page=2">Next</a>') }, { variants })).finding, 'pass');
  });
  test('fails medium on session IDs in internal links', () => {
    const { finding, excerpts } = run(id, one({ html: doc('<a href="/cart?sid=8f2a">Cart</a>') }));
    assertFail(finding, 'medium', 'session-id');
    assert.deepEqual(excerpts(), [`${origin}/cart?sid=8f2a`]);
  });
  test('fails medium on tracking parameters in internal links and on a duplicate tracking variant', () => {
    assertFail(run(id, one({ html: doc('<a href="/a?utm_source=nav">A</a>') })).finding, 'medium', 'tracking-parameter');
    assertFail(run(id, one({ html: doc('') }, { variants: [{ label: 'tracking-parameter', url: `${url}?utm_source=altimeter`, body: doc('') }] })).finding, 'medium', 'parameter-duplicate');
  });
  test('is not evaluated without pages', () => {
    assertOutcome(run(id, { pages: [] }).finding, 'not_evaluated', 'missing-input:http');
  });
});

describe('crawl-url-hygiene', () => {
  const id = 'crawl-url-hygiene';
  test('passes on well-formed URLs, including uppercase and underscores', () => {
    assertOutcome(run(id, one({ html: doc('<a href="/About_Us">About</a><a href="/a?x=1&y=2">A</a>') })).finding, 'pass');
  });
  test('fails low on spaces in hrefs', () => {
    const { finding, excerpts } = run(id, one({ html: doc('<a href="/my page">Page</a>') }));
    assertFail(finding, 'low', 'unencoded-characters');
    assert.deepEqual(excerpts(), ['/my page']);
  });
  test('fails low on very long URLs', () => {
    assertFail(run(id, one({ html: doc(`<a href="/${'a'.repeat(2100)}">Long</a>`) })).finding, 'low', 'too-long');
  });
  test('does not apply without internal URLs', () => {
    assertOutcome(run(id, one({ html: doc('<a href="https://other.org/">Out</a>') })).finding, 'not_applicable', 'no-urls');
  });
});

describe('crawl-duplicate-clusters', () => {
  const id = 'crawl-duplicate-clusters';
  const text = `<main><p>${prose(60, 'service')}</p></main>`;
  const at = (path: string, body: string, canonical = `${origin}${path}`, lang = 'en') =>
    page(`${origin}${path}`, { html: `<!doctype html><html lang="${lang}"><head><title>T</title><link rel="canonical" href="${canonical}"></head><body>${body}</body></html>` });
  test('passes when duplicates share one canonical and when pages differ', () => {
    assertOutcome(run(id, { pages: [at('/a', text), at('/b', text, `${origin}/a`)], crawled: true }).finding, 'pass');
    assertOutcome(run(id, { pages: [at('/a', text), at('/b', `<main><p>${prose(60, 'product')}</p></main>`)], crawled: true }).finding, 'pass');
  });
  test('hands an unconsolidated cluster to the analyst', () => {
    const { finding, excerpts } = run(id, { pages: [at('/a', text), at('/b', text)], crawled: true });
    assertFail(finding, 'medium', 'not-consolidated', true);
    assert.deepEqual(excerpts(), [`${origin}/a`, `${origin}/b`]);
  });
  test('does not cluster pages in different languages', () => {
    assertOutcome(run(id, { pages: [at('/en/a', text), at('/es/a', text, `${origin}/es/a`, 'es')], crawled: true }).finding, 'pass');
  });
  test('is not evaluated without a crawl', () => {
    assertOutcome(run(id, { pages: [at('/a', text)] }).finding, 'not_evaluated', 'missing-input:crawl');
  });
});
