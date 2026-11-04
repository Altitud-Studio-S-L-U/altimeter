import type { HttpClient } from '../fetch/http.ts';
import { GoogleAuthError, type AccessToken } from './google-auth.ts';

export const searchConsoleApi = { webmasters: 'https://www.googleapis.com/webmasters/v3', inspection: 'https://searchconsole.googleapis.com/v1' };

export interface GscProperty {
  readonly siteUrl: string;
  readonly permissionLevel: string;
}

export interface SearchRow {
  readonly keys: readonly string[];
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  readonly position: number;
}

export interface UrlInspection {
  readonly url: string;
  readonly verdict?: string;
  readonly coverageState?: string;
  readonly robotsTxtState?: string;
  readonly indexingState?: string;
  readonly pageFetchState?: string;
  readonly googleCanonical?: string;
  readonly userCanonical?: string;
  readonly lastCrawlTime?: string;
  readonly crawledAs?: string;
  readonly sitemaps: readonly string[];
  readonly referringUrls: readonly string[];
  readonly richResults: readonly { readonly type: string; readonly issues: readonly { readonly severity: string; readonly message: string }[] }[];
  readonly error?: string;
}

export interface GscSitemap {
  readonly path: string;
  readonly lastSubmitted?: string;
  readonly lastDownloaded?: string;
  readonly isPending?: boolean;
  readonly warnings: number;
  readonly errors: number;
}

export interface GscData {
  readonly property: GscProperty;
  /** When the data was read; ages such as the last crawl are measured from it. */
  readonly fetchedAt: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly previousPeriod: { readonly start: string; readonly end: string };
  readonly byPage: readonly SearchRow[];
  readonly byQuery: readonly SearchRow[];
  readonly byPageQuery: readonly SearchRow[];
  readonly byCountry: readonly SearchRow[];
  readonly byDevice: readonly SearchRow[];
  readonly previousByPage: readonly SearchRow[];
  readonly inspections: readonly UrlInspection[];
  readonly sitemaps: readonly GscSitemap[];
  /** True when a dimension hit the row cap, so totals from it are lower bounds. */
  readonly truncated: boolean;
}

export class SearchConsoleError extends Error {}

const rowLimit = 25_000;
const maxRows = 100_000;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 28 complete days ending three days ago (final data lags two to three days), and the 28 days before them. */
export function reportingPeriods(now: Date): { current: { start: string; end: string }; previous: { start: string; end: string } } {
  const end = new Date(now.getTime() - 3 * 86_400_000);
  const start = new Date(end.getTime() - 27 * 86_400_000);
  const previousEnd = new Date(start.getTime() - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - 27 * 86_400_000);
  return { current: { start: day(start), end: day(end) }, previous: { start: day(previousStart), end: day(previousEnd) } };
}

/**
 * Chooses the property that covers a URL: a Domain property first, otherwise the longest URL-prefix property that
 * contains it. URL-prefix properties are exact about scheme and host, so www and non-www are different properties.
 */
export function chooseProperty(properties: readonly GscProperty[], url: string): GscProperty | undefined {
  const usable = properties.filter(property => property.permissionLevel !== 'siteUnverifiedUser');
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./u, '');
  const domains = usable.filter(property => property.siteUrl.startsWith('sc-domain:'))
    .filter(property => { const domain = property.siteUrl.slice('sc-domain:'.length); return host === domain || host.endsWith(`.${domain}`); })
    .sort((a, b) => b.siteUrl.length - a.siteUrl.length);
  if (domains[0]) return domains[0];
  const target = parsed.href;
  return usable.filter(property => !property.siteUrl.startsWith('sc-domain:') && target.startsWith(property.siteUrl))
    .sort((a, b) => b.siteUrl.length - a.siteUrl.length)[0];
}

class Api {
  readonly client: HttpClient;
  readonly token: AccessToken;
  readonly endpoints: typeof searchConsoleApi;

  constructor(client: HttpClient, token: AccessToken, endpoints = searchConsoleApi) {
    this.client = client;
    this.token = token;
    this.endpoints = endpoints;
  }

  async call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
    const result = await this.client.fetch(url, {
      method,
      followRedirects: false,
      headers: { authorization: `Bearer ${this.token.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      maxBytes: 32 * 1024 * 1024,
      timeoutMs: 60_000,
    });
    if (result.error) throw new SearchConsoleError(`Search Console could not be reached (${result.error.code}).`);
    if (result.status === 401) throw new GoogleAuthError('The Search Console token is invalid or expired.');
    if (result.status === 403) throw new SearchConsoleError('The token has no access to this Search Console property.');
    if (result.status === 429) throw new SearchConsoleError('Search Console quota exceeded; try again later.');
    if (result.status !== 200) throw new SearchConsoleError(`Search Console answered ${result.status}.`);
    return JSON.parse(result.body.toString('utf8'));
  }

  sites(): Promise<unknown> {
    return this.call('GET', `${this.endpoints.webmasters}/sites`);
  }

  query(siteUrl: string, body: unknown): Promise<unknown> {
    return this.call('POST', `${this.endpoints.webmasters}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, body);
  }

  inspect(siteUrl: string, url: string): Promise<unknown> {
    return this.call('POST', `${this.endpoints.inspection}/urlInspection/index:inspect`, { inspectionUrl: url, siteUrl, languageCode: 'en-US' });
  }

  sitemaps(siteUrl: string): Promise<unknown> {
    return this.call('GET', `${this.endpoints.webmasters}/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
  }
}

function rows(payload: unknown): SearchRow[] {
  const list = (payload as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? [];
  return list.map(row => ({
    keys: Array.isArray(row.keys) ? (row.keys as unknown[]).map(String) : [],
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    ctr: Number(row.ctr ?? 0),
    position: Number(row.position ?? 0),
  }));
}

function inspection(url: string, payload: unknown): UrlInspection {
  const result = (payload as { inspectionResult?: Record<string, unknown> } | null)?.inspectionResult ?? {};
  const index = (result.indexStatusResult ?? {}) as Record<string, unknown>;
  const rich = (result.richResultsResult ?? {}) as { detectedItems?: Array<{ richResultType?: string; items?: Array<{ issues?: Array<{ severity?: string; issueMessage?: string }> }> }> };
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  return {
    url,
    ...(text(index.verdict) ? { verdict: text(index.verdict)! } : {}),
    ...(text(index.coverageState) ? { coverageState: text(index.coverageState)! } : {}),
    ...(text(index.robotsTxtState) ? { robotsTxtState: text(index.robotsTxtState)! } : {}),
    ...(text(index.indexingState) ? { indexingState: text(index.indexingState)! } : {}),
    ...(text(index.pageFetchState) ? { pageFetchState: text(index.pageFetchState)! } : {}),
    ...(text(index.googleCanonical) ? { googleCanonical: text(index.googleCanonical)! } : {}),
    ...(text(index.userCanonical) ? { userCanonical: text(index.userCanonical)! } : {}),
    ...(text(index.lastCrawlTime) ? { lastCrawlTime: text(index.lastCrawlTime)! } : {}),
    ...(text(index.crawledAs) ? { crawledAs: text(index.crawledAs)! } : {}),
    sitemaps: strings(index.sitemap),
    referringUrls: strings(index.referringUrls),
    richResults: (rich.detectedItems ?? []).map(item => ({
      type: item.richResultType ?? 'unknown',
      issues: (item.items ?? []).flatMap(entry => entry.issues ?? []).map(issue => ({ severity: issue.severity ?? '', message: issue.issueMessage ?? '' })),
    })),
  };
}

export interface FetchGscOptions {
  /** The audited URL; the property that covers it is chosen when `siteUrl` is not given. */
  readonly url: string;
  /** A property such as `sc-domain:example.com`; chosen automatically when omitted. */
  readonly siteUrl?: string;
  /** URLs to inspect; the API allows 2,000 per property per day. */
  readonly inspectUrls?: readonly string[];
  readonly now?: Date;
  readonly endpoints?: typeof searchConsoleApi;
}

/** Reads the owner's Search Console data that an audit uses. Read-only calls only. */
export async function fetchGscData(client: HttpClient, token: AccessToken, options: FetchGscOptions): Promise<GscData> {
  const api = new Api(client, token, options.endpoints);
  const listed = ((await api.sites()) as { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> } | null)?.siteEntry ?? [];
  const properties = listed.filter(entry => entry.siteUrl).map(entry => ({ siteUrl: entry.siteUrl!, permissionLevel: entry.permissionLevel ?? 'unknown' }));
  const property = options.siteUrl ? properties.find(entry => entry.siteUrl === options.siteUrl) : chooseProperty(properties, options.url);
  if (!property || property.permissionLevel === 'siteUnverifiedUser') {
    throw new SearchConsoleError(`No verified Search Console property covers ${new URL(options.url).origin}. Add the site in Search Console or pass --gsc with the property.`);
  }
  const fetchedAt = options.now ?? new Date();
  const periods = reportingPeriods(fetchedAt);
  let truncated = false;
  const all = async (dimensions: string[], period: { start: string; end: string }) => {
    const collected: SearchRow[] = [];
    for (let startRow = 0; startRow < maxRows; startRow += rowLimit) {
      const page = rows(await api.query(property.siteUrl, { startDate: period.start, endDate: period.end, dimensions, type: 'web', rowLimit, startRow, dataState: 'final' }));
      collected.push(...page);
      if (page.length < rowLimit) return collected;
    }
    truncated = true;
    return collected;
  };
  const byPage = await all(['page'], periods.current);
  const byQuery = await all(['query'], periods.current);
  const byPageQuery = await all(['page', 'query'], periods.current);
  const byCountry = await all(['country'], periods.current);
  const byDevice = await all(['device'], periods.current);
  const previousByPage = await all(['page'], periods.previous);
  const inspections: UrlInspection[] = [];
  for (const url of (options.inspectUrls ?? []).slice(0, 50)) {
    try {
      inspections.push(inspection(url, await api.inspect(property.siteUrl, url)));
    } catch (error) {
      if (error instanceof GoogleAuthError) throw error;
      inspections.push({ url, sitemaps: [], referringUrls: [], richResults: [], error: error instanceof Error ? error.message : 'inspection failed' });
    }
  }
  const sitemapList = ((await api.sitemaps(property.siteUrl)) as { sitemap?: Array<Record<string, unknown>> } | null)?.sitemap ?? [];
  const sitemaps = sitemapList.map(entry => ({
    path: String(entry.path ?? ''),
    ...(typeof entry.lastSubmitted === 'string' ? { lastSubmitted: entry.lastSubmitted } : {}),
    ...(typeof entry.lastDownloaded === 'string' ? { lastDownloaded: entry.lastDownloaded } : {}),
    ...(typeof entry.isPending === 'boolean' ? { isPending: entry.isPending } : {}),
    warnings: Number(entry.warnings ?? 0),
    errors: Number(entry.errors ?? 0),
  }));
  return { property, fetchedAt: fetchedAt.toISOString(), period: periods.current, previousPeriod: periods.previous, byPage, byQuery, byPageQuery, byCountry, byDevice, previousByPage, inspections, sitemaps, truncated };
}
