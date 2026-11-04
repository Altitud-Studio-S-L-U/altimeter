import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rules } from '../../src/catalog/index.ts';
import { EvidenceStore } from '../../src/core/evidence.ts';
import { findingMessage, messagesFor } from '../../src/i18n/messages.ts';
import type { BingData } from '../../src/owner/bing.ts';
import type { GscData, SearchRow, UrlInspection } from '../../src/owner/gsc.ts';
import { runRules, type Finding, type RuleImplementation } from '../../src/rules/engine.ts';
import { implementations, searchQueriesPath } from '../../src/rules/owner/search-console.ts';
import { activity } from '../support/bots.ts';
import { evaluate, page, site, type SiteSpec } from '../support/facts.ts';

const origin = 'https://example.com';
const url = `${origin}/en/services/`;
const html = (head = '') => `<!doctype html><html lang="en"><head><title>Services | Example</title>${head}</head><body><main><h1>Services</h1></main></body></html>`;
const rule = (id: string): RuleImplementation => implementations.find(entry => entry.id === id)!;
const row = (keys: string[], clicks: number, impressions: number, position: number): SearchRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

const inspected = (overrides: Partial<UrlInspection> = {}): UrlInspection => ({
  url, verdict: 'PASS', coverageState: 'Submitted and indexed', googleCanonical: url, userCanonical: url, lastCrawlTime: '2026-10-20T08:00:00Z',
  crawledAs: 'MOBILE', sitemaps: [], referringUrls: [], richResults: [], ...overrides,
});

const gsc = (overrides: Partial<GscData> = {}): GscData => ({
  property: { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, fetchedAt: '2026-11-04T09:00:00.000Z',
  period: { start: '2026-10-05', end: '2026-11-01' }, previousPeriod: { start: '2026-09-07', end: '2026-10-04' },
  byPage: [], byQuery: [], byPageQuery: [], byCountry: [], byDevice: [], previousByPage: [], inspections: [], sitemaps: [], truncated: false, ...overrides,
});

function check(id: string, data: GscData, extra: Partial<SiteSpec> = {}, head = '') {
  const result = evaluate(rule(id), site({ pages: [page(url, { html: html(head) })], owner: { gsc: data }, ...extra }));
  const excerpts = (finding: Finding | undefined) => (finding?.evidence ?? []).map(entry => result.evidence.get(entry)?.excerpt);
  return { findings: result.findings, first: result.findings[0], excerpts, evidence: result.evidence };
}

describe('crawl-gsc-index-status', () => {
  test('passes an indexed page and the expected alternate state', () => {
    assert.equal(check('crawl-gsc-index-status', gsc({ inspections: [inspected()] })).first?.outcome, 'pass');
    const alternate = inspected({ verdict: 'NEUTRAL', coverageState: 'Alternate page with proper canonical tag' });
    assert.equal(check('crawl-gsc-index-status', gsc({ inspections: [alternate] })).first?.outcome, 'pass');
  });

  test('grades the reasons Google gives for not indexing an indexable page', () => {
    const crawled = check('crawl-gsc-index-status', gsc({ inspections: [inspected({ verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' })] })).first;
    assert.deepEqual([crawled?.severity, crawled?.reason, crawled?.params?.lastCrawl, crawled?.origin], ['medium', 'crawled-not-indexed', '2026-10-20', 'owner-data']);
    const soft = check('crawl-gsc-index-status', gsc({ inspections: [inspected({ verdict: 'FAIL', coverageState: 'Soft 404' })] })).first;
    assert.deepEqual([soft?.severity, soft?.reason], ['high', 'soft-404']);
    const other = check('crawl-gsc-index-status', gsc({ inspections: [inspected({ verdict: 'FAIL', coverageState: 'Some new state' })] })).first;
    assert.deepEqual([other?.severity, other?.reason, other?.params?.state], ['medium', undefined, 'Some new state']);
  });

  test('does not apply to a page kept out of the index on purpose, or to a page that was not inspected', () => {
    const noindex = check('crawl-gsc-index-status', gsc({ inspections: [inspected({ verdict: 'NEUTRAL', coverageState: "Excluded by 'noindex' tag" })] }), {}, '<meta name="robots" content="noindex">');
    assert.equal(noindex.first?.reason, 'kept-out-of-index');
    assert.equal(check('crawl-gsc-index-status', gsc()).first?.reason, 'not-inspected');
  });
});

describe('crawl-gsc-google-canonical', () => {
  test('passes when Google keeps the declared canonical', () => {
    assert.equal(check('crawl-gsc-google-canonical', gsc({ inspections: [inspected()] })).first?.outcome, 'pass');
  });

  test('reports a different choice as medium, and a choice without a declared canonical as low', () => {
    const differs = check('crawl-gsc-google-canonical', gsc({ inspections: [inspected({ googleCanonical: `${origin}/en/services` })] })).first;
    assert.deepEqual([differs?.severity, differs?.reason, differs?.params?.chosen], ['medium', 'differs', `${origin}/en/services`]);
    const { userCanonical: _declared, ...withoutDeclared } = inspected({ googleCanonical: `${origin}/services/` });
    const undeclared = check('crawl-gsc-google-canonical', gsc({ inspections: [withoutDeclared] })).first;
    assert.deepEqual([undeclared?.severity, undeclared?.reason], ['low', 'chosen-without-declared']);
  });
});

describe('crawl-gsc-crawl-recency', () => {
  test('passes a recent smartphone crawl, reports an old one as low and a desktop crawl as info', () => {
    assert.equal(check('crawl-gsc-crawl-recency', gsc({ inspections: [inspected()] })).first?.outcome, 'pass');
    const stale = check('crawl-gsc-crawl-recency', gsc({ inspections: [inspected({ lastCrawlTime: '2026-06-01T00:00:00Z' })] })).first;
    assert.deepEqual([stale?.severity, stale?.reason, stale?.params?.days], ['low', 'stale-crawl', 156]);
    assert.equal(check('crawl-gsc-crawl-recency', gsc({ inspections: [inspected({ crawledAs: 'DESKTOP' })] })).first?.severity, 'info');
  });
});

describe('crawl-gsc-sitemaps', () => {
  const map = `${origin}/sitemap-index.xml`;
  const declared = { sitemaps: [{ url: map, xml: `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>` }] };
  test('passes a submitted sitemap without problems', () => {
    assert.equal(check('crawl-gsc-sitemaps', gsc({ sitemaps: [{ path: map, warnings: 0, errors: 0 }] }), declared).first?.outcome, 'pass');
  });

  test('reports errors, warnings and a declared sitemap that is not submitted', () => {
    const errors = check('crawl-gsc-sitemaps', gsc({ sitemaps: [{ path: map, warnings: 1, errors: 2 }] }), declared).first;
    assert.deepEqual([errors?.severity, errors?.reason, errors?.params?.count], ['medium', 'errors', 2]);
    assert.equal(check('crawl-gsc-sitemaps', gsc({ sitemaps: [{ path: map, warnings: 3, errors: 0 }] }), declared).first?.reason, 'warnings');
    const missing = check('crawl-gsc-sitemaps', gsc(), declared).first;
    assert.deepEqual([missing?.severity, missing?.reason, missing?.params?.sitemap], ['info', 'not-submitted', map]);
  });
});

describe('crawl-gsc-sitemap-urls-without-impressions', () => {
  const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/en/', '/en/services/', '/en/about/'].map(path => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;
  const sitemaps = { sitemaps: [{ url: `${origin}/sitemap.xml`, xml }] };
  test('reports the sitemap URLs that earned no impressions', () => {
    const { first, excerpts } = check('crawl-gsc-sitemap-urls-without-impressions', gsc({ byPage: [row([`${origin}/en/`], 5, 100, 3), row([`${origin}/en/services/`], 0, 20, 30)] }), sitemaps);
    assert.deepEqual([first?.severity, first?.params?.count, first?.params?.total], ['info', 1, 3]);
    assert.deepEqual(excerpts(first), [`${origin}/en/about/`]);
  });

  test('leaves out URLs the property does not cover and is not evaluated on truncated data', () => {
    const prefix = gsc({ property: { siteUrl: `${origin}/es/`, permissionLevel: 'siteOwner' } });
    assert.equal(check('crawl-gsc-sitemap-urls-without-impressions', prefix, sitemaps).first?.reason, 'no-sitemap-urls');
    assert.equal(check('crawl-gsc-sitemap-urls-without-impressions', gsc({ truncated: true }), sitemaps).first?.reason, 'performance-data-truncated');
  });
});

describe('Search Console performance rules', () => {
  const performance = gsc({
    byPage: [row([`${origin}/a`], 60, 1000, 2.1), row([`${origin}/b`], 4, 900, 2.0)],
    previousByPage: [row([`${origin}/a`], 20, 800, 3), row([`${origin}/b`], 60, 850, 2.2)],
    byPageQuery: [
      row([`${origin}/a`, 'custom software andorra'], 50, 700, 2.2), row([`${origin}/b`, 'custom software andorra'], 4, 600, 2.4),
      row([`${origin}/a`, 'software development studio'], 20, 400, 4), row([`${origin}/b`, 'software development studio'], 15, 350, 5),
      row([`${origin}/c`, 'erp integration'], 1, 120, 14),
    ],
  });

  test('content-gsc-low-ctr names the page and keeps its queries in a redactable excerpt', () => {
    const { first, evidence } = check('content-gsc-low-ctr', performance);
    assert.deepEqual([first?.severity, first?.params?.page, first?.params?.ctr], ['low', `${origin}/b`, '0.4%']);
    const queries = first!.evidence.map(id => evidence.get(id)!).find(item => item.path === searchQueriesPath);
    assert.match(queries?.excerpt ?? '', /^custom software andorra \(600 impressions, position 2\.4\)/u);
  });

  test('content-gsc-cannibalization, striking distance and traffic drop', () => {
    const shared = check('content-gsc-cannibalization', performance).first;
    assert.deepEqual([shared?.severity, shared?.params?.query, shared?.params?.count], ['info', 'software development studio', 2]);
    const near = check('content-gsc-striking-distance', performance).first;
    assert.deepEqual([near?.severity, near?.params?.query, near?.params?.position], ['info', 'erp integration', '14.0']);
    const drop = check('content-gsc-traffic-drop', performance).first;
    assert.deepEqual([drop?.severity, drop?.params?.page, drop?.params?.before, drop?.params?.now], ['low', `${origin}/b`, 60, 4]);
  });

  test('write numbered labels instead of queries when the owner asks for a shareable report', () => {
    const facts = (id: string) => evaluate(rule(id), site({ pages: [page(url, { html: html() })], owner: { gsc: performance, redactQueries: true } }));
    const shared = facts('content-gsc-cannibalization');
    assert.equal(shared.findings[0]?.params?.query, 'query 1');
    const lowCtr = facts('content-gsc-low-ctr');
    const excerpts = lowCtr.findings.flatMap(finding => finding.evidence.map(id => lowCtr.evidence.get(id)?.excerpt ?? '')).join('\n');
    assert.doesNotMatch(excerpts, /custom software|software development/u);
    assert.match(excerpts, /^query 1 \(600 impressions/mu);
  });

  test('do not apply to a property without search data', () => {
    for (const id of ['content-gsc-low-ctr', 'content-gsc-cannibalization', 'content-gsc-striking-distance', 'content-gsc-traffic-drop']) {
      assert.equal(check(id, gsc()).first?.reason, 'no-search-data', id);
    }
  });
});

describe('schema-url-inspection-rich-results', () => {
  test('reports errors as high and warnings as low, and does not apply without detected items', () => {
    const errors = inspected({ richResults: [{ type: 'Breadcrumbs', issues: [{ severity: 'ERROR', message: 'Missing field "item"' }] }] });
    assert.deepEqual([check('schema-url-inspection-rich-results', gsc({ inspections: [errors] })).first?.severity], ['high']);
    const warnings = inspected({ richResults: [{ type: 'Product snippets', issues: [{ severity: 'WARNING', message: 'Missing field "review"' }] }] });
    assert.deepEqual([check('schema-url-inspection-rich-results', gsc({ inspections: [warnings] })).first?.reason], ['warnings']);
    assert.equal(check('schema-url-inspection-rich-results', gsc({ inspections: [inspected()] })).first?.reason, 'no-rich-results-detected');
  });
});

/** Every failure must render a complete English message: a reason without a template, or a missing value, fails. */
function message(finding: Finding | undefined): string {
  assert.ok(finding?.outcome === 'fail', 'a failing finding');
  if (finding.reason) assert.ok(messagesFor('en')[finding.ruleId]?.messages[`fail:${finding.reason}`], `${finding.ruleId} has a message for ${finding.reason}`);
  const text = findingMessage('en', finding.ruleId, 'fail', finding.reason, finding.params);
  assert.ok(text, `${finding.ruleId} has a message`);
  assert.doesNotMatch(text, /\{[a-zA-Z]+\}/u, `${finding.ruleId}:${finding.reason ?? ''} leaves a placeholder: ${text}`);
  return text;
}

describe('Search Console context rules', () => {
  // Context only: they have no passing state, and without Search Console data the engine does not run them.
  test('ai-google-genai-control-context says the control is in the property settings, which nothing outside shows', () => {
    const { first, excerpts } = check('ai-google-genai-control-context', gsc());
    assert.deepEqual([first?.outcome, first?.severity, first?.params?.property], ['fail', 'info', 'sc-domain:example.com']);
    assert.deepEqual(excerpts(first), ['sc-domain:example.com']);
    assert.match(message(first), /cannot tell its state for sc-domain:example\.com; check it in the property's settings/u);
  });

  test('ai-measurement-context names the owner sources read and what the others would add', () => {
    const bing: BingData = { fetchedAt: '2026-11-04T09:00:00.000Z', site: `${origin}/`, crawlIssues: [], pageStats: [], pageQueries: [], urlInfo: [], unavailable: [] };
    const cases: ReadonlyArray<readonly [Partial<SiteSpec>, string, RegExp]> = [
      [{}, 'without-both', /--bing\) and access logs or Cloudflare analytics \(--bots-from\)/u],
      [{ owner: { gsc: gsc(), bing } }, 'without-bots', /\(--bots-from\) would show which AI crawlers/u],
      [{ owner: { gsc: gsc(), bots: activity() } }, 'without-bing', /\(--bing\) would add Bing's search data/u],
      [{ owner: { gsc: gsc(), bing, bots: activity() } }, 'all-sources', /arrive as Google search and cannot be told apart/u],
    ];
    for (const [extra, reason, text] of cases) {
      const { first, excerpts } = check('ai-measurement-context', gsc(), extra);
      assert.deepEqual([first?.outcome, first?.severity, first?.reason], ['fail', 'info', reason]);
      assert.match(message(first), /AI Overviews and AI Mode in the web search type, so the Search Console analyses for sc-domain:example\.com include them/u);
      assert.match(message(first), text, reason);
      assert.match(excerpts(first)[0] ?? '', /^Search Console sc-domain:example\.com: /u);
    }
  });
});

describe('owner-data rules in the engine', () => {
  test('run only when the owner provided Search Console data, and stay out of the score', () => {
    const facts = site({ pages: [page(url, { html: html() })] });
    const without = runRules({ rules, implementations: new Map(implementations.map(entry => [entry.id, entry])), site: facts, evidence: new EvidenceStore() });
    assert.deepEqual(without, []);
    const withData = runRules({ rules, implementations: new Map(implementations.map(entry => [entry.id, entry])), site: { ...facts, owner: { gsc: gsc({ inspections: [inspected()] }) } }, evidence: new EvidenceStore() });
    assert.ok(withData.length > 0 && withData.every(finding => finding.origin === 'owner-data'));
    assert.ok(rules.filter(entry => entry.status === 'requires-owner-data').every(entry => !entry.scored));
  });
});
