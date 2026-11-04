import type { Report, ReportFinding } from './model.ts';

export interface Comparison {
  /** Failed before, pass now. */
  readonly fixed: readonly ReportFinding[];
  /** Fail now, passed or did not exist before. */
  readonly introduced: readonly ReportFinding[];
  /** Fail in both. */
  readonly remaining: readonly ReportFinding[];
  /** Failures whose check the other report did not evaluate or, after the change, found not applicable. */
  readonly notComparable: readonly ReportFinding[];
}

function key(finding: ReportFinding): string {
  return JSON.stringify([finding.ruleId, finding.scope.kind === 'page' ? finding.scope.url : finding.scope.origin]);
}

const deterministic = (finding: ReportFinding) => !finding.needsJudgment && finding.origin !== 'ai';
const evaluated = (finding: ReportFinding) => (finding.outcome === 'pass' || finding.outcome === 'fail') && deterministic(finding);
/** A check that did not apply before shows the problem did not exist then, so a failure after it is new. */
const evaluatedBefore = (finding: ReportFinding) => finding.outcome !== 'not_evaluated' && deterministic(finding);

/** Compares two reports of the same site made with the same rule catalog. */
export function compareReports(before: Report, after: Report): Comparison {
  if (before.catalog.hash !== after.catalog.hash) {
    throw new Error('The reports were made with different rule catalogs, so their results are not comparable. Audit both states with the same Altimeter version.');
  }
  const previous = new Map<string, ReportFinding[]>();
  for (const finding of before.findings.filter(evaluatedBefore)) previous.set(key(finding), [...(previous.get(key(finding)) ?? []), finding]);
  const current = new Map<string, ReportFinding[]>();
  for (const finding of after.findings.filter(evaluated)) current.set(key(finding), [...(current.get(key(finding)) ?? []), finding]);
  const fixed: ReportFinding[] = [];
  const introduced: ReportFinding[] = [];
  const remaining: ReportFinding[] = [];
  const notComparable: ReportFinding[] = [];
  for (const [id, now] of current) {
    const was = previous.get(id);
    const failingNow = now.filter(finding => finding.outcome === 'fail');
    if (!was) {
      notComparable.push(...failingNow);
      continue;
    }
    const failedBefore = was.some(finding => finding.outcome === 'fail');
    if (failingNow.length > 0) (failedBefore ? remaining : introduced).push(...failingNow);
    else if (failedBefore) fixed.push(...was.filter(finding => finding.outcome === 'fail'));
  }
  for (const [id, was] of previous) if (!current.has(id)) notComparable.push(...was.filter(finding => finding.outcome === 'fail'));
  return { fixed, introduced, remaining, notComparable };
}
