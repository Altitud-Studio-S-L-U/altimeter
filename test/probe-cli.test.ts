import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test, type TestContext } from 'node:test';
import { aiProbeCommand, aiProbeHelp, type AiProbeContext } from '../src/cli/ai-probe.ts';
import type { GscData } from '../src/owner/gsc.ts';
import type { ProbeReport } from '../src/probe/types.ts';
import { probeDouble } from './fixtures/probe/doubles.ts';
import { sandbox, testEnv } from './support/providers.ts';

let server: Server;
let origin: string;
let host: string;

before(async () => {
  server = createServer((req, res) => {
    const html = (body: string) => void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    if (req.url === '/') {
      return html(`<!doctype html><html lang="en"><head><title>Web design in Andorra | Altitud Studio</title><meta property="og:site_name" content="Altitud Studio"></head>
        <body><h1>Altitud Studio</h1><a href="/services/">Services</a></body></html>`);
    }
    if (req.url === '/services/') return html('<!doctype html><html lang="en"><head><title>Services</title></head><body><h1>Technical SEO audits for small businesses</h1></body></html>');
    res.writeHead(404, { 'content-type': 'text/html' }).end('<title>Not found</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  host = new URL(origin).host;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function setup(t: TestContext, scenarios: { claude?: object; codex?: object } = {}) {
  const home = await sandbox(t);
  const site = `${origin}/services/`;
  const claude = await probeDouble(home, 'claude', scenarios.claude ?? {
    default: {
      searches: [{ links: [{ title: 'Services', url: site }, { title: 'Rival', url: 'https://rival.example/' }] }],
      answer: `Altitud Studio audits sites.\n\nSources:\n- ${site}\n- https://rival.example/`,
    },
  });
  const codex = await probeDouble(home, 'codex', scenarios.codex ?? { default: { searches: ['q'], answer: `See ${site}?utm_source=chatgpt.com` } });
  const env = testEnv(home, { claude: claude.executable, codex: codex.executable });
  const out = join(home, 'reports');
  let stdout = '';
  let stderr = '';
  const context = (extra: Partial<AiProbeContext> = {}): AiProbeContext => ({
    env,
    policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) },
    stdout: text => void (stdout += text),
    stderr: text => void (stderr += text),
    cwd: home,
    probe: { pauseMs: 0, now: () => new Date('2026-11-04T10:00:00.000Z') },
    ...extra,
  });
  const run = async (args: string[], extra: Partial<AiProbeContext> = {}) => {
    stdout = '';
    stderr = '';
    const status = await aiProbeCommand(args, context(extra));
    return { status, stdout, stderr };
  };
  return { home, out, claude, codex, run };
}

async function reportFolder(out: string): Promise<string> {
  const hostFolder = join(out, host.replace(':', '_'));
  const [folder] = await readdir(hostFolder);
  return join(hostFolder, folder!);
}

describe('altimeter ai-probe', () => {
  test('without --yes prints the plan and starts nothing, not even --version', async t => {
    const { out, claude, codex, run } = await setup(t);
    const result = await run([origin, '--keyword', 'seo audit for small businesses', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^AI answer probe \(sampled\) for 127\.0\.0\.1:\d+$/mu);
    assert.match(result.stdout, /^Engines: Claude Code, Codex CLI$/mu);
    assert.match(result.stdout, /^ {2}Q1 \[your keyword\] seo audit for small businesses$/mu);
    assert.match(result.stdout, /^ {2}Q2 \[brand question\] What is Altitud Studio\?$/mu);
    assert.match(result.stdout, /CLI calls: at most 12 \(queries × runs × engines = 2 × 3 × 2\)/u);
    assert.match(result.stdout, /Nothing was sent\. Run the same command with --yes/u);
    assert.deepEqual(await claude.starts(), []);
    assert.deepEqual(await codex.starts(), []);
    assert.equal(existsSync(out), false, 'nothing is written');
  });

  test('infers queries from the site when no keyword is given, and labels them', async t => {
    const { run } = await setup(t);
    const result = await run([origin, '--engines', 'claude']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Q1 \[inferred from the site\] Web design in Andorra/u);
    assert.match(result.stdout, /Q2 \[inferred from the site\] Technical SEO audits for small businesses/u);
  });

  test('with --yes runs the plan within its call cap and writes probe.json and probe.md with every label', async t => {
    const { home, out, claude, codex, run } = await setup(t);
    const result = await run([origin, '--keyword', 'seo audit for small businesses', '--runs', '2', '--yes', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await claude.calls()).length, 4);
    assert.equal((await codex.calls()).length, 4);
    assert.match(result.stdout, /^Claude Code: 4 of 4 runs completed \(0 from the cache, 0 failed, 0 skipped\)\.$/mu);
    assert.match(result.stdout, /probe\.md$/mu);
    const folder = await reportFolder(out);
    assert.match(folder, /ai-probe-20261104-100000Z$/u);
    const json = await readFile(join(folder, 'probe.json'), 'utf8');
    const markdown = await readFile(join(folder, 'probe.md'), 'utf8');
    const report = JSON.parse(json) as ProbeReport;
    assert.deepEqual([report.schemaVersion, report.kind, report.calls.made, report.calls.cap], [1, 'ai-probe', 8, 8]);
    assert.equal(report.engines[0]!.queries[0]!.cited, 2);
    assert.equal(report.engines[1]!.queries[0]!.cited, 2);
    for (const text of [json, markdown]) assert.equal(text.includes(home) || text.includes(home.replaceAll('\\', '\\\\')), false, 'no local path in the report');

    assert.match(markdown, /^# AI answer probe \(sampled\) for 127\.0\.0\.1:\d+$/mu);
    const claudeLabel = 'Claude Code 2.0.59 · model: claude-double-model · search: WebSearch (Anthropic web search; the provider is not disclosed) · locale: United States · 2026-11-04 · N = 2 runs per query';
    const codexLabel = 'Codex CLI 0.166.0-alpha.5.1 · model: not reported by the CLI (its default) · search: live (requested with web_search = "live"; the CLI does not report the mode it used) · locale: not set · 2026-11-04 · N = 2 runs per query';
    assert.ok(markdown.split('\n').filter(line => line === claudeLabel).length >= 3, 'every Claude section carries the label');
    assert.ok(markdown.split('\n').filter(line => line === codexLabel).length >= 3, 'every Codex section carries the label');
    assert.equal(markdown.split('\n').filter(line => line.includes('Not representative of ChatGPT, Claude.ai, Copilot, Perplexity or Google AI Overviews')).length, 2);
    assert.match(markdown, /Claude Code's web search is localised in the United States/u);
    assert.match(markdown, /Codex does not expose the results of its web searches/u);
    assert.match(markdown, /### Brand recognition \(not visibility\)/u);
    assert.match(markdown, /- Cited the site in 2 of 2 completed runs\./u);
    assert.match(markdown, /- Fewer than 3 completed runs: an insufficient sample\./u);
    assert.match(markdown, /\| Other domains cited \| Runs \|\n\| --- \| --- \|\n\| `rival\.example` \| 2 of 2 \|/u);
    assert.match(markdown, /\| `http:\/\/127\.0\.0\.1:\d+\/services\/` \| 2 of 2 \|/u);
    assert.doesNotMatch(markdown, /\]\(http/u, 'no clickable link');
    assert.doesNotMatch(markdown, /\d+(?:\.\d+)? ?%/u, 'no percentage');
  });

  test('a second run reads the cache, and --refresh asks again', async t => {
    const { out, claude, run } = await setup(t);
    const args = [origin, '--keyword', 'seo audit for small businesses', '--engines', 'claude', '--runs', '1', '--yes', '--out', out];
    assert.equal((await run(args)).status, 0);
    const again = await run(args);
    assert.match(again.stdout, /2 of 2 runs completed \(2 from the cache, 0 failed, 0 skipped\)/u);
    assert.equal((await claude.calls()).length, 2);
    await run([...args, '--refresh']);
    assert.equal((await claude.calls()).length, 4);
  });

  test('writes the report in Spanish or Catalan', async t => {
    const { out, run } = await setup(t);
    const spanish = await run([origin, '--keyword', 'auditoria seo', '--engines', 'claude', '--runs', '1', '--yes', '--out', join(out, 'es'), '--lang', 'es']);
    assert.match(spanish.stdout, /^Sondeo de respuestas de IA \(muestreo\) para/mu);
    const es = await readFile(join(await reportFolder(join(out, 'es')), 'probe.md'), 'utf8');
    assert.match(es, /^# Sondeo de respuestas de IA \(muestreo\) para/mu);
    assert.match(es, /La búsqueda web de Claude Code está localizada en Estados Unidos/u);
    await run([origin, '--keyword', 'auditoria seo', '--engines', 'claude', '--runs', '1', '--yes', '--out', join(out, 'ca'), '--lang', 'ca']);
    const ca = await readFile(join(await reportFolder(join(out, 'ca')), 'probe.md'), 'utf8');
    assert.match(ca, /^# Sondeig de respostes d'IA \(mostreig\) per a/mu);
    assert.match(ca, /Reconeixement de marca \(no visibilitat\)/u);
  });

  test('uses Search Console queries only with --from-gsc, and says when they could not be read', async t => {
    const { run } = await setup(t);
    const period = { start: '2026-10-04', end: '2026-10-31' };
    const data: GscData = {
      property: { siteUrl: `${origin}/`, permissionLevel: 'siteOwner' }, fetchedAt: '2026-11-03T00:00:00.000Z', period, previousPeriod: period,
      byPage: [], byQuery: [{ keys: ['altitud studio'], clicks: 50, impressions: 400, ctr: 0.125, position: 1 }, { keys: ['technical seo andorra'], clicks: 3, impressions: 120, ctr: 0.025, position: 9.2 }],
      byPageQuery: [], byCountry: [], byDevice: [], previousByPage: [], inspections: [], sitemaps: [], truncated: false,
    };
    const used = await run([origin, '--from-gsc'], { searchConsole: async () => data });
    assert.match(used.stdout, /Q1 \[Search Console, non-brand\] technical seo andorra/u);
    assert.doesNotMatch(used.stdout, /\] altitud studio$/mu);
    assert.match(used.stdout, /Search Console queries are sent to the engines as questions\./u);
    const failed = await run([origin, '--from-gsc'], { searchConsole: async () => { throw new Error('no Search Console credential was found.'); } });
    assert.equal(failed.status, 0);
    assert.match(failed.stdout, /Search Console could not be read: no Search Console credential was found\./u);
    assert.match(failed.stdout, /The queries were inferred from the site's pages because Search Console gave none\./u);
  });

  test('exits 2 when no run completed', async t => {
    const { out, run } = await setup(t, { claude: { default: { hang: false, isError: true, answer: 'x' } } });
    const result = await run([origin, '--keyword', 'seo audit', '--engines', 'claude', '--runs', '1', '--yes', '--out', out]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /0 of 2 runs completed \(0 from the cache, 2 failed, 0 skipped\)/u);
    assert.ok(existsSync(join(await reportFolder(out), 'probe.md')), 'the report still says why');
  });

  test('rejects bad options with exit 2 and a message, before anything is sent', async t => {
    const { claude, run } = await setup(t);
    const cases: Array<[string[], RegExp]> = [
      [[], /exactly one domain/u],
      [[origin, 'second.example'], /exactly one domain/u],
      [['ftp://example.com'], /host name such as example\.com/u],
      [['https://user:pass@example.com'], /host name such as example\.com/u],
      [[origin, '--runs', '0'], /--runs must be a whole number from 1 to 5/u],
      [[origin, '--runs', '6'], /--runs must be a whole number from 1 to 5/u],
      [[origin, '--engines', 'gpt'], /--engines must be claude, codex/u],
      [[origin, '--lang', 'fr'], /--lang must be en, es or ca/u],
      [[origin, '--keyword', `reviews of ${host}`], /names 127\.0\.0\.1/u],
      [[origin, '--model', 'opus'], /Unknown option/u],
    ];
    for (const [args, message] of cases) {
      const result = await run(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
    }
    assert.deepEqual(await claude.starts(), []);
  });

  test('prints its help', async t => {
    const { run } = await setup(t);
    const result = await run(['--help']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, aiProbeHelp);
    assert.match(aiProbeHelp, /does not represent|do not represent/u);
  });
});
