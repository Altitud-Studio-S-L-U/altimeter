import type { BingTrafficRow } from './bing.ts';

/**
 * Bing's crawl issue flags as the API reference documents them (UrlWithCrawlIssues.CrawlIssues, a bitwise
 * combination). JSON answers carry the number, XML answers the names.
 */
export const crawlIssueTypes = [
  { flag: 1, name: 'Code301' },
  { flag: 2, name: 'Code302' },
  { flag: 4, name: 'Code4xx' },
  { flag: 8, name: 'Code5xx' },
  { flag: 16, name: 'BlockedByRobotsTxt' },
  { flag: 32, name: 'ContainsMalware' },
  { flag: 64, name: 'ImportantUrlBlockedByRobotsTxt' },
  { flag: 128, name: 'DnsErrors' },
  { flag: 256, name: 'TimeOutErrors' },
] as const;

export type CrawlIssueName = (typeof crawlIssueTypes)[number]['name'];

/** The documented issue types set in `flags`; bits Bing does not document are ignored. */
export function issueNames(flags: number): CrawlIssueName[] {
  return crawlIssueTypes.filter(type => (flags & type.flag) !== 0).map(type => type.name);
}

/** Flags from Bing's text form, such as "ContainsMalware" or "Code301, Code4xx", or from a number written as text. */
export function flagsFromText(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed);
  let flags = 0;
  for (const part of trimmed.split(/[\s,|]+/u)) flags |= crawlIssueTypes.find(type => type.name.toLowerCase() === part.toLowerCase())?.flag ?? 0;
  return flags;
}

function parsed(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Whether `url` is on the site's host and under its path, whatever the scheme. */
export function onBingSite(site: string, url: string): boolean {
  const base = parsed(site);
  const target = parsed(url);
  if (!base || !target || base.hostname !== target.hostname) return false;
  const directory = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return target.pathname === base.pathname || target.pathname.startsWith(directory);
}

/** Days the performance analyses read: the twelve weeks that end on the latest date Bing reports (a tool convention). */
export const trafficWindowDays = 84;

export interface TrafficWindow {
  readonly rows: readonly BingTrafficRow[];
  /** First and last dates of the rows kept; empty when there are none. */
  readonly start: string;
  readonly end: string;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The rows dated within `days` days that end on the latest date among them. */
export function recentRows(rows: readonly BingTrafficRow[], days = trafficWindowDays): TrafficWindow {
  if (rows.length === 0) return { rows: [], start: '', end: '' };
  const end = rows.reduce((latest, row) => (row.date > latest ? row.date : latest), rows[0]!.date);
  const first = shiftDay(end, 1 - days);
  const kept = rows.filter(row => row.date >= first && row.date <= end);
  const start = kept.reduce((earliest, row) => (row.date < earliest ? row.date : earliest), end);
  return { rows: kept, start, end };
}

export interface TrafficTotal {
  readonly key: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
  /** Impression-weighted average of the rows' positions; absent when no row with impressions gave one. */
  readonly position?: number;
}

/** Sums the weekly rows of each page or query. */
export function trafficTotals(rows: readonly BingTrafficRow[]): TrafficTotal[] {
  const totals = new Map<string, { impressions: number; clicks: number; weighted: number; positioned: number }>();
  for (const row of rows) {
    const total = totals.get(row.key) ?? { impressions: 0, clicks: 0, weighted: 0, positioned: 0 };
    total.impressions += row.impressions;
    total.clicks += row.clicks;
    if (row.position !== undefined && row.impressions > 0) {
      total.weighted += row.position * row.impressions;
      total.positioned += row.impressions;
    }
    totals.set(row.key, total);
  }
  return [...totals].map(([key, total]) => ({
    key,
    impressions: total.impressions,
    clicks: total.clicks,
    ctr: total.impressions > 0 ? total.clicks / total.impressions : 0,
    ...(total.positioned > 0 ? { position: total.weighted / total.positioned } : {}),
  }));
}

/** Position bands of the comparison, the same as the Search Console analysis uses: 1, 2, 3, 4-5 and 6-10. */
const bands: ReadonlyArray<readonly [number, number]> = [[0, 1.5], [1.5, 2.5], [2.5, 3.5], [3.5, 5.5], [5.5, 10.5]];

function bandOf(position: number): number {
  return bands.findIndex(([low, high]) => position >= low && position < high);
}

export interface BingLowCtrPage {
  readonly page: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
  readonly position: number;
  /** CTR of the site's other pages in the same position band. */
  readonly expectedCtr: number;
}

export interface BingLowCtr {
  /** Pages that had enough impressions and a band where the other pages had enough impressions to compare with. */
  readonly compared: number;
  /** Pages under the norm, most impressions first. */
  readonly pages: readonly BingLowCtrPage[];
}

/**
 * Pages whose CTR is under `ratio` times the CTR of the site's other pages at a similar average position. Each page
 * is left out of the norm it is compared with, so one large page cannot set its own bar. Industry CTR curves do not
 * describe a given site's snippets, brand or result types, so only the site's own pages set the norm.
 */
export function lowCtrPages(rows: readonly BingTrafficRow[], minImpressions = 100, ratio = 0.5, minNormImpressions = 200): BingLowCtr {
  const pages = trafficTotals(rows).flatMap(page => (page.position !== undefined && bandOf(page.position) !== -1 ? [{ ...page, position: page.position, band: bandOf(page.position) }] : []));
  const byBand = new Map<number, { impressions: number; clicks: number }>();
  for (const page of pages) {
    const total = byBand.get(page.band) ?? { impressions: 0, clicks: 0 };
    byBand.set(page.band, { impressions: total.impressions + page.impressions, clicks: total.clicks + page.clicks });
  }
  let compared = 0;
  const low: BingLowCtrPage[] = [];
  for (const page of pages) {
    if (page.impressions < minImpressions) continue;
    const band = byBand.get(page.band)!;
    const otherImpressions = band.impressions - page.impressions;
    if (otherImpressions < minNormImpressions) continue;
    compared += 1;
    const expectedCtr = (band.clicks - page.clicks) / otherImpressions;
    if (page.ctr < expectedCtr * ratio) {
      low.push({ page: page.key, impressions: page.impressions, clicks: page.clicks, ctr: page.ctr, position: page.position, expectedCtr });
    }
  }
  return { compared, pages: low.sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page)) };
}
