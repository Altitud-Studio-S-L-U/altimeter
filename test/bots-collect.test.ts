import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseRobots, robotsAvailability } from '../src/fetch/robots.ts';
import type { BotActivity, BotSummary } from '../src/owner/bots/activity.ts';
import { BotActivityError, collectBotActivity, type CollectBotActivityOptions } from '../src/owner/bots/collect.ts';
import { botSiteInput } from '../src/owner/bots/site.ts';
import { listServer, logFixture, loopbackClient, now, scriptedResolver } from './support/bots.ts';
import { page, response, site as siteFacts } from './support/facts.ts';

let lists: Awaited<ReturnType<typeof listServer>>;
let work: string;

before(async () => {
  lists = await listServer();
  work = await mkdtemp(join(tmpdir(), 'altimeter-bot-collect-'));
});

after(async () => {
  await lists.close();
  await rm(work, { recursive: true, force: true });
});

const robots = parseRobots('User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /en/about/\n');
const site = {
  origin: 'https://example.com', robots: { url: 'https://example.com/robots.txt', file: robots, lastModified: 'Tue, 01 Sep 2026 10:00:00 GMT' },
  sitemapUrls: ['https://example.com/en/', 'https://example.com/en/about/', 'https://example.com/en/services/', 'https://example.com/en/contact/'],
};

async function collect(options: Partial<CollectBotActivityOptions>, name = 'cache'): Promise<{ activity: BotActivity; resolver: ReturnType<typeof scriptedResolver> }> {
  const resolver = scriptedResolver({ '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'] }, { 'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'] });
  const client = loopbackClient();
  try {
    const activity = await collectBotActivity({ now, client, dns: resolver, site, ipLists: { cacheDirectory: join(work, name), urls: lists.urls }, ...options });
    return { activity, resolver };
  } finally {
    await client.close();
  }
}

const byId = (activity: BotActivity, id: string): BotSummary | undefined => activity.bots.find(bot => bot.id === id);
const verdicts = (activity: BotActivity) => Object.fromEntries(activity.bots.map(bot => [bot.id, [bot.verified.hits, bot.unverified.hits, bot.spoofed.hits]]));

const expected = {
  googlebot: [2, 0, 1], bingbot: [1, 0, 0], gptbot: [1, 0, 1], 'oai-searchbot': [1, 0, 0], claudebot: [1, 0, 0], 'meta-externalagent': [0, 1, 0],
  perplexitybot: [1, 0, 0], 'chatgpt-user': [1, 0, 0],
};

describe('crawler activity from access logs', () => {
  test('every format gives the same verified, unverified and spoofed counts', async () => {
    for (const file of ['combined.log', 'nginx.ndjson', 'iis.log', 'cloudfront.log', 'alb.log', 'vercel.ndjson', 'netlify.ndjson']) {
      const { activity } = await collect({ logs: [logFixture(file)] }, `cache-${file}`);
      assert.deepEqual(verdicts(activity), expected, file);
      assert.equal(activity.sampled, false);
    }
    const { activity } = await collect({ logs: [logFixture('custom.ndjson')], jsonFields: { time: 'ts', ip: 'client.address', path: 'target', status: 'code', userAgent: 'agent', referer: 'from' } }, 'cache-custom');
    assert.deepEqual(verdicts(activity), expected);
  });

  test('downloads only the lists of crawlers that claimed requests, and looks up only what the lists do not verify', async () => {
    const before = lists.requests.length;
    const { activity, resolver } = await collect({ logs: [logFixture('combined.log')] }, 'cache-lazy');
    const requested = lists.requests.slice(before).sort();
    assert.deepEqual(requested, ['anthropic', 'bingbot', 'cloudflare-v4', 'cloudflare-v6', 'google-common', 'openai-chatgpt-user', 'openai-gptbot', 'openai-searchbot', 'perplexity-bot']);
    assert.deepEqual(resolver.lookups, ['ptr 203.0.113.50']);
    assert.deepEqual(activity.dns, { enabled: true, lookups: 1, errors: 0, capped: false });
    assert.deepEqual(activity.ipLists.find(list => list.id === 'openai-gptbot'), {
      id: 'openai-gptbot', url: lists.urls['openai-gptbot'], from: 'network', prefixes: 2, creationTime: '2026-09-22T02:00:07.000000', fetchedAt: now.toISOString(),
    });
  });

  test('summarises the log, the window, coverage, compliance and referrals', async () => {
    const { activity } = await collect({ logs: [logFixture('combined.log')] }, 'cache-summary');
    assert.deepEqual(activity.sources[0], {
      kind: 'access-log', file: 'combined.log', format: 'combined', lines: 16, records: 13, malformed: 1, skipped: { 'outside-window': 1, 'invalid-request': 1 },
      firstRecord: '2026-10-20T08:00:00.000Z', lastRecord: '2026-11-02T17:00:00.000Z', fields: { userAgent: true, clientIp: true, referer: true, host: false, bytes: true },
    });
    assert.deepEqual(activity.window, { start: '2026-10-05T12:00:00.000Z', end: now.toISOString(), days: 30, firstRecord: '2026-10-20T08:00:00.000Z', lastRecord: '2026-11-02T17:00:00.000Z' });
    assert.deepEqual(activity.site, {
      origin: 'https://example.com', sitemapUrls: 4, robots: { url: 'https://example.com/robots.txt', effectiveFrom: '2026-09-01T10:00:00.000Z', effectiveFromSource: 'last-modified' },
    });
    const googlebot = byId(activity, 'googlebot')!;
    assert.deepEqual(googlebot.coverage, { urls: 4, fetched: 1, ok: 1, missing: ['https://example.com/en/about/', 'https://example.com/en/services/', 'https://example.com/en/contact/'] });
    assert.equal(googlebot.scripts, 1);
    const gptbot = byId(activity, 'gptbot')!;
    assert.equal(gptbot.compliance?.disallowed, 1, 'verified GPTBot fetched /en/about/, which its group disallows');
    assert.equal(byId(activity, 'chatgpt-user')!.compliance, undefined);
    assert.equal(byId(activity, 'oai-searchbot')!.llmsTxt, 1);
    assert.deepEqual(activity.referrals, { byHost: [{ host: 'chatgpt.com', assistant: 'ChatGPT', visits: 1 }], tagged: 1, total: 2 });
    assert.deepEqual(activity.notObservable.map(token => token.name), ['Google-Extended', 'Applebot-Extended']);
    assert.deepEqual(activity.clientIp, { source: 'remote', claims: 11, checkable: 10, discarded: {} });
  });

  test('takes robots.txt from the owner\'s date, else its Last-Modified header, else assumes it unchanged', async () => {
    const owner = await collect({ logs: [logFixture('combined.log')], robotsSince: '2026-10-25' }, 'cache-since');
    assert.deepEqual(owner.activity.site?.robots?.effectiveFromSource, 'owner');
    assert.equal(byId(owner.activity, 'gptbot')!.compliance?.disallowed, 0, 'the request came before the file took effect');
    const { lastModified: _lastModified, ...withoutDate } = site.robots;
    const assumed = await collect({ logs: [logFixture('combined.log')], site: { ...site, robots: withoutDate } }, 'cache-assumed');
    assert.deepEqual([assumed.activity.site?.robots?.effectiveFromSource, assumed.activity.site?.robots?.effectiveFrom], ['assumed', '2026-10-05T12:00:00.000Z']);
  });

  test('compares the requests of the www host that an audited apex redirects to', async () => {
    const rules = 'User-agent: *\nDisallow: /private/\n';
    const robotsUrl = 'https://example.com/robots.txt';
    const home = page('https://example.com/', { redirects: [[301, 'https://www.example.com/']] });
    const audited = {
      ...siteFacts({ origin: 'https://example.com', pages: [home], homeUrl: home.fetch.finalUrl, sitemaps: [{
        url: 'https://www.example.com/sitemap.xml',
        xml: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.example.com/en/</loc></url><url><loc>https://www.example.com/en/about/</loc></url></urlset>',
      }] }),
      robots: {
        url: robotsUrl, fetch: response(robotsUrl, { body: rules, headers: { 'content-type': 'text/plain' }, redirects: [[301, 'https://www.example.com/robots.txt']] }),
        availability: robotsAvailability(200, Buffer.from(rules)),
      },
    };
    const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    const line = (time: string, uri: string, status: number, host: string) => JSON.stringify({
      time_iso8601: time, remote_addr: '66.249.64.10', request_method: 'GET', request_uri: uri, status: String(status), body_bytes_sent: '100', http_host: host, http_user_agent: googlebot,
    });
    const path = join(work, 'www-host.ndjson');
    await writeFile(path, `${[
      line('2026-10-20T08:00:00+00:00', '/en/', 403, 'www.example.com'), line('2026-10-20T09:00:00+00:00', '/en/about/', 403, 'www.example.com'),
      line('2026-10-20T10:00:00+00:00', '/en/services/', 403, 'www.example.com'), line('2026-10-21T08:00:00+00:00', '/private/x', 200, 'www.example.com'),
      line('2026-10-21T09:00:00+00:00', '/en/', 301, 'example.com'),
    ].join('\n')}\n`);
    const { activity } = await collect({ logs: [path], site: botSiteInput(audited) }, 'cache-www-host');
    assert.equal(activity.site?.origin, 'https://www.example.com');
    const summary = byId(activity, 'googlebot')!;
    assert.deepEqual([summary.verified.hits, summary.onAllowedPaths?.hits, summary.onAllowedPaths?.statuses], [5, 3, { 403: 3 }], 'the refusals on the www host are compared');
    assert.deepEqual([summary.coverage?.urls, summary.coverage?.fetched, summary.coverage?.ok], [2, 2, 0]);
    assert.equal(summary.compliance?.disallowed, 1);
  });

  test('reads gzip files and several files together', async () => {
    const path = join(work, 'access.log.2.gz');
    await writeFile(path, gzipSync(await readFile(logFixture('combined.log'))));
    const { activity } = await collect({ logs: [path, logFixture('nginx.ndjson')] }, 'cache-gzip');
    assert.deepEqual(byId(activity, 'googlebot') && [byId(activity, 'googlebot')!.verified.hits, byId(activity, 'googlebot')!.spoofed.hits], [4, 2]);
    assert.deepEqual(activity.sources.map(source => source.kind === 'access-log' && [source.file, source.format]), [['access.log.2.gz', 'combined'], ['nginx.ndjson', 'nginx-json']]);
  });

  test('without reverse DNS, or past its limit, the crawlers that need it stay unverified', async () => {
    const off = await collect({ logs: [logFixture('combined.log')], dns: false }, 'cache-nodns');
    assert.deepEqual([byId(off.activity, 'googlebot')!.unverified.hits, byId(off.activity, 'googlebot')!.unverifiedReasons], [1, { 'dns-disabled': 1 }]);
    assert.deepEqual(off.resolver.lookups, []);
    const capped = await collect({ logs: [logFixture('combined.log')], maxDnsLookups: 0 }, 'cache-cap');
    assert.deepEqual(byId(capped.activity, 'googlebot')!.unverifiedReasons, { 'dns-not-checked': 1 });
    assert.equal(capped.activity.dns.capped, true);
    assert.match(capped.activity.warnings.join('\n'), /Reverse DNS was limited/u);
  });

  test('a log that records a proxy is not used to verify, and the right X-Forwarded-For entry fixes it', async () => {
    const remote = await collect({ logs: [logFixture('combined-behind-proxy.log')] }, 'cache-proxy');
    assert.deepEqual(byId(remote.activity, 'googlebot')!.unverifiedReasons, { 'private-address': 3 });
    assert.equal(remote.activity.clientIp.discarded['private-address'], 10, 'claims of crawlers without a published check are not checked at all');
    assert.match(remote.activity.warnings.join('\n'), /private or loopback addresses/u);
    const forwarded = await collect({ logs: [logFixture('combined-behind-proxy.log')], ipSource: 'xff-last' }, 'cache-xff');
    assert.deepEqual(verdicts(forwarded.activity), expected);
    const cloudflareFront = join(work, 'behind-cloudflare.log');
    await writeFile(cloudflareFront, (await readFile(logFixture('combined.log'), 'utf8')).replace(/^66\.249\.64\.10 /gmu, '103.21.244.5 '));
    const edge = await collect({ logs: [cloudflareFront] }, 'cache-cf-front');
    assert.equal(byId(edge.activity, 'googlebot')!.unverifiedReasons['proxy-address'], 2);
    assert.match(edge.activity.warnings.join('\n'), /Cloudflare's own addresses/u);
  });

  test('a log whose requests come from one or two public addresses is treated as a proxy\'s', async () => {
    const path = join(work, 'one-address.log');
    const line = (index: number) => `198.51.100.200 - - [20/Oct/2026:10:${String(index % 60).padStart(2, '0')}:00 +0200] "GET /p${index} HTTP/1.1" 200 10 "-" "${index % 10 === 0 ? 'Mozilla/5.0 (compatible; Googlebot/2.1)' : 'Mozilla/5.0 Chrome/141.0'}"`;
    await writeFile(path, `${Array.from({ length: 300 }, (_, index) => line(index)).join('\n')}\n`);
    const { activity, resolver } = await collect({ logs: [path] }, 'cache-suspected');
    assert.deepEqual(byId(activity, 'googlebot')!.unverifiedReasons, { 'proxy-suspected': 30 });
    assert.deepEqual(resolver.lookups, []);
    assert.match(activity.warnings.join('\n'), /one or two addresses/u);
  });

  test('explains what the data cannot show instead of reporting zero', async () => {
    const common = await collect({ logs: [logFixture('common.log')] }, 'cache-common');
    assert.deepEqual(common.activity.bots, []);
    assert.match(common.activity.warnings.join('\n'), /Common Log Format, which has no user agent/u);
    assert.equal(common.activity.referrals, undefined);
    const netlify = await collect({ logs: [logFixture('netlify-pii-excluded.ndjson')] }, 'cache-pii');
    assert.match(netlify.activity.warnings.join('\n'), /Netlify removes client_ip and user_agent/u);
    const old = join(work, 'old.log');
    await writeFile(old, '66.249.64.10 - - [01/Jan/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 10 "-" "Googlebot/2.1"\n');
    const outside = await collect({ logs: [old] }, 'cache-old');
    assert.match(outside.activity.warnings.join('\n'), /No request falls within the window/u);
  });

  test('refuses inputs it cannot read', async () => {
    const unknown = join(work, 'unknown.txt');
    await writeFile(unknown, 'hello\nworld\n');
    await assert.rejects(collect({ logs: [unknown] }, 'cache-unknown'), (error: unknown) => error instanceof BotActivityError && /was not recognised/u.test(error.message));
    await assert.rejects(collect({ logs: [join(work, 'missing.log')] }, 'cache-missing'), (error: unknown) => error instanceof BotActivityError && /missing\.log could not be read/u.test(error.message));
    await assert.rejects(collect({ logs: [] }, 'cache-none'), /Give access logs or a Cloudflare zone/u);
    await assert.rejects(collect({ logs: [logFixture('combined.log')], days: 0 }, 'cache-days'), /whole number of days/u);
  });

  test('skips the files of a folder that are empty or not access logs, and refuses a named file that is not one', async () => {
    const errorLog = join(work, 'error.log');
    await writeFile(errorLog, '2026/11/03 10:00:00 [error] 1234#0: *1 open() "/var/www/html/favicon.ico" failed (2: No such file or directory)\n');
    const rotated = join(work, 'access.log.1');
    await writeFile(rotated, '');
    const folder = await collect({ logs: [{ path: logFixture('combined.log'), inFolder: true }, { path: errorLog, inFolder: true }, { path: rotated, inFolder: true }] }, 'cache-folder');
    assert.deepEqual(verdicts(folder.activity), expected);
    assert.deepEqual(folder.activity.sources.map(source => source.kind === 'access-log' && source.file), ['combined.log']);
    assert.match(folder.activity.warnings.join('\n'), /The format of error\.log was not recognised, so it was skipped\./u);
    assert.match(folder.activity.warnings.join('\n'), /access\.log\.1 is empty, so it was skipped\./u);
    const named = await collect({ logs: [logFixture('combined.log'), rotated] }, 'cache-named-empty');
    assert.deepEqual(verdicts(named.activity), expected, 'an empty file holds no request, however it was given');
    await assert.rejects(collect({ logs: [logFixture('combined.log'), errorLog] }, 'cache-named-error'), /The format of error\.log was not recognised\. Supported formats are combined/u);
  });

  test('marks addresses of lists that could not be read as unverified', async () => {
    const urls = { ...lists.urls, 'openai-gptbot': `${lists.base}/lists/not-there` };
    const client = loopbackClient();
    const activity = await collectBotActivity({ now, client, dns: false, logs: [logFixture('combined.log')], ipLists: { cacheDirectory: join(work, 'cache-404'), urls } });
    await client.close();
    assert.deepEqual(byId(activity, 'gptbot')!.unverifiedReasons, { 'list-unavailable': 2 }, 'without its list neither GPTBot claim can be verified or refuted');
    assert.equal(byId(activity, 'gptbot')!.verified.hits + byId(activity, 'gptbot')!.spoofed.hits, 0);
    assert.equal(byId(activity, 'oai-searchbot')!.verified.hits, 1, 'the other lists still verify their crawlers');
    assert.match(activity.warnings.join('\n'), /The address list openai-gptbot could not be read \(answered HTTP 404\)/u);
  });
});
