import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { blockListOf, parseIpList, type LoadedIpList } from '../src/owner/bots/ip-ranges.ts';
import { botById, botDefinitions, ipListDefinitions, isVerifiable, matchBot, type IpListId } from '../src/owner/bots/operators.ts';
import { reverseDns, verifyClaim, type ReverseDnsResult, type VerificationContext } from '../src/owner/bots/verify.ts';
import { fixtureDirectory, scriptedResolver } from './support/bots.ts';

function snapshot(id: IpListId, from: LoadedIpList['from'] = 'cache'): LoadedIpList {
  const file = id === 'amazon-searchbot' ? `${id}.html` : id.startsWith('cloudflare') ? `${id}.txt` : `${id}.json`;
  const parsed = parseIpList(readFileSync(join(fixtureDirectory, 'ip-lists', file), 'utf8'));
  return { id, url: ipListDefinitions[id].url, from, prefixes: parsed.prefixes.length, blocks: blockListOf(parsed.prefixes), ...(parsed.creationTime ? { creationTime: parsed.creationTime } : {}) };
}

const listIds: IpListId[] = [
  'google-common', 'google-user-triggered-agents', 'bingbot', 'openai-gptbot', 'openai-searchbot', 'openai-chatgpt-user', 'anthropic', 'perplexity-bot',
  'perplexity-user', 'applebot', 'ccbot', 'duckassistbot', 'mistral-index', 'mistral-user', 'amazon-searchbot',
];

function context(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    lists: new Map(listIds.map(id => [id, snapshot(id)])), proxies: [snapshot('cloudflare-v4'), snapshot('cloudflare-v6')], dnsEnabled: true,
    dns: new Map<string, ReverseDnsResult>([
      ['66.249.66.1', { kind: 'names', names: ['crawl-66-249-66-1.googlebot.com'], confirmed: ['crawl-66-249-66-1.googlebot.com'] }],
      ['203.0.113.50', { kind: 'none' }],
      ['198.51.100.7', { kind: 'names', names: ['googlebot.com.attacker.example'], confirmed: [] }],
      ['198.51.100.9', { kind: 'error', code: 'ETIMEOUT' }],
      ['17.241.75.1', { kind: 'names', names: ['17-241-75-1.applebot.apple.com'], confirmed: ['17-241-75-1.applebot.apple.com'] }],
    ]),
    ...overrides,
  };
}

const check = (id: string, address: string | undefined, edge?: string, extra: Partial<VerificationContext> = {}) => verifyClaim(botById(id)!, address, edge, context(extra));

describe('crawler identification by user agent', () => {
  test('matches tokens without case on token boundaries, including OpenAI\'s robots.txt marker', () => {
    assert.equal(matchBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot')?.id, 'gptbot');
    assert.equal(matchBot('Mozilla/5.0 ... compatible; OAI-SearchBot/1.4; robots.txt; +https://openai.com/searchbot')?.id, 'oai-searchbot');
    assert.equal(matchBot('Googlebot-Image/1.0')?.id, 'googlebot-image');
    assert.equal(matchBot('Mozilla/5.0 (compatible; googlebot/2.1)')?.id, 'googlebot');
    assert.equal(matchBot('NotGPTBotX/1.0'), undefined);
    assert.equal(matchBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36'), undefined);
    assert.equal(matchBot('Mozilla/5.0 (compatible; Google-NotebookLM)')?.id, 'google-gemininotebook');
    assert.equal(matchBot(undefined), undefined);
  });

  test('every crawler has a robots.txt token, a documented purpose and lists that exist', () => {
    for (const definition of botDefinitions) {
      assert.match(definition.token, /^[a-z-]+$/u, definition.id);
      for (const list of definition.checks.lists) assert.ok(ipListDefinitions[list], `${definition.id} uses ${list}`);
      if (definition.purpose === 'user-triggered') assert.equal(definition.followsRobots, false, definition.id);
    }
    assert.deepEqual(botDefinitions.filter(definition => !isVerifiable(definition)).map(definition => definition.id).sort(),
      ['bytespider', 'facebookexternalhit', 'meta-externalagent', 'meta-externalfetcher', 'meta-webindexer', 'mistralai-training']);
  });
});

describe('claim verification', () => {
  test('a published list verifies its own crawler, and an address outside it is spoofed', () => {
    assert.deepEqual(check('gptbot', '132.196.86.20'), { verdict: 'verified', method: 'ip-list' });
    assert.deepEqual(check('gptbot', '203.0.113.60'), { verdict: 'spoofed' });
    assert.deepEqual(check('gptbot', '135.234.64.9'), { verdict: 'spoofed' }, 'an OAI-SearchBot address does not verify GPTBot');
    assert.deepEqual(check('oai-searchbot', '135.234.64.9'), { verdict: 'verified', method: 'ip-list' });
  });

  test('Anthropic\'s shared list proves the operator only', () => {
    assert.deepEqual(check('claudebot', '216.73.216.30'), { verdict: 'verified', method: 'operator-ip-list' });
    assert.deepEqual(check('claude-user', '216.73.216.30'), { verdict: 'verified', method: 'operator-ip-list' });
  });

  test('reverse DNS with forward confirmation decides where the operator documents it', () => {
    assert.deepEqual(check('googlebot', '66.249.64.10'), { verdict: 'verified', method: 'ip-list' });
    assert.deepEqual(check('googlebot', '2001:4860:4801:10::1a'), { verdict: 'verified', method: 'ip-list' });
    assert.deepEqual(check('googlebot', '66.249.66.1'), { verdict: 'verified', method: 'reverse-dns' });
    assert.deepEqual(check('googlebot', '203.0.113.50'), { verdict: 'spoofed' });
    assert.deepEqual(check('googlebot', '198.51.100.7'), { verdict: 'spoofed' });
    assert.deepEqual(check('googlebot', '198.51.100.9'), { verdict: 'unverified', reason: 'dns-error' });
    assert.deepEqual(check('googlebot', '198.51.100.10'), { verdict: 'unverified', reason: 'dns-not-checked' });
    assert.deepEqual(check('googlebot', '203.0.113.50', undefined, { dnsEnabled: false }), { verdict: 'unverified', reason: 'dns-disabled' });
    assert.deepEqual(check('applebot', '17.241.75.1'), { verdict: 'verified', method: 'reverse-dns' });
    assert.deepEqual(check('bingbot', '157.55.39.10'), { verdict: 'verified', method: 'ip-list' });
  });

  test('Common Crawl documents reverse DNS for IPv4 only, so its list alone decides IPv6', () => {
    assert.deepEqual(check('ccbot', '2600:1f28:365:8000::10'), { verdict: 'verified', method: 'ip-list' });
    assert.deepEqual(check('ccbot', '2001:db8::77'), { verdict: 'spoofed' });
    assert.deepEqual(check('ccbot', '203.0.113.50'), { verdict: 'spoofed' });
  });

  test('inconclusive lists, missing and stale lists leave a claim unverified', () => {
    assert.deepEqual(check('google-agent', '203.0.113.80'), { verdict: 'unverified', reason: 'not-in-list' });
    assert.deepEqual(check('google-agent', '136.121.16.4'), { verdict: 'verified', method: 'ip-list' });
    const withoutGptbot = new Map(listIds.filter(id => id !== 'openai-gptbot').map(id => [id, snapshot(id)]));
    assert.deepEqual(check('gptbot', '203.0.113.60', undefined, { lists: withoutGptbot }), { verdict: 'unverified', reason: 'list-unavailable' });
    const stale = new Map(listIds.map(id => [id, snapshot(id, id === 'openai-gptbot' ? 'stale-cache' : 'cache')]));
    assert.deepEqual(check('gptbot', '203.0.113.60', undefined, { lists: stale }), { verdict: 'unverified', reason: 'list-stale' });
    assert.deepEqual(check('gptbot', '132.196.86.20', undefined, { lists: stale }), { verdict: 'verified', method: 'ip-list' });
  });

  test('Google\'s user-triggered fetchers outside the Google-controlled list and google.com names stay unverified', () => {
    const fetchers: LoadedIpList = {
      id: 'google-user-triggered-fetchers-google', url: ipListDefinitions['google-user-triggered-fetchers-google'].url, from: 'cache', prefixes: 1, blocks: blockListOf(['192.0.2.0/25']),
    };
    const lists = new Map<IpListId, LoadedIpList>([...listIds.map(id => [id, snapshot(id)] as const), [fetchers.id, fetchers]]);
    const dns = new Map<string, ReverseDnsResult>([
      ['198.51.100.20', { kind: 'names', names: ['198-51-100-20.gae.googleusercontent.com'], confirmed: [] }],
      ['198.51.100.21', { kind: 'none' }],
      ['198.51.100.22', { kind: 'names', names: ['google-proxy-198-51-100-22.google.com'], confirmed: ['google-proxy-198-51-100-22.google.com'] }],
    ]);
    const notebook = (address: string) => check('google-gemininotebook', address, undefined, { lists, dns });
    assert.deepEqual(notebook('192.0.2.10'), { verdict: 'verified', method: 'operator-ip-list' });
    assert.deepEqual(notebook('198.51.100.22'), { verdict: 'verified', method: 'reverse-dns' });
    assert.deepEqual(notebook('198.51.100.20'), { verdict: 'unverified', reason: 'not-in-list' }, 'App Engine space is shared, so it neither verifies nor refutes');
    assert.deepEqual(notebook('198.51.100.21'), { verdict: 'unverified', reason: 'not-in-list' });
    assert.deepEqual(check('googlebot', '203.0.113.50', undefined, { lists, dns: context().dns }), { verdict: 'spoofed' }, 'Googlebot\'s documented host names still refute a claim');
  });

  test('operators without a published check stay claims unless the edge verified them', () => {
    assert.deepEqual(check('meta-externalagent', '203.0.113.70'), { verdict: 'unverified', reason: 'no-published-check' });
    assert.deepEqual(check('meta-externalagent', undefined, 'AI Crawler'), { verdict: 'verified', method: 'edge' });
    assert.deepEqual(check('gptbot', undefined, ''), { verdict: 'unverified', reason: 'edge-not-verified' });
    assert.deepEqual(check('gptbot', undefined), { verdict: 'unverified', reason: 'no-client-ip' });
  });

  test('addresses of a proxy or a private network are never checked against the lists', () => {
    assert.deepEqual(check('googlebot', '10.0.0.5'), { verdict: 'unverified', reason: 'private-address' });
    assert.deepEqual(check('googlebot', '127.0.0.1'), { verdict: 'unverified', reason: 'private-address' });
    assert.deepEqual(check('gptbot', '103.21.244.9'), { verdict: 'unverified', reason: 'proxy-address' });
    assert.deepEqual(check('gptbot', '2400:cb00::1'), { verdict: 'unverified', reason: 'proxy-address' });
  });
});

describe('reverse DNS', () => {
  test('confirms forward, compares IPv6 in any notation and never resolves names outside the suffixes', async () => {
    const resolver = scriptedResolver({
      '66.249.66.1': ['crawl-66-249-66-1.googlebot.com.'],
      '198.51.100.7': ['googlebot.com.attacker.example'],
      '198.51.100.8': ['crawl-198-51-100-8.googlebot.com'],
      '2001:4860:4801:10::5': ['crawl-2001-4860-4801-10--5.googlebot.com'],
      '198.51.100.9': Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }),
    }, {
      'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'],
      'crawl-198-51-100-8.googlebot.com': ['66.249.66.99'],
      'crawl-2001-4860-4801-10--5.googlebot.com': ['2001:4860:4801:10:0:0:0:5'],
    });
    assert.deepEqual(await reverseDns(resolver, '66.249.66.1', ['googlebot.com']), { kind: 'names', names: ['crawl-66-249-66-1.googlebot.com'], confirmed: ['crawl-66-249-66-1.googlebot.com'] });
    assert.deepEqual(await reverseDns(resolver, '198.51.100.7', ['googlebot.com']), { kind: 'names', names: ['googlebot.com.attacker.example'], confirmed: [] });
    assert.deepEqual((await reverseDns(resolver, '198.51.100.8', ['googlebot.com'])).kind === 'names' ? 'unconfirmed' : 'other', 'unconfirmed');
    assert.deepEqual(await reverseDns(resolver, '2001:4860:4801:10::5', ['googlebot.com']), {
      kind: 'names', names: ['crawl-2001-4860-4801-10--5.googlebot.com'], confirmed: ['crawl-2001-4860-4801-10--5.googlebot.com'],
    });
    assert.deepEqual(await reverseDns(resolver, '203.0.113.1', ['googlebot.com']), { kind: 'none' });
    assert.deepEqual(await reverseDns(resolver, '198.51.100.9', ['googlebot.com']), { kind: 'error', code: 'ETIMEOUT' });
    assert.ok(!resolver.lookups.some(entry => entry.includes('attacker')), 'the attacker\'s name is never looked up forward');
  });
});
