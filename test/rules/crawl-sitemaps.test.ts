import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SiteFacts } from '../../src/core/facts.ts';
import type { Severity } from '../../src/core/types.ts';
import { findingMessage } from '../../src/i18n/messages.ts';
import { implementations } from '../../src/rules/crawl/index.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { evaluate, headers, page, site, type SiteSpec } from '../support/facts.ts';

function run(id: string, facts: SiteFacts | SiteSpec) {
  const implementation = implementations.find(entry => entry.id === id);
  assert.ok(implementation, `${id} is implemented`);
  const { findings, evidence } = evaluate(implementation, facts.pages instanceof Map ? facts as SiteFacts : site(facts as SiteSpec));
  return { finding: findings[0]!, findings, evidence, excerpts: (finding: Finding = findings[0]!) => finding.evidence.map(ref => evidence.get(ref)?.excerpt ?? '') };
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
const map = `${origin}/sitemap.xml`;
const doc = (head = '') => `<!doctype html><html lang="en"><head><title>Page</title>${head}</head><body><p>Text.</p></body></html>`;
const namespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const entry = (loc: string, extra = '') => `<url><loc>${loc}</loc>${extra}</url>`;
const urlset = (entries: readonly string[], ns = namespace) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${ns}">${entries.join('')}</urlset>`;
const locs = (paths: readonly string[]) => urlset(paths.map(path => entry(`${origin}${path}`)));
const home = () => page(`${origin}/`, { html: doc() });

/** Adds a Date header to every sitemap response, which the builder does not set. */
function servedAt(facts: SiteFacts, date: string): SiteFacts {
  return { ...facts, sitemaps: facts.sitemaps.map(item => ({ ...item, fetch: { ...item.fetch, headers: { ...item.fetch.headers, ...headers({ date }) } } })) };
}

describe('crawl-sitemap-validity', () => {
  const id = 'crawl-sitemap-validity';
  test('passes on a valid urlset and a valid text sitemap', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, xml: locs(['/', '/a']) }] }).finding, 'pass');
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: `${origin}/urls.txt`, xml: `${origin}/\n${origin}/a\n` }] }).finding, 'pass');
  });
  test('fails high on XML that does not parse', () => {
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: map, xml: `<urlset xmlns="${namespace}"><url><loc>${origin}/</loc></url>` }] });
    assertFail(finding, 'high', 'unparseable');
    assert.ok(excerpts()[0]!.length > 0);
  });
  test('fails high on the wrong namespace', () => {
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: map, xml: urlset([entry(`${origin}/`)], 'http://www.google.com/schemas/sitemap/0.84') }] });
    assertFail(finding, 'high', 'wrong-namespace');
    assert.deepEqual(excerpts(), ['http://www.google.com/schemas/sitemap/0.84']);
  });
  test('fails high over the entry limit and counts every entry', () => {
    const xml = urlset(Array.from({ length: 50_001 }, (_, index) => entry(`${origin}/p/${index}`)));
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: map, xml }] });
    assertFail(finding, 'high', 'over-limit');
    assert.match(excerpts()[0]!, /^50001 entries, /u);
    assert.match(String(finding.params?.detail), /^50001 entries, /u);
  });
  test('fails medium on relative locs, unreachable children and nested indexes', () => {
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: map, xml: urlset([entry('/relative')]) }] });
    assertFail(finding, 'medium', 'invalid-urls');
    assert.deepEqual(excerpts(), ['/relative']);
    assertFail(run(id, { pages: [home()], sitemaps: [{ url: `${origin}/a.xml`, status: 404, source: 'index' }] }).finding, 'medium', 'child-unreachable');
    const nested = `<?xml version="1.0"?><sitemapindex xmlns="${namespace}"><sitemap><loc>${origin}/b.xml</loc></sitemap></sitemapindex>`;
    assertFail(run(id, { pages: [home()], sitemaps: [{ url: `${origin}/a.xml`, xml: nested, source: 'index' }] }).finding, 'medium', 'nested-index');
  });
  test('fails medium, not as unparseable, on an entry without a loc', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${namespace}">\n${entry(`${origin}/`)}\n<url><loc></loc></url>\n${entry('/relative')}\n</urlset>`;
    const { finding, findings, evidence } = run(id, { pages: [home()], sitemaps: [{ url: map, xml }] });
    assert.equal(findings.length, 1);
    assertFail(finding, 'medium', 'invalid-urls');
    assert.equal(finding.params?.detail, '2 entries');
    assert.deepEqual(finding.evidence.map(ref => [evidence.get(ref)?.line, evidence.get(ref)?.excerpt]), [[4, undefined], [5, '/relative']]);
  });
  test('fails medium on a bad line in a text sitemap', () => {
    assertFail(run(id, { pages: [home()], sitemaps: [{ url: `${origin}/urls.txt`, xml: `${origin}/\nnot a url\n` }] }).finding, 'medium', 'invalid-urls');
  });
  test('does not apply when /sitemap.xml answers 404 or an HTML page and nothing else was found', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, status: 404, source: 'default' }] }).finding, 'not_applicable', 'no-sitemap-document');
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, xml: '<!doctype html><title>Home</title>', source: 'default' }] }).finding, 'not_applicable', 'no-sitemap-document');
  });
  test('is not evaluated without sitemaps', () => {
    assertOutcome(run(id, { pages: [home()] }).finding, 'not_evaluated', 'missing-input:sitemaps');
  });
});

describe('crawl-sitemap-scope', () => {
  const id = 'crawl-sitemap-scope';
  const blogMap = `${origin}/blog/sitemap.xml`;
  test('passes when every URL is under the sitemap location', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, xml: locs(['/', '/blog/a']) }] }).finding, 'pass');
  });
  test('fails medium on URLs outside the sitemap directory', () => {
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: blogMap, xml: locs(['/blog/a', '/about']) }] });
    assertFail(finding, 'medium', 'out-of-scope');
    assert.deepEqual(excerpts(), [`${origin}/about`]);
  });
  test('passes when robots.txt cross-submits the sitemap', () => {
    assertOutcome(run(id, { pages: [home()], robots: `Sitemap: ${blogMap}`, sitemaps: [{ url: blogMap, xml: locs(['/blog/a', '/about']) }] }).finding, 'pass');
  });
  test('fails medium on http URLs in an https site', () => {
    assertFail(run(id, { pages: [home()], sitemaps: [{ url: map, xml: urlset([entry('http://example.com/a')]) }] }).finding, 'medium', 'http-urls');
  });
  test('passes on children of a sitemap index that robots.txt declares', () => {
    const index = `${origin}/sitemap_index.xml`;
    const child = `${origin}/sitemaps/pages.xml`;
    const facts = { pages: [home()], robots: `Sitemap: ${index}`, sitemaps: [
      { url: index, xml: `<?xml version="1.0"?><sitemapindex xmlns="${namespace}"><sitemap><loc>${child}</loc></sitemap></sitemapindex>` },
      { url: child, xml: locs(['/', '/about']), source: 'index' as const },
    ] };
    assertOutcome(run(id, facts).finding, 'pass');
  });
  test('does not apply without a urlset', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, status: 404, source: 'default' }] }).finding, 'not_applicable', 'no-sitemap-document');
  });
});

describe('crawl-sitemap-url-quality', () => {
  const id = 'crawl-sitemap-url-quality';
  test('passes when listed pages are indexable and self-canonical', () => {
    const facts = { pages: [page(`${origin}/a`, { html: doc(`<link rel="canonical" href="${origin}/a">`) })], robots: 'User-agent: *\nDisallow: /private/', sitemaps: [{ url: map, xml: locs(['/a', '/b']) }] };
    assertOutcome(run(id, facts).finding, 'pass');
  });
  test('fails medium on a robots-blocked URL', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /private/', sitemaps: [{ url: map, xml: locs(['/private/x']) }] });
    assertFail(finding, 'medium', 'robots-blocked');
    assert.deepEqual(excerpts(), [`${origin}/private/x | disallow: /private/`]);
  });
  test('fails medium on a noindex URL and low on a redirect in a small sample', () => {
    assertFail(run(id, { pages: [page(`${origin}/a`, { html: doc('<meta name="robots" content="noindex">') })], sitemaps: [{ url: map, xml: locs(['/a']) }] }).finding, 'medium', 'noindex');
    assertFail(run(id, { pages: [page(`${origin}/old`, { redirects: [[301, '/new']], html: doc() })], sitemaps: [{ url: map, xml: locs(['/old']) }] }).finding, 'low', 'redirect');
  });
  test('fails high when more than 10% of at least 10 classified URLs are problematic', () => {
    const paths = Array.from({ length: 12 }, (_, index) => `/p/${index}`);
    const { finding } = run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /p/1', sitemaps: [{ url: map, xml: locs(paths) }] });
    assertFail(finding, 'high', 'high-share');
  });
  test('does not apply without listed URLs', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, status: 404 }] }).finding, 'not_applicable', 'no-sitemap-urls');
  });
});

describe('crawl-sitemap-lastmod', () => {
  const id = 'crawl-sitemap-lastmod';
  const dated = (values: readonly string[]) => urlset(values.map((value, index) => entry(`${origin}/p/${index}`, `<lastmod>${value}</lastmod>`)));
  test('passes on varied valid dates, and on a small site sharing one date', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, xml: dated(['2026-01-02', '2026-03-04T10:00:00+01:00', '2025-12-31']) }] }).finding, 'pass');
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, xml: dated(Array(5).fill('2026-10-01')) }] }).finding, 'pass');
  });
  test('fails medium on an invalid format', () => {
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: map, xml: dated(['2026/11/01']) }] });
    assertFail(finding, 'medium', 'invalid-format');
    assert.deepEqual(excerpts(), ['2026/11/01']);
  });
  test('fails medium when every lastmod is the generation time', () => {
    const facts = servedAt(site({ pages: [home()], sitemaps: [{ url: map, xml: dated(Array(25).fill('2026-11-04T10:00:00+00:00')) }] }), 'Wed, 04 Nov 2026 10:02:00 GMT');
    const { finding, excerpts } = run(id, facts);
    assertFail(finding, 'medium', 'generation-time');
    assert.deepEqual(excerpts(), ['2026-11-04T10:00:00+00:00 (25 of 25)', 'Wed, 04 Nov 2026 10:02:00 GMT']);
  });
  test('hands a uniform older date to the analyst and reports future dates as low', () => {
    assertFail(run(id, { pages: [home()], sitemaps: [{ url: map, xml: dated(Array(25).fill('2025-01-01')) }] }).finding, 'medium', 'uniform', true);
    const future = servedAt(site({ pages: [home()], sitemaps: [{ url: map, xml: dated(['2026-10-01', '2027-03-01']) }] }), 'Wed, 04 Nov 2026 10:00:00 GMT');
    assertFail(run(id, future).finding, 'low', 'future-dates');
  });
  test('reports low when no URL has lastmod, and does not apply without listed URLs', () => {
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: map, xml: locs(['/a', '/b']) }] });
    assertFail(finding, 'low', 'missing');
    assert.deepEqual(excerpts(), ['2 URLs, none with lastmod']);
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, status: 404 }] }).finding, 'not_applicable', 'no-sitemap-urls');
  });
});

describe('crawl-sitemap-ignored-tags', () => {
  const id = 'crawl-sitemap-ignored-tags';
  test('passes without changefreq or priority', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, xml: locs(['/a']) }] }).finding, 'pass');
  });
  test('reports them as info', () => {
    const { finding, excerpts } = run(id, { pages: [home()], sitemaps: [{ url: map, xml: urlset([entry(`${origin}/a`, '<changefreq>daily</changefreq><priority>0.8</priority>')]) }] });
    assertFail(finding, 'info');
    assert.deepEqual(excerpts(), [`${origin}/a | changefreq daily, priority 0.8`]);
  });
  test('does not apply without a urlset', () => {
    assertOutcome(run(id, { pages: [home()], sitemaps: [{ url: map, status: 404, source: 'default' }] }).finding, 'not_applicable', 'no-sitemap-document');
  });
});
