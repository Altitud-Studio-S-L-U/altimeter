import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { collectBotActivity } from '../src/owner/bots/collect.ts';
import { CloudflareError, fetchCloudflareActivity, graphqlLiteral } from '../src/owner/bots/cloudflare.ts';
import { listServer, loopbackClient, now, scriptedResolver } from './support/bots.ts';

const token = 'cf-test-token-0123456789';
const zoneTag = '023e105f4ecef8ad9ca31a8372d0c353';
const googlebot = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const gptbot = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot';
const oai = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot';

interface Row { time: string; userAgent: string; clientRequestPath: string; edgeResponseStatus: number; verifiedBotCategory: string; clientIP: string; count: number; bytes: number }

/** Requests the fake zone holds; Cloudflare would return them grouped and sampled. */
const dataset: Row[] = [
  { time: '2026-10-27T08:00:00Z', userAgent: googlebot, clientRequestPath: '/en/', edgeResponseStatus: 200, verifiedBotCategory: 'Search Engine Crawler', clientIP: '66.249.66.1', count: 40, bytes: 400_000 },
  { time: '2026-10-28T08:00:00Z', userAgent: googlebot, clientRequestPath: '/en/about/', edgeResponseStatus: 200, verifiedBotCategory: 'Search Engine Crawler', clientIP: '66.249.66.1', count: 12, bytes: 96_000 },
  { time: '2026-10-29T08:00:00Z', userAgent: googlebot, clientRequestPath: '/wp-login.php', edgeResponseStatus: 403, verifiedBotCategory: '', clientIP: '203.0.113.50', count: 30, bytes: 3000 },
  { time: '2026-10-30T09:00:00Z', userAgent: gptbot, clientRequestPath: '/en/', edgeResponseStatus: 200, verifiedBotCategory: 'AI Crawler', clientIP: '132.196.86.20', count: 8, bytes: 80_000 },
  { time: '2026-11-01T10:00:00Z', userAgent: oai, clientRequestPath: '/llms.txt', edgeResponseStatus: 200, verifiedBotCategory: '', clientIP: '135.234.64.9', count: 3, bytes: 2700 },
  { time: '2026-11-03T10:00:00Z', userAgent: oai, clientRequestPath: '/en/', edgeResponseStatus: 403, verifiedBotCategory: '', clientIP: '135.234.64.9', count: 6, bytes: 600 },
  { time: '2026-10-01T10:00:00Z', userAgent: gptbot, clientRequestPath: '/old', edgeResponseStatus: 200, verifiedBotCategory: 'AI Crawler', clientIP: '132.196.86.20', count: 99, bytes: 1 },
];
const referrers = [{ time: '2026-10-30T12:00:00Z', clientRefererHost: 'chatgpt.com', count: 7 }, { time: '2026-11-02T12:00:00Z', clientRefererHost: 'www.perplexity.ai', count: 2 }];
const tagged = [{ time: '2026-10-31T12:00:00Z', count: 4 }];

const allFields = ['count', 'sum_edgeResponseBytes', 'avg_sampleInterval', 'dimensions_date', 'dimensions_userAgent', 'dimensions_clientRequestPath', 'dimensions_edgeResponseStatus',
  'dimensions_verifiedBotCategory', 'dimensions_clientIP', 'dimensions_requestSource', 'dimensions_clientRefererHost', 'dimensions_clientRequestQuery'];

const state = { maxPageSize: 100, availableFields: allFields, notOlderThan: 864_000, settingsErrors: undefined as string | undefined, queries: [] as string[] };

const body = (request: IncomingMessage) => new Promise<string>(resolve => { let text = ''; request.on('data', chunk => (text += chunk)); request.on('end', () => resolve(text)); });

function answer(query: string): unknown {
  if (query.includes('settings')) {
    if (state.settingsErrors) return { data: null, errors: [{ message: state.settingsErrors, path: ['viewer'] }] };
    return { data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: { enabled: true, maxDuration: 259_200, notOlderThan: state.notOlderThan, maxPageSize: state.maxPageSize, maxNumberOfFields: 30, availableFields: state.availableFields } } }] } }, errors: null };
  }
  const limit = Number(/limit: (\d+)/u.exec(query)?.[1]);
  const from = Date.parse(/datetime_geq: "([^"]+)"/u.exec(query)?.[1] ?? '');
  const to = Date.parse(/datetime_lt: "([^"]+)"/u.exec(query)?.[1] ?? '');
  const inRange = (time: string) => Date.parse(time) >= from && Date.parse(time) < to;
  const dimensions = (/dimensions \{ ([^}]+) \}/u.exec(query)?.[1] ?? '').trim().split(/\s+/u);
  if (query.includes('clientRefererHost_in')) {
    return { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: referrers.filter(row => inRange(row.time)).map(row => ({ count: row.count, dimensions: { clientRefererHost: row.clientRefererHost } })) }] } } };
  }
  if (query.includes('clientRequestQuery_like')) {
    return { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: tagged.filter(row => inRange(row.time)).map(row => ({ count: row.count, dimensions: { date: row.time.slice(0, 10) } })) }] } } };
  }
  const patterns = [...query.matchAll(/userAgent_like: "%([^"%]+)%"/gu)].map(match => match[1]!);
  const groups = new Map<string, { count: number; sum: { edgeResponseBytes: number }; avg: { sampleInterval: number }; dimensions: Record<string, unknown> }>();
  for (const row of dataset.filter(entry => inRange(entry.time) && patterns.some(pattern => entry.userAgent.includes(pattern)))) {
    const values: Record<string, unknown> = { ...row, date: row.time.slice(0, 10) };
    const picked = Object.fromEntries(dimensions.map(name => [name, values[name]]));
    const key = JSON.stringify(picked);
    const group = groups.get(key) ?? { count: 0, sum: { edgeResponseBytes: 0 }, avg: { sampleInterval: 10 }, dimensions: picked };
    group.count += row.count;
    group.sum.edgeResponseBytes += row.bytes;
    groups.set(key, group);
  }
  return { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit) }] } }, errors: null };
}

let server: Server;
let endpoint: string;

before(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (request.headers.authorization !== `Bearer ${token}`) return void json(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/client/v4/zones') {
        const name = url.searchParams.get('name');
        return void json(200, { success: true, errors: [], result: name === 'example.com' ? [{ id: zoneTag, name: 'example.com', status: 'active' }] : [] });
      }
      if (url.pathname === '/client/v4/graphql' && request.method === 'POST') {
        const { query } = JSON.parse(await body(request)) as { query: string };
        state.queries.push(query);
        return void json(200, answer(query));
      }
      json(404, {});
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  Object.assign(state, { maxPageSize: 100, availableFields: allFields, notOlderThan: 864_000, settingsErrors: undefined, queries: [] });
});

const window = { start: new Date(now.getTime() - 30 * 86_400_000), end: now };

describe('Cloudflare GraphQL Analytics', () => {
  test('finds the zone of a subdomain, reads the limits first and keeps every query within them', async () => {
    const client = loopbackClient();
    const data = await fetchCloudflareActivity({ client, token, zone: 'www.example.com', endpoint, ...window });
    await client.close();
    assert.deepEqual(data.zone, { id: zoneTag, name: 'example.com' });
    assert.match(state.queries[0]!, /settings \{ httpRequestsAdaptiveGroups \{ enabled maxDuration notOlderThan maxPageSize maxNumberOfFields availableFields \} \}/u);
    assert.equal(data.start.getTime(), now.getTime() - 864_000_000 + 60_000, 'the window starts where the dataset ends');
    assert.match(data.warnings.join(' '), /keeps 10 days/u);
    for (const query of state.queries.slice(1)) {
      const from = Date.parse(/datetime_geq: "([^"]+)"/u.exec(query)![1]!);
      const to = Date.parse(/datetime_lt: "([^"]+)"/u.exec(query)![1]!);
      assert.ok(to - from <= 259_200_000, 'no query spans more than maxDuration');
      assert.match(query, /requestSource: "eyeball"/u);
      assert.match(query, /zoneTag: "023e105f4ecef8ad9ca31a8372d0c353"/u);
    }
    assert.deepEqual(data.dimensions, ['userAgent', 'clientRequestPath', 'date', 'edgeResponseStatus', 'verifiedBotCategory', 'clientIP']);
    const total = data.observations.reduce((sum, row) => sum + row.count, 0);
    assert.equal(total, 40 + 12 + 30 + 8 + 3 + 6, 'rows outside the dataset window are never asked for');
    const oaiRow = data.observations.find(row => row.path === '/llms.txt');
    assert.deepEqual([oaiRow?.ip, oaiRow?.edgeCategory, oaiRow?.span, oaiRow?.time], ['135.234.64.9', '', 86_400_000, Date.parse('2026-11-01T00:00:00Z')]);
    assert.equal(data.sampleInterval, 10);
    assert.deepEqual([...data.referrals!.byHost], [['chatgpt.com', 7], ['perplexity.ai', 2]]);
    assert.equal(data.referrals!.tagged, 4);
  });

  test('splits the crawlers into smaller groups when a query returns its maximum rows', async () => {
    state.maxPageSize = 2;
    const client = loopbackClient();
    const data = await fetchCloudflareActivity({ client, token, zone: zoneTag, endpoint, ...window });
    await client.close();
    assert.equal(data.zone.id, zoneTag);
    assert.ok(state.queries.some(query => (query.match(/userAgent_like/gu) ?? []).length === 1), 'single-crawler queries were made');
    assert.equal(data.truncated, true);
    assert.ok(data.truncatedBots.includes('googlebot'), 'Googlebot alone still fills a page');
  });

  test('groups only by the fields the plan exposes', async () => {
    state.availableFields = ['count', 'dimensions_date', 'dimensions_userAgent', 'dimensions_clientRequestPath', 'dimensions_edgeResponseStatus'];
    const client = loopbackClient();
    const data = await fetchCloudflareActivity({ client, token, zone: 'example.com', endpoint, ...window });
    await client.close();
    assert.deepEqual(data.dimensions, ['userAgent', 'clientRequestPath', 'date', 'edgeResponseStatus']);
    assert.ok(data.observations.every(row => row.ip === undefined && row.edgeCategory === undefined && row.bytes === undefined));
    assert.equal(data.referrals, undefined);
    assert.ok(!state.queries.some(query => /clientIP|verifiedBotCategory|requestSource/u.test(query)));
  });

  test('never puts the token in an error, and cleans the API\'s messages', async () => {
    const client = loopbackClient();
    await assert.rejects(fetchCloudflareActivity({ client, token: 'wrong-token-value', zone: 'example.com', endpoint, ...window }), error => {
      assert.ok(error instanceof CloudflareError);
      assert.doesNotMatch(error.message, /wrong-token-value/u);
      assert.match(error.message, /refused the token/u);
      return true;
    });
    await assert.rejects(fetchCloudflareActivity({ client, token, zone: 'unknown.example', endpoint, ...window }), /No Cloudflare zone for unknown\.example/u);
    state.settingsErrors = `not authorized${String.fromCharCode(27)}[2J for zone`;
    await assert.rejects(fetchCloudflareActivity({ client, token, zone: 'example.com', endpoint, ...window }), error => {
      assert.equal((error as Error).message, 'Cloudflare GraphQL error: not authorized for zone', 'the terminal escape is removed');
      assert.ok(!(error as Error).message.includes(token));
      return true;
    });
    await assert.rejects(fetchCloudflareActivity({ client, token, zone: 'bad zone!', endpoint, ...window }), /domain name such as example\.com/u);
    await client.close();
  });

  test('escapes every value written into a query', () => {
    assert.equal(graphqlLiteral({ a: 'x"} viewer { y', b: [1, true] }), '{a: "x\\"} viewer { y", b: [1, true]}');
    assert.throws(() => graphqlLiteral({ 'a b': 1 }), /Not a GraphQL name/u);
  });
});

describe('crawler activity from Cloudflare', () => {
  test('verifies with Cloudflare\'s bot flag and the client address, and marks the counts as sampled', async () => {
    const lists = await listServer();
    const cache = await mkdtemp(join(tmpdir(), 'altimeter-cf-'));
    const client = loopbackClient();
    try {
      const activity = await collectBotActivity({
        cloudflare: { zone: 'example.com', token, endpoint }, now, client, dns: scriptedResolver({}, {}),
        ipLists: { cacheDirectory: cache, urls: lists.urls }, env: {},
      });
      assert.equal(activity.sampled, true);
      assert.deepEqual(activity.sources.map(source => source.kind), ['cloudflare-graphql']);
      const googlebotSummary = activity.bots.find(bot => bot.id === 'googlebot')!;
      assert.deepEqual([googlebotSummary.verified.hits, googlebotSummary.spoofed.hits, googlebotSummary.verifiedBy], [52, 30, { edge: 52 }]);
      const oaiSummary = activity.bots.find(bot => bot.id === 'oai-searchbot')!;
      assert.deepEqual([oaiSummary.verified.hits, oaiSummary.verifiedBy, oaiSummary.verified.statuses], [9, { 'ip-list': 9 }, { 200: 3, 403: 6 }]);
      assert.deepEqual(activity.referrals, { byHost: [{ host: 'chatgpt.com', assistant: 'ChatGPT', visits: 7 }, { host: 'perplexity.ai', assistant: 'Perplexity', visits: 2 }], tagged: 4, total: 9 });
      assert.ok(!JSON.stringify(activity).includes(token), 'the token is never part of the activity');
      assert.ok(!lists.requests.includes('cloudflare-v4'), 'Cloudflare\'s own ranges are not needed for its analytics');
      await assert.rejects(collectBotActivity({ cloudflare: { zone: 'example.com', endpoint }, now, client, env: {} }), /ALTIMETER_CLOUDFLARE_API_TOKEN/u);
    } finally {
      await client.close();
      await lists.close();
      await rm(cache, { recursive: true, force: true });
    }
  });
});
