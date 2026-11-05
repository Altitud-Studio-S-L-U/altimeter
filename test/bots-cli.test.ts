import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { botsCommand, botsHelp, BotsUsageError, type BotsCommandContext } from '../src/cli/bots.ts';
import type { BotsReport } from '../src/owner/bots/report.ts';
import { listServer, logFixture, loopbackClient, now, scriptedResolver } from './support/bots.ts';

let site: Server;
let origin: string;
let lists: Awaited<ReturnType<typeof listServer>>;
let work: string;

before(async () => {
  site = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      return void response.writeHead(200, { 'content-type': 'text/plain', 'last-modified': 'Tue, 01 Sep 2026 10:00:00 GMT' })
        .end(`User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /en/about/\n\nSitemap: ${origin}/sitemap.xml\n`);
    }
    if (request.url === '/sitemap.xml') {
      const urls = ['/en/', '/en/about/', '/en/services/', '/en/contact/'].map(path => `<url><loc>${origin}${path}</loc></url>`).join('');
      return void response.writeHead(200, { 'content-type': 'application/xml' }).end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  lists = await listServer();
  work = await mkdtemp(join(tmpdir(), 'altimeter-bot-cli-'));
});

after(async () => {
  site.closeAllConnections();
  await new Promise(resolve => site.close(resolve));
  await lists.close();
  await rm(work, { recursive: true, force: true });
});

async function run(args: string[], extra: Partial<BotsCommandContext> = {}) {
  const client = loopbackClient();
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const code = await botsCommand(args, {
      client, now, dns: scriptedResolver({}, {}), ipLists: { cacheDirectory: join(work, 'lists'), urls: lists.urls }, env: {},
      stdout: text => void stdout.push(text), stderr: text => void stderr.push(text), ...extra,
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    await client.close();
  }
}

async function output(directory: string): Promise<{ json: BotsReport; markdown: string; raw: string }> {
  const host = (await readdir(directory))[0]!;
  const run = (await readdir(join(directory, host))).sort().at(-1)!;
  const raw = await readFile(join(directory, host, run, 'bots.json'), 'utf8');
  return { json: JSON.parse(raw) as BotsReport, markdown: await readFile(join(directory, host, run, 'bots.md'), 'utf8'), raw };
}

describe('altimeter bots', () => {
  test('writes bots.json and bots.md with the findings of the crawler rules', async () => {
    const out = join(work, 'out-en');
    const result = await run(['--logs', logFixture('combined.log'), '--site', origin, '--out', out, '--quiet']);
    assert.equal(result.code, 0);
    const { json, markdown } = await output(out);
    assert.deepEqual([json.schemaVersion, json.tool.name, json.origin], [1, 'altimeter', origin]);
    assert.equal(json.activity.site?.robots?.effectiveFromSource, 'last-modified');
    assert.ok(json.findings.some(finding => finding.ruleId === 'crawl-bots-robots-compliance' && finding.outcome === 'fail'), 'verified GPTBot fetched a disallowed path');
    assert.ok(json.findings.some(finding => finding.ruleId === 'ai-bots-blocked-at-edge'));
    assert.ok(json.evidence.length > 0);
    assert.match(markdown, /^# Crawler activity on 127\.0\.0\.1:\d+$/mu);
    assert.match(markdown, /^\| Crawler \| Operator \| Purpose \| Verified \| Unverified \| Spoofed \| Last verified \| robots\.txt \| llms\.txt \|$/mu);
    assert.match(markdown, /^\| GPTBot \| OpenAI \| training \| 1 \| 0 \| 1 \| 2026-10-23 \| 0 \| 0 \|$/mu);
    assert.match(markdown, /^\| meta-externalagent \| Meta \| training \| no published check: 1 \| - \| - \|/mu);
    assert.match(markdown, /Google-Extended \(Google\) is a robots\.txt token that no request carries/u);
    assert.match(markdown, /chatgpt\.com \(ChatGPT\): 1/u);
    assert.equal(result.stdout.trim().endsWith('-bots'), true, 'quiet prints the output folder only');
  });

  test('writes bots.md in Spanish and Catalan', async () => {
    for (const [lang, heading] of [['es', '## Rastreadores'], ['ca', '## Rastrejadors']] as const) {
      const out = join(work, `out-${lang}`);
      assert.equal((await run(['--logs', logFixture('nginx.ndjson'), '--out', out, '--lang', lang, '--quiet'])).code, 0);
      assert.ok((await output(out)).markdown.includes(`\n${heading}\n`), lang);
    }
  });

  test('prints its progress, summary and warnings in the language of --lang', async () => {
    const spanish = await run(['--logs', logFixture('nginx.ndjson'), '--out', join(work, 'out-es-terminal'), '--lang', 'es']);
    assert.equal(spanish.code, 0);
    assert.match(spanish.stderr, /^· Sin --site: no se comparan el robots\.txt ni los sitemaps\.$/mu);
    assert.match(spanish.stderr, /^· Leyendo nginx\.ndjson$/mu);
    assert.match(spanish.stdout, /^Actividad de rastreadores del 20\d\d-\d\d-\d\d al 20\d\d-\d\d-\d\d$/mu);
    assert.match(spanish.stdout, /^ {2}GPTBot \(OpenAI, entrenamiento\): 1 verificada, 0 sin verificar, 1 suplantada$/mu);
    assert.match(spanish.stdout, /^ {2}meta-externalagent \(Meta, entrenamiento\): 1 declarada, sin comprobación publicada$/mu);
    assert.match(spanish.stdout, /^\d+ hallazgos? · /mu);
    const catalan = await run(['--logs', logFixture('nginx.ndjson'), '--out', join(work, 'out-ca-terminal'), '--lang', 'ca']);
    assert.match(catalan.stdout, /^Troballes: \d+ · /mu);
    for (const text of [spanish.stdout, spanish.stderr, catalan.stdout]) assert.doesNotMatch(text, /Crawler activity|Reading |finding\(s\)|verified,/u);
  });

  test('keeps hostile log text out of the terminal and quotes it as untrusted data', async () => {
    const escape = String.fromCharCode(27);
    const override = String.fromCodePoint(0x202e);
    const path = join(work, 'hostile.log');
    const hostilePath = String.raw`/en/about/\x1B[2J](javascript:alert(1))`;
    await writeFile(path, [
      `132.196.86.20 - - [23/Oct/2026:13:00:00 +0200] "GET ${hostilePath} HTTP/1.1" 200 10 "-" "Mozilla/5.0 (compatible; GPTBot/1.4; ${override}<script>alert(1)</script>)" "-"`,
      `132.196.86.21 - - [24/Oct/2026:13:00:00 +0200] "GET /en/about/x HTTP/1.1" 200 10 "-" "GPTBot/1.4" "-"`,
    ].join('\n'));
    const out = join(work, 'out-hostile');
    const result = await run(['--logs', path, '--site', origin, '--out', out]);
    assert.equal(result.code, 0);
    const { markdown, raw } = await output(out);
    for (const text of [markdown, raw, result.stdout, result.stderr]) {
      assert.ok(!text.includes(escape) && !text.includes(override), 'no terminal escape or bidi override survives');
      assert.ok(!text.includes('\\u001b') && !text.includes('\\u202e'), 'not even escaped in JSON');
    }
    assert.match(markdown, /```untrusted\n {4}\/en\/about\/\]\(javascript:alert\(1\)\) \(1, 2026-10-23\)/u, 'the escape sequence is removed and the rest stays inside an untrusted block');
    assert.ok(!raw.includes(work), 'no local folder appears in bots.json');
    assert.match(raw, /"file": "hostile\.log"/u);
  });

  test('reads Cloudflare with the token from the environment and never writes it', async () => {
    const token = 'cf-cli-token-value-0001';
    const zoneTag = '023e105f4ecef8ad9ca31a8372d0c353';
    const api = createServer((request, response) => {
      const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (request.headers.authorization !== `Bearer ${token}`) return void json(403, { success: false, errors: [{ message: 'Authentication error' }] });
      if ((request.url ?? '').startsWith('/client/v4/zones')) return void json(200, { success: true, result: [{ id: zoneTag, name: 'example.com' }] });
      let text = '';
      request.on('data', chunk => (text += chunk));
      request.on('end', () => {
        const query = (JSON.parse(text) as { query: string }).query;
        if (query.includes('settings')) {
          return void json(200, { data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: {
            enabled: true, maxDuration: 2_678_400, notOlderThan: 2_678_400, maxPageSize: 100, maxNumberOfFields: 30,
            availableFields: ['count', 'dimensions_date', 'dimensions_userAgent', 'dimensions_clientRequestPath', 'dimensions_edgeResponseStatus', 'dimensions_verifiedBotCategory'],
          } } }] } } });
        }
        json(200, { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
          { count: 120, dimensions: { date: '2026-11-01', userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', clientRequestPath: '/en/', edgeResponseStatus: 200, verifiedBotCategory: 'Search Engine Crawler' } },
          { count: 9, dimensions: { date: '2026-11-02', userAgent: 'Mozilla/5.0 (compatible; GPTBot/1.4; +https://openai.com/gptbot)', clientRequestPath: '/en/', edgeResponseStatus: 403, verifiedBotCategory: '' } },
        ] }] } } });
      });
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(api.address() as AddressInfo).port}/client/v4`;
    try {
      const out = join(work, 'out-cloudflare');
      const result = await run(['--cloudflare-zone', 'example.com', '--site', origin, '--out', out], { env: { ALTIMETER_CLOUDFLARE_API_TOKEN: token }, cloudflareEndpoint: endpoint });
      assert.equal(result.code, 0);
      const { json, markdown, raw } = await output(out);
      assert.equal(json.activity.sampled, true);
      assert.match(markdown, /Cloudflare samples these data, so counts marked ~ are estimates\./u);
      assert.match(markdown, /^\| Googlebot \| Google \| search \| ~120 \|/mu);
      assert.match(result.stdout, /Googlebot \(Google, search\): 120 verified, 0 unverified, 0 spoofed \(estimates\)/u);
      for (const text of [raw, markdown, result.stdout, result.stderr]) assert.ok(!text.includes(token), 'the token is never written');
      const refused = run(['--cloudflare-zone', 'example.com', '--site', origin, '--out', out], { env: { ALTIMETER_CLOUDFLARE_API_TOKEN: 'another-secret-value' }, cloudflareEndpoint: endpoint });
      await assert.rejects(refused, (error: unknown) => error instanceof BotsUsageError && !error.message.includes('another-secret-value') && /refused the token/u.test(error.message));
    } finally {
      api.closeAllConnections();
      await new Promise(resolve => api.close(resolve));
    }
  });

  test('skips the files of a log folder that are not access logs, but not a file named itself', async () => {
    const folder = join(work, 'nginx');
    await mkdir(folder);
    await writeFile(join(folder, 'access.log'), await readFile(logFixture('combined.log')));
    await writeFile(join(folder, 'error.log'), '2026/11/03 10:00:00 [error] 1234#0: *1 open() "/var/www/html/favicon.ico" failed (2: No such file or directory)\n');
    const out = join(work, 'out-folder');
    const result = await run(['--logs', folder, '--out', out]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /The format of error\.log was not recognised, so it was skipped\./u);
    const { json } = await output(out);
    assert.deepEqual(json.activity.sources.map(source => source.kind === 'access-log' && source.file), ['access.log']);
    await assert.rejects(run(['--logs', folder, '--logs', join(folder, 'error.log')]),
      (error: unknown) => error instanceof BotsUsageError && /The format of error\.log was not recognised\. Supported formats are combined/u.test(error.message), 'a file named itself is still checked');
  });

  test('rejects wrong options with a message and prints help', async () => {
    const cases: Array<[string[], RegExp]> = [
      [[], /needs --cloudflare-zone or --logs/u],
      [['--logs', logFixture('combined.log'), '--days', '0'], /--days must be a whole number from 1 to 400/u],
      [['--logs', logFixture('combined.log'), '--ip-source', 'proxy'], /--ip-source must be remote, xff-first or xff-last/u],
      [['--logs', logFixture('combined.log'), '--json-fields', 'when=ts'], /--json-fields takes role=field pairs/u],
      [['--logs', logFixture('combined.log'), '--log-format', 'apache'], /--log-format must be one of/u],
      [['--logs', logFixture('combined.log'), '--robots-since', 'last week'], /--robots-since must be a date/u],
      [['--logs', join(work, 'nothing-here.log')], /nothing-here\.log does not exist/u],
      [['--logs', logFixture('combined.log'), '--lang', 'fr'], /--lang must be en, es or ca/u],
      [['--logs', logFixture('combined.log'), '--site', 'ftp://example.com/'], /--site must be an http or https URL/u],
    ];
    for (const [args, pattern] of cases) await assert.rejects(run(args), (error: unknown) => error instanceof BotsUsageError && pattern.test(error.message), args.join(' '));
    const help = await run(['--help']);
    assert.deepEqual([help.code, help.stdout], [0, botsHelp]);
  });
});
