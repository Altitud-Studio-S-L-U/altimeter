import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GscData, SearchRow } from '../src/owner/gsc.ts';
import { brandPattern, brandSplit, cannibalization, expectedCtrCurve, inspectionInsights, lowCtrPages, pageTrends, strikingDistance } from '../src/owner/gsc-analyses.ts';

const row = (keys: string[], clicks: number, impressions: number, position: number): SearchRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

const data: GscData = {
  property: { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  period: { start: '2026-10-05', end: '2026-11-01' },
  previousPeriod: { start: '2026-09-07', end: '2026-10-04' },
  byPage: [row(['/a'], 60, 1000, 2.1), row(['/b'], 4, 900, 2.0), row(['/c'], 10, 200, 14)],
  previousByPage: [row(['/a'], 20, 800, 3), row(['/b'], 5, 850, 2.2), row(['/c'], 9, 190, 15)],
  byQuery: [row(['example studio'], 30, 300, 1.2), row(['custom software andorra'], 40, 1500, 2.4), row(['software consultancy'], 4, 300, 14)],
  byPageQuery: [
    row(['/a', 'custom software andorra'], 50, 700, 2.2), row(['/b', 'custom software andorra'], 4, 600, 2.4),
    row(['/a', 'example studio'], 10, 300, 1.2), row(['/c', 'software consultancy'], 4, 300, 14),
    row(['/a', 'software development studio'], 20, 400, 4), row(['/b', 'software development studio'], 15, 350, 5),
  ],
  byCountry: [], byDevice: [row(['MOBILE'], 60, 1500, 3), row(['DESKTOP'], 30, 900, 3)],
  inspections: [], sitemaps: [], truncated: false,
};

test('builds the expected CTR curve from the site\'s own data', () => {
  const curve = expectedCtrCurve(data.byPageQuery);
  assert.equal(curve.get(1), 54 / 1300);
  assert.equal(curve.has(5), false, 'positions beyond 10 are not part of the curve');
});

test('flags pages far below the expected CTR, with their top queries', () => {
  const pages = lowCtrPages(data);
  assert.deepEqual(pages.map(page => page.page), ['/b']);
  assert.equal(pages[0]?.topQueries[0]?.query, 'custom software andorra');
});

test('detects cannibalization on non-brand queries only', () => {
  const brand = brandPattern(['Example Studio']);
  const results = cannibalization(data, brand);
  assert.deepEqual(results.map(entry => entry.query), ['software development studio'], 'a page holding 80% of clicks is not cannibalization');
  assert.deepEqual(results[0]?.pages.map(page => page.page), ['/a', '/b']);
});

test('splits brand, non-brand and anonymised traffic', () => {
  const split = brandSplit(data, brandPattern(['Example Studio SLU']));
  assert.deepEqual(split.brand, { clicks: 30, impressions: 300 });
  assert.deepEqual(split.nonBrand, { clicks: 44, impressions: 1800 });
  assert.deepEqual(split.anonymised, { clicks: 16, impressions: 300 });
});

test('lists striking-distance queries and unusual page trends', () => {
  assert.deepEqual(strikingDistance(data).map(entry => entry.query), ['software consultancy']);
  assert.deepEqual(pageTrends(data).map(trend => [trend.page, trend.z]), [['/a', 4.47]]);
});

test('turns URL Inspection results into insights', () => {
  const insights = inspectionInsights([
    { url: 'https://example.com/a', verdict: 'PASS', googleCanonical: 'https://example.com/b', userCanonical: 'https://example.com/a', lastCrawlTime: '2026-08-01T00:00:00Z', crawledAs: 'DESKTOP', sitemaps: [], referringUrls: [], richResults: [{ type: 'Breadcrumbs', issues: [{ severity: 'ERROR', message: 'Missing field "item"' }] }] },
    { url: 'https://example.com/c', verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', sitemaps: [], referringUrls: [], richResults: [] },
  ], new Date('2026-11-04T00:00:00Z'));
  assert.deepEqual(insights.map(insight => insight.kind), ['google-canonical-differs', 'stale-crawl', 'crawled-as-desktop', 'rich-result-errors', 'not-indexed']);
});
