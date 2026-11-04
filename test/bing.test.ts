import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { CollectResult } from '../src/collect/index.ts';
import type { OwnerData } from '../src/core/facts.ts';
import { HttpClient } from '../src/fetch/http.ts';
import { flagsFromText, issueNames } from '../src/owner/bing-analyses.ts';
import { BingWebmasterError, bingDate, chooseBingSite, fetchBingData, redactKey, resolveBingSite, withBing, type BingSite, type FetchBingOptions } from '../src/owner/bing.ts';
import type { GscData } from '../src/owner/gsc.ts';
import { page, site } from './support/facts.ts';

const key = '5A1B2C3D4E5F60718293A4B5C6D7E8F9';
const origin = 'https://example.com';
const weeks = ['2026-10-17', '2026-10-24', '2026-10-31'];
const zeroWidth = String.fromCodePoint(0x200b);
const bidiOverride = String.fromCodePoint(0x202e);

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}
type Route = (params: URLSearchParams) => Reply | 'drop';

/** Bing's serializer escapes the slashes of its dates, as in "\/Date(1316156400000-0700)\/". */
const bingJson = (value: unknown, status = 200): Reply => ({ status, body: JSON.stringify(value).replace(/"\/Date\((-?\d+[+-]\d{4})\)\/"/gu, '"\\/Date($1)\\/"') });
const fault = (code: number, message: string): Reply => ({ status: 400, body: JSON.stringify({ ErrorCode: code, Message: message }) });
/** Midnight of `day` in the Pacific offset the documentation's samples use. */
const wcf = (day: string) => `/Date(${Date.parse(`${day}T07:00:00Z`)}-0700)/`;
const stat = (query: string, day: string, impressions: number, clicks: number, position: number) => ({
  __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', AvgClickPosition: position, AvgImpressionPosition: position, Clicks: clicks, Date: wcf(day), Impressions: impressions, Query: query,
});

const defaults: Readonly<Record<string, Route>> = {
  GetUserSites: () => bingJson({ d: [
    { __type: 'Site:#Microsoft.Bing.Webmaster.Api', AuthenticationCode: '258CAD36B9EEE22F', DnsVerificationCode: '258cad36b9eee22f.example.com', IsVerified: true, Url: `${origin}/` },
    { __type: 'Site:#Microsoft.Bing.Webmaster.Api', IsVerified: true, Url: `${origin}/blog/` },
    { __type: 'Site:#Microsoft.Bing.Webmaster.Api', IsVerified: false, Url: 'https://shop.example.com/' },
  ] }),
  GetCrawlIssues: () => bingJson({ d: [
    { __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', HttpCode: 503, Issues: 8, Url: `${origin}/en/`, InLinks: 4 },
    { HttpCode: 200, Issues: 32, Url: `${origin}/x.htm`, InLinks: 0 },
    { HttpCode: 404, Issues: 'Code301, Code4xx', Url: `${origin}/old`, InLinks: '2' },
    { HttpCode: 404, Issues: 4, Url: 'https://other.example.org/page', InLinks: 1 },
    { HttpCode: 200, Issues: 0, Url: `${origin}/fine` },
  ] }),
  GetPageStats: () => bingJson({ d: [
    ...weeks.map(day => stat(`${origin}/a`, day, 400, 40, 2)),
    ...weeks.map(day => stat(`${origin}/b`, day, 300, 2, 2.2)),
    stat(`${origin}/c${bidiOverride}`, '2026-10-31', 150, 15, 1.8),
    { ...stat(`${origin}/b`, '2026-10-31', 9000, 9000, 1), Date: '/Date(-62135596800000)/' },
    stat('https://other.example.org/a', '2026-10-31', 999, 0, 1),
  ] }),
  GetPageQueryStats: params => bingJson({ d: params.get('page') === `${origin}/b` ? [
    stat(`custom software${zeroWidth} andorra`, '2026-10-24', 250, 1, 2.1), stat('custom software andorra', '2026-10-31', 250, 1, 2.1), stat('erp integration', '2026-10-31', 200, 0, 2.4),
  ] : [] }),
  GetUrlInfo: params => (params.get('url') === `${origin}/en/` ? bingJson({ d: {
    __type: 'UrlInfo:#Microsoft.Bing.Webmaster.Api', AnchorCount: 12, DiscoveryDate: wcf('2025-03-01'), DocumentSize: 51234, HttpStatus: 200, IsPage: true,
    LastCrawledDate: wcf('2026-10-20'), TotalChildUrlCount: 0, Url: `${origin}/en/`,
  } }) : fault(11, 'NotFound')),
};

let server: Server;
let endpoint: string;
let overrides = new Map<string, Route>();
const calls: Array<{ readonly method: string; readonly params: URLSearchParams }> = [];
const sockets = new Set<Socket>();

before(async () => {
  server = createServer((req, res) => {
    const target = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = target.pathname.split('/').pop() ?? '';
    calls.push({ method, params: target.searchParams });
    const send = (reply: Reply) => res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', ...reply.headers }).end(reply.body);
    if (!target.pathname.startsWith('/webmaster/api.svc/json/')) return void send({ status: 404, body: '' });
    if (target.searchParams.get('apikey') !== key) return void send(fault(3, 'InvalidApiKey'));
    const route = overrides.get(method) ?? defaults[method];
    if (!route) return void send(fault(8, 'InvalidParameter'));
    const reply = route(target.searchParams);
    if (reply === 'drop') return void req.socket.destroy();
    send(reply);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webmaster/api.svc/json`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  calls.length = 0;
  overrides = new Map();
});

const policy = { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) };
const client = () => new HttpClient({ policy });
const options = (extra: Partial<FetchBingOptions> = {}): FetchBingOptions => ({
  url: `${origin}/en/`, endpoint, pauseMs: 0, retryDelayMs: 0, now: new Date('2026-11-04T09:00:00Z'), ...extra,
});
const methods = () => calls.map(call => call.method);

async function read(extra: Partial<FetchBingOptions> = {}, apiKey = key) {
  const http = client();
  try {
    return await fetchBingData(http, apiKey, options(extra));
  } finally {
    await http.close();
  }
}

async function failure(extra: Partial<FetchBingOptions> = {}, apiKey = key): Promise<BingWebmasterError> {
  const error = await read(extra, apiKey).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BingWebmasterError, `expected a BingWebmasterError, got ${String(error)}`);
  return error;
}

function keyFree(error: BingWebmasterError, secret = key): void {
  for (const text of [error.message, String(error), String(error.stack), JSON.stringify(error)]) assert.ok(!text.includes(secret), `the key leaked: ${text}`);
}

describe('Bing Webmaster data', () => {
  test('reads the verified site that covers the audited URL, with read-only methods only', async () => {
    const data = await read({ urlInfoFor: [`${origin}/en/`, `${origin}/missing/`, 'https://other.example.org/', `${origin}/en/`] });
    assert.deepEqual([data.site, data.fetchedAt, data.unavailable], [`${origin}/`, '2026-11-04T09:00:00.000Z', []]);
    assert.deepEqual(data.crawlIssues?.map(entry => [entry.url, issueNames(entry.issues).join(','), entry.httpCode, entry.inLinks]), [
      [`${origin}/en/`, 'Code5xx', 503, 4], [`${origin}/x.htm`, 'ContainsMalware', 200, 0], [`${origin}/old`, 'Code301,Code4xx', 404, 2],
    ], 'URLs on other hosts and entries without issues are left out');
    assert.deepEqual(data.pageStats?.find(row => row.key === `${origin}/a`), { key: `${origin}/a`, date: '2026-10-17', impressions: 400, clicks: 40, position: 2 });
    assert.deepEqual([...new Set(data.pageStats?.map(row => row.key))], [`${origin}/a`, `${origin}/b`, `${origin}/c%E2%80%AE`], 'an invisible character in a URL is percent-encoded');
    assert.equal(data.pageStats?.length, 7, 'rows dated DateTime.MinValue or on other hosts are left out');
    assert.deepEqual(calls.filter(call => call.method === 'GetPageQueryStats').map(call => call.params.get('page')), [`${origin}/b`], 'queries are read only for the pages far below the norm');
    assert.deepEqual(data.pageQueries[0]?.rows.map(row => row.key), ['custom software andorra', 'custom software andorra', 'erp integration']);
    assert.deepEqual(data.urlInfo, [
      { url: `${origin}/en/`, httpStatus: 200, lastCrawled: '2026-10-20T07:00:00.000Z', discovered: '2025-03-01T07:00:00.000Z', documentSize: 51234 },
      { url: `${origin}/missing/`, error: 'NotFound' },
    ]);
    assert.deepEqual([...new Set(methods())], ['GetUserSites', 'GetCrawlIssues', 'GetPageStats', 'GetPageQueryStats', 'GetUrlInfo']);
    assert.ok(calls.every(call => call.params.get('apikey') === key));
    assert.ok(calls.slice(1).every(call => call.params.get('siteUrl') === `${origin}/`));
    assert.ok(!JSON.stringify(data).includes(key), 'the key is never stored');
  });

  test('reads the site the owner names, and only its URLs', async () => {
    const data = await read({ site: `${origin}/blog`, urlInfoFor: [`${origin}/en/`, `${origin}/blog/post`] });
    assert.equal(data.site, `${origin}/blog/`);
    assert.deepEqual(calls.filter(call => call.method === 'GetUrlInfo').map(call => call.params.get('url')), [`${origin}/blog/post`]);
  });

  test('names a part it could not read and still reads the rest', async () => {
    overrides.set('GetCrawlIssues', () => fault(16, 'Deprecated'));
    const data = await read();
    assert.equal(data.crawlIssues, undefined);
    assert.ok((data.pageStats?.length ?? 0) > 0);
    assert.deepEqual(data.unavailable, ['The crawl issues could not be read: Bing Webmaster Tools refused GetCrawlIssues (Deprecated).']);
  });

  test('treats an answer without the documented shape as unread, never as empty', async () => {
    overrides.set('GetCrawlIssues', () => bingJson({ d: { Url: `${origin}/` } }));
    overrides.set('GetPageStats', () => bingJson({ rows: [] }));
    const data = await read();
    assert.deepEqual([data.crawlIssues, data.pageStats], [undefined, undefined]);
    assert.deepEqual(data.unavailable, [
      'The crawl issues could not be read: Bing Webmaster Tools answered GetCrawlIssues with something other than a list.',
      'The page traffic could not be read: Bing Webmaster Tools answered GetPageStats without the documented JSON.',
    ]);
  });

  test('retries a transient failure once', async () => {
    let failures = 1;
    overrides.set('GetCrawlIssues', params => (failures-- > 0 ? { status: 503, body: 'busy' } : defaults.GetCrawlIssues!(params)));
    const data = await read();
    assert.equal(data.crawlIssues?.length, 3);
    assert.equal(methods().filter(method => method === 'GetCrawlIssues').length, 2);
  });

  test('stops calling after a throttling answer and keeps what it read', async () => {
    overrides.set('GetPageStats', () => fault(4, 'ThrottleUser'));
    const data = await read({ urlInfoFor: [`${origin}/en/`, `${origin}/de/`] });
    assert.equal(data.crawlIssues?.length, 3);
    assert.deepEqual([data.pageStats, data.urlInfo], [undefined, []]);
    assert.deepEqual(methods(), ['GetUserSites', 'GetCrawlIssues', 'GetPageStats']);
    assert.deepEqual(data.unavailable, [
      'The page traffic could not be read: Bing Webmaster Tools throttled the requests (ThrottleUser); try again later.',
      '2 later requests were not sent after Bing Webmaster Tools throttled the requests.',
    ]);
  });

  test('stops at a refused key or site access', async () => {
    const wrong = 'FFFFEEEEDDDDCCCCBBBBAAAA99998888';
    const refused = await failure({}, wrong);
    assert.equal(refused.kind, 'credentials');
    assert.match(refused.message, /InvalidApiKey\)\. Check BING_WEBMASTER_API_KEY/u);
    keyFree(refused, wrong);
    overrides.set('GetCrawlIssues', () => fault(14, 'NotAuthorized'));
    const denied = await failure();
    assert.deepEqual([denied.kind, denied.code], ['credentials', 'NotAuthorized']);
    assert.deepEqual(methods().slice(-1), ['GetCrawlIssues'], 'nothing is called after access is refused');
  });

  test('requires a verified site that covers the audited URL', async () => {
    assert.match((await failure({ url: 'https://shop.example.com/' })).message, /^The Bing Webmaster Tools site https:\/\/shop\.example\.com\/ is not verified/u);
    assert.match((await failure({ url: 'https://www.example.com/' })).message, /^No verified Bing Webmaster Tools site covers https:\/\/www\.example\.com\/\. Add and verify the site/u);
    assert.deepEqual(methods(), ['GetUserSites', 'GetUserSites'], 'no site data is read without a verified site');
  });

  test('sends the key only over HTTPS, or to a loopback test server', async () => {
    const error = await failure({ endpoint: 'http://api.example.com/webmaster/api.svc/json' });
    assert.match(error.message, /must use HTTPS/u);
    assert.equal(calls.length, 0);
  });

  test('reads queries for at most five pages and index details for at most ten URLs', async () => {
    const low = Array.from({ length: 7 }, (_, index) => `${origin}/low-${index}`);
    overrides.set('GetPageStats', () => bingJson({ d: [stat(`${origin}/healthy`, '2026-10-31', 3000, 300, 2), ...low.map(entry => stat(entry, '2026-10-31', 300, 1, 2))] }));
    const data = await read({ urlInfoFor: Array.from({ length: 12 }, (_, index) => `${origin}/page-${index}`) });
    assert.equal(methods().filter(method => method === 'GetPageQueryStats').length, 5);
    assert.equal(methods().filter(method => method === 'GetUrlInfo').length, 10);
    assert.equal(data.urlInfo.length, 10);
  });

  test('spaces its calls', async () => {
    const started = performance.now();
    await read({ pauseMs: 30, urlInfoFor: [`${origin}/en/`] });
    assert.equal(calls.length, 5);
    assert.ok(performance.now() - started >= 4 * 30 - 6, 'four pauses between five calls');
  });
});

describe('the Bing API key', () => {
  test('is redacted as written, URL-encoded or as an apikey parameter, in any case', () => {
    const odd = 'k3y+with/slash=';
    assert.equal(redactKey(`GET /json/GetUserSites?apikey=${encodeURIComponent(odd)}&x=1`, odd), 'GET /json/GetUserSites?apikey=[redacted]&x=1');
    assert.equal(redactKey(`key ${odd} and ${new URLSearchParams({ a: odd }).toString().slice(2)}`, odd), 'key [redacted] and [redacted]');
    assert.equal(redactKey(`echo ${key.toLowerCase()}`, key), 'echo [redacted]');
    assert.equal(redactKey('apikey=something-else&b=2', key), 'apikey=[redacted]&b=2');
  });

  test('never reaches an error, whatever Bing or the network answers', async () => {
    const scenarios: ReadonlyArray<readonly [string, Route, number]> = [
      ['a server error that echoes the request', params => ({ status: 500, body: `failed: /json/GetUserSites?apikey=${params.get('apikey')}` }), 2],
      ['a body that is not JSON and holds the key', params => ({ status: 200, body: `<html>${params.get('apikey')}</html>` }), 1],
      ['a redirect that carries the key', params => ({ status: 302, body: '', headers: { location: `https://elsewhere.example/?apikey=${params.get('apikey')}` } }), 1],
      ['a fault whose message holds the key', params => ({ status: 400, body: JSON.stringify({ ErrorCode: 1, Message: `InternalError for ${params.get('apikey')}` }) }), 2],
      ['a dropped connection', () => 'drop', 2],
    ];
    for (const [label, route, attempts] of scenarios) {
      calls.length = 0;
      overrides = new Map([['GetUserSites', route]]);
      const error = await failure();
      keyFree(error);
      assert.equal(calls.length, attempts, `${label}: ${attempts} attempt(s)`);
    }
  });

  test('is kept out of an exception thrown by the HTTP layer', async () => {
    const throwing = { fetch: async (target: string) => { throw new Error(`socket hang up at ${target}`); }, close: async () => {} } as unknown as HttpClient;
    const error = await fetchBingData(throwing, key, options()).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof BingWebmasterError);
    assert.equal(error.message, 'GetUserSites failed before Bing Webmaster Tools answered.');
    keyFree(error);
  });

  test('is removed from a message that would repeat it, such as a site named with the key by mistake', async () => {
    const error = await failure({ site: `https://unknown.example/?apikey=${key}&k=${key}` });
    keyFree(error);
    assert.equal(error.message, 'The API key gives no access to the Bing Webmaster Tools site https://unknown.example/?apikey=[redacted]&k=[redacted].');
  });
});

describe('Bing site resolution', () => {
  const sites: BingSite[] = [
    { url: `${origin}/`, verified: true }, { url: `${origin}/blog/`, verified: true },
    { url: 'http://www.example.org', verified: true }, { url: 'https://pending.example.net/', verified: false },
  ];

  test('chooses the longest verified site that covers the URL, without mapping schemes, hosts or sibling paths', () => {
    assert.equal(chooseBingSite(sites, `${origin}/blog/post`)?.url, `${origin}/blog/`);
    assert.equal(chooseBingSite(sites, `${origin}/blogger`)?.url, `${origin}/`);
    assert.equal(chooseBingSite(sites, 'https://EXAMPLE.com/en/')?.url, `${origin}/`);
    assert.equal(chooseBingSite(sites, 'https://www.example.com/'), undefined, 'the bare domain does not cover www');
    assert.equal(chooseBingSite(sites, 'http://example.com/'), undefined, 'an https site does not cover http');
    assert.equal(chooseBingSite(sites, 'http://www.example.org/page')?.url, 'http://www.example.org');
    assert.equal(chooseBingSite(sites, 'https://pending.example.net/'), undefined);
  });

  test('explains what is missing, and accepts a named site on the same host', () => {
    assert.throws(() => resolveBingSite(sites, 'https://pending.example.net/'), /is not verified; verify it in Bing Webmaster Tools/u);
    assert.throws(() => resolveBingSite(sites, 'https://www.example.org/'), /The account has http:\/\/www\.example\.org for the same host; name it as the Bing site/u);
    assert.equal(resolveBingSite(sites, 'https://www.example.org/', 'http://www.example.org/').url, 'http://www.example.org', 'a named site may differ in scheme');
    assert.throws(() => resolveBingSite(sites, `${origin}/`, 'http://www.example.org'), /is not on the audited host example\.com/u);
    assert.throws(() => resolveBingSite(sites, `${origin}/`, 'https://unknown.example/'), /gives no access to the Bing Webmaster Tools site/u);
  });
});

describe('Bing values', () => {
  test('reads dates in the offset Bing writes them, and treats placeholders as no date', () => {
    assert.deepEqual(bingDate('/Date(1316156400000-0700)/'), { instant: '2011-09-16T07:00:00.000Z', day: '2011-09-16' });
    assert.equal(bingDate(`/Date(${Date.UTC(2026, 9, 31, 23, 30)}+0100)/`)?.day, '2026-11-01');
    assert.deepEqual(bingDate('2011-09-16T00:00:00-07:00'), { instant: '2011-09-16T07:00:00.000Z', day: '2011-09-16' });
    for (const value of ['/Date(-62135596800000)/', '1', 'soon', 42, undefined]) assert.equal(bingDate(value), undefined, String(value));
  });

  test('decodes crawl issue flags from numbers and from names', () => {
    assert.deepEqual(issueNames(flagsFromText('ContainsMalware')), ['ContainsMalware']);
    assert.deepEqual(issueNames(flagsFromText('Code301, Code4xx')), ['Code301', 'Code4xx']);
    assert.deepEqual(issueNames(flagsFromText('288')), ['ContainsMalware', 'TimeOutErrors']);
    assert.deepEqual(issueNames(8 | 256 | 1024), ['Code5xx', 'TimeOutErrors'], 'undocumented bits are ignored');
  });
});

describe('withBing', () => {
  const audited = `${origin}/en/`;
  // Read when a test runs: the loopback endpoint exists only once the server listens.
  const request = () => {
    assert.ok(endpoint.startsWith('http://127.0.0.1:'));
    return { endpoint, policy, pauseMs: 0, retryDelayMs: 0 };
  };
  const collected = (owner?: OwnerData): CollectResult => ({
    site: site({ pages: [page(audited, { html: '<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1></body></html>' })], ...(owner ? { owner } : {}) }),
    versions: {}, warnings: [], durationMs: 0,
  });
  const gsc: GscData = {
    property: { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, fetchedAt: '2026-11-04T09:00:00.000Z',
    period: { start: '2026-10-05', end: '2026-11-01' }, previousPeriod: { start: '2026-09-07', end: '2026-10-04' },
    byPage: [], byQuery: [], byPageQuery: [], byCountry: [], byDevice: [], previousByPage: [], inspections: [], sitemaps: [], truncated: false,
  };

  async function closed(): Promise<void> {
    for (let attempt = 0; attempt < 100 && sockets.size > 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sockets.size, 0, 'the HTTP client was closed');
  }

  async function withKey<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
    const saved = process.env.BING_WEBMASTER_API_KEY;
    if (value === undefined) delete process.env.BING_WEBMASTER_API_KEY;
    else process.env.BING_WEBMASTER_API_KEY = value;
    try {
      return await run();
    } finally {
      if (saved === undefined) delete process.env.BING_WEBMASTER_API_KEY;
      else process.env.BING_WEBMASTER_API_KEY = saved;
    }
  }

  test('does nothing unless Bing data was requested', async () => {
    const input = collected();
    assert.equal(await withBing(input, { url: audited }), input);
  });

  test('warns instead of failing when no key is set', async () => {
    const result = await withKey(undefined, () => withBing(collected(), { url: audited, bing: request() }));
    assert.deepEqual(result.warnings, ['Bing Webmaster Tools data was requested but BING_WEBMASTER_API_KEY is not set. Generate a key in Bing Webmaster Tools under Settings > API Access.']);
    assert.equal(result.site.owner, undefined);
    assert.equal(calls.length, 0);
  });

  test('adds the data read with the key from the environment, keeps other owner data and closes its client', async () => {
    const result = await withKey(` ${key} `, () => withBing(collected({ gsc }), { url: audited, bing: { ...request(), redactQueries: true } }));
    assert.deepEqual(result.warnings, []);
    assert.equal(result.site.owner?.gsc, gsc);
    assert.equal(result.site.owner?.redactQueries, true);
    assert.equal(result.site.owner?.bing?.site, `${origin}/`);
    assert.deepEqual(result.site.owner?.bing?.urlInfo.map(entry => [entry.url, entry.httpStatus]), [[audited, 200]], 'the audited pages get index details');
    await closed();
  });

  test('turns a failed read into a warning that never shows the key', async () => {
    overrides.set('GetUserSites', params => ({ status: 500, body: String(params.get('apikey')) }));
    const result = await withBing(collected(), { url: audited, bing: { ...request(), apiKey: key } });
    assert.deepEqual(result.warnings, ['Bing Webmaster Tools data was not used: Bing Webmaster Tools answered HTTP 500 to GetUserSites.']);
    assert.equal(result.site.owner, undefined);
    assert.ok(!JSON.stringify(result).includes(key));
    await closed();
  });

  test('names the parts it could not read in warnings and keeps the rest', async () => {
    overrides.set('GetCrawlIssues', () => fault(1, 'InternalError'));
    const result = await withBing(collected(), { url: audited, bing: { ...request(), apiKey: key } });
    assert.deepEqual(result.warnings, ['Bing Webmaster Tools data is incomplete. The crawl issues could not be read: Bing Webmaster Tools refused GetCrawlIssues (InternalError).']);
    assert.equal(result.site.owner?.bing?.crawlIssues, undefined);
    assert.ok((result.site.owner?.bing?.pageStats?.length ?? 0) > 0);
  });

  describe('when the audited URL redirects to the www host', () => {
    const served = 'https://www.example.com/en/';
    const moved = (): CollectResult => ({
      site: site({ pages: [page(audited, { redirects: [[301, served]], html: '<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1></body></html>' })] }),
      versions: {}, warnings: [], durationMs: 0,
    });
    const sites = () => bingJson({ d: [{ IsVerified: true, Url: `${origin}/` }, { IsVerified: true, Url: 'https://www.example.com/' }] });

    test('reads the site that covers the URL the page is served from', async () => {
      overrides.set('GetUserSites', sites);
      const result = await withBing(moved(), { url: audited, bing: { ...request(), apiKey: key } });
      assert.deepEqual(result.warnings, []);
      assert.equal(result.site.owner?.bing?.site, 'https://www.example.com/');
      assert.deepEqual(calls.filter(call => call.method === 'GetUrlInfo').map(call => call.params.get('url')), [served]);
    });

    test('accepts a named site on the host the page is served from, and refuses one on the host it left', async () => {
      overrides.set('GetUserSites', sites);
      const named = await withBing(moved(), { url: audited, bing: { ...request(), apiKey: key, site: 'https://www.example.com/' } });
      assert.deepEqual(named.warnings, []);
      assert.equal(named.site.owner?.bing?.site, 'https://www.example.com/');
      const left = await withBing(moved(), { url: audited, bing: { ...request(), apiKey: key, site: `${origin}/` } });
      assert.deepEqual(left.warnings, ['Bing Webmaster Tools data was not used: The Bing Webmaster Tools site https://example.com/ is not on the audited host www.example.com.']);
    });
  });
});
