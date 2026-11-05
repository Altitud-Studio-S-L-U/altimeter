import { setTimeout as sleep } from 'node:timers/promises';
import type { CollectResult } from '../collect/index.ts';
import { servedUrl } from '../collect/page.ts';
import { HttpClient, type FetchResult } from '../fetch/http.ts';
import type { NetworkPolicy } from '../fetch/ip-guard.ts';
import { cleanLine } from '../report/sanitize.ts';
import { flagsFromText, lowCtrPages, onBingSite, recentRows } from './bing-analyses.ts';

/** The JSON endpoint of the Bing Webmaster API; each method is a GET on `<endpoint>/<Method>`. */
export const bingWebmasterApi = 'https://ssl.bing.com/webmaster/api.svc/json';

/** A site of the key's user, as GetUserSites lists it. */
export interface BingSite {
  readonly url: string;
  readonly verified: boolean;
}

/** One row of Bing's search performance, which Bing updates weekly: a page (GetPageStats) or a query (GetPageQueryStats). */
export interface BingTrafficRow {
  /** The page URL in page rows, the query in query rows. */
  readonly key: string;
  /** The day Bing dates the row with, as YYYY-MM-DD in the time zone of Bing's answer. */
  readonly date: string;
  readonly impressions: number;
  readonly clicks: number;
  /** Average position of the impressions; absent when Bing gives none. */
  readonly position?: number;
}

export interface BingPageQueries {
  readonly page: string;
  readonly rows: readonly BingTrafficRow[];
}

/** A URL Bing lists with crawl issues (GetCrawlIssues). */
export interface BingCrawlIssue {
  readonly url: string;
  /** Bing's crawl issue flags; `issueNames` in bing-analyses.ts decodes them. */
  readonly issues: number;
  readonly httpCode?: number;
  readonly inLinks: number;
}

/** What Bing keeps about one URL (GetUrlInfo). */
export interface BingUrlInfo {
  /** The URL Altimeter asked about. */
  readonly url: string;
  readonly httpStatus?: number;
  readonly lastCrawled?: string;
  readonly discovered?: string;
  readonly documentSize?: number;
  /** Why Bing gave no details, such as NotFound. */
  readonly error?: string;
}

/** What Bing Webmaster Tools reported for the site, read with the owner's API key. */
export interface BingData {
  /** When the data was read; ages are measured from it. */
  readonly fetchedAt: string;
  /** The verified site the data belongs to, as Bing lists it. */
  readonly site: string;
  /** URLs Bing lists with crawl issues; absent when the list could not be read. */
  readonly crawlIssues?: readonly BingCrawlIssue[];
  /** Weekly traffic of the site's top pages; absent when it could not be read. */
  readonly pageStats?: readonly BingTrafficRow[];
  /** Weekly traffic by query of the pages whose CTR is far below the site norm, at most five pages. */
  readonly pageQueries: readonly BingPageQueries[];
  /** Index details of audited pages, at most ten. */
  readonly urlInfo: readonly BingUrlInfo[];
  /** Parts that could not be read, one message each, free of secrets. */
  readonly unavailable: readonly string[];
}

/** `credentials`: the key or its access was refused; `throttled`: Bing asked to slow down; `failed`: anything else. */
export type BingErrorKind = 'credentials' | 'throttled' | 'failed';

export class BingWebmasterError extends Error {
  readonly kind: BingErrorKind;
  /** Bing's error code name, such as NotFound, when Bing answered with one. */
  readonly code: string | undefined;

  constructor(message: string, kind: BingErrorKind, code?: string) {
    super(message);
    this.name = 'BingWebmasterError';
    this.kind = kind;
    this.code = code;
  }
}

/** Replaces the API key, as written or URL-encoded, and the value of any apikey parameter with a marker. */
export function redactKey(text: string, key: string): string {
  const forms = [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)])]
    .filter(form => form.length >= 4)
    .sort((a, b) => b.length - a.length)
    .map(form => form.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const withoutKey = forms.length === 0 ? text : text.replace(new RegExp(forms.join('|'), 'giu'), '[redacted]');
  return withoutKey.replace(/(apikey=)[^&#\s"'<>]+/giu, '$1[redacted]');
}

/** ApiErrorCode as the API reference documents it. */
const errorNames: Readonly<Record<number, string>> = {
  1: 'InternalError', 2: 'UnknownError', 3: 'InvalidApiKey', 4: 'ThrottleUser', 5: 'ThrottleHost', 6: 'UserBlocked', 7: 'InvalidUrl',
  8: 'InvalidParameter', 9: 'TooManySites', 10: 'UserNotFound', 11: 'NotFound', 12: 'AlreadyExists', 13: 'NotAllowed', 14: 'NotAuthorized',
  15: 'UnexpectedState', 16: 'Deprecated',
};
const credentialCodes = new Set([3, 6, 10, 13, 14]);
const throttleCodes = new Set([4, 5]);
const transientCodes = new Set([1, 2]);

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The key travels in the query string, so it is only sent over HTTPS, or to a loopback server in tests. */
function checkedEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new BingWebmasterError('The Bing Webmaster API endpoint is not a valid URL.', 'failed');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname))) {
    throw new BingWebmasterError('The Bing Webmaster API endpoint must use HTTPS, so the API key is never sent in clear text.', 'failed');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
}

function parseJson(body: Buffer): unknown {
  const text = body.toString('utf8');
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
}

type Answer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly transient: boolean; readonly error: BingWebmasterError };

const refused = (message: string, kind: BingErrorKind, transient = false, code?: string): Answer => ({ ok: false, transient, error: new BingWebmasterError(message, kind, code) });

const maxAnswerBytes = 32 * 1024 * 1024;

interface ApiOptions {
  readonly endpoint: string;
  readonly pauseMs: number;
  readonly retryDelayMs: number;
}

/**
 * Read-only calls, one at a time and spaced by `pauseMs`: Bing publishes no request rate. A throttling answer stops
 * every later call, and a transient failure is retried once. Request URLs carry the key, so they are never kept,
 * logged or put in a message.
 */
class Api {
  readonly #client: HttpClient;
  readonly #key: string;
  readonly #options: ApiOptions;
  #lastCall = Number.NEGATIVE_INFINITY;
  #throttled: string | undefined;

  constructor(client: HttpClient, key: string, options: ApiOptions) {
    this.#client = client;
    this.#key = key;
    this.#options = options;
  }

  get throttled(): boolean {
    return this.#throttled !== undefined;
  }

  /** Calls one method and returns the `d` member of its JSON answer. */
  async call(method: string, params: Readonly<Record<string, string>> = {}): Promise<unknown> {
    if (this.#throttled) throw new BingWebmasterError(`${method} was not sent. ${this.#throttled}`, 'throttled');
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.#once(method, params);
      if (answer.ok) return answer.value;
      if (answer.error.kind === 'throttled') this.#throttled = answer.error.message;
      if (!answer.transient || attempt >= 2) throw answer.error;
      await sleep(this.#options.retryDelayMs);
    }
  }

  async #once(method: string, params: Readonly<Record<string, string>>): Promise<Answer> {
    const wait = this.#lastCall + this.#options.pauseMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.#lastCall = Date.now();
    const query = new URLSearchParams({ ...params, apikey: this.#key });
    let result: FetchResult;
    try {
      result = await this.#client.fetch(`${this.#options.endpoint}/${method}?${query.toString()}`, {
        followRedirects: false,
        headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
        maxBytes: maxAnswerBytes,
        timeoutMs: 60_000,
      });
    } catch {
      return refused(`${method} failed before Bing Webmaster Tools answered.`, 'failed', true);
    }
    // A dropped connection is worth one more try; a timeout already waited a minute.
    if (result.error) return refused(`Bing Webmaster Tools could not be reached for ${method} (${result.error.code}).`, 'failed', result.error.code === 'connection');
    if (result.truncated) return refused(`Bing Webmaster Tools answered ${method} with more than ${maxAnswerBytes / 1024 / 1024} MiB, which is not read.`, 'failed');
    const status = result.status ?? 0;
    const body = parseJson(result.body);
    if (status === 200) {
      if (body === null || typeof body !== 'object' || !('d' in body)) return refused(`Bing Webmaster Tools answered ${method} without the documented JSON.`, 'failed');
      return { ok: true, value: (body as { d: unknown }).d };
    }
    const code = body !== null && typeof body === 'object' ? (body as { ErrorCode?: unknown }).ErrorCode : undefined;
    if (typeof code === 'number' && Number.isInteger(code)) {
      const name = errorNames[code] ?? `error code ${code}`;
      if (credentialCodes.has(code)) return refused(`Bing Webmaster Tools refused ${method} (${name}). Check BING_WEBMASTER_API_KEY and the site's access in Bing Webmaster Tools.`, 'credentials', false, name);
      if (throttleCodes.has(code)) return refused(`Bing Webmaster Tools throttled the requests (${name}); try again later.`, 'throttled', false, name);
      return refused(`Bing Webmaster Tools refused ${method} (${name}).`, 'failed', transientCodes.has(code), name);
    }
    if (status === 401 || status === 403) return refused(`Bing Webmaster Tools refused the API key (HTTP ${status}).`, 'credentials');
    if (status === 429) return refused('Bing Webmaster Tools throttled the requests (HTTP 429); try again later.', 'throttled');
    if (status >= 300 && status < 400) return refused(`Bing Webmaster Tools answered ${method} with a redirect (HTTP ${status}), which is not followed.`, 'failed');
    return refused(`Bing Webmaster Tools answered HTTP ${status} to ${method}.`, 'failed', status >= 500);
  }
}

function listOf(payload: unknown, method: string): unknown[] {
  if (payload === null) return [];
  if (Array.isArray(payload)) return payload;
  throw new BingWebmasterError(`Bing Webmaster Tools answered ${method} with something other than a list.`, 'failed');
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A non-negative number, also when written as text. */
function count(value: unknown): number {
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : 0;
}

function httpStatus(value: unknown): number | undefined {
  const status = count(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** A URL on the site's host, serialised again, which also percent-encodes control and invisible characters. */
function urlOn(value: unknown, host: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === host ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A query as searchers typed it, without control, bidirectional or zero-width characters. */
function queryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const query = cleanLine(value, 300);
  return query === '' ? undefined : query;
}

const wcfDate = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/u;
const earliestDate = Date.UTC(2000, 0, 1);
const latestDate = Date.UTC(2200, 0, 1);

/**
 * Bing's JSON dates, "/Date(1316156400000-0700)/": milliseconds since 1970 in UTC, then the offset of the time zone
 * the server writes in, which gives the calendar day Bing means. Dates before 2000, such as .NET's DateTime.MinValue,
 * mean that Bing has no date.
 */
export function bingDate(value: unknown): { readonly instant: string; readonly day: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const match = wcfDate.exec(text);
  // The XML answers write ISO dates with an offset; any other text is not a date.
  const iso = !match && /^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(text);
  const ms = match ? Number(match[1]) : iso ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms) || ms < earliestDate || ms > latestDate) return undefined;
  if (!match) return { instant: new Date(ms).toISOString(), day: text.slice(0, 10) };
  const offset = match[2] ?? '+0000';
  const minutes = (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  return { instant: new Date(ms).toISOString(), day: new Date(ms + minutes * 60_000).toISOString().slice(0, 10) };
}

function sitesOf(payload: unknown): BingSite[] {
  return listOf(payload, 'GetUserSites').flatMap(entry => {
    const record = recordOf(entry);
    if (typeof record.Url !== 'string' || record.Url.trim() === '' || record.Url.length > 2048) return [];
    return [{ url: cleanLine(record.Url, 2048), verified: record.IsVerified === true }];
  });
}

function crawlIssuesOf(payload: unknown, host: string): BingCrawlIssue[] {
  return listOf(payload, 'GetCrawlIssues').flatMap(entry => {
    const record = recordOf(entry);
    const url = urlOn(record.Url, host);
    const issues = typeof record.Issues === 'string' ? flagsFromText(record.Issues) : record.Issues;
    if (!url || typeof issues !== 'number' || !Number.isInteger(issues) || issues <= 0 || issues >= 2 ** 31) return [];
    const code = httpStatus(record.HttpCode);
    return [{ url, issues, ...(code === undefined ? {} : { httpCode: code }), inLinks: count(record.InLinks) }];
  });
}

function trafficOf(payload: unknown, method: string, keyOf: (value: unknown) => string | undefined): BingTrafficRow[] {
  return listOf(payload, method).flatMap(entry => {
    const record = recordOf(entry);
    const key = keyOf(record.Query);
    const date = bingDate(record.Date);
    if (!key || !date) return [];
    const position = count(record.AvgImpressionPosition);
    return [{ key, date: date.day, impressions: count(record.Impressions), clicks: count(record.Clicks), ...(position > 0 ? { position } : {}) }];
  });
}

function urlInfoOf(url: string, payload: unknown): BingUrlInfo {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { url, error: 'no details' };
  const record = payload as Record<string, unknown>;
  const status = httpStatus(record.HttpStatus);
  const lastCrawled = bingDate(record.LastCrawledDate)?.instant;
  const discovered = bingDate(record.DiscoveryDate)?.instant;
  const size = count(record.DocumentSize);
  return {
    url,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(lastCrawled === undefined ? {} : { lastCrawled }),
    ...(discovered === undefined ? {} : { discovered }),
    ...(size > 0 ? { documentSize: size } : {}),
  };
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Same scheme, host and port, and a path under the site's path. */
function coversExactly(site: string, url: URL): boolean {
  const base = parsedUrl(site);
  return base !== undefined && base.protocol === url.protocol && base.host === url.host && onBingSite(site, url.href);
}

/**
 * The verified site that covers the audited URL: same scheme, host and port, and the longest path that contains it.
 * Bing documents no rule that maps http to https or www to the bare domain, so neither is assumed.
 */
export function chooseBingSite(sites: readonly BingSite[], url: string): BingSite | undefined {
  const target = new URL(url);
  return sites.filter(site => site.verified && coversExactly(site.url, target))
    .sort((a, b) => (parsedUrl(b.url)?.pathname.length ?? 0) - (parsedUrl(a.url)?.pathname.length ?? 0))[0];
}

function sameSite(a: string, b: string): boolean {
  const x = parsedUrl(a);
  const y = parsedUrl(b);
  return x !== undefined && y !== undefined && x.protocol === y.protocol && x.host === y.host
    && x.pathname.replace(/\/+$/u, '') === y.pathname.replace(/\/+$/u, '');
}

const unverified = (site: BingSite) => new BingWebmasterError(`The Bing Webmaster Tools site ${site.url} is not verified; verify it in Bing Webmaster Tools to read its data.`, 'failed');

/**
 * The site whose data the audit reads. A site the owner names must be listed, verified and on the audited host;
 * its scheme may differ, which is the owner's call. Otherwise the verified site that covers the audited URL.
 */
export function resolveBingSite(sites: readonly BingSite[], url: string, named?: string): BingSite {
  const target = new URL(url);
  if (named !== undefined) {
    const site = sites.find(entry => sameSite(entry.url, named));
    if (!site) throw new BingWebmasterError(`The API key gives no access to the Bing Webmaster Tools site ${cleanLine(named, 300)}.`, 'failed');
    if (!site.verified) throw unverified(site);
    if (parsedUrl(site.url)?.hostname !== target.hostname) throw new BingWebmasterError(`The Bing Webmaster Tools site ${site.url} is not on the audited host ${target.hostname}.`, 'failed');
    return site;
  }
  const chosen = chooseBingSite(sites, url);
  if (chosen) return chosen;
  const pending = sites.find(site => !site.verified && coversExactly(site.url, target));
  if (pending) throw unverified(pending);
  const sameHost = sites.filter(site => site.verified && parsedUrl(site.url)?.hostname === target.hostname).map(site => site.url);
  throw new BingWebmasterError(`No verified Bing Webmaster Tools site covers ${target.origin}${target.pathname}. Add and verify the site in Bing Webmaster Tools.${
    sameHost.length > 0 ? ` The account has ${sameHost.join(', ')} for the same host; name it as the Bing site to read its data.` : ''}`, 'failed');
}

export interface FetchBingOptions {
  /** The audited URL; the verified site that covers it is chosen unless `site` names one. */
  readonly url: string;
  /** The verified site to read, such as https://example.com/. */
  readonly site?: string;
  /** Audited URLs to read index details for; the first ten on the site are read. */
  readonly urlInfoFor?: readonly string[];
  readonly now?: Date;
  readonly endpoint?: string;
  /** Milliseconds between two calls (default 500). Bing publishes no request rate, so calls are sequential and spaced. */
  readonly pauseMs?: number;
  /** Milliseconds before the single retry of a transient failure (default 2000). */
  readonly retryDelayMs?: number;
}

const maxUrlInfo = 10;
const maxQueryPages = 5;

async function readBing(client: HttpClient, apiKey: string, options: FetchBingOptions): Promise<BingData> {
  const api = new Api(client, apiKey, { endpoint: checkedEndpoint(options.endpoint ?? bingWebmasterApi), pauseMs: options.pauseMs ?? 500, retryDelayMs: options.retryDelayMs ?? 2000 });
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const site = resolveBingSite(sitesOf(await api.call('GetUserSites')), options.url, options.site);
  const host = new URL(site.url).hostname;
  const unavailable: string[] = [];
  let skipped = 0;
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
    if (api.throttled) {
      skipped += 1;
      return undefined;
    }
    try {
      return await run();
    } catch (error) {
      if (error instanceof BingWebmasterError && error.kind === 'credentials') throw error;
      unavailable.push(`${what} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
      return undefined;
    }
  };
  const crawlIssues = await attempt('The crawl issues', async () => crawlIssuesOf(await api.call('GetCrawlIssues', { siteUrl: site.url }), host));
  const pageStats = await attempt('The page traffic', async () => trafficOf(await api.call('GetPageStats', { siteUrl: site.url }), 'GetPageStats', value => urlOn(value, host)));
  const pageQueries: BingPageQueries[] = [];
  for (const page of pageStats ? lowCtrPages(recentRows(pageStats).rows).pages.slice(0, maxQueryPages) : []) {
    const rows = await attempt(`The queries of ${page.page}`, async () => trafficOf(await api.call('GetPageQueryStats', { siteUrl: site.url, page: page.page }), 'GetPageQueryStats', queryText));
    if (rows) pageQueries.push({ page: page.page, rows });
  }
  const urlInfo: BingUrlInfo[] = [];
  for (const url of [...new Set(options.urlInfoFor ?? [])].filter(entry => onBingSite(site.url, entry)).slice(0, maxUrlInfo)) {
    const details = await attempt(`The index details of ${url}`, async () => {
      try {
        return urlInfoOf(url, await api.call('GetUrlInfo', { siteUrl: site.url, url }));
      } catch (error) {
        // Bing knowing nothing about a URL is an answer about that URL, not a failure of the read.
        if (error instanceof BingWebmasterError && (error.code === 'NotFound' || error.code === 'InvalidUrl')) return { url, error: error.code };
        throw error;
      }
    });
    if (details) urlInfo.push(details);
  }
  if (skipped > 0) unavailable.push(`${skipped} later request${skipped === 1 ? ' was' : 's were'} not sent after Bing Webmaster Tools throttled the requests.`);
  return { fetchedAt, site: site.url, ...(crawlIssues ? { crawlIssues } : {}), ...(pageStats ? { pageStats } : {}), pageQueries, urlInfo, unavailable: unavailable.map(entry => redactKey(entry, apiKey)) };
}

/**
 * Reads the owner's Bing Webmaster Tools data that an audit uses, with read-only methods only: the verified site
 * (GetUserSites), its crawl issues (GetCrawlIssues), the traffic of its top pages (GetPageStats), the queries of the
 * pages whose CTR is far below the site norm (GetPageQueryStats) and the index details of audited pages (GetUrlInfo).
 */
export async function fetchBingData(client: HttpClient, apiKey: string, options: FetchBingOptions): Promise<BingData> {
  try {
    return await readBing(client, apiKey, options);
  } catch (error) {
    // Messages are built from fixed text, but whatever is thrown, the key never leaves this function.
    const kind = error instanceof BingWebmasterError ? error.kind : 'failed';
    const code = error instanceof BingWebmasterError ? error.code : undefined;
    throw new BingWebmasterError(redactKey(error instanceof Error ? error.message : 'Bing Webmaster Tools data could not be read.', apiKey), kind, code);
  }
}

export interface BingRequest {
  /** The verified site to read, such as https://example.com/; chosen from the audited URL when omitted. */
  readonly site?: string;
  /** Write numbered labels instead of the owner's search queries, for a report meant to be shared. */
  readonly redactQueries?: boolean;
  /** The API key; BING_WEBMASTER_API_KEY when omitted. */
  readonly apiKey?: string;
  /** Another API endpoint and network policy, for tests against a local server. */
  readonly endpoint?: string;
  readonly policy?: NetworkPolicy;
  readonly pauseMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: Date;
}

export interface BingAuditOptions {
  /** The audited URL as requested; the site is chosen for the URL its page was served from, after redirects. */
  readonly url: string;
  /** Read the owner's Bing Webmaster Tools data; nothing is read when absent. */
  readonly bing?: BingRequest;
}

/**
 * Adds the owner's Bing Webmaster Tools data to collected facts. A missing key or a failed read becomes a warning,
 * never a failed audit, and a part that could not be read is named in a warning.
 */
export async function withBing(collected: CollectResult, options: BingAuditOptions): Promise<CollectResult> {
  const request = options.bing;
  if (!request) return collected;
  const apiKey = (request.apiKey ?? process.env.BING_WEBMASTER_API_KEY ?? '').trim();
  if (apiKey === '') {
    return { ...collected, warnings: [...collected.warnings, 'Bing Webmaster Tools data was requested but BING_WEBMASTER_API_KEY is not set. Generate a key in Bing Webmaster Tools under Settings > API Access.'] };
  }
  const client = new HttpClient(request.policy ? { policy: request.policy } : {});
  try {
    const urlInfoFor = [...collected.site.pages.values()].filter(page => !page.notAuditable && page.fetch.status !== undefined).map(page => page.fetch.finalUrl);
    const bing = await fetchBingData(client, apiKey, {
      url: servedUrl(collected.site.pages.values().next().value, options.url),
      urlInfoFor,
      ...(request.site === undefined ? {} : { site: request.site }),
      ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }),
      ...(request.pauseMs === undefined ? {} : { pauseMs: request.pauseMs }),
      ...(request.retryDelayMs === undefined ? {} : { retryDelayMs: request.retryDelayMs }),
      ...(request.now === undefined ? {} : { now: request.now }),
    });
    return {
      ...collected,
      warnings: [...collected.warnings, ...bing.unavailable.map(entry => `Bing Webmaster Tools data is incomplete. ${entry}`)],
      site: { ...collected.site, owner: { ...collected.site.owner, bing, ...(request.redactQueries ? { redactQueries: true } : {}) } },
    };
  } catch (error) {
    return { ...collected, warnings: [...collected.warnings, `Bing Webmaster Tools data was not used: ${redactKey(error instanceof Error ? error.message : 'unknown error', apiKey)}`] };
  } finally {
    await client.close();
  }
}
