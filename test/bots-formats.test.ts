import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { LogFormat } from '../src/owner/bots/activity.ts';
import { createParser, detectFormat, forwardedAddress, parseClfTime, parseTimeValue, unescapeLogField, type LogRecord, type ParserOptions } from '../src/owner/bots/formats.ts';
import { readLogLines, splitLines, type LineEvent } from '../src/owner/bots/lines.ts';
import { logFixture } from './support/bots.ts';

async function lines(name: string): Promise<string[]> {
  return (await readFile(logFixture(name), 'utf8')).split('\n').filter(line => line !== '');
}

async function parse(name: string, format: LogFormat, options: ParserOptions = {}) {
  const parser = createParser(format, options);
  const records: LogRecord[] = [];
  const outcomes: Record<string, number> = {};
  for (const line of await lines(name)) {
    const result = parser.parse(line);
    const key = result.kind === 'skip' || result.kind === 'malformed' ? `${result.kind}:${result.reason}` : result.kind;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    if (result.kind === 'records') records.push(...result.records);
  }
  return { records, outcomes };
}

const googlebotUa = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const first = { time: Date.parse('2026-10-20T08:00:00Z'), ip: '66.249.64.10', method: 'GET', path: '/en/', status: 200, bytes: 5120 };

describe('log format detection', () => {
  test('recognises every supported format from its first lines', async () => {
    const expected: Record<string, LogFormat> = {
      'combined.log': 'combined', 'common.log': 'common', 'nginx.ndjson': 'nginx-json', 'custom.ndjson': 'nginx-json', 'iis.log': 'iis',
      'cloudfront.log': 'cloudfront', 'alb.log': 'alb', 'cloudflare.ndjson': 'cloudflare', 'vercel.ndjson': 'vercel', 'netlify.ndjson': 'netlify',
    };
    for (const [file, format] of Object.entries(expected)) assert.equal(detectFormat((await lines(file)).slice(0, 50)), format, file);
    assert.equal(detectFormat(['not a log', '{"broken"']), undefined);
  });
});

describe('access log parsers', () => {
  test('combined: local time with offset becomes UTC, escaped request lines are skipped and garbage is malformed', async () => {
    const { records, outcomes } = await parse('combined.log', 'combined');
    assert.deepEqual({ ...records[0], userAgent: undefined }, { ...first, userAgent: undefined });
    assert.equal(records[0]!.userAgent, googlebotUa);
    assert.equal(records.find(record => record.ip === '192.0.2.10')?.referer, 'https://chatgpt.com/');
    assert.equal(records.length, 14);
    assert.deepEqual([outcomes['skip:invalid-request'], outcomes['malformed:pattern']], [1, 1]);
  });

  test('combined behind a proxy: the client address comes from the configured X-Forwarded-For entry', async () => {
    const remote = await parse('combined-behind-proxy.log', 'combined');
    assert.equal(remote.records[0]!.ip, '10.0.0.5');
    const last = await parse('combined-behind-proxy.log', 'combined', { ipSource: 'xff-last' });
    assert.equal(last.records[0]!.ip, '66.249.64.10');
    const firstEntry = await parse('combined-behind-proxy.log', 'combined', { ipSource: 'xff-first' });
    assert.equal(firstEntry.records[0]!.ip, '198.51.100.200');
    const missing = createParser('combined', { ipSource: 'xff-last' }).parse('66.249.64.10 - - [20/Oct/2026:10:00:00 +0200] "GET / HTTP/1.1" 200 1 "-" "x"');
    assert.ok(missing.kind === 'records' && missing.records[0]!.ip === undefined, 'no fallback to the proxy address');
  });

  test('common: requests without referer or user agent', async () => {
    const { records, outcomes } = await parse('common.log', 'common');
    assert.equal(records.length, 14);
    assert.equal(records[0]!.userAgent, undefined);
    assert.equal(outcomes['malformed:pattern'], 1);
  });

  test('nginx JSON with the usual variable names, and with configured field names', async () => {
    const usual = await parse('nginx.ndjson', 'nginx-json');
    assert.deepEqual({ ...usual.records[0], userAgent: undefined }, { ...first, userAgent: undefined });
    assert.equal(usual.outcomes['malformed:json'], 1);
    const custom = await parse('custom.ndjson', 'nginx-json', {
      jsonFields: { time: 'ts', ip: 'client.address', method: 'verb', path: 'target', status: 'code', bytes: 'size', referer: 'from', userAgent: 'agent' },
    });
    assert.deepEqual({ ...custom.records[0], userAgent: undefined }, { ...first, userAgent: undefined });
    assert.equal(custom.records.find(record => record.ip === '192.0.2.11')?.path, '/en/services/?utm_source=chatgpt.com');
    const unmapped = await parse('custom.ndjson', 'nginx-json');
    assert.ok(unmapped.records.every(record => record.ip === undefined), 'without a mapping the nested address is not guessed');
  });

  test('IIS: the latest #Fields directive names the columns and + stands for spaces', async () => {
    const { records, outcomes } = await parse('iis.log', 'iis');
    assert.equal(records[0]!.userAgent?.includes('Nexus 5X Build/MMB29P'), true);
    assert.deepEqual({ ...records[0], userAgent: undefined }, { ...first, userAgent: undefined });
    assert.equal(records.find(record => record.ip === '192.0.2.11')?.path, '/en/services/?utm_source=chatgpt.com');
    assert.equal(outcomes.directive, 4);
    assert.equal(outcomes['malformed:columns'], 1);
    const parser = createParser('iis');
    parser.parse('#Fields: c-ip date time cs-method cs-uri-stem sc-status cs(User-Agent) a b c d e');
    const swapped = parser.parse('203.0.113.9 2026-10-30 10:00:00 GET /x 404 curl/8.0 - - - - -');
    assert.ok(swapped.kind === 'records' && swapped.records[0]!.ip === '203.0.113.9' && swapped.records[0]!.status === 404);
  });

  test('CloudFront: tab-separated, URL-encoded user agent, host from x-host-header', async () => {
    const { records } = await parse('cloudfront.log', 'cloudfront');
    assert.equal(records[0]!.userAgent, googlebotUa);
    assert.equal(records[0]!.host, 'example.com');
    assert.equal(records[0]!.requestId, 'request-0');
    assert.deepEqual({ ...records[0], userAgent: undefined, host: undefined, requestId: undefined }, { ...first, userAgent: undefined, host: undefined, requestId: undefined });
  });

  test('ALB: client and port split, path and host from the request line, IPv6 clients', async () => {
    const { records } = await parse('alb.log', 'alb');
    assert.deepEqual([records[0]!.ip, records[0]!.host, records[0]!.path, records[0]!.status, records[0]!.bytes], ['66.249.64.10', 'example.com', '/en/', 200, 5120]);
    assert.equal(records[0]!.time, Date.parse('2026-10-20T08:00:00.123Z'));
    const line = 'h2 2026-10-30T10:00:00.000000Z app/lb/1 [2001:4860:4801:10::5]:443 - 0.000 0.001 0.000 200 - 10 20 "GET https://example.com:443/a?b=1 HTTP/2.0" "Googlebot/2.1" - -';
    const parsed = createParser('alb').parse(line);
    assert.ok(parsed.kind === 'records');
    assert.deepEqual([parsed.records[0]!.ip, parsed.records[0]!.path], ['2001:4860:4801:10::5', '/a?b=1']);
    assert.equal(createParser('alb').parse('http 2026-10-30T10:00:00Z app/lb/1 1.2.3.4:5 - -1 -1 -1 400 - 0 0 "- - - " "-" - -').kind, 'skip');
  });

  test('Cloudflare Logpush: epoch nanoseconds, verified bot category, challenges and ray ids', async () => {
    const { records } = await parse('cloudflare.ndjson', 'cloudflare');
    assert.equal(records[0]!.edgeCategory, 'Search Engine Crawler');
    assert.equal(records.find(record => record.ip === '203.0.113.60')?.challenged, true);
    assert.equal(records.find(record => record.ip === '203.0.113.60')?.edgeCategory, '');
    const nanoseconds = records.find(record => record.ip === '66.249.66.1');
    assert.equal(nanoseconds?.time, Date.parse('2026-10-30T12:00:00Z'));
    assert.match(records[0]!.requestId ?? '', /^8f1c2d3e4a5b/u);
  });

  test('Vercel drains: proxy requests only, batches, revalidations skipped', async () => {
    const { records, outcomes } = await parse('vercel.ndjson', 'vercel');
    assert.equal(outcomes['skip:not-a-request'], 1);
    assert.equal(outcomes['skip:background-revalidation'], 1);
    assert.equal(records.length, 15, 'the batch line holds eight requests and the duplicate line is still parsed');
    assert.deepEqual({ ...records[0], userAgent: undefined, host: undefined, requestId: undefined }, { ...first, userAgent: undefined, host: undefined, requestId: undefined });
    assert.equal(records[0]!.requestId, 'req-0');
  });

  test('Netlify drains: traffic logs only; with PII excluded there is no address or user agent', async () => {
    const { records, outcomes } = await parse('netlify.ndjson', 'netlify');
    assert.equal(outcomes['skip:not-a-request'], 1);
    assert.deepEqual([records[0]!.host, records[0]!.path, records[0]!.ip], ['example.com', '/en/', '66.249.64.10']);
    const excluded = await parse('netlify-pii-excluded.ndjson', 'netlify');
    assert.ok(excluded.records.length === 4 && excluded.records.every(record => record.ip === undefined && record.userAgent === undefined));
  });
});

describe('field decoding', () => {
  test('times in Common Log Format and epoch units', () => {
    assert.equal(parseClfTime('10/Oct/2000:13:55:36 -0700'), Date.parse('2000-10-10T20:55:36Z'));
    assert.equal(parseClfTime('31/Feb/2026:25:00:00 +0000'), Date.parse('2026-03-04T01:00:00Z'));
    assert.equal(parseClfTime('yesterday'), undefined);
    const second = Date.parse('2026-10-30T12:00:00Z') / 1000;
    for (const value of [second, second * 1e3, second * 1e6, second * 1e9, String(second), `${second}.25`]) {
      assert.equal(Math.floor((parseTimeValue(value) ?? 0) / 1000), second, String(value));
    }
    assert.equal(parseTimeValue('2026-10-30T12:00:00+02:00'), Date.parse('2026-10-30T10:00:00Z'));
    assert.equal(parseTimeValue('not a time'), undefined);
  });

  test('nginx and Apache escapes, including UTF-8 bytes', () => {
    assert.equal(unescapeLogField(String.raw`GET /caf\xC3\xA9 HTTP/1.1`), `GET /caf${String.fromCodePoint(0xe9)} HTTP/1.1`);
    assert.equal(unescapeLogField(String.raw`say \"hi\" \\ there`), 'say "hi" \\ there');
  });

  test('X-Forwarded-For entries', () => {
    assert.equal(forwardedAddress('198.51.100.1, 203.0.113.5:443', 'xff-last'), '203.0.113.5');
    assert.equal(forwardedAddress('[2001:db8::1]:8443, unknown', 'xff-first'), '2001:db8::1');
    assert.equal(forwardedAddress('unknown', 'xff-last'), undefined);
    assert.equal(forwardedAddress('-', 'xff-first'), undefined);
  });
});

describe('line reading', () => {
  let work: string;
  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'altimeter-bot-lines-'));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const collect = async (events: AsyncIterable<LineEvent>) => {
    const out: LineEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  };

  test('reads gzip by its magic bytes, including several gzip members in one file', async () => {
    const text = await readFile(logFixture('combined.log'));
    const path = join(work, 'access.log.1');
    await writeFile(path, Buffer.concat([gzipSync(text), gzipSync(Buffer.from('extra line\n'))]));
    const events = await collect(readLogLines(path));
    const plain = text.toString('utf8').split('\n').filter(Boolean);
    assert.deepEqual(events.map(event => ('line' in event ? event.line : '')).filter(Boolean), [...plain, 'extra line']);
  });

  test('bounds line length, strips CR and ends a truncated gzip file with an error event', async () => {
    const stream = Readable.from([Buffer.from('short\r\n'), Buffer.from('x'.repeat(40)), Buffer.from('y'.repeat(40)), Buffer.from('\nlast')]);
    assert.deepEqual(await collect(splitLines(stream, 64)), [{ line: 'short' }, { tooLong: true }, { line: 'last' }]);
    const path = join(work, 'cut.log.gz');
    const text = Array.from({ length: 4000 }, (_, index) => `line ${index} ${(index * 2654435761 % 4294967296).toString(36)}`).join('\n');
    const full = gzipSync(Buffer.from(text));
    await writeFile(path, full.subarray(0, Math.floor(full.length / 2)));
    const events = await collect(readLogLines(path));
    assert.ok('error' in events.at(-1)!, 'the last event reports the incomplete file');
    assert.ok(events.some(event => 'line' in event && event.line.startsWith('line 0 ')), 'the lines before the cut are read');
  });
});
