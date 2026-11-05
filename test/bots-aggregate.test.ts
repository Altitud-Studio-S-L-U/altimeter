import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseRobots } from '../src/fetch/robots.ts';
import { BotAggregator, coverageKey, robotsDecision, type AggregatorSite, type Observation } from '../src/owner/bots/aggregate.ts';
import { botById, type BotDefinition } from '../src/owner/bots/operators.ts';
import type { VerificationOutcome } from '../src/owner/bots/verify.ts';

const agents = {
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  amazonbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/141.0.0.0 Safari/537.36',
  meta: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36',
};

const hour = 3_600_000;
const start = Date.parse('2026-10-05T12:00:00Z');
const at = (iso: string) => Date.parse(iso);
/** A request from 192.0.2.1 unless the test gives another address, or `ip: undefined` for none. */
function request(time: string, path: string, userAgent: string, extra: Omit<Partial<Observation>, 'ip'> & { readonly ip?: string | undefined } = {}): Observation {
  const { ip, ...rest } = extra;
  const address = 'ip' in extra ? ip : '192.0.2.1';
  return { time: at(time), path, userAgent, status: 200, bytes: 1000, count: 1, span: 0, ...rest, ...(address === undefined ? {} : { ip: address }) };
}

/** Verdicts by address: .1 verified, .2 spoofed, anything else unverified. */
const verify = (_definition: BotDefinition, observation: Observation): VerificationOutcome => {
  if (observation.ip?.endsWith('.1')) return { verdict: 'verified', method: 'ip-list' };
  if (observation.ip?.endsWith('.2')) return { verdict: 'spoofed' };
  return { verdict: 'unverified', reason: 'no-client-ip' };
};

const robots = parseRobots(['User-agent: *', 'Disallow: /private/', '', 'User-agent: GPTBot', 'Disallow: /en/team/', '', 'User-agent: Googlebot', 'Allow: /', ''].join('\n'));
const site: AggregatorSite = {
  host: 'example.com', robots: { file: robots, effectiveFrom: start },
  sitemapUrls: ['https://example.com/', 'https://example.com/en/', 'https://example.com/en/about/', 'https://example.com/en/caf%C3%A9/', 'https://other.example/en/'],
};

function run(observations: readonly Observation[], options: { site?: AggregatorSite } = { site }) {
  const aggregator = new BotAggregator({ ...(options.site ? { site: options.site } : {}), verify });
  for (const observation of observations) aggregator.add(observation);
  return aggregator.finish(at('2026-11-04T12:00:00Z'));
}

describe('crawler aggregation', () => {
  test('tallies verified, unverified and spoofed requests with days, statuses, bytes and challenges', () => {
    const { bots } = run([
      request('2026-10-20T08:00:00Z', '/en/', agents.googlebot, { ip: '66.249.64.1' }),
      request('2026-10-21T08:00:00Z', '/en/about/', agents.googlebot, { ip: '66.249.64.1', status: 403, challenged: true }),
      request('2026-10-21T09:00:00Z', '/en/', agents.googlebot, { ip: '203.0.113.2' }),
      request('2026-10-22T09:00:00Z', '/en/', agents.googlebot, { ip: undefined }),
    ]);
    const googlebot = bots.find(bot => bot.id === 'googlebot')!;
    assert.deepEqual(googlebot.verified, {
      hits: 2, bytes: 2000, firstSeen: '2026-10-20T08:00:00.000Z', lastSeen: '2026-10-21T08:00:00.000Z', activeDays: 2, statuses: { 200: 1, 403: 1 }, challenges: 1,
    });
    assert.deepEqual([googlebot.spoofed.hits, googlebot.unverified.hits, googlebot.unverifiedReasons], [1, 1, { 'no-client-ip': 1 }]);
    assert.deepEqual(googlebot.verifiedBy, { 'ip-list': 2 });
    assert.equal(googlebot.basis, 'verified');
  });

  test('counts robots.txt, llms.txt, scripts and style sheets on the basis requests', () => {
    const { bots } = run([
      request('2026-10-20T08:00:00Z', '/robots.txt', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-20T08:01:00Z', '/LLMS.txt', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-20T08:02:00Z', '/llms-full.txt', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-20T08:03:00Z', '/assets/app.mjs?v=2', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-20T08:04:00Z', '/assets/site.css', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-20T08:05:00Z', '/robots.txt', agents.gptbot, { ip: '203.0.113.2' }),
    ]);
    const gptbot = bots.find(bot => bot.id === 'gptbot')!;
    assert.deepEqual([gptbot.robotsTxt, gptbot.llmsTxt, gptbot.scripts, gptbot.stylesheets], [1, 2, 1, 1]);
  });

  test('uses every claim as the basis when none could be checked, and for operators without a check', () => {
    const { bots } = run([
      request('2026-10-20T08:00:00Z', '/en/', agents.googlebot, { ip: undefined }),
      request('2026-10-20T08:00:00Z', '/robots.txt', agents.meta, { ip: undefined }),
    ]);
    assert.deepEqual(bots.map(bot => [bot.id, bot.basis, bot.robotsTxt]), [['googlebot', 'claimed', 0], ['meta-externalagent', 'claimed', 1]]);
    assert.equal(bots.find(bot => bot.id === 'meta-externalagent')!.verifiable, false);
  });

  test('compares requested paths with the sitemap URLs of the audited host', () => {
    assert.equal(coverageKey('/en/about/index.html?utm=x#top'), '/en/about');
    assert.equal(coverageKey(`/en/caf${String.fromCodePoint(0xe9)}/`), coverageKey('/en/caf%c3%a9'));
    const { bots } = run([
      request('2026-10-20T08:00:00Z', '/en', agents.googlebot, { ip: '66.249.64.1', status: 301 }),
      request('2026-10-20T08:00:01Z', '/en/?ref=x', agents.googlebot, { ip: '66.249.64.1' }),
      request('2026-10-20T08:00:02Z', `/en/caf${String.fromCodePoint(0xe9)}/`, agents.googlebot, { ip: '66.249.64.1', host: 'example.com' }),
      request('2026-10-20T08:00:03Z', '/en/about/', agents.googlebot, { ip: '66.249.64.1', host: 'www.example.com' }),
    ]);
    assert.deepEqual(bots[0]!.coverage, { urls: 4, fetched: 2, ok: 2, missing: ['https://example.com/', 'https://example.com/en/about/'] });
  });

  test('keeps the most requested paths, cleaned of control and invisible characters, within a bound', () => {
    const hostile = `/a${String.fromCharCode(27)}[31m${String.fromCodePoint(0x202e)}b`;
    const observations = [request('2026-10-20T08:00:00Z', hostile, agents.gptbot, { ip: '132.196.86.1' })];
    for (let index = 0; index < 2100; index++) observations.push(request('2026-10-20T09:00:00Z', `/page-${index}`, agents.gptbot, { ip: '132.196.86.1' }));
    const gptbot = run(observations).bots[0]!;
    assert.equal(gptbot.paths.capped, true);
    assert.equal(gptbot.paths.distinct, 2000);
    assert.equal(gptbot.verified.hits, 2101);
    assert.ok(gptbot.paths.top.some(entry => entry.path === '/ab'), 'escape sequences and bidi overrides are removed');
  });
});

describe('robots.txt compliance', () => {
  test('counts disallowed requests after the caching window or after a fresh robots.txt fetch, never before the file took effect', () => {
    const { bots } = run([
      request('2026-10-04T08:00:00Z', '/en/team/a', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-05T20:00:00Z', '/en/team/b', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-05T21:00:00Z', '/robots.txt', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-05T22:00:00Z', '/en/team/c', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-20T08:00:00Z', '/en/team/d', agents.gptbot, { ip: '132.196.86.1' }),
      request('2026-10-20T08:00:00Z', '/en/team/e', agents.gptbot, { ip: '203.0.113.2' }),
      request('2026-10-20T08:00:00Z', '/private/x', agents.chatgptUser, { ip: '104.208.184.1' }),
    ]);
    const gptbot = bots.find(bot => bot.id === 'gptbot')!;
    assert.deepEqual(gptbot.compliance && { ...gptbot.compliance, paths: gptbot.compliance.paths.map(entry => entry.path) }, {
      cacheHours: 24, cacheBasis: 'standard', checkedFrom: '2026-10-05T21:00:00.000Z', disallowed: 2, paths: ['/en/team/c', '/en/team/d'], incomplete: false,
    });
    assert.deepEqual([gptbot.compliance!.paths[0]!.rule, gptbot.compliance!.paths[0]!.line], ['/en/team/', 5]);
    assert.equal(bots.find(bot => bot.id === 'chatgpt-user')!.compliance, undefined, 'fetches a user asks for are not checked');
  });

  test('uses the documented caching window: Amazon keeps robots.txt up to 30 days', () => {
    const amazonRobots = parseRobots('User-agent: Amazonbot\nDisallow: /\n');
    const { bots } = run([request('2026-10-25T08:00:00Z', '/en/', agents.amazonbot, { ip: '3.82.67.1' })], { site: { host: 'example.com', robots: { file: amazonRobots, effectiveFrom: start } } });
    const amazonbot = bots[0]!;
    assert.deepEqual([amazonbot.compliance?.cacheHours, amazonbot.compliance?.cacheBasis, amazonbot.compliance?.disallowed, amazonbot.compliance?.checkedFrom], [720, 'documented', 0, undefined]);
  });

  test('groups by day are counted from the day after a robots.txt fetch on the same day', () => {
    const day = 24 * hour;
    const { bots } = run([
      { time: at('2026-10-06T00:00:00Z'), span: day, count: 3, path: '/robots.txt', userAgent: agents.gptbot, status: 200, ip: '132.196.86.1' },
      { time: at('2026-10-06T00:00:00Z'), span: day, count: 4, path: '/en/team/x', userAgent: agents.gptbot, status: 200, ip: '132.196.86.1' },
      { time: at('2026-10-07T00:00:00Z'), span: day, count: 5, path: '/en/team/y', userAgent: agents.gptbot, status: 200, ip: '132.196.86.1' },
    ]);
    assert.equal(bots[0]!.compliance?.disallowed, 5);
  });

  test('follows Applebot\'s fallback to the Googlebot group and Amazon\'s fallback to other search bots', () => {
    const file = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n');
    assert.equal(robotsDecision(file, botById('applebot')!, '/en/').allowed, true);
    assert.equal(robotsDecision(file, botById('amzn-searchbot')!, '/en/').allowed, true);
    assert.equal(robotsDecision(file, botById('amazonbot')!, '/en/').allowed, false);
    assert.equal(robotsDecision(parseRobots('User-agent: *\nDisallow: /\n'), botById('amzn-searchbot')!, '/en/').allowed, false);
  });

  test('records the statuses of requests for allowed paths apart', () => {
    const { bots } = run([
      request('2026-10-20T08:00:00Z', '/en/', agents.gptbot, { ip: '132.196.86.1', status: 403 }),
      request('2026-10-20T08:00:00Z', '/en/team/z', agents.gptbot, { ip: '132.196.86.1', status: 403 }),
    ]);
    assert.deepEqual(bots[0]!.onAllowedPaths?.statuses, { 403: 1 });
  });
});

describe('AI assistant referrals', () => {
  test('match exact assistant hosts on browser page requests and count utm_source=chatgpt.com apart', () => {
    const { referrals } = run([
      request('2026-10-20T08:00:00Z', '/en/', agents.browser, { referer: 'https://chatgpt.com/' }),
      request('2026-10-20T08:00:00Z', '/en/', agents.browser, { referer: 'https://www.perplexity.ai/search?q=x' }),
      request('2026-10-20T08:00:00Z', '/en/', agents.browser, { referer: 'https://notchatgpt.com/' }),
      request('2026-10-20T08:00:00Z', '/en/', agents.browser, { referer: 'https://chatgpt.com.evil.example/' }),
      request('2026-10-20T08:00:00Z', '/assets/app.js', agents.browser, { referer: 'https://chatgpt.com/' }),
      request('2026-10-20T08:00:00Z', '/en/?utm_source=chatgpt.com', agents.browser, { referer: 'https://chatgpt.com/' }),
      request('2026-10-20T08:00:00Z', '/en/?utm_source=ChatGPT.com', agents.browser),
      request('2026-10-20T08:00:00Z', '/en/', agents.browser, { referer: 'https://gemini.google.com/app', method: 'POST' }),
      request('2026-10-20T08:00:00Z', '/en/', agents.gptbot, { referer: 'https://chatgpt.com/' }),
    ]);
    assert.deepEqual(referrals, {
      byHost: [{ host: 'chatgpt.com', assistant: 'ChatGPT', visits: 2 }, { host: 'perplexity.ai', assistant: 'Perplexity', visits: 1 }], tagged: 2, total: 4,
    });
  });
});
