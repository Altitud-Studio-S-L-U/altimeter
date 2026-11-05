import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { blockListOf, ipListCacheDirectory, listContains, loadIpLists, normalizeIp, parseIpList, type LoadedIpList } from '../src/owner/bots/ip-ranges.ts';
import { ipListDefinitions } from '../src/owner/bots/operators.ts';
import { fixtureDirectory, listServer, loopbackClient } from './support/bots.ts';

const fixture = (name: string) => readFile(join(fixtureDirectory, 'ip-lists', name), 'utf8');

describe('published address lists', () => {
  test('reads the operators\' JSON with its creationTime, IPv4 and IPv6 prefixes', async () => {
    const google = parseIpList(await fixture('google-common.json'));
    assert.equal(google.creationTime, '2026-11-03T15:46:11.000000');
    assert.deepEqual(google.prefixes, ['2001:4860:4801:10::/64', '192.178.4.0/27', '66.249.64.0/27']);
    assert.equal(google.invalid, 0);
  });

  test('reads the JSON Amazon embeds in a page and Cloudflare\'s plain lists', async () => {
    const amazon = parseIpList(await fixture('amazon-searchbot.html'));
    assert.equal(amazon.creationTime, '2026-09-08T05:24:10.610952+00:00');
    assert.deepEqual(amazon.prefixes, ['3.82.67.224/32', '3.82.90.168/32']);
    assert.deepEqual(parseIpList(await fixture('cloudflare-v4.txt')).prefixes, ['103.21.244.0/22', '103.22.200.0/22']);
    assert.deepEqual(parseIpList(await fixture('cloudflare-v6.txt')).prefixes, ['2400:cb00::/32']);
  });

  test('counts invalid entries and finds nothing in a changed format', () => {
    const parsed = parseIpList(JSON.stringify({ prefixes: [{ ipv4Prefix: '10.0.0.0/33' }, { ipv4Prefix: 'example' }, { ipv6Prefix: '2001:db8::/48' }] }));
    assert.deepEqual([parsed.prefixes, parsed.invalid], [['2001:db8::/48'], 2]);
    assert.deepEqual(parseIpList('<html><body>Moved to a new page</body></html>').prefixes, []);
    const escaped = parseIpList(JSON.stringify({ creationTime: `2026-11-04${String.fromCharCode(27)}[31m${String.fromCodePoint(0x202e)}`, prefixes: [] }));
    assert.equal(escaped.creationTime, '2026-11-04', 'the list\'s own text is cleaned before it is stored');
  });

  test('matches IPv4 and IPv6 addresses against prefixes, including blocks written with host bits', () => {
    const list = { prefixes: 3, blocks: blockListOf(['66.249.64.0/27', '2001:4860:c::10/124', '17.241.208.160/27']) } as LoadedIpList;
    assert.equal(listContains(list, '66.249.64.31'), true);
    assert.equal(listContains(list, '66.249.64.32'), false);
    assert.equal(listContains(list, '2001:4860:c::1f'), true);
    assert.equal(listContains(list, '2001:4860:c::20'), false);
    assert.equal(listContains({ ...list, prefixes: 0 }, '66.249.64.1'), false);
  });

  test('normalises client addresses and rejects other values', () => {
    assert.equal(normalizeIp(' 66.249.64.10 '), '66.249.64.10');
    assert.equal(normalizeIp('66.249.64.10:51234'), '66.249.64.10');
    assert.equal(normalizeIp('[2001:4860:4801:10::5]:443'), '2001:4860:4801:10::5');
    assert.equal(normalizeIp('2001:DB8::1%eth0'), '2001:db8::1');
    assert.equal(normalizeIp('::ffff:66.249.64.10'), '66.249.64.10');
    for (const value of ['-', '', 'unknown', '999.1.1.1', 'example.com']) assert.equal(normalizeIp(value), undefined, value);
  });

  test('keep their cache in the user cache folder', () => {
    assert.match(ipListCacheDirectory(), /altimeter[\\/]bot-ip-ranges$/u);
  });
});

describe('list download and cache', () => {
  let lists: Awaited<ReturnType<typeof listServer>>;
  let cache: string;
  before(async () => {
    lists = await listServer();
    cache = await mkdtemp(join(tmpdir(), 'altimeter-bot-lists-'));
  });
  after(async () => {
    await lists.close();
    await rm(cache, { recursive: true, force: true });
  });

  test('downloads once, serves the cache within its TTL and downloads again after it', async () => {
    const client = loopbackClient();
    const options = { client, cacheDirectory: cache, urls: lists.urls };
    const first = await loadIpLists(['openai-gptbot', 'anthropic'], { ...options, now: new Date('2026-11-04T08:00:00Z') });
    assert.deepEqual([first.get('openai-gptbot')?.from, first.get('openai-gptbot')?.prefixes, first.get('openai-gptbot')?.creationTime], ['network', 2, '2026-09-22T02:00:07.000000']);
    assert.deepEqual((await readdir(cache)).sort(), ['anthropic.json', 'openai-gptbot.json']);
    const requests = lists.requests.length;
    const cached = await loadIpLists(['openai-gptbot'], { ...options, now: new Date('2026-11-04T20:00:00Z') });
    assert.equal(cached.get('openai-gptbot')?.from, 'cache');
    assert.equal(lists.requests.length, requests);
    const refreshed = await loadIpLists(['openai-gptbot'], { ...options, now: new Date('2026-11-05T09:00:00Z') });
    assert.equal(refreshed.get('openai-gptbot')?.from, 'network');
    assert.equal(lists.requests.length, requests + 1);
    await client.close();
  });

  test('falls back to a stale copy when the download fails, and reports a list it never had', async () => {
    const client = loopbackClient();
    const broken = { ...lists.urls, 'openai-gptbot': `${lists.base}/lists/missing-file` };
    const stale = await loadIpLists(['openai-gptbot'], { client, cacheDirectory: cache, urls: { 'openai-gptbot': broken['openai-gptbot']! }, now: new Date('2026-11-09T09:00:00Z') });
    // The cached copy belongs to another URL, so it is not used for this one.
    assert.equal(stale.get('openai-gptbot')?.from, 'unavailable');
    assert.match(stale.get('openai-gptbot')?.error ?? '', /HTTP 404/u);
    const cachedEntry = JSON.parse(await readFile(join(cache, 'openai-gptbot.json'), 'utf8')) as { url: string };
    await writeFile(join(cache, 'openai-gptbot.json'), JSON.stringify({ ...cachedEntry, url: broken['openai-gptbot'] }));
    const fallback = await loadIpLists(['openai-gptbot'], { client, cacheDirectory: cache, urls: { 'openai-gptbot': broken['openai-gptbot']! }, now: new Date('2026-11-09T09:00:00Z') });
    assert.deepEqual([fallback.get('openai-gptbot')?.from, fallback.get('openai-gptbot')?.prefixes], ['stale-cache', 2]);
    const offline = await loadIpLists(['perplexity-bot'], { client, cacheDirectory: cache, urls: lists.urls, offline: true });
    assert.equal(offline.get('perplexity-bot')?.from, 'unavailable');
    await client.close();
  });

  test('the default URLs are the operators\' own https addresses', () => {
    for (const definition of Object.values(ipListDefinitions)) assert.match(definition.url, /^https:\/\/[a-z0-9.-]+\//u, definition.id);
  });
});
