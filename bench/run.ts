/**
 * The integrated benchmark: serves every scenario over HTTPS on loopback, audits it with the real pipeline and Chrome,
 * and grades the findings against the scenario's expectations. Run it with `npm run bench`.
 */
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { findChrome } from '../src/render/chrome.ts';
import { createTestCa } from '../test/support/certificates.ts';
import { scenarios } from './scenarios/index.ts';
import { checkScenario, executeScenario, fingerprint, ruleErrors, type Check, type ScenarioRun } from './support/execute.ts';

const usage = `Usage: npm run bench -- [--scenario <name>]... [--repeat <n>] [--findings]

  --scenario <name>  Run only this scenario; repeat the flag for several.
  --repeat <n>       Run each scenario n times and fail when its deterministic findings differ between runs.
  --findings         Also print every failing finding of each scenario, to help write expectations.
`;

interface Problem {
  readonly scenario: string;
  readonly text: string;
}

function parse(): { names: string[]; repeat: number; findings: boolean } {
  const { values } = parseArgs({
    strict: true,
    options: { scenario: { type: 'string', multiple: true }, repeat: { type: 'string' }, findings: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    process.stdout.write(usage);
    process.exit(0);
  }
  const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('--repeat must be a whole number from 1 to 20.');
  const names = values.scenario ?? [];
  const unknown = names.filter(name => !scenarios.some(scenario => scenario.name === name));
  if (unknown.length > 0) throw new Error(`Unknown scenario ${unknown.join(', ')}. Known: ${scenarios.map(scenario => scenario.name).join(', ')}.`);
  return { names, repeat, findings: values.findings === true };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const ratio = (part: number, whole: number) => (whole === 0 ? '-' : (part / whole).toFixed(2));

function table(rows: readonly (readonly string[])[], rightAligned: ReadonlySet<number>): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
  return rows.map(row => row.map((cell, column) => (rightAligned.has(column) ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join('  ').trimEnd()).join('\n');
}

function describeCheck(check: Check): string {
  return `${check.rule}${check.page ? ` on ${check.page}` : ''}: ${check.detail}`;
}

function differences(first: readonly string[], other: readonly string[]): string[] {
  const missing = first.filter(line => !other.includes(line)).map(line => `- ${line}`);
  const added = other.filter(line => !first.includes(line)).map(line => `+ ${line}`);
  return [...missing, ...added];
}

async function main(): Promise<number> {
  let options: ReturnType<typeof parse>;
  try {
    options = parse();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 2;
  }
  const chromePath = findChrome();
  if (!chromePath || !existsSync(chromePath)) {
    process.stderr.write(chromePath
      ? `The benchmark needs Chrome or Chromium to render pages, and CHROME_PATH points to ${chromePath}, which does not exist.\n`
      : 'The benchmark needs Chrome or Chromium to render pages, and none was found. Install Chrome or set CHROME_PATH.\n');
    return 2;
  }
  const started = performance.now();
  const selected = options.names.length > 0 ? scenarios.filter(scenario => options.names.includes(scenario.name)) : scenarios;
  const ca = createTestCa('Altimeter Bench CA');
  const checks: Array<Check & { readonly scenario: string }> = [];
  const problems: Problem[] = [];
  let browser = '';
  process.stdout.write(`Altimeter benchmark: ${selected.length} scenario${selected.length === 1 ? '' : 's'}${options.repeat > 1 ? `, ${options.repeat} runs each` : ''}\n\n`);
  for (const scenario of selected) {
    let first: ScenarioRun | undefined;
    const elapsed: number[] = [];
    try {
      for (let attempt = 0; attempt < options.repeat; attempt += 1) {
        const run = await executeScenario(scenario, { ca, chromePath });
        elapsed.push(run.durationMs);
        browser ||= run.result.report.run.versions.chrome ?? '';
        if (!first) {
          first = run;
          continue;
        }
        const changed = differences(fingerprint(first), fingerprint(run));
        if (changed.length > 0) problems.push({ scenario: scenario.name, text: `run ${attempt + 1} differs from run 1:\n      ${changed.slice(0, 12).join('\n      ')}` });
      }
    } catch (error) {
      problems.push({ scenario: scenario.name, text: `the scenario could not run: ${error instanceof Error ? error.stack ?? error.message : String(error)}` });
      process.stdout.write(`  ERROR ${scenario.name}\n`);
      continue;
    }
    const run = first!;
    const graded = checkScenario(run);
    checks.push(...graded.map(check => ({ ...check, scenario: scenario.name })));
    for (const error of ruleErrors(run)) problems.push({ scenario: scenario.name, text: `rule error ${error}` });
    for (const warning of run.result.report.run.warnings) problems.push({ scenario: scenario.name, text: `collector warning: ${warning}` });
    if (run.strayHosts.length > 0) problems.push({ scenario: scenario.name, text: `requests for hosts the scenario does not serve: ${run.strayHosts.join(', ')}` });
    const failed = graded.filter(check => !check.known && (check.verdict === 'fn' || check.verdict === 'fp' || check.verdict === 'unevaluated')).length;
    const status = failed > 0 ? 'FAIL' : 'ok';
    process.stdout.write(`  ${status.padEnd(5)} ${scenario.name.padEnd(30)} ${seconds(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length).padStart(7)}  ${graded.length} checks${failed > 0 ? `, ${failed} failed` : ''}\n`);
    if (options.findings) {
      const port = `:${run.port}`;
      for (const finding of run.result.report.findings.filter(entry => entry.outcome === 'fail')) {
        const scope = finding.scope.kind === 'page' ? finding.scope.url.replace(port, '') : 'site';
        process.stdout.write(`        ${finding.ruleId} ${finding.severity}${finding.reason ? ` ${finding.reason}` : ''} ${scope}${finding.needsJudgment ? ' (judgment)' : ''}\n`);
      }
    }
  }

  const rules = [...new Set(checks.map(check => check.rule))].sort();
  const count = (rule: string | undefined, verdict: Check['verdict']) => checks.filter(check => (rule === undefined || check.rule === rule) && check.verdict === verdict).length;
  const rows = rules.map(rule => {
    const [tp, fp, fn, tn] = (['tp', 'fp', 'fn', 'tn'] as const).map(verdict => count(rule, verdict));
    const known = checks.some(check => check.rule === rule && check.known) ? ' *' : '';
    return [`${rule}${known}`, String(tp), String(fp), String(fn), String(tn), ratio(tp!, tp! + fp!), ratio(tp!, tp! + fn!)];
  });
  const [tp, fp, fn, tn] = (['tp', 'fp', 'fn', 'tn'] as const).map(verdict => count(undefined, verdict));
  process.stdout.write(`\n${table([
    ['Rule', 'TP', 'FP', 'FN', 'TN', 'Precision', 'Recall'],
    ...rows,
    [`All ${rules.length} rules`, String(tp), String(fp), String(fn), String(tn), ratio(tp!, tp! + fp!), ratio(tp!, tp! + fn!)],
  ], new Set([1, 2, 3, 4, 5, 6]))}\n`);
  if (rows.some(row => row[0]!.endsWith(' *'))) process.stdout.write('* the rule has a known gap, listed below\n');

  const violations = checks.filter(check => !check.known && check.verdict !== 'tp' && check.verdict !== 'tn');
  const gaps = checks.filter(check => check.known);
  if (violations.length > 0 || problems.length > 0) {
    process.stdout.write('\nViolated expectations:\n');
    for (const check of violations) process.stdout.write(`  ${check.scenario}: ${check.verdict === 'unevaluated' ? 'not evaluated' : check.verdict.toUpperCase()} ${describeCheck(check)}\n`);
    for (const problem of problems) process.stdout.write(`  ${problem.scenario}: ${problem.text}\n`);
  }
  if (gaps.length > 0) {
    process.stdout.write('\nKnown gaps (they do not fail the run):\n');
    for (const check of gaps) {
      const holds = check.verdict === 'tp' || check.verdict === 'tn';
      process.stdout.write(`  ${check.scenario}: ${check.rule}: ${check.known}${holds ? ' (now met: the known marker can go)' : ''}\n`);
    }
  }
  const total = performance.now() - started;
  process.stdout.write(`\n${violations.length + problems.length === 0 ? 'Passed' : 'Failed'}: ${checks.length} checks in ${selected.length} scenarios, ${Math.floor(total / 60_000)} min ${Math.round((total % 60_000) / 1000)} s${browser ? ` with ${browser}` : ''}.\n`);
  return violations.length + problems.length === 0 ? 0 : 1;
}

process.exitCode = await main();
