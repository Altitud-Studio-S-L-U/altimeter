import { severities, type Severity } from '../../core/types.ts';
import type { RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';

export const notApplicable = (reason: string): RuleResult => ({ outcome: 'not_applicable', reason });
export const notEvaluated = (reason: string): RuleResult => ({ outcome: 'not_evaluated', reason });
export const pass = (evidence: readonly string[] = []): RuleResult => ({ outcome: 'pass', ...(evidence.length > 0 ? { evidence } : {}) });

export function fail(
  severity: Severity,
  evidence: readonly string[],
  params: Readonly<Record<string, string | number>>,
  reason?: string,
  needsJudgment = false,
): RuleResult {
  return { outcome: 'fail', severity, evidence: [...new Set(evidence)], params, ...(reason ? { reason } : {}), ...(needsJudgment ? { needsJudgment: true } : {}) };
}

export function worst(a: Severity, b: Severity): Severity {
  return severities.indexOf(a) <= severities.indexOf(b) ? a : b;
}

/** Evidence lists stay readable: the first items prove the pattern, the count says how widespread it is. */
export const maxEvidence = 8;

export function list(values: Iterable<string>, max = 3): string {
  return summarizeList([...new Set(values)], max);
}

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return groups;
}
