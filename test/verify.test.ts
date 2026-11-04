import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { rules as catalogRules } from '../src/catalog/index.ts';
import type { CollectResult } from '../src/collect/index.ts';
import { EvidenceStore } from '../src/core/evidence.ts';
import { HttpClient } from '../src/fetch/http.ts';
import { runRules, type RuleImplementation } from '../src/rules/engine.ts';
import { implementations as registered } from '../src/rules/registry.ts';
import { buildReport } from '../src/report/model.ts';
import type { TaskCheck } from '../src/report/tasks.ts';
import { serveStatic } from '../src/verify/static-server.ts';
import { rebaseSite, verifyExitCode, verifyTasks } from '../src/verify/index.ts';
import { page, site } from './support/facts.ts';

const titleRule: RuleImplementation = {
  id: 'content-title-missing',
  evaluate({ page: current, evidence }) {
    const title = current!.raw?.parsed.titles.find(entry => entry.inHead && entry.text.trim() !== '');
    if (title) return { outcome: 'pass', evidence: [evidence.add({ kind: 'html', url: current!.url, label: 'title element', excerpt: title.text })] };
    return { outcome: 'fail', severity: 'high', evidence: [evidence.add({ kind: 'html', label: 'no non-empty title element in the head' })] };
  },
};
const rules = catalogRules.map(rule => rule.id === titleRule.id ? { ...rule, inputs: ['raw-html' as const], optionalInputs: ['rendered-dom' as const] } : rule);
const implementations = new Map([[titleRule.id, titleRule]]);

function reportFor(html: string) {
  const facts = site({ pages: [page('https://example.com/', { html })], homeUrl: 'https://example.com/' });
  const evidence = new EvidenceStore();
  const findings = runRules({ rules: rules.filter(rule => rule.id === titleRule.id), implementations, site: facts, evidence });
  const collected: CollectResult = { site: facts, versions: {}, warnings: [], durationMs: 1 };
  return buildReport({ collected, findings, evidence, implemented: 1, language: 'en', startedAt: new Date('2026-11-04T10:00:00Z'), targetUrl: 'https://example.com/', options: {}, rules });
}

let build: string;

before(async () => {
  build = await mkdtemp(join(tmpdir(), 'altimeter-build-'));
  await mkdir(join(build, 'about'));
  await writeFile(join(build, 'about', 'index.html'), '<!doctype html><title>About</title>');
});

after(async () => {
  await rm(build, { recursive: true, force: true });
});

describe('verify', () => {
  const report = reportFor('<!doctype html><p>No title</p>');

  test('fails while the build still has the problem and passes once it is fixed', async () => {
    assert.equal(report.tasks.length, 1);
    await writeFile(join(build, 'index.html'), '<!doctype html><p>Still no title</p>');
    const before = await verifyTasks({ report, staticDir: build, implementations, rules });
    assert.equal(before[0]?.verdict, 'fail');
    assert.equal(verifyExitCode(before), 1);
    await writeFile(join(build, 'index.html'), '<!doctype html><title>Home</title>');
    const after = await verifyTasks({ report, staticDir: build, implementations, rules });
    assert.equal(after[0]?.verdict, 'pass');
    assert.equal(verifyExitCode(after), 0);
  });

  test('does not claim to verify locally what only a deployment can show', async () => {
    const deployed = { ...report, tasks: report.tasks.map(task => ({ ...task, verifiableBy: 'deployed' as const })) };
    const results = await verifyTasks({ report: deployed, staticDir: build, implementations, rules });
    assert.equal(results[0]?.verdict, 'not-verifiable');
    assert.equal(verifyExitCode(results), 3);
  });

  test('rejects unknown task ids', async () => {
    await assert.rejects(verifyTasks({ report, taskIds: ['T-0000000000'], staticDir: build, implementations, rules }), /Unknown task/u);
  });

  const keeping = (...ruleIds: string[]) => ({ ...report, tasks: report.tasks.map(task => ({ ...task, mustRemainPassing: ruleIds.map((ruleId): TaskCheck => ({ ruleId, scope: task.scopes[0]! })) })) });
  const withRules = (...extra: RuleImplementation[]) => new Map([...implementations, ...extra.map(entry => [entry.id, entry] as const)]);

  test('passes a fix when a check that must keep passing cannot run here, and lists it as not re-checked', async () => {
    await writeFile(join(build, 'index.html'), '<!doctype html><title>Home</title>');
    const rendered = registered.get('content-title-raw-rendered-mismatch')!;
    const [result] = await verifyTasks({ report: keeping(rendered.id), staticDir: build, implementations: withRules(rendered), rules });
    assert.equal(result?.verdict, 'pass');
    assert.deepEqual(result?.regressions, []);
    assert.deepEqual(result?.notRechecked.map(entry => [entry.check.ruleId, entry.outcome, entry.reason]), [[rendered.id, 'not_evaluated', 'missing-input:rendered-dom']]);
    assert.equal(verifyExitCode([result!]), 0);
  });

  test('fails a fix that breaks a check that passed before', async () => {
    await writeFile(join(build, 'index.html'), '<!doctype html><title>Home</title>');
    const description = registered.get('content-meta-description-missing')!;
    const [result] = await verifyTasks({ report: keeping(description.id), staticDir: build, implementations: withRules(description), rules });
    assert.equal(result?.verdict, 'fail');
    assert.deepEqual(result?.regressions.map(entry => [entry.check.ruleId, entry.outcome]), [[description.id, 'fail']]);
  });

  test('re-checks what only a deployment can show against an origin, never against a served build', async () => {
    await writeFile(join(build, 'index.html'), '<!doctype html><title>Home</title>');
    let runs = 0;
    // content-img-format needs a deployment: a CDN may convert the images the build holds.
    const deployedCheck: RuleImplementation = {
      id: 'content-img-format',
      evaluate: () => {
        runs += 1;
        return { outcome: 'fail', severity: 'low', evidence: [] };
      },
    };
    const served = await verifyTasks({ report: keeping(deployedCheck.id), staticDir: build, implementations: withRules(deployedCheck), rules });
    assert.equal(served[0]?.verdict, 'pass');
    assert.deepEqual(served[0]?.notRechecked.map(entry => [entry.check.ruleId, entry.outcome, entry.reason]), [[deployedCheck.id, 'not_evaluated', 'needs deployed verification']]);
    assert.equal(runs, 0);
    const server = await serveStatic(build);
    try {
      const deployed = await verifyTasks({ report: keeping(deployedCheck.id), origin: server.origin, implementations: withRules(deployedCheck), rules });
      assert.equal(deployed[0]?.verdict, 'fail');
      assert.equal(runs, 1);
    } finally {
      await server.close();
    }
  });
});

describe('static server and rebasing', () => {
  test('serves index files, redirects folders, answers 404 and never leaves its root', async () => {
    const server = await serveStatic(build);
    const client = new HttpClient({ policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) } });
    try {
      assert.equal((await client.fetch(`${server.origin}/about/`)).status, 200);
      const folder = await client.fetch(`${server.origin}/about`, { followRedirects: false });
      assert.deepEqual([folder.status, folder.hops[0]?.location], [301, `${server.origin}/about/`]);
      assert.equal((await client.fetch(`${server.origin}/missing`)).status, 404);
      const traversal = await client.fetch(`${server.origin}/..%2f..%2fetc%2fpasswd`);
      assert.ok(traversal.status === 403 || traversal.status === 404);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('presents local facts with the production origin', () => {
    const local = site({ pages: [page('http://127.0.0.1:5000/en/', { html: '<title>x</title>', redirects: [[301, 'http://127.0.0.1:5000/en/']] })], homeUrl: 'http://127.0.0.1:5000/' });
    const rebased = rebaseSite(local, 'http://127.0.0.1:5000', 'https://example.com');
    const [entry] = [...rebased.pages.values()];
    assert.equal(rebased.origin, 'https://example.com');
    assert.equal(entry?.url, 'https://example.com/en/');
    assert.equal(entry?.fetch.hops[0]?.location, 'https://example.com/en/');
    assert.equal(rebased.homeUrl, 'https://example.com/');
  });
});
