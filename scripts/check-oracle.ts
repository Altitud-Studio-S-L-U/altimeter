import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Severity } from '../src/core/types.ts';
import type { Report, ReportFinding } from '../src/report/model.ts';

/**
 * One expectation about a report: a failure that must appear, a false positive that must not, or a failure that may
 * appear but never above `maxSeverity` (`capped`), for checks that depend on the lab run.
 */
export interface OracleEntry {
  readonly ruleId: string;
  readonly expect: 'present' | 'absent' | 'capped';
  /** The path of the page the finding is on, or "site" for site-wide findings; any scope when omitted. */
  readonly scope?: string;
  readonly reason?: string;
  /** The highest severity the finding may have. */
  readonly maxSeverity?: Severity;
  /** Count candidates that still need judgment too; by default only findings that count are compared. */
  readonly includeCandidates?: boolean;
  readonly note?: string;
}

export interface OracleResult {
  readonly entry: OracleEntry;
  readonly ok: boolean;
  readonly detail: string;
}

const order: readonly Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

function scopeOf(finding: ReportFinding): string {
  return finding.scope.kind === 'site' ? 'site' : new URL(finding.scope.url).pathname;
}

/** Compares a report with an oracle; a report that breaks no expectation passes. */
export function checkOracle(report: Report, entries: readonly OracleEntry[]): OracleResult[] {
  return entries.map(entry => {
    const matching = report.findings.filter(finding => finding.ruleId === entry.ruleId && finding.outcome === 'fail'
      && (entry.includeCandidates || !finding.needsJudgment || finding.judgment === 'confirmed')
      && (entry.scope === undefined || scopeOf(finding) === entry.scope)
      && (entry.reason === undefined || finding.reason === entry.reason));
    const listed = matching.map(finding => `${scopeOf(finding)} ${finding.severity ?? 'info'}${finding.reason ? ` ${finding.reason}` : ''}`).join('; ');
    if (entry.expect === 'absent') return { entry, ok: matching.length === 0, detail: matching.length === 0 ? 'absent' : `reported: ${listed}` };
    if (matching.length === 0) return { entry, ok: entry.expect === 'capped', detail: entry.expect === 'capped' ? 'absent' : 'missing' };
    const tooSevere = entry.maxSeverity === undefined ? [] : matching.filter(finding => order.indexOf(finding.severity ?? 'info') > order.indexOf(entry.maxSeverity!));
    return { entry, ok: tooSevere.length === 0, detail: tooSevere.length === 0 ? `present: ${listed}` : `above ${entry.maxSeverity}: ${listed}` };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [reportPath, oraclePath] = process.argv.slice(2);
  if (!reportPath || !oraclePath) {
    process.stderr.write('Usage: node scripts/check-oracle.ts <report.json> <oracle.json>\n');
    process.exit(2);
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
  const entries = JSON.parse(await readFile(oraclePath, 'utf8')) as OracleEntry[];
  const results = checkOracle(report, entries);
  for (const result of results) process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.entry.expect.padEnd(7)} ${result.entry.ruleId}${result.entry.scope ? ` @ ${result.entry.scope}` : ''}: ${result.detail}\n`);
  const failed = results.filter(result => !result.ok).length;
  process.stdout.write(`${results.length - failed}/${results.length} expectations met\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
