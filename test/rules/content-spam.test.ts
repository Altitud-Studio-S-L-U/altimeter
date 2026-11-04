import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentProbe, PageFacts } from '../../src/core/facts.ts';
import { browserAgent, googlebotSmartphone } from '../../src/data/agents.ts';
import type { TextBlock } from '../../src/render/chrome.ts';
import { aiArtifacts, cloakingUa, hackedSignals, hiddenLinks, hiddenText, keywordStuffing, sneakyRedirects } from '../../src/rules/content/spam.ts';
import type { RuleImplementation } from '../../src/rules/engine.ts';
import { evaluate, outcomeOn, page, response, site, type ResponseSpec, type SiteSpec } from '../support/facts.ts';

const url = 'https://example.com/services/plumbing';
const doc = (body: string, head = '<title>Plumbing</title>') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const block = (selector: string, text: string, extra: Partial<TextBlock> = {}): TextBlock => ({ selector, text, fontSize: 16, top: 400, inMain: true, ...extra });
const sentence = 'We repair leaking pipes, replace old boilers and install new bathrooms across the city with a written quote before any work starts.';

function run(rule: RuleImplementation, pages: readonly PageFacts[], extra: Partial<SiteSpec> = {}) {
  const { findings, evidence } = evaluate(rule, site({ pages, ...extra }));
  const excerpts = (finding: (typeof findings)[number] | undefined) => (finding?.evidence ?? []).map(id => evidence.get(id)?.excerpt);
  return { at: (target = url) => outcomeOn(findings, target), siteFindings: findings.filter(entry => entry.scope.kind === 'site'), excerpts };
}

describe('content-ai-artifacts', () => {
  test('passes copy that discusses AI, agents, prompts, Codex or Claude', () => {
    const html = doc(`<main><p>We build agents with Claude and Codex. Good prompts and evaluation matter more than the model.</p></main>`);
    assert.equal(run(aiArtifacts, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails medium on an unfilled template token and quotes it', () => {
    const { at, excerpts } = run(aiArtifacts, [page(url, { html: doc('<main><p>Call [Your Name] today for a free quote.</p></main>') })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.needsJudgment], ['medium', 'template-token', undefined]);
    assert.match(String(excerpts(at())[0]), /Call \[Your Name\] today/u);
  });

  test('fails on an assistant phrase, and hands it to the analyst on a page about AI', () => {
    const plain = run(aiArtifacts, [page(url, { html: doc('<main><p>As an AI language model, I recommend copper pipes.</p></main>') })]).at();
    assert.deepEqual([plain?.reason, plain?.needsJudgment], ['assistant-phrase', undefined]);
    const aboutAi = run(aiArtifacts, [page(url, { html: doc('<main><p>Chatbots built on a language model often answer: as an AI language model, I cannot help.</p></main>') })]).at();
    assert.equal(aboutAi?.needsJudgment, true);
  });

  test('ignores quotations, code and client-side templates in the raw HTML', () => {
    const html = doc('<main><blockquote>As an AI language model, I cannot browse.</blockquote><code>printf("%s")</code><div id="app">{{ greeting }}</div></main>');
    assert.equal(run(aiArtifacts, [page(url, { html })]).at()?.outcome, 'pass');
    assert.equal(run(aiArtifacts, [page(url, { html, rendered: doc('<main><p>Hello {{ greeting }}</p></main>') })]).at()?.reason, 'template-token');
  });

  test('is not evaluated without the raw HTML', () => {
    assert.equal(run(aiArtifacts, [page(url)]).at()?.outcome, 'not_evaluated');
  });
});

const spamText = 'cheap plumber barcelona cheap plumber girona cheap plumber tarragona cheap plumber lleida cheap plumber reus';

describe('content-hidden-text', () => {
  const html = doc('<main><p>Visible</p></main>');

  test('passes when no text is concealed', () => {
    assert.equal(run(hiddenText, [page(url, { html, rendered: { html, textBlocks: [block('main > p', sentence)] } })]).at()?.outcome, 'pass');
  });

  test('hands same-colour keyword text to the analyst at medium', () => {
    const rendered = { html, textBlocks: [block('div.seo > p', spamText, { hidden: 'same-color' })] };
    const { at, excerpts } = run(hiddenText, [page(url, { html, rendered, userRender: rendered })]);
    assert.deepEqual([at()?.outcome, at()?.severity, at()?.needsJudgment], ['fail', 'medium', true]);
    assert.deepEqual(excerpts(at()), [spamText]);
  });

  test('never reports [data-reveal] sections at opacity 0 that the scrolled render shows', () => {
    const rendered = { html, textBlocks: [block('section.reveal > p', sentence, { hidden: 'opacity-zero' })] };
    const userRender = { html, textBlocks: [block('section.reveal > p', sentence)] };
    assert.equal(run(hiddenText, [page(url, { html, rendered, userRender })]).at()?.outcome, 'pass');
    assert.equal(run(hiddenText, [page(url, { html, rendered })]).at()?.outcome, 'pass');
  });

  test('ignores accordions, menus and screen-reader text', () => {
    const rendered = { html, textBlocks: [
      block('div.accordion-body > p', sentence, { hidden: 'display-none' }),
      block('nav.drawer > ul > li', sentence, { hidden: 'offscreen' }),
      block('span.sr-only', sentence, { hidden: 'visually-hidden' }),
    ] };
    assert.equal(run(hiddenText, [page(url, { html, rendered, userRender: rendered })]).at()?.outcome, 'pass');
  });

  test('is not evaluated without a render', () => {
    assert.equal(run(hiddenText, [page(url, { html })]).at()?.reason, 'missing-input:rendered-dom');
  });
});

describe('content-hidden-links', () => {
  test('passes visible external links and icon links with a label', () => {
    const html = doc('<main><a href="https://partner.example/">Our partner</a><a href="https://social.example/acme" aria-label="Acme on Social">x</a></main>');
    const rendered = { html, textBlocks: [block('main > a', 'Our partner')] };
    assert.equal(run(hiddenLinks, [page(url, { html, rendered })]).at()?.outcome, 'pass');
  });

  test('hands a hidden followed external link to the analyst', () => {
    const html = doc('<main><div style="display:none"><a href="https://casino.example/">best casino</a></div></main>');
    const rendered = { html, textBlocks: [block('div > a', 'best casino', { hidden: 'display-none' })] };
    const { at, excerpts } = run(hiddenLinks, [page(url, { html, rendered })]);
    assert.deepEqual([at()?.severity, at()?.needsJudgment, at()?.params?.hosts], ['medium', true, 'casino.example']);
    assert.deepEqual(excerpts(at()), ['best casino -> https://casino.example/']);
  });

  test('ignores links inside closed menus', () => {
    const html = doc('<nav class="mobile-menu"><a href="https://shop.example/">Shop</a></nav>');
    const rendered = { html, textBlocks: [block('nav.mobile-menu > a', 'Shop', { hidden: 'display-none' })] };
    assert.equal(run(hiddenLinks, [page(url, { html, rendered })]).at()?.outcome, 'pass');
  });

  test('is not evaluated without a render', () => {
    assert.equal(run(hiddenLinks, [page(url, { html: doc('') })]).at()?.outcome, 'not_evaluated');
  });
});

describe('content-keyword-stuffing', () => {
  test('passes natural copy', () => {
    assert.equal(run(keywordStuffing, [page(url, { html: doc(`<main><p>${sentence} ${sentence}</p></main>`) })]).at()?.outcome, 'pass');
  });

  test('hands a phrase repeated far above normal use to the analyst', () => {
    const text = Array.from({ length: 10 }, (_, index) => `Need a cheap plumber barcelona service on day ${index}?`).join(' ');
    const { at, excerpts } = run(keywordStuffing, [page(url, { html: doc(`<main><p>${text}</p></main>`) })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.needsJudgment], ['medium', 'repeated-phrase', true]);
    assert.match(String(excerpts(at())[0]), /cheap plumber/u);
  });

  test('ignores button and link text repeated by product cards', () => {
    const cards = Array.from({ length: 12 }, (_, index) => `<li><h3>Pipe wrench model ${index}</h3><p>Steel, ${index + 20} cm.</p><button>Add to cart now</button><a href="/p/${index}">View product details</a></li>`).join('');
    assert.equal(run(keywordStuffing, [page(url, { html: doc(`<main><ul>${cards}</ul></main>`) })]).at()?.outcome, 'pass');
  });

  test('does not apply to pages with very little text', () => {
    assert.equal(run(keywordStuffing, [page(url, { html: doc('<main><p>Contact us.</p></main>') })]).at()?.reason, 'too-little-text');
  });
});

function probe(agent: AgentProbe['agent'], body: string, spec: ResponseSpec = {}): AgentProbe {
  return { agent, url, fetch: response(url, { body, ...spec }) };
}

describe('content-cloaking-ua', () => {
  const same = doc(`<main><h1>Plumbing</h1><p>${sentence}</p></main>`);

  test('passes when both user agents receive the same page', () => {
    const uaProbes = [probe(googlebotSmartphone, same), probe(browserAgent, same)];
    assert.equal(run(cloakingUa, [page(url, { html: same, uaProbes })]).at()?.outcome, 'pass');
  });

  test('fails high on followed links served only to Googlebot', () => {
    const injected = doc(`<main><h1>Plumbing</h1><p>${sentence}</p><a href="https://pills.example/buy">cheap pills</a></main>`);
    const { at, excerpts } = run(cloakingUa, [page(url, { html: same, uaProbes: [probe(googlebotSmartphone, injected), probe(browserAgent, same)] })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.params?.hosts], ['high', 'googlebot-only-links', 'pills.example']);
    assert.ok(excerpts(at()).includes('cheap pills -> https://pills.example/buy'));
  });

  test('compares with the rendered page when crawlers get prerendered HTML and browsers an app shell', () => {
    const shell = doc('<div id="root"></div><script src="/app.js"></script>');
    const uaProbes = [probe(googlebotSmartphone, same), probe(browserAgent, shell)];
    assert.equal(run(cloakingUa, [page(url, { html: shell, rendered: same, uaProbes })]).at()?.outcome, 'pass');
    assert.equal(run(cloakingUa, [page(url, { html: shell, uaProbes })]).at()?.reason, 'browser-shell-without-render');
  });

  test('is not evaluated when the browser receives a challenge page', () => {
    const challenge = doc('<p>Checking</p>', '<title>Just a moment...</title>');
    const { at } = run(cloakingUa, [page(url, { html: same, uaProbes: [probe(googlebotSmartphone, same), probe(browserAgent, challenge)] })]);
    assert.deepEqual([at()?.outcome, at()?.reason], ['not_evaluated', 'consent-or-challenge']);
  });

  test('is not evaluated without user-agent probes', () => {
    assert.equal(run(cloakingUa, [page(url, { html: same })]).at()?.reason, 'missing-input:ua-probe');
  });
});

describe('content-sneaky-redirects', () => {
  test('passes an intentional locale redirect that every user agent receives', () => {
    const uaProbes = [probe(googlebotSmartphone, '', { redirects: [[302, '/es/']] }), probe(browserAgent, '', { redirects: [[302, '/es/']] })];
    assert.equal(run(sneakyRedirects, [page(url, { html: doc(''), uaProbes })]).at()?.outcome, 'pass');
  });

  test('fails critical when browsers are sent to another site', () => {
    const uaProbes = [probe(googlebotSmartphone, doc('<p>ok</p>')), probe(browserAgent, '', { redirects: [[302, 'https://spam.example/landing']] })];
    const { at, excerpts } = run(sneakyRedirects, [page(url, { html: doc(''), uaProbes })]);
    assert.deepEqual([at()?.outcome, at()?.severity], ['fail', 'critical']);
    assert.deepEqual(excerpts(at()), [url, 'https://spam.example/landing']);
  });

  test('is not evaluated when browsers are sent to a consent or login page', () => {
    const uaProbes = [probe(googlebotSmartphone, doc('<p>ok</p>')), probe(browserAgent, '', { redirects: [[302, 'https://consent.cmp.example/?return=x']] })];
    assert.equal(run(sneakyRedirects, [page(url, { html: doc(''), uaProbes })]).at()?.reason, 'consent-or-login-redirect');
  });

  test('is not evaluated without probes', () => {
    assert.equal(run(sneakyRedirects, [page(url, { html: doc('') })]).at()?.outcome, 'not_evaluated');
  });
});

describe('content-hacked-signals', () => {
  const home = 'https://example.com/';
  const sitemap = (loc: string) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${loc}</loc></url></urlset>`;

  test('passes a clean site', () => {
    const pages = [page(home, { html: doc(`<main><p>${sentence}</p></main>`) })];
    assert.equal(run(hackedSignals, pages, { sitemaps: [{ url: `${home}sitemap.xml`, xml: sitemap(`${home}services/`) }] }).siteFindings[0]?.outcome, 'pass');
  });

  test('hands spam URLs in the sitemap to the analyst', () => {
    const pages = [page(home, { html: doc(`<main><p>${sentence}</p></main>`) })];
    const spam = `${home}wp-content/uploads/cheap-viagra-online.html`;
    const { siteFindings, excerpts } = run(hackedSignals, pages, { sitemaps: [{ url: `${home}sitemap.xml`, xml: sitemap(spam) }] });
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.reason, siteFindings[0]?.needsJudgment], ['medium', 'spam-urls-in-sitemap', true]);
    assert.deepEqual(excerpts(siteFindings[0]), [spam]);
  });

  test('does not apply when the site itself is about those topics', () => {
    const pages = [page(home, { html: doc('<main><h1>Online casino reviews</h1></main>', '<title>Online casino reviews</title>') })];
    assert.equal(run(hackedSignals, pages).siteFindings[0]?.reason, 'site-topic-matches-vocabulary');
  });

  test('is not evaluated without any fetched page', () => {
    assert.equal(run(hackedSignals, [], { origin: 'https://example.com' }).siteFindings[0]?.reason, 'missing-input:http');
  });
});
