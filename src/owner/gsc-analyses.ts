import { iso639_1 } from '../rules/intl/codes.ts';
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

// Legal forms written after a company name, which searches for the brand leave out.
const legalForm = /[\s,]+(?:s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?\s?u?\.?|s\.?\s?a\.?\s?s\.?|inc\.?|llc|ltd\.?|limited|gmbh|ag|b\.?v\.?|n\.?v\.?|plc|sarl|srl|oy|ab|as|corp\.?|co\.?)$/iu;

/** Lowercase and without accents, as names and queries are compared. */
const fold = (text: string) => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** A name as its words in order, with or without separators between them; undefined when no word is distinctive. */
function namePattern(name: string): string | undefined {
  const words = fold(name.trim().replace(legalForm, '')).split(/[^a-z0-9]+/u).filter(word => word !== '');
  if (!words.some(word => word.length >= 4 && !genericBusinessWords.has(word))) return undefined;
  return words.join('[^a-z0-9]*');
}

/**
 * A pattern for queries that name the brand: queries that hold one of the given names (the site's names, the first
 * label of the host) as whole words, with or without the spaces between them, and without a legal form such as
 * "S.L.". A name made only of generic or short words, such as "Digital Agency", names no brand, and a descriptive
 * word of a name alone, such as "cooking" in "Barcelona Cooking School", does not make a brand query.
 */
export function brandPattern(names: readonly string[]): RegExp | undefined {
  const patterns = [...new Set(names.map(namePattern).filter((pattern): pattern is string => pattern !== undefined))];
  if (patterns.length === 0) return undefined;
  return new RegExp(`\\b(?:${patterns.join('|')})\\b`, 'iu');
}

function isBrand(query: string, brand: RegExp | undefined): boolean {
  return brand !== undefined && brand.test(fold(query));
}

// A language with an optional script and region, as URLs write a locale: en, pt-br, zh_Hant, es-419.
const urlLocale = /^([a-z]{2})(?:[-_][a-z]{4})?(?:[-_](?:[a-z]{2}|\d{3}))?$/iu;
const localeParameter = /^(?:lang|language|hl|locale|lng|lc)$/iu;

function localeTag(value: string | undefined): string | undefined {
  const match = value === undefined ? null : urlLocale.exec(value);
  return match && iso639_1.has(match[1]!.toLowerCase()) ? match[0].toLowerCase().replace(/_/gu, '-') : undefined;
}

/**
 * The locale a page URL is written for: its first path segment, its subdomain or a language parameter, when that is
 * a language code such as en or pt-br; empty when the URL names none, as is often the case for the default language.
 */
function localeOf(page: string): string {
  let url: URL;
  try {
    url = new URL(page, 'https://unknown.invalid/');
  } catch {
    return '';
  }
  const labels = url.hostname.split('.');
  return localeTag(url.pathname.split('/').find(part => part !== '')) ?? (labels.length > 2 ? localeTag(labels[0]) : undefined)
    ?? localeTag([...url.searchParams].find(([name]) => localeParameter.test(name))?.[1]) ?? '';
}

/**
 * Non-brand queries whose impressions several pages split without one taking most clicks. Pages written for different
 * languages or regions are not compared: they are versions of one page for different searchers, not competitors.
 */
export function cannibalization(data: GscData, brand: RegExp | undefined, minImpressions = 50): Cannibalization[] {
  const byQuery = new Map<string, SearchRow[]>();
  for (const row of data.byPageQuery) {
    const key = JSON.stringify([row.keys[1]!, localeOf(row.keys[0]!)]);
    const rows = byQuery.get(key);
    if (rows) rows.push(row);
    else byQuery.set(key, [row]);
  }
  const results: Cannibalization[] = [];
  for (const rows of byQuery.values()) {
    const query = rows[0]!.keys[1]!;
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
