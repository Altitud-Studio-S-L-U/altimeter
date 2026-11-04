import { evidenceLabel } from '../../core/evidence.ts';
import type { PageFacts } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import type { LighthouseSummary } from '../../render/lighthouse.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { clsMetric, inpMetric, lcpMetric } from './field.ts';
import { auditEvidence, auditOf, fieldRecord, labConditions, labEvidence, labFormFactor, labOf, notEvaluated, p75 } from './shared.ts';

/** Lighthouse documents that the median of five runs is about twice as stable as a single run. */
const recommendedRuns = 5;

export const labRunProtocol: RuleImplementation = {
  id: 'perf-lab-run-protocol',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const range = summary.lcpRangeMs ? `; lab LCP across valid runs ${Math.round(summary.lcpRangeMs[0])}-${Math.round(summary.lcpRangeMs[1])} ms` : '';
    const benchmark = summary.benchmarkIndex === undefined ? '' : `; benchmarkIndex=${Math.round(summary.benchmarkIndex)}`;
    const run = labEvidence(evidence, page!, summary, 'runs', evidenceLabel('Lighthouse run protocol'), `runs=${summary.runs}; validRuns=${summary.validRuns}${range}${benchmark}`, 'runs');
    const results: RuleResult[] = [];
    if (summary.validRuns < recommendedRuns) {
      results.push({ outcome: 'fail', severity: 'info', reason: 'few-runs', evidence: [run], params: { validRuns: summary.validRuns, runs: summary.runs, recommended: recommendedRuns } });
    }
    if (summary.runWarnings.length > 0) {
      const warnings = labEvidence(evidence, page!, summary, 'runWarnings', evidenceLabel('Lighthouse run warnings'), summary.runWarnings.join(' | '), 'runWarnings');
      results.push({ outcome: 'fail', severity: 'info', reason: 'run-warnings', evidence: [warnings], params: { count: summary.runWarnings.length } });
    }
    return results.length > 0 ? results : [{ outcome: 'pass', evidence: [run] }];
  },
};

export const labPerformanceScore: RuleImplementation = {
  id: 'perf-lab-performance-score',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const score = summary.categories.performance;
    if (score === null || score === undefined) return notEvaluated('no-performance-score');
    const value = Math.round(score * 100);
    const cited = labEvidence(evidence, page!, summary, 'performance', evidenceLabel('Lighthouse performance category score'), `score=${value}`, 'categories.performance');
    if (value >= 90) return { outcome: 'pass', evidence: [cited] };
    return { outcome: 'fail', severity: 'info', reason: value < 50 ? 'poor' : 'needs-improvement', evidence: [cited], params: { score: value, conditions: labConditions(summary) } };
  },
};

interface LabMetric {
  readonly id: string;
  readonly audit: string;
  readonly label: string;
  /** The field metric that takes precedence over this lab value when CrUX has it. */
  readonly field: string;
  /** Returns the severity of a lab value, or undefined when it passes. */
  readonly grade: (value: number, summary: LighthouseSummary) => Severity | undefined;
  readonly format: (value: number) => string | number;
}

function hasFieldValue(page: PageFacts, summary: LighthouseSummary, metric: string): boolean {
  return p75(fieldRecord(page, labFormFactor(summary)), metric) !== undefined;
}

function labMetricRule(spec: LabMetric): RuleImplementation {
  return {
    id: spec.id,
    evaluate({ page, evidence }) {
      const summary = labOf(page)!;
      const value = auditOf(summary, spec.audit)?.numericValue;
      if (value === undefined) return notEvaluated('no-lab-value');
      const cited = auditEvidence(evidence, page!, summary, spec.audit, evidenceLabel('Lighthouse lab {metric}', { metric: spec.label }));
      const severity = spec.grade(value, summary);
      if (severity === undefined) return { outcome: 'pass', evidence: [cited] };
      const params = { value: spec.format(value), conditions: labConditions(summary) };
      // Field data decides the status; the lab value stays as a diagnostic that does not change the score.
      if (hasFieldValue(page!, summary, spec.field)) return { outcome: 'fail', severity: 'info', reason: 'field-precedence', evidence: [cited], params };
      return { outcome: 'fail', severity, evidence: [cited], params };
    },
  };
}

const ms = (value: number) => `${Math.round(value)} ms`;

export const labLcp = labMetricRule({
  id: 'perf-lab-lcp', audit: 'largest-contentful-paint', label: 'Largest Contentful Paint', field: lcpMetric.name, format: ms,
  grade: value => (value > lcpMetric.poor ? 'medium' : value > lcpMetric.good ? 'low' : undefined),
});

/** Lighthouse scoring control points: the median is 600 ms on mobile and 350 ms on desktop. */
export const tbtLimits = { mobile: 600, desktop: 350 } as const;

export const labTbt = labMetricRule({
  id: 'perf-lab-tbt-inp-proxy', audit: 'total-blocking-time', label: 'Total Blocking Time', field: inpMetric.name, format: ms,
  grade: (value, summary) => (value > (summary.settings.formFactor === 'desktop' ? tbtLimits.desktop : tbtLimits.mobile) ? 'medium' : undefined),
});

export const labCls = labMetricRule({
  id: 'perf-lab-cls', audit: 'cumulative-layout-shift', label: 'Cumulative Layout Shift', field: clsMetric.name, format: value => Math.round(value * 1000) / 1000,
  grade: value => (value > clsMetric.poor ? 'medium' : value > clsMetric.good ? 'low' : undefined),
});

export const labImplementations: readonly RuleImplementation[] = [labRunProtocol, labPerformanceScore, labLcp, labTbt, labCls];
