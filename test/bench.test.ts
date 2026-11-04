import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { LookupAddress } from 'node:dns';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { scenarios } from '../bench/scenarios/index.ts';
import { checkScenario, fingerprint, type ScenarioRun } from '../bench/support/execute.ts';
import { defineScenario, route, loopbackLookup, loopbackPolicy } from '../bench/support/scenario.ts';
import { startVirtualHosts } from '../bench/support/server.ts';
import { rules } from '../src/catalog/index.ts';
import { HttpClient } from '../src/fetch/http.ts';
import { trustedRoots } from '../src/fetch/tls.ts';
import { implementations } from '../src/rules/registry.ts';
import { createTestCa } from './support/certificates.ts';

const day = 86_400_000;
const root = fileURLToPath(new URL('..', import.meta.url));

test('every scenario has a unique name and expectations on implemented rules', () => {
  assert.equal(new Set(scenarios.map(scenario => scenario.name)).size, scenarios.length);
  for (const scenario of scenarios) {
    const expected = [...scenario.mustFail.map(entry => entry.rule), ...scenario.mustNotFail.map(entry => (typeof entry === 'string' ? entry : entry.rule))];
    assert.ok(expected.length > 0, `${scenario.name} expects something`);
    for (const rule of expected) {
      const meta = rules.find(entry => entry.id === rule);
      assert.ok(meta && meta.status !== 'planned' && implementations.has(rule), `${scenario.name}: ${rule} is an implemented rule`);
    }
    assert.ok(scenario.hosts.every(host => !host.endsWith('.test')), `${scenario.name}: *.test hosts count as staging hosts for several rules`);
  }
});

test('grades findings into true and false positives and negatives, and flags a rule that did not run', () => {
  const site = { kind: 'site', origin: 'https://site.example:8443' };
  const page = { kind: 'page', url: 'https://site.example:8443/about/' };
  const finding = (ruleId: string, outcome: string, extra: Record<string, unknown> = {}) => ({ ruleId, outcome, scope: site, ...extra });
  const run = {
    scenario: defineScenario({
      name: 'grading', summary: 'grading', hosts: ['site.example'], build: () => ({ origins: {}, url: 'https://site.example:8443/' }),
      mustFail: [{ rule: 'crawl-sitemap-lastmod', severity: 'low' }, { rule: 'schema-organization' }, { rule: 'schema-breadcrumb', page: '/about/', reason: 'name-with-site-name' }],
      mustNotFail: ['tech-hsts-header', 'perf-html-cdn', { rule: 'ai-llms-txt', outcome: 'not_evaluated' }, 'ai-content-signal-lines', { rule: 'content-h1-missing', page: '/about/' }],
    }),
    result: {
      report: {
        target: { url: 'https://site.example:8443/' },
        findings: [
          finding('crawl-sitemap-lastmod', 'fail', { severity: 'low', reason: 'missing' }),
          finding('schema-organization', 'pass'),
          finding('schema-breadcrumb', 'fail', { scope: page, severity: 'low', reason: 'name-with-site-name' }),
          finding('tech-hsts-header', 'fail', { severity: 'info', reason: 'missing', message: 'No Strict-Transport-Security header.' }),
          finding('perf-html-cdn', 'pass'),
          finding('ai-llms-txt', 'not_evaluated', { reason: 'llms-txt-unreachable' }),
          finding('ai-content-signal-lines', 'not_evaluated', { reason: 'missing-input:robots' }),
          finding('content-h1-missing', 'pass', { scope: { kind: 'page', url: 'https://site.example:8443/' } }),
        ],
      },
      collected: { site: { pages: new Map() } },
    },
    port: 8443, durationMs: 0, strayHosts: [],
  } as unknown as ScenarioRun;
  const checks = checkScenario(run);
  assert.deepEqual(checks.map(check => [check.rule, check.verdict]), [
    ['crawl-sitemap-lastmod', 'tp'], ['schema-organization', 'fn'], ['schema-breadcrumb', 'tp'],
    ['tech-hsts-header', 'fp'], ['perf-html-cdn', 'tn'], ['ai-llms-txt', 'tn'], ['ai-content-signal-lines', 'unevaluated'], ['content-h1-missing', 'unevaluated'],
  ]);
  assert.match(checks[3]!.detail, /No Strict-Transport-Security header/u);
  assert.match(checks[7]!.detail, /the rule reported on https:\/\/site\.example:8443\//u);
  assert.ok(fingerprint(run).every(line => !line.includes(':8443')), 'the port is left out of the fingerprint');
});

test('the benchmark exits 2 and says why when Chrome is missing', () => {
  const folder = mkdtempSync(join(tmpdir(), 'altimeter-bench-'));
  try {
    const result = spawnSync(process.execPath, ['bench/run.ts'], {
      cwd: root, env: { ...process.env, CHROME_PATH: join(folder, 'no-chrome') }, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs Chrome or Chromium/u);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('one loopback port answers plain HTTP and HTTPS, routed by Host and with the certificate SNI asks for', async () => {
  const ca = createTestCa();
  const leaf = ca.issue(['site.example', 'www.site.example']);
  const expired = ca.issue(['www.site.example'], { notBefore: new Date(Date.now() - 10 * day), notAfter: new Date(Date.now() - day) });
  const origins = {
    'http://site.example': () => ({ status: 301, headers: { location: 'https://site.example/' }, body: '' }),
    'https://site.example': { routes: { '/': { headers: { 'content-type': 'text/html' }, body: `<!doctype html><title>Home</title>${'text '.repeat(500)}` } } },
  };
  const server = await startVirtualHosts({
    tls: { key: leaf.key, cert: leaf.chain },
    hostTls: { 'www.site.example': { key: expired.key, cert: expired.chain } },
    handle: request => route(origins, request),
  });
  const hosts = ['site.example', 'www.site.example'];
  const client = new HttpClient({ policy: loopbackPolicy(hosts), lookup: loopbackLookup(hosts), ca: trustedRoots(ca.cert) });
  try {
    const plain = await client.fetch(`http://site.example:${server.port}/`, { followRedirects: false });
    assert.equal(plain.status, 301);
    const secure = await client.fetch(`https://site.example:${server.port}/`);
    assert.equal(secure.status, 200);
    assert.equal(secure.headers['content-encoding']?.[0], 'br');
    assert.match(secure.body.toString(), /<title>Home<\/title>/u);
    const unknown = await client.fetch(`https://site.example:${server.port}/missing`);
    assert.equal(unknown.status, 404);
    const certificate = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: server.port, servername: 'www.site.example', rejectUnauthorized: false }, () => {
        resolve(new X509Certificate(socket.getPeerCertificate().raw).validTo);
        socket.destroy();
      });
      socket.on('error', reject);
    });
    assert.ok(Date.parse(certificate) < Date.now(), 'www gets its own, expired certificate');
    assert.deepEqual(server.requests.map(request => [request.secure, request.host, request.path]),
      [[false, 'site.example', '/'], [true, 'site.example', '/'], [true, 'site.example', '/missing']]);
    assert.equal(server.requests[1]?.sni, 'site.example');
  } finally {
    await client.close();
    await server.close();
  }
});

test('the loopback lookup resolves only the scenario hosts, and the policy admits only those names', async () => {
  const lookup = loopbackLookup(['site.example']);
  const resolve = (host: string) => new Promise<{ error: string | undefined; addresses: LookupAddress[] }>(done => {
    (lookup as unknown as (host: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void)(
      host, { all: true }, (error, addresses) => done({ error: error?.code, addresses }));
  });
  assert.deepEqual(await resolve('SITE.example'), { error: undefined, addresses: [{ address: '127.0.0.1', family: 4 }] });
  assert.deepEqual(await resolve('example.com'), { error: 'ENOTFOUND', addresses: [] });
  assert.deepEqual([...loopbackPolicy(['Site.Example']).privateHosts ?? []], ['site.example']);
  assert.equal(loopbackPolicy(['site.example']).allowPrivate, false);
});
