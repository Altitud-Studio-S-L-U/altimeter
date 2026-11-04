import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SiteFacts } from '../../src/core/facts.ts';
import type { Severity } from '../../src/core/types.ts';
import { findingMessage } from '../../src/i18n/messages.ts';
import { implementations } from '../../src/rules/crawl/index.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { evaluate, page, site, type PageSpec, type SiteSpec } from '../support/facts.ts';

function run(id: string, facts: SiteFacts | SiteSpec, url?: string) {
  const implementation = implementations.find(entry => entry.id === id);
  assert.ok(implementation, `${id} is implemented`);
  const { findings, evidence } = evaluate(implementation, facts.pages instanceof Map ? facts as SiteFacts : site(facts as SiteSpec));
  const picked = url ? findings.filter(entry => entry.scope.kind === 'page' && entry.scope.url === url) : findings;
  return { finding: picked[0]!, findings: picked, excerpts: (finding: Finding = picked[0]!) => finding.evidence.map(ref => evidence.get(ref)?.excerpt ?? '') };
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
const doc = (head: string, body = '<p>Body text.</p>') => `<!doctype html><html lang="en"><head><title>Page</title>${head}</head><body>${body}</body></html>`;
const one = (url: string, spec: PageSpec, rest: Partial<SiteSpec> = {}): SiteSpec => ({ pages: [page(url, spec)], ...rest });
const urlset = (locs: readonly string[]) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map(loc => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`;
const served = { date: 'Wed, 04 Nov 2026 10:00:00 GMT' };

describe('crawl-meta-robots-noindex', () => {
  const id = 'crawl-meta-robots-noindex';
  const service = `${origin}/services/web`;
  test('passes on an indexable page, without any X-Robots-Tag header', () => {
    assertOutcome(run(id, one(`${origin}/`, { html: doc('') })).finding, 'pass');
  });
  test('fails critical on a noindex home page', () => {
    const { finding, excerpts } = run(id, one(`${origin}/`, { html: doc('<meta name="robots" content="noindex">') }));
    assertFail(finding, 'critical', 'conflict-home');
    assert.deepEqual(excerpts(), ['noindex']);
  });
  test('fails critical when a sitemap lists the noindex page', () => {
    const facts = one(service, { html: doc('<meta name="robots" content="noindex">') }, { sitemaps: [{ url: `${origin}/sitemap.xml`, xml: urlset([service]) }] });
    const { finding, excerpts } = run(id, facts);
    assertFail(finding, 'critical', 'conflict-sitemap');
    assert.ok(excerpts().includes(service));
  });
  test('fails medium on a content page without conflicts, from the header', () => {
    const { finding, excerpts } = run(id, one(service, { html: doc(''), headers: { 'x-robots-tag': 'noindex' } }));
    assertFail(finding, 'medium', 'content-page');
    assert.deepEqual(excerpts(), ['noindex']);
  });
  test('fails medium when only Bingbot is told noindex', () => {
    assertFail(run(id, one(service, { html: doc('<meta name="bingbot" content="noindex">') })).finding, 'medium', 'bingbot-only');
  });
  test('passes on a noindex,follow legal page linked from the footer and absent from the sitemap', () => {
    const privacy = `${origin}/privacy`;
    const facts: SiteSpec = {
      pages: [page(`${origin}/`, { html: doc('', '<footer><a href="/privacy">Privacy</a></footer>') }), page(privacy, { html: doc('<meta name="robots" content="noindex,follow">') })],
      sitemaps: [{ url: `${origin}/sitemap.xml`, xml: urlset([`${origin}/`]) }],
    };
    assertOutcome(run(id, facts, privacy).finding, 'pass');
  });
  test('does not apply to non-200 pages and needs the raw HTML', () => {
    assertOutcome(run(id, one(service, { status: 404, html: doc('<meta name="robots" content="noindex">') })).finding, 'not_applicable', 'non-200');
    assertOutcome(run(id, one(service, {})).finding, 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('crawl-noindex-raw-vs-rendered', () => {
  const id = 'crawl-noindex-raw-vs-rendered';
  const url = `${origin}/app`;
  test('passes when both agree', () => {
    assertOutcome(run(id, one(url, { html: doc(''), rendered: doc('') })).finding, 'pass');
  });
  test('fails critical when JavaScript removes a raw noindex', () => {
    const { finding, excerpts } = run(id, one(url, { html: doc('<meta name="robots" content="noindex">'), rendered: doc('') }));
    assertFail(finding, 'critical', 'removed-by-js');
    assert.deepEqual(excerpts(), ['noindex', '(none)']);
  });
  test('fails high when JavaScript adds noindex', () => {
    assertFail(run(id, one(url, { html: doc(''), rendered: doc('<meta name="robots" content="noindex">') })).finding, 'high', 'added-by-js');
  });
  test('reports a JavaScript noindex on an error view as info', () => {
    const rendered = '<!doctype html><title>Page not found</title><meta name="robots" content="noindex"><h1>Page not found</h1>';
    assertFail(run(id, one(url, { html: doc(''), rendered })).finding, 'info', 'error-view');
  });
  test('is not evaluated without a render', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_evaluated', 'missing-input:rendered-dom');
  });
});

describe('crawl-robots-directives-conflict', () => {
  const id = 'crawl-robots-directives-conflict';
  const url = `${origin}/a`;
  test('passes with one consistent source', () => {
    assertOutcome(run(id, one(url, { html: doc('<meta name="robots" content="noindex, nofollow">') })).finding, 'pass');
  });
  test('fails medium on index against noindex and reports the effective value', () => {
    const { finding, excerpts } = run(id, one(url, { html: doc('<meta name="robots" content="index, follow">'), headers: { 'x-robots-tag': 'noindex' } }));
    assertFail(finding, 'medium', 'index-noindex');
    assert.equal(finding.params?.effective, 'noindex');
    assert.deepEqual(excerpts().sort(), ['index, follow', 'noindex']);
  });
  test('fails medium on nosnippet against max-snippet', () => {
    assertFail(run(id, one(url, { html: doc('<meta name="robots" content="nosnippet"><meta name="googlebot" content="max-snippet:50">') })).finding, 'medium', 'snippet');
  });
  test('fails low on a redundant duplicate', () => {
    assertFail(run(id, one(url, { html: doc('<meta name="robots" content="noindex">'), headers: { 'x-robots-tag': 'noindex' } })).finding, 'low', 'duplicate');
  });
  test('does not apply without robots directives', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-robots-directives');
  });
});

describe('crawl-robots-directive-validity', () => {
  const id = 'crawl-robots-directive-validity';
  const url = `${origin}/a`;
  const meta = (content: string) => one(url, { html: doc(`<meta name="robots" content="${content}">`) });
  test('passes on valid directives', () => {
    assertOutcome(run(id, meta('noindex, max-snippet:50, max-image-preview:large, max-video-preview:-1')).finding, 'pass');
  });
  test('fails medium on a malformed value', () => {
    const { finding, excerpts } = run(id, meta('max-image-preview:big'));
    assertFail(finding, 'medium', 'malformed-value');
    assert.deepEqual(excerpts(), ['max-image-preview:big']);
  });
  test('fails medium on an unknown token', () => {
    assertFail(run(id, meta('no-index')).finding, 'medium', 'unknown-token');
  });
  test('fails low on space-separated directives', () => {
    assertFail(run(id, meta('noindex nofollow')).finding, 'low', 'space-separated');
  });
  test('reports no-op directives as info', () => {
    assertFail(run(id, meta('noarchive')).finding, 'info', 'no-op');
  });
  test('does not apply without directives', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-robots-directives');
  });
});

describe('crawl-unavailable-after', () => {
  const id = 'crawl-unavailable-after';
  const url = `${origin}/offer`;
  const meta = (value: string, head = '') => one(url, { html: doc(`<meta name="googlebot" content="unavailable_after: ${value}">${head}`), headers: served });
  test('passes on a date more than 30 days away, in RFC 850 form too', () => {
    assertOutcome(run(id, meta('2027-06-01')).finding, 'pass');
    assertOutcome(run(id, meta('Friday, 25-Jun-27 15:00:00 PST')).finding, 'pass');
  });
  test('fails critical on a past date', () => {
    const { finding, excerpts } = run(id, meta('2026-10-01'));
    assertFail(finding, 'critical', 'past');
    assert.deepEqual(excerpts(), ['unavailable_after: 2026-10-01', served.date]);
  });
  test('fails medium within 30 days', () => {
    const { finding } = run(id, meta('2026-11-20T00:00:00Z'));
    assertFail(finding, 'medium', 'soon');
    assert.equal(finding.params?.days, 15);
  });
  test('fails low on an unparseable date', () => {
    assertFail(run(id, meta('soon')).finding, 'low', 'unparseable');
  });
  test('does not apply to expiring content or pages without the directive', () => {
    assertOutcome(run(id, meta('2026-10-01', '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"Fair"}</script>')).finding, 'not_applicable', 'expiring-content');
    assertOutcome(run(id, one(url, { html: doc(''), headers: served })).finding, 'not_applicable', 'no-unavailable-after');
  });
  test('is not evaluated without a response date', () => {
    assertOutcome(run(id, one(url, { html: doc('<meta name="robots" content="unavailable_after: 2026-10-01">') })).finding, 'not_evaluated', 'no-response-date');
  });
});

describe('crawl-snippet-restrictions', () => {
  const id = 'crawl-snippet-restrictions';
  const url = `${origin}/guide`;
  const meta = (content: string, spec: Partial<PageSpec> = {}) => one(url, { html: doc(`<meta name="robots" content="${content}">`), ...spec });
  test('passes without restrictions', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'pass');
  });
  test('hands nosnippet to the analyst at medium', () => {
    const { finding, excerpts } = run(id, meta('nosnippet'));
    assertFail(finding, 'medium', 'nosnippet', true);
    assert.deepEqual(excerpts(), ['nosnippet']);
  });
  test('hands a short max-snippet to the analyst', () => {
    assertFail(run(id, meta('max-snippet:20')).finding, 'medium', 'short-snippet', true);
  });
  test('reports a limited image preview on articles as low', () => {
    assertFail(run(id, meta('max-image-preview:standard', { pageType: 'article' })).finding, 'low', 'image-preview', true);
  });
  test('does not apply to policy pages or noindex pages', () => {
    assertOutcome(run(id, meta('nosnippet', { pageType: 'legal' })).finding, 'not_applicable', 'policy-or-utility-page');
    assertOutcome(run(id, meta('noindex, nosnippet')).finding, 'not_applicable', 'noindex');
  });
});

describe('crawl-page-nofollow', () => {
  const id = 'crawl-page-nofollow';
  const links = '<nav><a href="/a">A</a><a href="/b">B</a></nav>';
  test('passes without nofollow', () => {
    assertOutcome(run(id, one(`${origin}/`, { html: doc('', links) })).finding, 'pass');
  });
  test('fails medium on a hub page', () => {
    const { finding, excerpts } = run(id, one(`${origin}/`, { html: doc('<meta name="robots" content="nofollow">', links) }));
    assertFail(finding, 'medium', 'hub-page');
    assert.deepEqual(excerpts(), ['nofollow']);
  });
  test('fails low on a leaf page', () => {
    assertFail(run(id, one(`${origin}/about`, { html: doc('<meta name="robots" content="none">', links) })).finding, 'low', 'leaf-page');
  });
  test('does not apply without internal links', () => {
    assertOutcome(run(id, one(`${origin}/`, { html: doc('<meta name="robots" content="nofollow">') })).finding, 'not_applicable', 'no-internal-links');
  });
});

describe('crawl-indexifembedded', () => {
  const id = 'crawl-indexifembedded';
  const url = `${origin}/player`;
  test('passes with noindex', () => {
    assertOutcome(run(id, one(url, { html: doc('<meta name="googlebot" content="noindex, indexifembedded">') })).finding, 'pass');
  });
  test('reports it without noindex as info', () => {
    const { finding, excerpts } = run(id, one(url, { html: doc('<meta name="googlebot" content="indexifembedded">') }));
    assertFail(finding, 'info');
    assert.deepEqual(excerpts(), ['indexifembedded']);
  });
  test('does not apply without the directive', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-indexifembedded');
  });
});

describe('crawl-head-invalid-element', () => {
  const id = 'crawl-head-invalid-element';
  const url = `${origin}/a`;
  test('passes on a clean head', () => {
    assertOutcome(run(id, one(url, { html: doc(`<link rel="canonical" href="${url}">`) })).finding, 'pass');
  });
  test('fails high when a canonical lands in the body', () => {
    const { finding, excerpts } = run(id, one(url, { html: `<!doctype html><html><head><title>A</title><img src="/pixel.gif"><link rel="canonical" href="${url}"></head><body></body></html>` }));
    assertFail(finding, 'high', 'canonical-or-hreflang-ignored');
    assert.equal(excerpts()[0], '<img>');
    assert.match(excerpts()[1]!, /rel="canonical"/u);
  });
  test('fails low when only other metadata is displaced', () => {
    assertFail(run(id, one(url, { html: '<!doctype html><html><head><title>A</title><div>x</div><meta name="description" content="d"></head><body></body></html>' })).finding, 'low', 'metadata-displaced');
  });
  test('needs the raw HTML', () => {
    assertOutcome(run(id, one(url, {})).finding, 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('crawl-canonical-presence', () => {
  const id = 'crawl-canonical-presence';
  const url = `${origin}/a/`;
  test('passes with a canonical', () => {
    assertOutcome(run(id, one(url, { html: doc(`<link rel="canonical" href="${url}">`) })).finding, 'pass');
  });
  test('fails low without a canonical', () => {
    const { finding, excerpts } = run(id, one(url, { html: doc('') }));
    assertFail(finding, 'low', 'missing');
    assert.deepEqual(excerpts(), ['(none)']);
  });
  test('escalates to medium when a variant answers 200', () => {
    const { finding } = run(id, one(url, { html: doc('') }, { variants: [{ label: 'trailing-slash', url: `${origin}/a`, body: doc('') }] }));
    assertFail(finding, 'medium', 'duplicates-answer');
  });
  test('does not apply to noindex pages', () => {
    assertOutcome(run(id, one(url, { html: doc('<meta name="robots" content="noindex">') })).finding, 'not_applicable', 'noindex');
  });
});

describe('crawl-canonical-multiple', () => {
  const id = 'crawl-canonical-multiple';
  const url = `${origin}/a`;
  test('passes with one canonical', () => {
    assertOutcome(run(id, one(url, { html: doc(`<link rel="canonical" href="${url}">`) })).finding, 'pass');
  });
  test('fails high on two different targets', () => {
    const { finding, excerpts } = run(id, one(url, { html: doc(`<link rel="canonical" href="${url}"><link rel="canonical" href="${origin}/b">`) }));
    assertFail(finding, 'high', 'conflicting-targets');
    assert.deepEqual(excerpts(), [url, `${origin}/b`]);
  });
  test('fails low on a repeated target, including the Link header', () => {
    assertFail(run(id, one(url, { html: doc(`<link rel="canonical" href="${url}">`), headers: { link: `<${url}>; rel="canonical"` } })).finding, 'low', 'repeated');
  });
  test('does not apply without a canonical', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-canonical');
  });
});

describe('crawl-canonical-js-changed', () => {
  const id = 'crawl-canonical-js-changed';
  const url = `${origin}/a`;
  const canonical = (href: string) => doc(`<link rel="canonical" href="${href}">`);
  test('passes when raw and rendered agree', () => {
    assertOutcome(run(id, one(url, { html: canonical(url), rendered: canonical(url) })).finding, 'pass');
  });
  test('fails high when JavaScript changes the canonical', () => {
    const { finding, excerpts } = run(id, one(url, { html: canonical(url), rendered: canonical(`${origin}/b`) }));
    assertFail(finding, 'high', 'changed');
    assert.deepEqual(excerpts(), [url, `${origin}/b`]);
  });
  test('fails high when JavaScript removes it and low when it only adds it', () => {
    assertFail(run(id, one(url, { html: canonical(url), rendered: doc('') })).finding, 'high', 'removed');
    assertFail(run(id, one(url, { html: doc(''), rendered: canonical(url) })).finding, 'low', 'added');
  });
  test('does not apply without any canonical and needs a render', () => {
    assertOutcome(run(id, one(url, { html: doc(''), rendered: doc('') })).finding, 'not_applicable', 'no-canonical');
    assertOutcome(run(id, one(url, { html: canonical(url) })).finding, 'not_evaluated', 'missing-input:rendered-dom');
  });
});

describe('crawl-canonical-format', () => {
  const id = 'crawl-canonical-format';
  const url = `${origin}/a`;
  const canonical = (href: string) => one(url, { html: doc(`<link rel="canonical" href="${href}">`) });
  test('passes on an absolute URL', () => {
    assertOutcome(run(id, canonical(url)).finding, 'pass');
  });
  test('fails low on a relative URL', () => {
    const { finding, excerpts } = run(id, canonical('/a'));
    assertFail(finding, 'low', 'relative');
    assert.deepEqual(excerpts(), ['/a']);
  });
  test('fails medium on a placeholder or a fragment', () => {
    assertFail(run(id, canonical('{{ page.url }}')).finding, 'medium', 'placeholder');
    assertFail(run(id, canonical(`${url}#top`)).finding, 'medium', 'fragment');
  });
  test('does not apply without a canonical', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-canonical');
  });
});

describe('crawl-canonical-ignored-attributes-placement', () => {
  const id = 'crawl-canonical-ignored-attributes-placement';
  const url = `${origin}/a`;
  test('passes with a canonical in the head', () => {
    assertOutcome(run(id, one(url, { html: doc(`<link rel="canonical" href="${url}">`) })).finding, 'pass');
  });
  test('fails high when the only canonical is in the body', () => {
    const { finding, excerpts } = run(id, one(url, { html: doc('', `<link rel="canonical" href="${url}">`) }));
    assertFail(finding, 'high', 'only-unusable');
    assert.deepEqual(excerpts(), [`<link rel="canonical" href="${url}">`]);
  });
  test('fails low on an extra canonical with a media attribute', () => {
    assertFail(run(id, one(url, { html: doc(`<link rel="canonical" href="${url}"><link rel="canonical" media="print" href="${url}?print">`) })).finding, 'low', 'extra-unusable');
  });
  test('does not apply without a canonical', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-canonical');
  });
});

describe('crawl-canonical-target-health', () => {
  const id = 'crawl-canonical-target-health';
  const a = `${origin}/a`;
  const b = `${origin}/b`;
  const pointing = () => page(a, { html: doc(`<link rel="canonical" href="${b}">`) });
  test('passes on a self-referencing canonical', () => {
    assertOutcome(run(id, one(a, { html: doc(`<link rel="canonical" href="${a}">`) }), a).finding, 'pass');
  });
  test('fails high when the target answers an error', () => {
    const { finding, excerpts } = run(id, { pages: [pointing(), page(b, { status: 404, html: doc('') })] }, a);
    assertFail(finding, 'high', 'target-error');
    assert.deepEqual(excerpts(), [b, 'HTTP 404']);
  });
  test('fails medium when the target redirects', () => {
    const { finding, excerpts } = run(id, { pages: [pointing(), page(b, { redirects: [[301, '/c']], html: doc('') })] }, a);
    assertFail(finding, 'medium', 'target-redirects');
    assert.deepEqual(excerpts(), [b, `HTTP 301 -> ${origin}/c`]);
  });
  test('fails high when the target is noindex or blocked', () => {
    assertFail(run(id, { pages: [pointing(), page(b, { html: doc('<meta name="robots" content="noindex">') })] }, a).finding, 'high', 'target-noindex');
    assertFail(run(id, { pages: [pointing(), page(b, { html: doc('') })], robots: 'User-agent: *\nDisallow: /b' }, a).finding, 'high', 'target-blocked');
  });
  test('passes when the target is a root that redirects by locale to a page in its hreflang cluster', () => {
    const en = '<link rel="alternate" hreflang="en" href="https://example.com/en/"><link rel="alternate" hreflang="es" href="https://example.com/es/">';
    const facts: SiteSpec = { pages: [page(`${origin}/`, { redirects: [[302, '/en/']], html: doc(`${en}<link rel="canonical" href="${origin}/">`) })] };
    assertOutcome(run(id, facts, `${origin}/`).finding, 'pass');
  });
  test('is not evaluated when the target was not fetched', () => {
    assertOutcome(run(id, { pages: [pointing()] }, a).finding, 'not_evaluated', 'target-not-fetched');
  });
});

describe('crawl-canonical-protocol-host', () => {
  const id = 'crawl-canonical-protocol-host';
  const a = `${origin}/a`;
  test('passes on an https self canonical', () => {
    assertOutcome(run(id, one(a, { html: doc(`<link rel="canonical" href="${a}">`) })).finding, 'pass');
  });
  test('fails high on a canonical to http', () => {
    const { finding, excerpts } = run(id, one(a, { html: doc('<link rel="canonical" href="http://example.com/a">') }));
    assertFail(finding, 'high', 'canonical-to-http');
    assert.deepEqual(excerpts(), ['http://example.com/a']);
  });
  test('fails high when the canonical host is the one variants redirect away from', () => {
    const facts = one(a, { html: doc('<link rel="canonical" href="https://www.example.com/a">') }, { variants: [{ label: 'www', url: 'https://www.example.com/a', redirects: [[301, a]] }] });
    const { finding, excerpts } = run(id, facts);
    assertFail(finding, 'high', 'canonical-host-mismatch');
    assert.deepEqual(excerpts(), ['https://www.example.com/a', a]);
  });
  test('does not apply without canonicals', () => {
    assertOutcome(run(id, one(a, { html: doc('') })).finding, 'not_applicable', 'no-canonical');
  });
});

describe('crawl-canonical-cross-domain', () => {
  const id = 'crawl-canonical-cross-domain';
  const url = 'https://shop.example.co.uk/a';
  const canonical = (href: string) => one(url, { html: doc(`<link rel="canonical" href="${href}">`) });
  test('passes on the same registrable domain', () => {
    assertOutcome(run(id, canonical('https://www.example.co.uk/a')).finding, 'pass');
  });
  test('hands another domain to the analyst', () => {
    const { finding, excerpts } = run(id, canonical('https://other.org/a'));
    assertFail(finding, 'medium', 'cross-domain', true);
    assert.deepEqual(excerpts(), ['https://other.org/a']);
  });
  test('fails high on a canonical to a staging host', () => {
    assertFail(run(id, canonical('https://staging.examplecdn.net/a')).finding, 'high', 'canonical-to-staging');
  });
  test('does not apply without a canonical', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-canonical');
  });
});

describe('crawl-canonical-pagination', () => {
  const id = 'crawl-canonical-pagination';
  const second = `${origin}/blog/?page=2`;
  const canonical = (href: string) => one(second, { html: doc(`<link rel="canonical" href="${href}">`) });
  test('passes on a self canonical', () => {
    assertOutcome(run(id, canonical(second)).finding, 'pass');
  });
  test('fails medium when page 2 canonicalises to page 1', () => {
    const { finding, excerpts } = run(id, canonical(`${origin}/blog/`));
    assertFail(finding, 'medium');
    assert.deepEqual(excerpts(), [`${origin}/blog/`]);
  });
  test('passes on a view-all canonical', () => {
    assertOutcome(run(id, canonical(`${origin}/blog/view-all`)).finding, 'pass');
  });
  test('does not apply without paginated pages', () => {
    assertOutcome(run(id, one(`${origin}/blog/`, { html: doc('') })).finding, 'not_applicable', 'no-paginated-pages');
  });
});

describe('crawl-canonical-chains', () => {
  const id = 'crawl-canonical-chains';
  const at = (path: string, target: string) => page(`${origin}${path}`, { html: doc(`<link rel="canonical" href="${origin}${target}">`) });
  test('passes when each page names the final canonical', () => {
    assertOutcome(run(id, { pages: [at('/a', '/b'), at('/b', '/b')] }).finding, 'pass');
  });
  test('fails low on a chain', () => {
    const { finding, excerpts } = run(id, { pages: [at('/a', '/b'), at('/b', '/c'), at('/c', '/c')] });
    assertFail(finding, 'low', 'chain');
    assert.deepEqual(excerpts(), [`${origin}/b`, `${origin}/c`]);
  });
  test('fails medium on a loop', () => {
    assertFail(run(id, { pages: [at('/a', '/b'), at('/b', '/a')] }).finding, 'medium', 'loop');
  });
  test('does not apply when canonicals do not point at other audited pages', () => {
    assertOutcome(run(id, { pages: [at('/a', '/a')] }).finding, 'not_applicable', 'no-canonical-edges');
  });
});

describe('crawl-canonical-signal-consistency', () => {
  const id = 'crawl-canonical-signal-consistency';
  const a = `${origin}/a`;
  const sitemap = { url: `${origin}/sitemap.xml`, xml: urlset([a]) };
  test('passes when a listed URL is its own canonical', () => {
    assertOutcome(run(id, one(a, { html: doc(`<link rel="canonical" href="${a}">`) }, { sitemaps: [sitemap] })).finding, 'pass');
  });
  test('fails medium when the sitemap lists a non-canonical URL', () => {
    const { finding, excerpts } = run(id, one(a, { html: doc(`<link rel="canonical" href="${origin}/b">`) }, { sitemaps: [sitemap] }));
    assertFail(finding, 'medium', 'sitemap-non-canonical');
    assert.deepEqual(excerpts(), [a, `${origin}/b`]);
  });
  test('does not apply when no audited page is in the sitemap', () => {
    assertOutcome(run(id, one(`${origin}/z`, { html: doc('') }, { sitemaps: [sitemap] })).finding, 'not_applicable', 'no-overlap');
  });
});

describe('crawl-base-href', () => {
  const id = 'crawl-base-href';
  const url = `${origin}/a`;
  const based = (base: string, body = '<a href="page">Page</a>') => doc(`<base href="${base}">`, body);
  test('passes on a base on the same host', () => {
    assertOutcome(run(id, one(url, { html: based(`${origin}/`) })).finding, 'pass');
  });
  test('fails high on a base on another site with relative links', () => {
    const { finding, excerpts } = run(id, one(url, { html: based('https://dev.agency.test/') }));
    assertFail(finding, 'high', 'other-host');
    assert.deepEqual(excerpts(), ['https://dev.agency.test/']);
  });
  test('fails low on a base on another site that nothing depends on', () => {
    assertFail(run(id, one(url, { html: based('https://cdn.other.net/', '<a href="https://example.com/x">X</a>') })).finding, 'low', 'other-host-unused');
  });
  test('fails high when relative links resolve to errors', () => {
    const facts = one(url, { html: based(`${origin}/sub/`) }, { siblings: [page(`${origin}/sub/page`, { status: 404 })] });
    const { finding, excerpts } = run(id, facts);
    assertFail(finding, 'high', 'relative-links-broken');
    assert.ok(excerpts().includes('HTTP 404'));
  });
  test('fails high when the links the collector fetched through the base answer errors, without a crawl', () => {
    assertFail(run(id, one(url, { html: based(`${origin}/sub/`) }, { baseLinks: [{ url: `${origin}/sub/page`, status: 404 }] })).finding, 'high', 'relative-links-broken');
  });
  test('passes when the links the base moves answer 200', () => {
    assertOutcome(run(id, one(url, { html: based(`${origin}/sub/`) }, { baseLinks: [{ url: `${origin}/sub/page`, status: 200 }] })).finding, 'pass');
  });
  test('is not evaluated when none of the links the base moves was fetched', () => {
    assertOutcome(run(id, one(url, { html: based(`${origin}/sub/`) })).finding, 'not_evaluated', 'shifted-links-not-fetched');
  });
  test('does not apply without a base element', () => {
    assertOutcome(run(id, one(url, { html: doc('') })).finding, 'not_applicable', 'no-base');
  });
});
