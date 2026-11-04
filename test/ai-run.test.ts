import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { clearCache } from '../src/ai/cache.ts';
import { runAnalysis, type AnalysisOptions } from '../src/ai/run.ts';
import { systemPrompt } from '../src/ai/system-prompt.ts';
import type { ReportAnalysis } from '../src/ai/types.ts';
import { mergeAnalysis } from '../src/report/model.ts';
import { hotelAudit, hotelScenario, outOfSchemaRules, ownerSecret, roomsUrl, verifierVerdicts } from './support/analysis.ts';
import { providerDouble, sandbox, testEnv } from './support/providers.ts';

async function setup(t: TestContext, scenario: object = hotelScenario, audit = hotelAudit()) {
  const home = await sandbox(t);
  const claude = await providerDouble(home, 'claude', scenario);
  const env = testEnv(home, { claude: claude.executable });
  const options = (extra: Partial<AnalysisOptions> = {}): AnalysisOptions => ({ ...audit, env, cacheDir: join(home, 'cache'), ...extra });
  return { home, claude, env, options };
}

/** What a run concluded, without ids that depend on the evidence numbering. */
function outcomes(result: ReportAnalysis) {
  return {
    findings: result.findings.map(finding => [finding.ruleId, finding.outcome, finding.severity ?? null, finding.confidence, finding.verification]).sort(),
    dropped: result.dropped.map(entry => [entry.kind, entry.ruleId ?? '', entry.reason]).sort(),
    proposals: result.proposals.map(entry => [entry.kind, entry.kind === 'json-ld' ? entry.jsonLd : entry.text]).sort(),
    confirmations: result.confirmations.map(entry => [entry.ruleId, entry.decision]).sort(),
  };
}

describe('runAnalysis with a synthetic Claude Code', () => {
  test('keeps only claims that pass validation and verification, and records why the others were dropped', async t => {
    const { claude, options } = await setup(t);
    const result = await runAnalysis(options());
    assert.deepEqual(result.warnings, []);
    assert.equal(result.provider.analyst?.name, 'claude');
    assert.equal(result.provider.analyst?.cliVersion, '2.0.59');
    assert.deepEqual(result.calls.map(call => [call.role, call.pass, call.status]), [
      ['analyst', 'content', 'ok'], ['analyst', 'content', 'ok'], ['analyst', 'serp', 'ok'], ['analyst', 'schema', 'ok'], ['verifier', 'content', 'ok'], ['verifier', 'schema', 'ok'],
    ]);
    assert.equal((await claude.calls()).length, 6);
    assert.ok(Math.abs(result.costUsd - 6 * 0.0125) < 1e-9);
    const { findings, dropped, confirmations } = outcomes(result);
    assert.deepEqual(findings, [
      ['content-img-alt-quality', 'pass', null, 'high', 'supported'],
      ['content-keyword-stuffing', 'fail', 'medium', 'medium', 'partial'],
      ['content-subtopic-coverage', 'fail', 'medium', 'medium', 'supported'],
      ['content-title-obsolete-year', 'pass', null, 'high', 'supported'],
      ['schema-localbusiness', 'fail', 'medium', 'high', 'supported'],
      ['schema-visible-content-parity', 'pass', null, 'high', 'supported'],
    ]);
    assert.deepEqual(dropped, [
      ['assessment', '', 'unknown-evidence'],
      ['finding', 'content-headings-descriptive', 'contradicts-deterministic'],
      ['finding', 'content-headings-descriptive', 'scope-not-audited'],
      ['finding', 'content-headings-descriptive', 'unknown-evidence'],
      ['finding', 'content-hidden-links', 'rule-out-of-scope'],
      ['finding', 'content-imaginary-rule', 'rule-not-in-catalog'],
      ['finding', 'content-intent-match', 'myth'],
      ['finding', 'content-title-sensational', 'quote-other-evidence'],
      ['finding', 'content-ymyl-classification', 'verification-unsupported'],
      ['finding', 'crawl-soft-404', 'rule-out-of-scope'],
      ['proposal', '', 'brand-missing'],
      ['proposal', '', 'new-fact'],
      ['proposal', '', 'new-fact'],
      ['proposal', '', 'retired-feature'],
    ]);
    assert.deepEqual(confirmations, [
      ['content-img-alt-quality', 'dismissed'],
      ['content-keyword-stuffing', 'confirmed'],
      ['content-title-obsolete-year', 'dismissed'],
      ['schema-localbusiness', 'confirmed'],
      ['schema-visible-content-parity', 'dismissed'],
    ]);
  });

  test('gives code-decided hybrid rules to the analyst only as candidates', async t => {
    const { claude, options } = await setup(t);
    await runAnalysis(options());
    const content = (await claude.calls()).find(call => call.stdin.includes('Content quality and E-E-A-T: analyst request for P1'));
    const scope = content!.stdin.slice(content!.stdin.indexOf('## Rules in scope'), content!.stdin.indexOf('## Myths'));
    const listed = [...scope.matchAll(/"id":"([a-z0-9-]+)","title"/gu)].map(match => match[1]);
    for (const id of ['content-img-alt-quality', 'content-keyword-stuffing', 'content-title-obsolete-year']) assert.match(scope, new RegExp(`"id":"${id}"[^\\n]*"candidate":true`, 'u'));
    for (const id of ['content-subtopic-coverage', 'content-headings-descriptive', 'content-title-sensational', 'content-intent-match']) assert.ok(listed.includes(id), `${id} is the analyst's own rule`);
    for (const id of ['content-hidden-links', 'content-stale-content', 'content-title-h1-mismatch']) assert.equal(listed.includes(id), false, `${id} is decided by code and has no candidate`);
  });

  test('caps judged severity at medium and lowers confidence for likely verdicts and partial verification', async t => {
    const { options } = await setup(t);
    const result = await runAnalysis(options());
    const stuffing = result.findings.find(finding => finding.ruleId === 'content-keyword-stuffing')!;
    assert.deepEqual(stuffing.adjustments, ['severity-capped:high->medium', 'verification-partial:high->medium']);
    assert.equal(stuffing.origin, 'ai');
    assert.match(stuffing.id, /^F-[0-9a-f]{16}$/u);
    const coverage = result.findings.find(finding => finding.ruleId === 'content-subtopic-coverage')!;
    assert.deepEqual(coverage.adjustments, ['confidence-capped:high->medium']);
    assert.ok(result.findings.every(finding => finding.severity === undefined || ['medium', 'low', 'info'].includes(finding.severity)));
  });

  test('accepts quotes written with other apostrophes and checks proposals in code', async t => {
    const { options } = await setup(t, { responses: hotelScenario.responses.map(entry => ('verdicts' in entry ? { ...entry, verdicts: { '*': 'supported' } } : entry)) });
    const result = await runAnalysis(options());
    const ymyl = result.findings.find(finding => finding.ruleId === 'content-ymyl-classification');
    assert.equal(ymyl?.quotes[0]?.text, "We don't rent rooms by the hour", 'the page writes the apostrophe as U+2019');
    const kinds = result.proposals.map(proposal => [proposal.kind, proposal.placeholders]);
    assert.deepEqual(kinds, [['title', 0], ['meta-description', 0], ['json-ld', 1]]);
    const markup = JSON.parse((result.proposals.find(proposal => proposal.kind === 'json-ld') as { jsonLd: string }).jsonLd) as { sameAs: string[] };
    assert.deepEqual(markup.sameAs, ['https://www.instagram.com/hotelexample/', 'OWNER_TO_SUPPLY'], 'a link not on the crawled pages becomes a placeholder');
    const assessment = result.assessments.find(entry => entry.page === roomsUrl)!;
    assert.equal(assessment.ymyl?.value, 'not');
    assert.equal(assessment.nonCommodityValue?.value, 'no');
    assert.deepEqual(assessment.selfAssessment.map(entry => entry.question), ['original-information', 'descriptive-heading']);
  });

  test('keeps the evidence it cites, with ids that never collide with deterministic ones', async t => {
    const { options } = await setup(t);
    const { report } = hotelAudit();
    const result = await runAnalysis(options());
    const cited = new Set(result.findings.flatMap(finding => finding.evidence));
    for (const id of cited) {
      if (id.startsWith('E')) assert.ok(report.evidence.some(item => item.id === id), `${id} is in the report`);
      else assert.ok(result.evidence.some(item => item.id === id), `${id} is in the analysis evidence`);
    }
    assert.ok(result.evidence.every(item => item.id.startsWith('A')));
  });

  test('an injection in alt text and JSON-LD changes no validation outcome and is reported as a candidate', async t => {
    const clean = await setup(t);
    const injected = await setup(t, hotelScenario, hotelAudit({ injection: true }));
    const before = await runAnalysis(clean.options());
    const after = await runAnalysis(injected.options());
    assert.deepEqual(outcomes(after), outcomes(before));
    assert.deepEqual(before.injectionCandidates, []);
    assert.deepEqual(after.injectionCandidates.map(entry => [entry.ruleId, entry.where, entry.pattern, entry.visible]), [
      ['ai-hidden-llm-instructions', 'img alt text', 'ignore-instructions', false],
      ['ai-hidden-llm-instructions', 'JSON-LD block', 'ignore-instructions', false],
    ]);
  });

  test('owner data never enters a request, while the report keeps it', async t => {
    const audit = hotelAudit({ owner: true });
    const owned = audit.report.evidence.filter(item => item.kind === 'owner-data').map(item => item.id);
    assert.ok(owned.length >= 2, 'the fixture has owner evidence');
    assert.ok(audit.report.findings.some(finding => finding.origin === 'owner-data' && finding.ruleId === 'content-gsc-low-ctr'));
    assert.ok(audit.report.findings.some(finding => finding.origin === 'deterministic' && finding.evidence.some(id => owned.includes(id))));
    const { claude, env, home, options } = await setup(t, hotelScenario, audit);
    const result = await runAnalysis(options());
    const calls = await claude.calls();
    assert.ok(calls.some(call => call.stdin.includes('Verification of')), 'verification requests are checked too');
    for (const call of calls) {
      assert.equal(call.stdin.includes(ownerSecret), false, 'no Search Console query');
      assert.equal(call.stdin.includes('content-gsc-low-ctr'), false, 'no owner-data rule');
      for (const id of owned) assert.equal(call.stdin.includes(`"${id}"`), false, `no owner evidence ${id}`);
    }
    const withoutOwner = await runAnalysis({ ...hotelAudit(), env, cacheDir: join(home, 'cache-without-owner') });
    assert.deepEqual(outcomes(result).findings, outcomes(withoutOwner).findings, 'owner data changes nothing the analysis concludes');
  });

  test('sends site text only inside nonce delimiters, after the trusted part', async t => {
    const { claude, options } = await setup(t, hotelScenario, hotelAudit({ injection: true }));
    await runAnalysis(options());
    for (const call of await claude.calls()) {
      const begin = /<<<SITE-DATA ([0-9a-f]{24}) BEGIN>>>/u.exec(call.stdin);
      assert.ok(begin, 'every request delimits its untrusted part');
      const nonce = begin[1]!;
      assert.ok(call.stdin.indexOf(`<<<SITE-DATA ${nonce} END>>>`) > begin.index);
      const trusted = call.stdin.slice(0, begin.index);
      assert.doesNotMatch(trusted, /Ignore (all )?previous instructions/u);
      assert.ok(Buffer.byteLength(call.stdin, 'utf8') + Buffer.byteLength(systemPrompt, 'utf8') <= 60 * 1024);
    }
    const nonces = new Set((await claude.calls()).map(call => /<<<SITE-DATA ([0-9a-f]{24}) BEGIN>>>/u.exec(call.stdin)![1]));
    assert.equal(nonces.size, 1, 'one nonce per run');
  });
});

describe('verification outcomes', () => {
  test('a failed verification leaves findings unverified, out of the findings list', async t => {
    const scenario = { responses: [{ when: 'Verification of', isError: true, subtype: 'error_during_execution' }, ...hotelScenario.responses.slice(1)] };
    const { options } = await setup(t, scenario);
    const result = await runAnalysis(options());
    assert.deepEqual(result.findings, []);
    assert.ok(result.unverified.length >= 6);
    assert.ok(result.unverified.every(finding => finding.verification === 'unverified'));
    assert.ok(result.warnings.some(warning => /verifier call C\d+ \(content\) failed/u.test(warning)));
    assert.ok(result.confirmations.every(entry => entry.verification === 'unverified'));
  });

  test('a finding the verifier does not answer stays unverified', async t => {
    const scenario = { responses: [{ when: 'Verification of', verdicts: { ...verifierVerdicts, 'content-img-alt-quality': 'omit' } }, ...hotelScenario.responses.slice(1)] };
    const { options } = await setup(t, scenario);
    const result = await runAnalysis(options());
    assert.deepEqual(result.unverified.map(finding => finding.ruleId), ['content-img-alt-quality']);
    assert.equal(result.findings.some(finding => finding.ruleId === 'content-img-alt-quality'), false);
  });

  test('a partial verdict lowers confidence one level and drops a finding that is already low', async t => {
    const lowAlt = (entry: (typeof hotelScenario.responses)[number]) => {
      if (!('answer' in entry) || !('findings' in entry.answer)) return entry;
      const findings = (entry.answer.findings as ReadonlyArray<Record<string, unknown>>).map(item => (item.ruleId === 'content-img-alt-quality' ? { ...item, confidence: 'low' } : item));
      return { ...entry, answer: { ...entry.answer, findings } };
    };
    const verdicts = { 'content-subtopic-coverage': 'partial', 'content-img-alt-quality': 'partial', '*': 'supported' };
    const scenario = { responses: [{ when: 'Verification of', verdicts }, ...hotelScenario.responses.slice(1).map(lowAlt)] };
    const { options } = await setup(t, scenario);
    const result = await runAnalysis(options());
    const coverage = result.findings.find(finding => finding.ruleId === 'content-subtopic-coverage');
    assert.equal(coverage?.confidence, 'low', 'medium after the likely cap, low after partial verification');
    assert.equal(coverage?.verification, 'partial');
    assert.equal(result.findings.some(finding => finding.ruleId === 'content-img-alt-quality'), false);
    assert.ok(result.dropped.some(entry => entry.ruleId === 'content-img-alt-quality' && entry.reason === 'verification-partial-low' && entry.role === 'verifier'));
  });

  test('verifier none leaves every finding unverified; verifier other uses the other CLI', async t => {
    const { home, options } = await setup(t);
    const none = await runAnalysis(options({ verifier: 'none' }));
    assert.deepEqual(none.findings, []);
    assert.ok(none.unverified.length > 0);
    assert.ok(none.warnings.some(warning => /Verification was turned off/u.test(warning)));
    assert.equal(none.calls.filter(call => call.role === 'verifier').length, 0);
    const codex = await providerDouble(home, 'codex', { responses: [{ when: 'Verification of', verdicts: { '*': 'supported' } }] });
    const claude = await providerDouble(home, 'claude', hotelScenario);
    const other = await runAnalysis({ ...hotelAudit(), env: testEnv(home, { claude: claude.executable, codex: codex.executable }), cacheDir: join(home, 'cache-other'), verifier: 'other' });
    assert.equal(other.provider.verifier?.name, 'codex');
    assert.equal((await codex.calls()).length, 2);
    assert.ok(other.findings.length > 0);
  });
});

describe('planning, budget and providers', () => {
  test('dry run writes every prompt, its schema and the call plan, and starts no process', async t => {
    const { home, claude, options } = await setup(t);
    const directory = join(home, 'dry-run');
    const result = await runAnalysis(options({ dryRunDir: directory }));
    assert.deepEqual(await claude.calls(), []);
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, [
      '01-content-p1.prompt.txt', '01-content-p1.schema.json', '02-content-p2.prompt.txt', '02-content-p2.schema.json', '03-serp-p1.prompt.txt', '03-serp-p1.schema.json',
      '04-schema-p1.prompt.txt', '04-schema-p1.schema.json', 'plan.json', 'system-prompt.txt',
    ]);
    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
    assert.equal(plan.calls.length, 4);
    for (const call of plan.calls) {
      const prompt = await readFile(join(directory, call.promptFile), 'utf8');
      const schema = await readFile(join(directory, call.promptFile.replace('.prompt.txt', '.schema.json')), 'utf8');
      assert.equal(call.estimatedTokens, Math.ceil((systemPrompt.length + prompt.length + JSON.stringify(JSON.parse(schema)).length) / 4));
    }
    assert.deepEqual(plan.verification.map((entry: { pass: string }) => entry.pass), ['content', 'serp', 'schema']);
    assert.equal(plan.totals.analystCalls, 4);
    assert.ok(plan.notNeeded.some((entry: { pass: string; reason: string }) => entry.pass === 'intl'));
    assert.ok(result.calls.every(call => call.status === 'planned'));
  });

  test('an answer that does not match its schema is never cached', async t => {
    const { claude, options } = await setup(t);
    await runAnalysis(options());
    const second = await runAnalysis(options());
    assert.deepEqual(second.calls.filter(call => call.status === 'ok').map(call => call.pass), ['content'], 'the content answer names rules outside the schema');
    assert.equal((await claude.calls()).length, 7);
  });

  test('a second run is served from the cache; a different keyword asks again; clearCache empties it', async t => {
    const outOfSchema = new Set(outOfSchemaRules);
    const responses = hotelScenario.responses.map(entry => {
      if (!('answer' in entry) || !('findings' in entry.answer)) return entry;
      return { ...entry, answer: { ...entry.answer, findings: (entry.answer.findings as Array<{ ruleId: string }>).filter(item => !outOfSchema.has(item.ruleId)) } };
    });
    const { home, claude, options } = await setup(t, { responses });
    const first = await runAnalysis(options());
    const second = await runAnalysis(options());
    assert.equal((await claude.calls()).length, 6, 'no provider call on the second run');
    assert.ok(second.calls.every(call => call.status === 'cached'));
    assert.equal(second.costUsd, 0);
    assert.deepEqual(outcomes(second), outcomes(first));
    const third = await runAnalysis(options({ keyword: ['hotel rooms andorra'] }));
    assert.ok(third.calls.some(call => call.status === 'ok'), 'the keyword is part of the cache key');
    assert.ok((await claude.calls()).length > 6);
    const removed = await clearCache({ directory: join(home, 'cache') });
    assert.ok(removed >= 6);
    const fourth = await runAnalysis(options());
    assert.ok(fourth.calls.every(call => call.status === 'ok'));
  });

  test('stays within the call limit, keeping a verification call for every pass that runs', async t => {
    const { claude, options } = await setup(t);
    const result = await runAnalysis(options({ maxCalls: 3 }));
    assert.ok(result.calls.length <= 3);
    assert.equal((await claude.calls()).length, result.calls.length);
    assert.ok(result.warnings.some(warning => /left out to stay within the call limit/u.test(warning)));
    assert.deepEqual(result.calls.map(call => [call.role, call.pass]), [['analyst', 'content'], ['analyst', 'content'], ['verifier', 'content']]);
  });

  test('Codex as the analyst reaches the same conclusions from the same answers', async t => {
    const { options } = await setup(t);
    const viaClaude = await runAnalysis(options());
    const home = await sandbox(t);
    const codex = await providerDouble(home, 'codex', hotelScenario);
    const viaCodex = await runAnalysis({ ...hotelAudit(), provider: 'codex', env: testEnv(home, { codex: codex.executable }), cacheDir: join(home, 'cache') });
    assert.equal(viaCodex.provider.analyst?.name, 'codex');
    assert.deepEqual(outcomes(viaCodex), outcomes(viaClaude));
    for (const call of await codex.calls()) assert.ok(call.stdin.startsWith(systemPrompt), 'Codex gets the system prompt on stdin');
  });

  test('the overall deadline cancels hung calls and skips the rest', { timeout: 60_000 }, async t => {
    const { options } = await setup(t, { default: { hang: true } });
    const started = Date.now();
    const result = await runAnalysis(options({ deadlineMs: 6000, concurrency: 1 }));
    assert.ok(Date.now() - started < 30_000);
    assert.deepEqual(result.findings, []);
    assert.equal(result.calls[0]?.status, 'failed');
    assert.equal(result.calls[0]?.error?.code, 'cancelled');
    assert.ok(result.calls.slice(1).every(call => call.status === 'skipped' && call.error?.code === 'deadline'));
  });

  test('analyses only as many pages as asked', async t => {
    const { claude, options } = await setup(t);
    const result = await runAnalysis(options({ aiPages: 1 }));
    assert.deepEqual(result.pages, [roomsUrl]);
    assert.ok((await claude.calls()).every(call => !call.stdin.includes('analyst request for P2')));
  });

  test('without any provider CLI the analysis reports why and calls nothing', async t => {
    const home = await sandbox(t);
    const result = await runAnalysis({ ...hotelAudit(), env: testEnv(home), cacheDir: join(home, 'cache') });
    assert.deepEqual(result.calls, []);
    assert.ok(result.warnings.some(warning => /Claude Code was not found/u.test(warning)));
    assert.ok(result.warnings.some(warning => /no provider CLI is available/u.test(warning)));
    const none = await runAnalysis({ ...hotelAudit(), provider: 'none', env: testEnv(home) });
    assert.deepEqual(none.calls, []);
    assert.deepEqual(none.warnings, []);
  });

  test('merges into a report as an optional ai section without touching other fields', async t => {
    const { options } = await setup(t);
    const { report } = hotelAudit();
    const analysis = await runAnalysis(options());
    const merged = mergeAnalysis(report, analysis);
    assert.equal(merged.ai, analysis);
    const { ai: _ai, ...rest } = merged;
    assert.deepEqual(rest, report);
    assert.deepEqual(JSON.parse(JSON.stringify(merged)).ai.findings.length, analysis.findings.length);
  });
});
