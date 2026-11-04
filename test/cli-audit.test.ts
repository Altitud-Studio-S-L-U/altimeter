import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { userCacheDirectory } from '../src/ai/providers.ts';
import { createTestCertificates } from './support/certificates.ts';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
let server: Server;
let origin: string;
let work: string;

function run(args: string[], cwd = work, env: Readonly<Record<string, string>> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    // No test may reach a real Claude Code or Codex, not even for --version: executables that do not exist stand in for them.
    const missing = { ALTIMETER_CLAUDE_EXECUTABLE: join(work, 'missing', 'claude.exe'), ALTIMETER_CODEX_EXECUTABLE: join(work, 'missing', 'codex.exe') };
    const child = spawn(process.execPath, [cli, ...args], { cwd, windowsHide: true, env: { ...process.env, ALTIMETER_PROVIDER: 'none', ...missing, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    if (req.url === '/challenge') return void res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }).end('<title>Just a moment...</title>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(join(tmpdir(), 'altimeter-cli-'));
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
});

describe('altimeter audit', () => {
  test('audits a page and writes the report folder', async () => {
    const result = await run(['audit', `${origin}/`, '--no-render', '--allow-private-network', '--out', 'out', '--quiet']);
    assert.equal(result.status, 0, result.stderr);
    const folder = result.stdout.trim();
    const files = await readdir(join(work, folder));
    assert.ok(['report.json', 'report.md', 'FIXES.md', 'tasks'].every(name => files.includes(name)), files.join(','));
    const report = JSON.parse(await readFile(join(work, folder, 'report.json'), 'utf8'));
    assert.equal(report.target.origin, origin);
    assert.equal(report.run.options.render, false);
    assert.deepEqual([report.run.options.provider, report.ai], ['none', undefined]);
  });

  test('says how to sign in when Search Console is requested and no credential is stored', async () => {
    const empty = join(work, 'no-login');
    const result = await run(['audit', `${origin}/`, '--no-render', '--allow-private-network', '--gsc', '--out', 'gsc-out', '--quiet'], work,
      { LOCALAPPDATA: empty, XDG_STATE_HOME: empty, HOME: empty, ALTIMETER_GSC_ACCESS_TOKEN: '', ALTIMETER_GSC_SA_KEY: '' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(join(work, result.stdout.trim(), 'report.json'), 'utf8'));
    assert.ok(report.run.warnings.includes('Search Console was requested but no credential was found. Run "altimeter gsc login --client <client_secret.json> --remember <dpapi|file>" or set ALTIMETER_GSC_ACCESS_TOKEN.'), report.run.warnings.join('\n'));
  });

  test('never writes the report or a dry run inside the --source repository', async () => {
    const repo = join(work, 'site-repo');
    await mkdir(repo, { recursive: true });
    const inside = await run(['audit', `${origin}/`, '--no-render', '--allow-private-network', '--source', repo, '--out', join(repo, 'reports')]);
    assert.equal(inside.status, 2);
    assert.match(inside.stderr, /outside the --source repository/u);
    const dryRun = await run(['audit', `${origin}/`, '--no-render', '--allow-private-network', '--source', repo, '--out', join(work, 'dry-run-out'), '--dry-run', join(repo, 'prompts')]);
    assert.equal(dryRun.status, 2, dryRun.stderr);
    assert.equal(dryRun.stderr, '--dry-run must be outside the --source repository.\n');
    assert.deepEqual(await readdir(repo), [], 'nothing was written in the repository');
    assert.equal((await run(['audit', `${origin}/`, '--source', join(work, 'missing')])).status, 2);
  });

  test('rejects bad analysis options', async () => {
    assert.equal((await run(['audit', `${origin}/`, '--provider', 'gpt'])).status, 2);
    assert.equal((await run(['audit', `${origin}/`, '--ai-pages', '0'])).status, 2);
    assert.equal((await run(['audit', `${origin}/`, '--verifier', 'both'])).status, 2);
  });

  test('refuses private addresses unless asked', async () => {
    const result = await run(['audit', `${origin}/`, '--no-render', '--out', 'out', '--quiet']);
    assert.equal(result.status, 3);
  });

  test('exits 3 when the page is a firewall challenge', async () => {
    const result = await run(['audit', `${origin}/challenge`, '--no-render', '--allow-private-network', '--out', 'out', '--quiet']);
    assert.equal(result.status, 3);
  });

  test('rejects bad options', async () => {
    assert.equal((await run(['audit', 'not a url'])).status, 2);
    assert.equal((await run(['audit', `${origin}/`, '--lang', 'fr'])).status, 2);
    assert.equal((await run(['audit', `${origin}/`, '--fail-on', 'some'])).status, 2);
  });

  test('checks the owner data options before collecting anything', async () => {
    const days = await run(['audit', `${origin}/`, '--bots-days', '7']);
    assert.equal(days.status, 2);
    assert.match(days.stderr, /need --bots-from/u);
    const missing = await run(['audit', `${origin}/`, '--bots-from', join(work, 'missing.log')]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /missing\.log does not exist/u);
    assert.equal((await run(['audit', `${origin}/`, '--bots-from', 'cloudflare', '--bots-days', '401'])).status, 2);
    assert.equal((await run(['audit', `${origin}/`, '--bing-site', 'example.com'])).status, 2);
  });

  test('an owner source it cannot read is a warning, and the report records which sources were asked for', async () => {
    const result = await run(['audit', `${origin}/`, '--no-render', '--allow-private-network', '--out', 'owner-out', '--quiet', '--bots-from', 'cloudflare', '--bing'],
      work, { ALTIMETER_CLOUDFLARE_API_TOKEN: '', BING_WEBMASTER_API_KEY: '' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(join(work, result.stdout.trim(), 'report.json'), 'utf8'));
    assert.deepEqual([report.run.options.botActivity, report.run.options.bing], ['cloudflare', true]);
    assert.ok(report.run.warnings.some((warning: string) => /^Crawler activity was not read: .*ALTIMETER_CLOUDFLARE_API_TOKEN/u.test(warning)), report.run.warnings.join('\n'));
    assert.ok(report.run.warnings.some((warning: string) => warning.includes('BING_WEBMASTER_API_KEY is not set')), report.run.warnings.join('\n'));
  });

  test('--ca trusts a private CA for the page and the certificate check', async () => {
    const { ca, leaf } = createTestCertificates(['127.0.0.1']);
    const secure = createHttpsServer({ key: leaf.key, cert: leaf.chain }, (req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><title>Staging</title></head><body><h1>Staging</h1></body></html>');
    });
    await new Promise<void>(resolve => secure.listen(0, '127.0.0.1', resolve));
    try {
      await writeFile(join(work, 'staging-ca.pem'), ca.cert);
      const target = `https://127.0.0.1:${(secure.address() as AddressInfo).port}/`;
      const result = await run(['audit', target, '--no-render', '--allow-private-network', '--ca', 'staging-ca.pem', '--out', 'ca-out', '--quiet']);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(await readFile(join(work, result.stdout.trim(), 'report.json'), 'utf8'));
      assert.equal(report.run.options.extraCa, true);
      assert.equal(report.pages[0].status, 200);
      assert.deepEqual(report.findings.filter((finding: { ruleId: string }) => finding.ruleId === 'tech-tls-certificate-valid').map((finding: { outcome: string }) => finding.outcome), ['pass']);
    } finally {
      secure.closeAllConnections();
      await new Promise(resolve => secure.close(resolve));
    }
  });

  test('rejects a --ca file that cannot be read or holds no certificate', async () => {
    const missing = await run(['audit', `${origin}/`, '--ca', 'missing.pem']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--ca: missing\.pem cannot be read/u);
    await writeFile(join(work, 'empty.pem'), 'not a certificate\n');
    const empty = await run(['audit', `${origin}/`, '--ca', 'empty.pem']);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /--ca must be a PEM file with at least one certificate/u);
  });
});

describe('other commands', () => {
  test('render writes the report again in another language', async () => {
    const audit = await run(['audit', `${origin}/`, '--no-render', '--allow-private-network', '--out', 'render-out', '--quiet']);
    const folder = audit.stdout.trim();
    const result = await run(['render', join(folder, 'report.json'), '--lang', 'ca']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(join(work, folder, 'report.md'), 'utf8'), /^# Auditoria SEO de/u);
  });

  test('compare refuses reports from different catalogs', async () => {
    const audit = await run(['audit', `${origin}/`, '--no-render', '--allow-private-network', '--out', 'compare-out', '--quiet']);
    const path = join(work, audit.stdout.trim(), 'report.json');
    const other = JSON.parse(await readFile(path, 'utf8'));
    other.catalog.hash = '0'.repeat(64);
    await writeFile(join(work, 'other.json'), JSON.stringify(other));
    const result = await run(['compare', path, join(work, 'other.json')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /different rule catalogs/u);
    assert.equal((await run(['compare', path, path])).status, 0);
  });

  test('rules, explain and doctor describe the catalog and the environment', async () => {
    const rules = await run(['rules', '--category', 'crawl']);
    assert.equal(rules.status, 0);
    assert.match(rules.stdout, /^crawl-/mu);
    assert.doesNotMatch(rules.stdout, /^content-/mu);
    const explain = await run(['explain', 'crawl-meta-robots-noindex']);
    assert.match(explain.stdout, /Source: https:\/\//u);
    assert.equal((await run(['explain', 'no-such-rule'])).status, 2);
    assert.match((await run(['doctor'])).stdout, /^Node\.js \d+/u);
  });

  test('bots and ai-probe are commands with their own help', async () => {
    const help = await run(['--help']);
    assert.match(help.stdout, /altimeter bots /u);
    assert.match(help.stdout, /altimeter ai-probe /u);
    const bots = await run(['bots', '--help']);
    assert.equal(bots.status, 0);
    assert.match(bots.stdout, /--cloudflare-zone <domain>/u);
    const probe = await run(['ai-probe', '--help']);
    assert.equal(probe.status, 0);
    assert.match(probe.stdout, /Without --yes it only/u);
    const usage = await run(['bots']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /bots needs --cloudflare-zone or --logs/u);
  });

  test('cache clear removes model answers, probe runs and crawler IP lists', async () => {
    // Every variable the user cache folder can come from points into the test folder, so no real cache is touched.
    const cache = join(work, 'user-cache');
    const env = { LOCALAPPDATA: cache, XDG_CACHE_HOME: cache, HOME: cache, USERPROFILE: cache };
    const base = userCacheDirectory(env);
    const entries = [join(base, 'ai-cache', 'ab', `${'ab'.repeat(32)}.json`), join(base, 'ai-probe', 'cd', `${'cd'.repeat(32)}.json`), join(base, 'bot-ip-ranges', 'googlebot.json')];
    for (const path of entries) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{}');
    }
    const result = await run(['cache', 'clear'], work, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Removed 1 cached model answer\(s\), 1 cached probe run\(s\) and 1 crawler IP list\(s\)\.$/mu);
    assert.deepEqual((await readdir(base)).sort(), [], 'the three cache folders are gone');
  });
});
