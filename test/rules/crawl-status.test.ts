import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts, SiteFacts } from '../../src/core/facts.ts';
import type { Severity } from '../../src/core/types.ts';
import { findingMessage } from '../../src/i18n/messages.ts';
import { implementations } from '../../src/rules/crawl/index.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { evaluate, headers, page, site, type SiteSpec } from '../support/facts.ts';

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
const alternates = '<link rel="alternate" hreflang="en" href="https://example.com/en/"><link rel="alternate" hreflang="es" href="https://example.com/es/">';
/** A root that sends visitors to /en/ by locale, with /en/ listing itself among its alternates. */
const localeRoot = (from = `${origin}/`, body = '<p>Welcome.</p>') => page(from, { redirects: [[302, `${origin}/en/`]], html: doc(alternates, body) });

function withHopHeaders(entry: PageFacts, index: number, values: Readonly<Record<string, string>>): PageFacts {
  const hops = entry.fetch.hops.map((hop, position) => (position === index ? { ...hop, headers: { ...hop.headers, ...headers(values) } } : hop));
  return { ...entry, fetch: { ...entry.fetch, hops } };
}

describe('crawl-status-final', () => {
  const id = 'crawl-status-final';
  const gone = `${origin}/gone`;
  test('passes on 200', () => {
    const { finding, excerpts } = run(id, { pages: [page(`${origin}/`, { html: doc('') })] });
    assertOutcome(finding, 'pass');
    assert.deepEqual(excerpts(), ['HTTP 200']);
  });
  test('fails critical on a 404 that another page links to', () => {
    const facts = { pages: [page(`${origin}/`, { html: doc('', '<a href="/gone">Gone</a>') }), page(gone, { status: 404, html: doc('') })] };
    const { finding, excerpts } = run(id, facts, gone);
    assertFail(finding, 'critical', 'client-error');
    assert.deepEqual(excerpts(), ['HTTP 404', gone]);
  });
  test('fails on server errors, rate limiting and empty responses', () => {
    assertFail(run(id, { pages: [page(gone, { status: 503 })] }).finding, 'critical', 'server-error');
    assertFail(run(id, { pages: [page(gone, { status: 429 })] }).finding, 'high', 'rate-limited');
    assertFail(run(id, { pages: [page(gone, { status: 204 })] }).finding, 'high', 'no-content');
  });
  test('does not apply to an unreferenced removed URL', () => {
    assertOutcome(run(id, { pages: [page(gone, { status: 410, html: doc('') })] }).finding, 'not_applicable', 'removed-unreferenced');
  });
  test('is not evaluated without a response', () => {
    const failed = page(gone);
    const facts = site({ pages: [{ ...failed, fetch: { ...failed.fetch, status: undefined, hops: [], error: { code: 'timeout', message: 'timed out' } } }] });
    assertOutcome(run(id, facts).finding, 'not_evaluated', 'missing-input:http,redirects');
  });
});

describe('crawl-redirect-chain', () => {
  const id = 'crawl-redirect-chain';
  const a = `${origin}/a`;
  test('passes on a single redirect', () => {
    assertOutcome(run(id, { pages: [page(a, { redirects: [[301, '/b']], html: doc('') })] }).finding, 'pass');
  });
  test('fails low on two hops and medium on longer chains', () => {
    const { finding, excerpts } = run(id, { pages: [page(a, { redirects: [[301, '/b'], [301, '/c']], html: doc('') })] });
    assertFail(finding, 'low', 'two-hops');
    assert.deepEqual(excerpts(), [`301 -> ${origin}/b`, `301 -> ${origin}/c`]);
    assertFail(run(id, { pages: [page(a, { redirects: [[301, '/b'], [301, '/c'], [301, '/d'], [301, '/e']], html: doc('') })] }).finding, 'medium', 'long-chain');
  });
  test('fails medium on a loop', () => {
    const looping = page(a, { redirects: [[301, '/b'], [301, '/a']], status: 301 });
    const facts = site({ pages: [{ ...looping, fetch: { ...looping.fetch, error: { code: 'redirect-loop', message: 'loop' } } }] });
    assertFail(run(id, facts).finding, 'medium', 'loop');
  });
  test('does not count the hop of a locale entry point', () => {
    const facts = { pages: [page('http://example.com/', { redirects: [[301, `${origin}/`], [302, `${origin}/en/`]], html: doc(alternates) })] };
    assertOutcome(run(id, facts).finding, 'pass');
  });
  test('does not apply without redirects', () => {
    assertOutcome(run(id, { pages: [page(a, { html: doc('') })] }).finding, 'not_applicable', 'no-redirect');
  });
});

describe('crawl-redirect-type', () => {
  const id = 'crawl-redirect-type';
  test('passes on permanent redirects', () => {
    assertOutcome(run(id, { pages: [page(`${origin}/old`, { redirects: [[301, '/new']], html: doc('') })] }).finding, 'pass');
  });
  test('fails medium on a temporary protocol consolidation', () => {
    const { finding, excerpts } = run(id, { pages: [page('http://example.com/a', { redirects: [[302, `${origin}/a`]], html: doc('') })] });
    assertFail(finding, 'medium', 'temporary-consolidation');
    assert.deepEqual(excerpts(), [`302 -> ${origin}/a`]);
  });
  test('hands a temporary move to the analyst', () => {
    assertFail(run(id, { pages: [page(`${origin}/old`, { redirects: [[302, '/new']], html: doc('') })] }).finding, 'medium', 'temporary-move', true);
  });
  test('passes on a locale root, a login redirect and a private no-store redirect with Vary: Cookie', () => {
    assertOutcome(run(id, { pages: [localeRoot()] }).finding, 'pass');
    assertOutcome(run(id, { pages: [page(`${origin}/account/orders`, { redirects: [[302, '/login?next=/account/orders']], html: doc('') })] }).finding, 'pass');
    const privateRedirect = withHopHeaders(page(`${origin}/offer`, { redirects: [[302, '/offer/es']], html: doc('') }), 0, { 'cache-control': 'private, no-store', vary: 'Cookie' });
    assertOutcome(run(id, site({ pages: [privateRedirect] })).finding, 'pass');
  });
  test('does not apply without redirects', () => {
    assertOutcome(run(id, { pages: [page(`${origin}/a`, { html: doc('') })] }).finding, 'not_applicable', 'no-redirect');
  });
});

describe('crawl-meta-refresh-js-redirect', () => {
  const id = 'crawl-meta-refresh-js-redirect';
  const a = `${origin}/a`;
  test('passes without client redirects, and on a refresh of the page itself', () => {
    assertOutcome(run(id, { pages: [page(a, { html: doc('') })] }).finding, 'pass');
    assertOutcome(run(id, { pages: [page(a, { html: doc('<meta http-equiv="refresh" content="300">') })] }).finding, 'pass');
  });
  test('fails low on an instant meta refresh', () => {
    const { finding, excerpts } = run(id, { pages: [page(a, { html: doc('<meta http-equiv="refresh" content="0; url=/b">') })] });
    assertFail(finding, 'low', 'instant-refresh');
    assert.deepEqual(excerpts(), ['0; url=/b']);
  });
  test('fails medium on a delayed meta refresh', () => {
    assertFail(run(id, { pages: [page(a, { html: doc('<meta http-equiv="refresh" content="5;URL=\'https://example.com/b\'">') })] }).finding, 'medium', 'delayed-refresh');
  });
  test('fails medium when the render navigates away', () => {
    const base = page(a, { html: doc(''), rendered: doc('') });
    const moved: PageFacts = { ...base, rendered: { ...base.rendered!, result: { ...base.rendered!.result, finalUrl: `${origin}/b` } } };
    const { finding, excerpts } = run(id, site({ pages: [moved] }));
    assertFail(finding, 'medium', 'js-redirect');
    assert.deepEqual(excerpts(), [`${origin}/b`]);
  });
  test('does not apply to non-200 pages', () => {
    assertOutcome(run(id, { pages: [page(a, { status: 404, html: doc('<meta http-equiv="refresh" content="0; url=/">') })] }).finding, 'not_applicable', 'non-200');
  });
});

describe('crawl-soft-404', () => {
  const id = 'crawl-soft-404';
  const pages = () => [page(`${origin}/`, { html: doc('') }), page(`${origin}/about`, { html: '<!doctype html><title>About</title><h1>About us</h1><p>Small studio.</p>' })];
  test('passes when unknown paths answer 404 and a short About page is not flagged', () => {
    const { finding, excerpts } = run(id, { pages: pages(), notFound: { status: 404, html: doc('') } });
    assertOutcome(finding, 'pass');
    assert.deepEqual(excerpts(), ['HTTP 404']);
  });
  test('fails high when an unknown path answers 200', () => {
    const { finding, excerpts } = run(id, { pages: pages(), notFound: { status: 200, html: doc('') } });
    assertFail(finding, 'high', 'probe-200');
    assert.deepEqual(excerpts(), ['HTTP 200', 'Page']);
  });
  test('hands a 200 page with error wording to the analyst', () => {
    const facts = { pages: [page(`${origin}/item/9`, { html: '<!doctype html><title>Página no encontrada</title><h1>404</h1>' })], notFound: { status: 404 } };
    const { findings, excerpts } = run(id, facts);
    assertFail(findings[0]!, 'medium', 'error-page-200', true);
    assert.deepEqual(excerpts(findings[0]), ['Página no encontrada | 404']);
  });
  test('is not evaluated without the probe or when it fails', () => {
    assertOutcome(run(id, { pages: pages() }).finding, 'not_evaluated', 'missing-input:not-found-probe');
    assertOutcome(run(id, { pages: pages(), notFound: { status: 502 } }).finding, 'not_evaluated', 'probe-server-error');
  });
});

describe('crawl-redirect-to-home', () => {
  const id = 'crawl-redirect-to-home';
  const about = () => page(`${origin}/about`, { html: doc('') });
  test('passes when redirects lead to related pages, and on a locale root', () => {
    assertOutcome(run(id, { pages: [page(`${origin}/old`, { redirects: [[301, '/new']], html: doc('') })] }).finding, 'pass');
    assertOutcome(run(id, { pages: [localeRoot()] }).finding, 'pass');
  });
  test('fails medium when the unknown path redirects home', () => {
    const { finding, excerpts } = run(id, { pages: [about()], notFound: { redirects: [[301, '/']], html: doc('') } });
    assertFail(finding, 'medium', 'probe-to-home');
    assert.deepEqual(excerpts(), [`301 -> ${origin}/`]);
  });
  test('fails medium when a variant of a non-home page redirects home', () => {
    assertFail(run(id, { pages: [about()], variants: [{ label: 'uppercase', url: `${origin}/ABOUT`, redirects: [[301, '/']] }] }).finding, 'medium', 'variant-to-home');
  });
  test('hands an audited URL that redirects home to the analyst', () => {
    assertFail(run(id, { pages: [page(`${origin}/old-offer`, { redirects: [[301, '/']], html: doc('') })] }).finding, 'medium', 'page-to-home', true);
  });
  test('does not apply when nothing redirects', () => {
    assertOutcome(run(id, { pages: [about()], notFound: { status: 404 } }).finding, 'not_applicable', 'no-redirects');
  });
});

describe('crawl-server-errors-rate', () => {
  const id = 'crawl-server-errors-rate';
  const many = (count: number, failing: number, status = 503) => Array.from({ length: count }, (_, index) => page(`${origin}/p/${index}`, index < failing ? { status } : { html: doc('') }));
  test('passes without server errors', () => {
    assertOutcome(run(id, { pages: many(10, 0), crawled: true }).finding, 'pass');
  });
  test('fails high at 1% or more', () => {
    const { finding, excerpts } = run(id, { pages: many(10, 1), crawled: true });
    assertFail(finding, 'high', 'error-rate');
    assert.deepEqual(excerpts(), ['HTTP 503']);
  });
  test('fails low on a rare 503 without Retry-After', () => {
    assertFail(run(id, { pages: many(120, 1), crawled: true }).finding, 'low', 'no-retry-after');
  });
  test('is not evaluated without a crawl', () => {
    assertOutcome(run(id, { pages: many(3, 1) }).finding, 'not_evaluated', 'missing-input:crawl');
  });
});

describe('crawl-host-variant-consolidation', () => {
  const id = 'crawl-host-variant-consolidation';
  const preferred = `${origin}/a/`;
  const body = '<main><h1>Services</h1><p>We design and build websites for small companies in the valley.</p></main>';
  const base = () => page(preferred, { html: doc(`<link rel="canonical" href="${preferred}">`, body) });
  test('passes on permanent redirects, a 404 case variant and a 200 variant with a canonical to the preferred URL', () => {
    const facts = { pages: [base()], variants: [
      { label: 'www', url: 'https://www.example.com/a/', redirects: [[301, preferred]] as const },
      { label: 'uppercase', url: `${origin}/A/`, status: 404 },
      { label: 'trailing-slash', url: `${origin}/a`, body: doc(`<link rel="canonical" href="${preferred}">`, body) },
    ] };
    assertOutcome(run(id, facts).finding, 'pass');
  });
  test('fails high on a duplicate that answers 200 without a canonical', () => {
    const { finding, excerpts } = run(id, { pages: [base()], variants: [{ label: 'trailing-slash', url: `${origin}/a`, body: doc('', body) }] });
    assertFail(finding, 'high', 'duplicate-200');
    assert.deepEqual(excerpts(), ['HTTP 200, canonical (none)', 'HTTP 200']);
  });
  test('fails low on a temporary or multi-hop consolidation', () => {
    assertFail(run(id, { pages: [base()], variants: [{ label: 'http', url: 'http://example.com/a/', redirects: [[302, preferred]] }] }).finding, 'low', 'temporary-redirect');
    assertFail(run(id, { pages: [base()], variants: [{ label: 'http', url: 'http://example.com/a/', redirects: [[301, 'http://www.example.com/a/'], [301, preferred]] }] }).finding, 'low', 'multiple-hops');
  });
  test('passes when the audited root redirects by locale and its variants reach the locale page permanently', () => {
    const facts = { pages: [localeRoot()], variants: [
      { label: 'http', url: 'http://example.com/en/', redirects: [[301, `${origin}/en/`]] as const },
      { label: 'www', url: 'https://www.example.com/en/', redirects: [[301, `${origin}/en/`]] as const },
    ] };
    assertOutcome(run(id, facts).finding, 'pass');
  });
  test('does not apply to variants of other pages and needs variants', () => {
    assertOutcome(run(id, { pages: [base()], variants: [{ label: 'http', url: 'http://example.com/zzz', redirects: [[302, '/']] }] }).finding, 'not_applicable', 'no-variants-of-audited-pages');
    assertOutcome(run(id, { pages: [base()] }).finding, 'not_evaluated', 'missing-input:variants');
  });
});

describe('crawl-internal-links-broken-redirected', () => {
  const id = 'crawl-internal-links-broken-redirected';
  const home = (body: string) => page(`${origin}/`, { html: doc('', body) });
  test('passes when linked pages answer 200', () => {
    assertOutcome(run(id, { pages: [home('<a href="/about">About</a>')], siblings: [page(`${origin}/about`, { html: doc('') })] }).finding, 'pass');
  });
  test('fails medium on a footer link to an error page', () => {
    const { finding, excerpts } = run(id, { pages: [home('<footer><a href="/old">Old</a></footer>')], siblings: [page(`${origin}/old`, { status: 404 })] });
    assertFail(finding, 'medium', 'broken');
    assert.deepEqual(excerpts(), [`${origin}/old -> HTTP 404`]);
  });
  test('fails low on a content link to an error page and on links to redirects', () => {
    assertFail(run(id, { pages: [home('<p><a href="/old">Old</a></p>')], siblings: [page(`${origin}/old`, { status: 404 })] }).finding, 'low', 'broken');
    assertFail(run(id, { pages: [home('<a href="/moved">Moved</a>')], siblings: [page(`${origin}/moved`, { redirects: [[301, '/new']], html: doc('') })] }).finding, 'low', 'redirected');
  });
  test('passes on a logo link to a root that redirects by locale', () => {
    assertOutcome(run(id, { pages: [localeRoot(`${origin}/`, '<header><a href="/">Logo</a></header>')] }).finding, 'pass');
  });
  test('does not apply when no link target was fetched', () => {
    assertOutcome(run(id, { pages: [home('<a href="/unknown">Unknown</a>')] }).finding, 'not_applicable', 'no-known-targets');
  });
});

describe('crawl-conditional-requests', () => {
  const id = 'crawl-conditional-requests';
  const a = `${origin}/`;
  test('passes with an ETag, including max-age=0 on edge-cached HTML', () => {
    assertOutcome(run(id, { pages: [page(a, { html: doc(''), headers: { etag: '"abc"', 'cache-control': 'public, max-age=0, must-revalidate' } })] }).finding, 'pass');
  });
  test('fails low on a malformed Last-Modified', () => {
    const { finding, excerpts } = run(id, { pages: [page(a, { html: doc(''), headers: { 'last-modified': '2026-11-01' } })] });
    assertFail(finding, 'low', 'malformed-last-modified');
    assert.deepEqual(excerpts(), ['2026-11-01']);
  });
  test('is not evaluated without validators when the site size is unknown', () => {
    assertOutcome(run(id, { pages: [page(a, { html: doc('') })] }).finding, 'not_evaluated', 'site-size-unknown');
  });
  test('does not apply without HTML pages', () => {
    assertOutcome(run(id, { pages: [page(a, { status: 200 })] }).finding, 'not_applicable', 'no-html-pages');
  });
});

describe('crawl-html-size-limit', () => {
  const id = 'crawl-html-size-limit';
  const a = `${origin}/a`;
  const filler = 'x'.repeat(2_150_000);
  test('passes under 2 MB', () => {
    const { finding, excerpts } = run(id, { pages: [page(a, { html: doc('') })] });
    assertOutcome(finding, 'pass');
    assert.equal(excerpts().length, 1);
  });
  test('fails high when links come after the first 2 MB', () => {
    const { finding, excerpts } = run(id, { pages: [page(a, { html: `<!doctype html><title>A</title><p>${filler}</p><a href="/late">Late</a>` })] });
    assertFail(finding, 'high', 'content-after-limit');
    assert.ok(excerpts().includes('<a href="/late">'));
  });
  test('fails low when only a trailing script is cut', () => {
    const html = `<!doctype html><title>A</title><p>${'x'.repeat(2_090_000)}</p><script>${'var a = 1;'.repeat(5_000)}</script>`;
    assertFail(run(id, { pages: [page(a, { html })] }).finding, 'low', 'scripts-after-limit');
  });
  test('needs the raw HTML', () => {
    assertOutcome(run(id, { pages: [page(a)] }).finding, 'not_evaluated', 'missing-input:raw-html');
  });
});
