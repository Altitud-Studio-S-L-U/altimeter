import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test, type TestContext } from 'node:test';
import { probeCacheDirectory, probeCacheKey, probeCacheTtlMs, readProbeCache, writeProbeCache } from '../src/probe/cache.ts';
import { planProbe } from '../src/probe/plan.ts';
import { runProbe, type ProbeOptions } from '../src/probe/run.ts';
import type { ProbeEngine, SiteProfile } from '../src/probe/types.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { probeDouble } from './fixtures/probe/doubles.ts';
import { alive, sandbox, testEnv } from './support/providers.ts';

const site: SiteProfile = {
  origin: 'https://altitudstudio.ad', host: 'altitudstudio.ad', domain: 'altitudstudio.ad', brandNames: ['Altitud Studio'], language: 'en', pages: [], notices: [],
};
const now = () => new Date('2026-11-04T10:00:00.000Z');

const claudeScenario = {
  responses: [
    {
      when: 'seo audit andorra',
      searches: [{ query: 'seo audit andorra', links: [{ title: 'Altitud', url: 'https://altitudstudio.ad/serveis/' }, { title: 'Rival', url: 'https://rival.example/seo' }] }],
      answer: 'Altitud Studio runs SEO audits.\n\nSources:\n- https://altitudstudio.ad/serveis/\n- https://rival.example/seo\n- https://unseen.example/',
    },
    { when: 'web design agency', searches: [{ links: [{ title: 'Rival', url: 'https://rival.example/' }] }], answer: 'Try https://rival.example/ or https://altitudstudio.ad/.' },
    { when: 'What is Altitud Studio', searches: [{ links: [] }], answer: 'Altitud Studio is a studio in Andorra.' },
  ],
};
const codexScenario = { default: { searches: ['q'], answer: 'See https://altitudstudio.ad/?utm_source=chatgpt.com and https://rival.example/.' } };

async function setup(t: TestContext, options: { engines?: ProbeEngine[]; keywords?: string[]; runs?: number; claude?: object; codex?: object | null } = {}) {
  const home = await sandbox(t);
  const claude = await probeDouble(home, 'claude', options.claude ?? claudeScenario);
  const codex = options.codex === null ? undefined : await probeDouble(home, 'codex', options.codex ?? codexScenario);
  const env = testEnv(home, { claude: claude.executable, ...(codex ? { codex: codex.executable } : {}) });
  const plan = planProbe({ site, keywords: options.keywords ?? ['seo audit andorra', 'web design agency'], engines: options.engines ?? ['claude', 'codex'], runsPerQuery: options.runs ?? 3, language: 'en' });
  const probe = (extra: Partial<ProbeOptions> = {}) => runProbe({ plan, language: 'en', env, pauseMs: 0, now, ...extra });
  return { home, env, claude, codex, plan, probe };
}

describe('running a probe', () => {
  test('asks every engine every query N times, the first run of each query first, and labels each section', async t => {
    const { claude, codex, plan, probe } = await setup(t);
    const report = await probe();
    assert.deepEqual(plan.queries.map(query => query.text), ['seo audit andorra', 'web design agency', 'What is Altitud Studio?']);
    const asked = (await claude.calls()).map(call => call.stdin.replace(/^Question: |\n$/gu, ''));
    assert.deepEqual(asked, [...plan.queries.map(query => query.text), ...plan.queries.map(query => query.text), ...plan.queries.map(query => query.text)]);
    assert.equal((await codex!.calls()).length, 9);
    assert.deepEqual(report.calls, { planned: 18, cap: 18, made: 18, fromCache: 0, skipped: 0 });

    const [first, second] = report.engines;
    assert.deepEqual(
      [first!.engine, first!.status, first!.cliVersion, first!.verifiedVersion, first!.models, first!.searchMode, first!.locale, first!.provenance, first!.firstRun, first!.lastRun, first!.runsPerQuery],
      ['claude', 'ran', '2.0.59', true, ['claude-double-model'], 'claude-websearch', 'united-states', 'retrieval', '2026-11-04', '2026-11-04', 3],
    );
    const [audit, design, brand] = first!.queries;
    assert.deepEqual([audit!.completed, audit!.cited, audit!.citedUnconfirmed, audit!.brandMentioned, audit!.searched], [3, 3, 0, 3, 3]);
    assert.deepEqual(audit!.siteUrls, [{ value: 'https://altitudstudio.ad/serveis/', runs: 3 }]);
    assert.deepEqual(audit!.competitors, [{ value: 'rival.example', runs: 3 }]);
    assert.deepEqual(audit!.citedNotRetrieved, [{ value: 'https://unseen.example/', runs: 3 }]);
    assert.deepEqual([design!.cited, design!.citedUnconfirmed], [0, 3], 'the site was cited without its search returning it');
    assert.deepEqual([brand!.cited, brand!.brandMentioned, brand!.insufficientSample], [0, 3, false]);
    assert.equal(first!.costUsd !== undefined && Math.abs(first!.costUsd - 9 * 0.02) < 1e-9, true);

    assert.deepEqual([second!.engine, second!.models, second!.searchMode, second!.locale, second!.provenance], ['codex', [], 'codex-live', 'not-set', 'unverifiable']);
    assert.deepEqual(second!.queries.map(query => [query.cited, query.citedUnconfirmed, query.citedNotRetrieved]), [[3, undefined, undefined], [3, undefined, undefined], [3, undefined, undefined]]);
    assert.deepEqual(first!.runs.map(run => `${run.queryId}#${run.run}:${run.status}`).slice(0, 3), ['Q1#1:ok', 'Q1#2:ok', 'Q1#3:ok']);
    assert.ok(first!.runs.every(run => /^[0-9a-f]{64}$/u.test(run.cacheKey ?? '')));
  });

  test('reuses runs from the last seven days, asks again with refresh, and drops entries that expired', async t => {
    const { home, env, claude, probe } = await setup(t, { engines: ['claude'], keywords: ['seo audit andorra'], runs: 2, codex: null });
    const first = await probe();
    assert.equal(first.calls.made, 4, 'two runs of the keyword and two of the brand question');
    assert.equal((await claude.calls()).length, first.calls.made);
    const second = await probe();
    assert.deepEqual([second.calls.made, second.calls.fromCache], [0, first.calls.made]);
    assert.ok(second.engines[0]!.runs.every(run => run.status === 'cached'));
    assert.deepEqual(second.engines[0]!.queries.map(query => query.cited), first.engines[0]!.queries.map(query => query.cited));
    const third = await probe({ refresh: true });
    assert.equal(third.calls.made, first.calls.made);
    const later = await probe({ now: () => new Date(now().getTime() + probeCacheTtlMs) });
    assert.equal(later.calls.made, first.calls.made, 'a week later every run is asked again');
    assert.ok(probeCacheDirectory(env).startsWith(home), 'runs are cached in the user cache folder');
    assert.ok(existsSync(probeCacheDirectory(env)));
    assert.equal(probeCacheDirectory({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'), 'C:\\Users\\u\\AppData\\Local\\altimeter\\ai-probe');
    assert.equal(probeCacheDirectory({ HOME: '/home/u' }, 'linux'), '/home/u/.cache/altimeter/ai-probe');
  });

  test('never makes more CLI calls than its cap, and skips what is left', async t => {
    const { claude, codex, probe } = await setup(t, { runs: 1 });
    const report = await probe({ maxCalls: 2 });
    assert.equal(report.calls.made, 2);
    assert.equal((await claude.calls()).length + (await codex!.calls()).length, 2);
    const skipped = report.engines.flatMap(section => section.runs).filter(run => run.status === 'skipped');
    assert.equal(skipped.length, 4);
    assert.ok(skipped.every(run => run.skipped === 'call-cap'));
  });

  test('skips every run once the deadline has passed, or when the probe is cancelled', async t => {
    const { claude, probe } = await setup(t, { engines: ['claude'], runs: 1, codex: null });
    const late = await probe({ deadlineMs: 0 });
    assert.ok(late.engines[0]!.runs.every(run => run.status === 'skipped' && run.skipped === 'deadline'));
    const controller = new AbortController();
    controller.abort();
    const cancelled = await probe({ signal: controller.signal });
    assert.ok(cancelled.engines[0]!.runs.every(run => run.skipped === 'cancelled'));
    assert.deepEqual(await claude.calls(), []);
  });

  test('cancelling a probe stops the running CLI and skips the rest', { timeout: 30_000 }, async t => {
    const { claude, probe } = await setup(t, { engines: ['claude'], runs: 1, codex: null, claude: { default: { hang: true } } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const report = await probe({ signal: controller.signal });
    const runs = report.engines[0]!.runs;
    assert.deepEqual(runs.map(run => run.error?.code ?? run.skipped), ['cancelled', 'cancelled', 'cancelled']);
    const [call] = await claude.calls();
    for (let attempt = 0; attempt < 20 && alive(call!.pid); attempt += 1) await delay(100);
    assert.equal(alive(call!.pid), false);
    assert.equal((await claude.calls()).length, 1);
  });

  test('stops asking an engine that broke its isolation, and one that failed twice in a row', async t => {
    const { claude, codex, probe } = await setup(t, {
      runs: 2,
      claude: { default: { searches: [{ tool: 'Bash', links: [] }], answer: 'done' } },
      codex: { default: { answer: 'x', failTurn: true } },
    });
    const report = await probe();
    assert.equal((await claude.calls()).length, 1);
    assert.equal((await codex!.calls()).length, 2);
    const [first, second] = report.engines;
    assert.deepEqual(first!.notices, [{ code: 'stopped', reason: 'tool-use', consecutive: 1 }]);
    assert.deepEqual(first!.runs.map(run => run.status === 'failed' ? run.error?.code : run.skipped), ['tool-use', 'engine-stopped', 'engine-stopped', 'engine-stopped', 'engine-stopped', 'engine-stopped']);
    assert.deepEqual(second!.notices, [{ code: 'stopped', reason: 'provider-failed', consecutive: 2 }]);
    assert.ok(first!.queries.every(query => query.completed === 0 && query.insufficientSample));
  });

  test('reports an engine that is not installed and still runs the other', async t => {
    const { probe } = await setup(t, { runs: 1, codex: null });
    const report = await probe();
    const codex = report.engines.find(section => section.engine === 'codex')!;
    assert.equal(codex.status, 'unavailable');
    assert.match(codex.problem ?? '', /Codex CLI was not found/u);
    assert.equal(report.engines.find(section => section.engine === 'claude')!.status, 'ran');
  });

  test('flags runs whose search results were not in the form it reads', async t => {
    const { probe } = await setup(t, { engines: ['claude'], keywords: ['seo audit andorra'], runs: 1, codex: null, claude: { default: { searches: [{ links: [{ title: 'A', url: 'https://altitudstudio.ad/' }], format: 'markdown' }], answer: 'See https://altitudstudio.ad/.' } } });
    const report = await probe();
    const section = report.engines[0]!;
    assert.deepEqual(section.notices, [{ code: 'unrecognised-results', runs: 2 }]);
    assert.equal(section.runs[0]!.retrievalFormat, 'text');
    assert.equal(section.queries[0]!.cited, 1, 'URLs read from the text still count, with the fallback reported');
  });
});

describe('the probe cache', () => {
  test('rejects entries that were tampered with, from the future or malformed, and cleans what it returns', async t => {
    const directory = `${await sandbox(t)}/cache`;
    const key = probeCacheKey({ engine: 'claude', cliVersion: '2.0.59', searchMode: 'claude-websearch', locale: 'united-states', prompt: 'p', query: 'q', run: 1 });
    const run = { answer: `Altitud${String.fromCodePoint(0x202e)} Studio`, retrieved: ['https://a.example/#x', 'javascript:alert(1)'], formats: ['links-json' as const], searches: 1, durationMs: 5, at: '2026-11-04T10:00:00.000Z' };
    await writeProbeCache(key, run, { directory, now: () => 1000 });
    const read = await readProbeCache(key, { directory, now: () => 2000 });
    assert.deepEqual(read, { answer: 'Altitud Studio', retrieved: ['https://a.example/'], formats: ['links-json'], searches: 1, durationMs: 5, at: '2026-11-04T10:00:00.000Z' });
    assert.equal(await readProbeCache(key, { directory, now: () => 500 }), undefined, 'an entry from the future is a miss');
    await writeProbeCache(key, { ...run, searches: -1 }, { directory, now: () => 1000 });
    assert.equal(await readProbeCache(key, { directory, now: () => 2000 }), undefined);
    assert.equal(await readProbeCache('../../outside', { directory }), undefined);
    const other = probeCacheKey({ engine: 'claude', cliVersion: '2.0.60', searchMode: 'claude-websearch', locale: 'united-states', prompt: 'p', query: 'q', run: 1 });
    assert.notEqual(other, key);
    assert.notEqual(probeCacheKey({ engine: 'claude', cliVersion: '2.0.59', searchMode: 'claude-websearch', locale: 'united-states', prompt: 'p', query: 'q', run: 2 }), key);
  });
});
