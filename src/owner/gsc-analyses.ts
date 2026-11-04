import type { GscData, SearchRow, UrlInspection } from './gsc.ts';

export interface LowCtrPage {
  readonly page: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
  readonly expectedCtr: number;
  readonly position: number;
  /** The queries that bring the most impressions to the page, for title and description rewrites. */
  readonly topQueries: readonly { readonly query: string; readonly impressions: number; readonly position: number }[];
}

export interface Cannibalization {
  readonly query: string;
  readonly impressions: number;
  readonly pages: readonly { readonly page: string; readonly impressionShare: number; readonly clickShare: number; readonly position: number }[];
}

export interface BrandSplit {
  readonly brand: { readonly clicks: number; readonly impressions: number };
  readonly nonBrand: { readonly clicks: number; readonly impressions: number };
  /** Clicks and impressions from anonymised queries, which Search Console never lists. */
  readonly anonymised: { readonly clicks: number; readonly impressions: number };
}

export interface StrikingDistance {
  readonly query: string;
  readonly page: string;
  readonly impressions: number;
  readonly position: number;
}

export interface PageTrend {
  readonly page: string;
  readonly clicksBefore: number;
  readonly clicksNow: number;
  /** (now - before) / sqrt(now + before): how unusual the change is if clicks were Poisson counts. */
  readonly z: number;
}

export interface InspectionInsight {
  readonly url: string;
  readonly kind: 'google-canonical-differs' | 'not-indexed' | 'stale-crawl' | 'crawled-as-desktop' | 'rich-result-errors' | 'fetch-problem';
  readonly detail: string;
}

const buckets: ReadonlyArray<readonly [number, number]> = [[0, 1.5], [1.5, 2.5], [2.5, 3.5], [3.5, 5.5], [5.5, 10.5]];

function bucketOf(position: number): number {
  const index = buckets.findIndex(([low, high]) => position >= low && position < high);
  return index === -1 ? buckets.length : index;
}

/**
 * The site's own CTR by position band, weighted by impressions. Only bands with at least 200 impressions are used:
 * industry CTR curves do not describe a given site's snippets, brand or result types.
 */
export function expectedCtrCurve(rows: readonly SearchRow[]): ReadonlyMap<number, number> {
  const totals = new Map<number, { clicks: number; impressions: number }>();
  for (const row of rows) {
    const bucket = bucketOf(row.position);
    const total = totals.get(bucket) ?? { clicks: 0, impressions: 0 };
    totals.set(bucket, { clicks: total.clicks + row.clicks, impressions: total.impressions + row.impressions });
  }
  const curve = new Map<number, number>();
  for (const [bucket, total] of totals) if (bucket < buckets.length && total.impressions >= 200) curve.set(bucket, total.clicks / total.impressions);
  return curve;
}

export function lowCtrPages(data: GscData, minImpressions = 100, ratio = 0.5): LowCtrPage[] {
  const curve = expectedCtrCurve(data.byPageQuery);
  const results: LowCtrPage[] = [];
  for (const row of data.byPage) {
    const expected = curve.get(bucketOf(row.position));
    if (expected === undefined || row.impressions < minImpressions || row.ctr >= expected * ratio) continue;
    const page = row.keys[0]!;
    const topQueries = data.byPageQuery.filter(entry => entry.keys[0] === page).sort((a, b) => b.impressions - a.impressions).slice(0, 5)
      .map(entry => ({ query: entry.keys[1]!, impressions: entry.impressions, position: entry.position }));
    results.push({ page, impressions: row.impressions, clicks: row.clicks, ctr: row.ctr, expectedCtr: expected, position: row.position, topQueries });
  }
  return results.sort((a, b) => b.impressions - a.impressions);
}

// Words that name a kind of business rather than a brand, in the languages the reports support and their neighbours.
const genericBusinessWords = new Set([
  'studio', 'studios', 'estudio', 'estudi', 'software', 'digital', 'group', 'grupo', 'grup', 'company', 'compania', 'companyia',
  'agency', 'agencia', 'solutions', 'soluciones', 'solucions', 'services', 'servicios', 'serveis', 'consulting', 'consultoria',
  'labs', 'design', 'diseno', 'disseny', 'media', 'online', 'shop', 'tienda', 'botiga', 'store', 'global', 'international',
  'systems', 'sistemas', 'sistemes', 'technologies', 'technology', 'tecnologia', 'tech', 'partners', 'holding', 'limited',
]);

/**
 * A pattern for queries that name the brand, built from the site's names (Organization name, site name, the first
 * label of the host). Generic words such as "studio" are left out, so "software studio" is not a brand query.
 */
export function brandPattern(names: readonly string[]): RegExp | undefined {
  const terms = [...new Set(names.flatMap(name => name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036F]/gu, '').split(/[^a-z0-9]+/u))
    .filter(term => term.length >= 4 && !genericBusinessWords.has(term)))];
  if (terms.length === 0) return undefined;
  return new RegExp(`\\b(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'iu');
}

function isBrand(query: string, brand: RegExp | undefined): boolean {
  return brand !== undefined && brand.test(query.normalize('NFKD').replace(/[\u0300-\u036F]/gu, ''));
}

export function cannibalization(data: GscData, brand: RegExp | undefined, minImpressions = 50): Cannibalization[] {
  const byQuery = new Map<string, SearchRow[]>();
  for (const row of data.byPageQuery) byQuery.set(row.keys[1]!, [...(byQuery.get(row.keys[1]!) ?? []), row]);
  const results: Cannibalization[] = [];
  for (const [query, rows] of byQuery) {
    if (isBrand(query, brand)) continue;
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    if (impressions < minImpressions) continue;
    const pages = rows.map(row => ({ page: row.keys[0]!, impressionShare: row.impressions / impressions, clickShare: clicks === 0 ? 0 : row.clicks / clicks, position: row.position }))
      .filter(page => page.impressionShare >= 0.1 && page.position <= 20);
    if (pages.length >= 2 && !pages.some(page => page.clickShare >= 0.8)) results.push({ query, impressions, pages: pages.sort((a, b) => b.impressionShare - a.impressionShare) });
  }
  return results.sort((a, b) => b.impressions - a.impressions);
}

export function brandSplit(data: GscData, brand: RegExp | undefined): BrandSplit {
  const total = data.byDevice.reduce((sum, row) => ({ clicks: sum.clicks + row.clicks, impressions: sum.impressions + row.impressions }), { clicks: 0, impressions: 0 });
  const brandTotals = { clicks: 0, impressions: 0 };
  const nonBrandTotals = { clicks: 0, impressions: 0 };
  for (const row of data.byQuery) {
    const target = isBrand(row.keys[0]!, brand) ? brandTotals : nonBrandTotals;
    target.clicks += row.clicks;
    target.impressions += row.impressions;
  }
  return {
    brand: brandTotals,
    nonBrand: nonBrandTotals,
    anonymised: { clicks: Math.max(0, total.clicks - brandTotals.clicks - nonBrandTotals.clicks), impressions: Math.max(0, total.impressions - brandTotals.impressions - nonBrandTotals.impressions) },
  };
}

export function strikingDistance(data: GscData, minImpressions = 50): StrikingDistance[] {
  return data.byPageQuery.filter(row => row.position >= 10.5 && row.position < 20.5 && row.impressions >= minImpressions)
    .map(row => ({ query: row.keys[1]!, page: row.keys[0]!, impressions: row.impressions, position: row.position }))
    .sort((a, b) => b.impressions - a.impressions);
}

/** Pages whose clicks changed by at least `minChange` with a Poisson z-score of at least `minZ`, largest change in clicks first. */
export function pageTrends(data: GscData, minChange = 20, minZ = 2.5): PageTrend[] {
  const before = new Map(data.previousByPage.map(row => [row.keys[0]!, row.clicks]));
  const pages = new Set([...before.keys(), ...data.byPage.map(row => row.keys[0]!)]);
  const now = new Map(data.byPage.map(row => [row.keys[0]!, row.clicks]));
  const trends: PageTrend[] = [];
  for (const page of pages) {
    const a = before.get(page) ?? 0;
    const b = now.get(page) ?? 0;
    if (Math.abs(b - a) < minChange || a + b === 0) continue;
    const z = (b - a) / Math.sqrt(a + b);
    if (Math.abs(z) >= minZ) trends.push({ page, clicksBefore: a, clicksNow: b, z: Math.round(z * 100) / 100 });
  }
  const change = (trend: PageTrend) => Math.abs(trend.clicksNow - trend.clicksBefore);
  return trends.sort((x, y) => change(y) - change(x) || Math.abs(y.z) - Math.abs(x.z) || x.page.localeCompare(y.page));
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.href;
}

/** What URL Inspection says that the audit could not see from outside. */
export function inspectionInsights(inspections: readonly UrlInspection[], now: Date, staleDays = 30): InspectionInsight[] {
  const insights: InspectionInsight[] = [];
  for (const entry of inspections) {
    if (entry.error) continue;
    if (entry.googleCanonical && entry.userCanonical && normalizeUrl(entry.googleCanonical) !== normalizeUrl(entry.userCanonical)) {
      insights.push({ url: entry.url, kind: 'google-canonical-differs', detail: `${entry.userCanonical} -> ${entry.googleCanonical}` });
    }
    if (entry.verdict && entry.verdict !== 'PASS') insights.push({ url: entry.url, kind: 'not-indexed', detail: entry.coverageState ?? entry.verdict });
    if (entry.pageFetchState && entry.pageFetchState !== 'SUCCESSFUL') insights.push({ url: entry.url, kind: 'fetch-problem', detail: entry.pageFetchState });
    if (entry.lastCrawlTime) {
      const age = (now.getTime() - Date.parse(entry.lastCrawlTime)) / 86_400_000;
      if (age > staleDays) insights.push({ url: entry.url, kind: 'stale-crawl', detail: `${Math.floor(age)} days` });
    }
    if (entry.crawledAs === 'DESKTOP') insights.push({ url: entry.url, kind: 'crawled-as-desktop', detail: 'DESKTOP' });
    const errors = entry.richResults.flatMap(result => result.issues.filter(issue => issue.severity === 'ERROR').map(issue => `${result.type}: ${issue.message}`));
    if (errors.length > 0) insights.push({ url: entry.url, kind: 'rich-result-errors', detail: errors.join('; ') });
  }
  return insights;
}
