import type { Category, RuleMeta, Severity } from '../core/types.ts';
import { categories } from '../core/types.ts';
import type { Finding } from '../rules/engine.ts';

export const severityWeights: Readonly<Record<Severity, number>> = { critical: 10, high: 5, medium: 3, low: 1, info: 0 };

export const scoreFormula = 'For each category, score = 100 x (1 - sum of the weights of failed severities / sum of the weights of the maximum severities of every evaluated check), with weights critical 10, high 5, medium 3, low 1. Only deterministic checks marked as scored count; model judgments, info checks and checks that could not be evaluated never change the score. The overall score weights each category by the sum of its evaluated weights.';

export interface CategoryScore {
  readonly category: Category;
  /** 0-100, or null when no scored check could be evaluated. */
  readonly score: number | null;
  readonly evaluated: number;
  readonly failed: number;
  readonly notEvaluated: number;
  readonly notApplicable: number;
}

export interface Score {
  readonly overall: number | null;
  readonly categories: readonly CategoryScore[];
  /** fail when a critical crawling or indexing check failed on an audited page. */
  readonly indexability: 'pass' | 'fail' | 'unknown';
  readonly formula: string;
}

export function computeScore(findings: readonly Finding[], rulesById: ReadonlyMap<string, RuleMeta>): Score {
  const totals = new Map<Category, { possible: number; penalty: number; evaluated: number; failed: number; notEvaluated: number; notApplicable: number }>();
  for (const category of categories) totals.set(category, { possible: 0, penalty: 0, evaluated: 0, failed: 0, notEvaluated: 0, notApplicable: 0 });
  let indexabilityEvaluated = false;
  let indexabilityFailed = false;
  for (const finding of findings) {
    const rule = rulesById.get(finding.ruleId);
    if (!rule || finding.origin === 'ai') continue;
    const total = totals.get(rule.category)!;
    if (finding.outcome === 'not_evaluated') total.notEvaluated += 1;
    if (finding.outcome === 'not_applicable') total.notApplicable += 1;
    if (finding.outcome !== 'pass' && finding.outcome !== 'fail') continue;
    if (rule.category === 'crawl') {
      indexabilityEvaluated = true;
      if (finding.outcome === 'fail' && finding.severity === 'critical') indexabilityFailed = true;
    }
    if (!rule.scored) continue;
    total.evaluated += 1;
    total.possible += severityWeights[rule.maxSeverity];
    if (finding.outcome === 'fail') {
      total.failed += 1;
      total.penalty += severityWeights[finding.severity ?? rule.maxSeverity];
    }
  }
  const scores: CategoryScore[] = categories.map(category => {
    const total = totals.get(category)!;
    return {
      category,
      score: total.possible === 0 ? null : Math.round(100 * Math.max(0, 1 - total.penalty / total.possible)),
      evaluated: total.evaluated,
      failed: total.failed,
      notEvaluated: total.notEvaluated,
      notApplicable: total.notApplicable,
    };
  });
  const weighted = scores.filter(entry => entry.score !== null).map(entry => ({ score: entry.score!, weight: totals.get(entry.category)!.possible }));
  const weight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  return {
    overall: weight === 0 ? null : Math.round(weighted.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / weight),
    categories: scores,
    indexability: indexabilityFailed ? 'fail' : indexabilityEvaluated ? 'pass' : 'unknown',
    formula: scoreFormula,
  };
}
