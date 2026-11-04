import type { PageFacts } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import type { CruxFormFactor } from '../../data/crux.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { directivesFor, pageDocument, robotsDirectives } from '../helpers.ts';
import {
  band, bandLabel, fieldEvidence, fieldRecord, formFactors, missingFieldReason, notApplicable, notEvaluated, p75, percent, scopeLabel,
  type Band, type FieldRecord,
} from './shared.ts';

interface MetricSpec {
  readonly name: string;
  readonly label: string;
  readonly good: number;
  readonly poor: number;
  readonly unit: 'ms' | 'score';
}

export const lcpMetric: MetricSpec = { name: 'largest_contentful_paint', label: 'LCP', good: 2500, poor: 4000, unit: 'ms' };
export const inpMetric: MetricSpec = { name: 'interaction_to_next_paint', label: 'INP', good: 200, poor: 500, unit: 'ms' };
export const clsMetric: MetricSpec = { name: 'cumulative_layout_shift', label: 'CLS', good: 0.1, poor: 0.25, unit: 'score' };
const fcpMetric: MetricSpec = { name: 'first_contentful_paint', label: 'FCP', good: 1800, poor: 3000, unit: 'ms' };
const ttfbMetric: MetricSpec = { name: 'experimental_time_to_first_byte', label: 'TTFB', good: 800, poor: 1800, unit: 'ms' };

export function formatMetric(spec: MetricSpec, value: number): string {
  return spec.unit === 'score' ? value.toFixed(2) : `${Math.round(value)} ms`;
}

interface FieldObservation {
  readonly form: CruxFormFactor;
  readonly field: FieldRecord;
  readonly value: number;
  readonly band: Band;
}

function observe(page: PageFacts | undefined, spec: MetricSpec): FieldObservation[] {
  return formFactors.flatMap(form => {
    const field = fieldRecord(page, form);
    const value = p75(field, spec.name);
    return field && value !== undefined ? [{ form, field, value, band: band(value, spec.good, spec.poor) }] : [];
  });
}

/**
 * One result per form factor with data: phone and desktop are reported separately and never averaged.
 * Origin-level data is labelled as such, since it covers every page of the origin.
 */
function metricRule(id: string, spec: MetricSpec, severity: (observation: FieldObservation, page: PageFacts) => Severity, missing = 'no-field-data'): RuleImplementation {
  return {
    id,
    evaluate({ page, evidence }: RuleContext): RuleResult[] {
      const observations = observe(page, spec);
      if (observations.length === 0) return [notEvaluated(missingFieldReason(page, missing))];
      return observations.map(observation => {
        const value = formatMetric(spec, observation.value);
        const cited = fieldEvidence(evidence, observation.field, spec.name, `p75=${value}`);
        if (observation.band === 'good') return { outcome: 'pass', evidence: [cited] };
        return {
          outcome: 'fail',
          severity: severity(observation, page!),
          evidence: [cited],
          params: { formFactor: observation.form, scope: scopeLabel(observation.field), value, band: bandLabel(observation.band) },
          ...(observation.field.scope === 'origin' ? { reason: 'origin-level' } : {}),
        };
      });
    },
  };
}

const coreSeverity = (observation: FieldObservation): Severity => (observation.band === 'poor' ? 'high' : 'medium');

export const cruxLcp = metricRule('perf-crux-lcp-p75', lcpMetric, coreSeverity);
export const cruxInp = metricRule('perf-crux-inp-p75', inpMetric, coreSeverity, 'no-inp-data');
export const cruxCls = metricRule('perf-crux-cls-p75', clsMetric, coreSeverity);
export const cruxFcp = metricRule('perf-crux-fcp-p75', fcpMetric, () => 'low');

/** TTFB is a diagnostic, not a Core Web Vital: it matters most when LCP is also not good. */
export const cruxTtfb = metricRule('perf-crux-ttfb-p75', ttfbMetric, (observation, page) => {
  const lcp = p75(fieldRecord(page, observation.form), lcpMetric.name);
  return lcp !== undefined && lcp > lcpMetric.good ? 'medium' : 'low';
});

export const cruxAssessment: RuleImplementation = {
  id: 'perf-crux-cwv-assessment',
  evaluate({ page, evidence }) {
    const results: RuleResult[] = [];
    for (const form of formFactors) {
      const field = fieldRecord(page, form);
      if (!field) continue;
      const metrics = [lcpMetric, inpMetric, clsMetric].flatMap(spec => {
        const value = p75(field, spec.name);
        return value === undefined ? [] : [{ spec, value, band: band(value, spec.good, spec.poor) }];
      });
      const has = (spec: MetricSpec) => metrics.some(metric => metric.spec === spec);
      if (!has(lcpMetric) || !has(clsMetric)) {
        results.push(notEvaluated('not-assessable'));
        continue;
      }
      const cited = metrics.map(metric => fieldEvidence(evidence, field, metric.spec.name, `p75=${formatMetric(metric.spec, metric.value)}`));
      const failing = metrics.filter(metric => metric.band !== 'good');
      if (failing.length === 0) {
        results.push({ outcome: 'pass', evidence: cited });
        continue;
      }
      results.push({
        outcome: 'fail',
        severity: form === 'PHONE' ? 'high' : 'medium',
        evidence: cited,
        params: {
          formFactor: form,
          scope: scopeLabel(field),
          metrics: failing.map(metric => `${metric.spec.label} ${formatMetric(metric.spec, metric.value)} (${bandLabel(metric.band)})`).join(', '),
        },
        ...(field.scope === 'origin' ? { reason: 'origin-level' } : {}),
      });
    }
    return results.length > 0 ? results : [notEvaluated(missingFieldReason(page))];
  },
};

function noindex(page: PageFacts): boolean {
  return directivesFor(robotsDirectives(page.fetch.headers, pageDocument(page, 'raw'))).has('noindex');
}

export const cruxAvailability: RuleImplementation = {
  id: 'perf-crux-data-availability',
  evaluate({ page, evidence }) {
    const levels = formFactors.map(form => ({ form, field: fieldRecord(page, form) }));
    const withData = levels.filter(level => level.field !== undefined);
    const cited = withData.map(level => fieldEvidence(evidence, level.field!, 'record', `${level.form}: ${scopeLabel(level.field!)} data`));
    if (withData.some(level => level.field!.scope === 'url')) return { outcome: 'pass', evidence: cited };
    if (withData.length > 0) {
      return { outcome: 'fail', severity: 'info', reason: 'origin-only', evidence: cited, params: { formFactors: withData.map(level => level.form).join(', ') } };
    }
    if (missingFieldReason(page) === 'crux-error') return notEvaluated('crux-error');
    const status = page!.fetch.status;
    const hop = evidence.add({ kind: 'http', url: page!.url, label: 'final response status of the audited URL', excerpt: `HTTP ${status ?? 'none'}` });
    if (status !== 200) return { outcome: 'fail', severity: 'info', reason: 'not-eligible-status', evidence: [hop], params: { status: status ?? 'none' } };
    if (noindex(page!)) {
      const robots = evidence.add({ kind: 'html', url: page!.url, label: 'robots directives of the audited URL', excerpt: 'noindex' });
      return { outcome: 'fail', severity: 'info', reason: 'not-eligible-noindex', evidence: [robots] };
    }
    return { outcome: 'fail', severity: 'info', reason: 'no-field-data', evidence: [hop] };
  },
};

const subpartMetrics = {
  ttfb: 'largest_contentful_paint_image_time_to_first_byte',
  loadDelay: 'largest_contentful_paint_image_resource_load_delay',
  loadDuration: 'largest_contentful_paint_image_resource_load_duration',
  renderDelay: 'largest_contentful_paint_image_element_render_delay',
} as const;

export const subpartLimits = { ttfb: 0.4, loadDelay: 0.1, renderDelay: 0.1 } as const;

export interface Shares {
  readonly ttfb: number;
  readonly loadDelay: number;
  readonly loadDuration: number;
  readonly renderDelay: number;
}

/** The subparts whose share passes the web.dev guideline; the shares are approximate, never absolute targets. */
export function flaggedSubparts(shares: Shares): string[] {
  const flagged: string[] = [];
  if (shares.ttfb > subpartLimits.ttfb) flagged.push(`time to first byte ${percent(shares.ttfb)}`);
  if (shares.loadDelay > subpartLimits.loadDelay) flagged.push(`resource load delay ${percent(shares.loadDelay)}`);
  if (shares.renderDelay > subpartLimits.renderDelay) flagged.push(`element render delay ${percent(shares.renderDelay)}`);
  return flagged;
}

export const cruxSubparts: RuleImplementation = {
  id: 'perf-crux-lcp-subparts',
  evaluate({ page, evidence }) {
    const results: RuleResult[] = [];
    for (const form of formFactors) {
      const field = fieldRecord(page, form);
      const lcp = p75(field, lcpMetric.name);
      if (!field || lcp === undefined) continue;
      if (lcp <= lcpMetric.good) {
        results.push(notApplicable('lcp-good'));
        continue;
      }
      const values = Object.fromEntries(Object.entries(subpartMetrics).map(([key, metric]) => [key, p75(field, metric)])) as Record<keyof Shares, number | undefined>;
      if (Object.values(values).some(value => value === undefined)) {
        results.push(notEvaluated('no-subpart-data'));
        continue;
      }
      const total = Object.values(values).reduce<number>((sum, value) => sum + value!, 0);
      if (total <= 0) {
        results.push(notEvaluated('no-subpart-data'));
        continue;
      }
      const shares = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value! / total])) as unknown as Shares;
      const cited = [
        fieldEvidence(evidence, field, lcpMetric.name, `p75=${Math.round(lcp)} ms`),
        ...Object.entries(subpartMetrics).map(([key, metric]) => fieldEvidence(evidence, field, metric, `p75=${Math.round(values[key as keyof Shares]!)} ms`)),
      ];
      const flagged = flaggedSubparts(shares);
      if (flagged.length === 0) {
        results.push({ outcome: 'pass', evidence: cited });
        continue;
      }
      results.push({ outcome: 'fail', severity: 'medium', evidence: cited, params: { formFactor: form, scope: scopeLabel(field), lcp: `${Math.round(lcp)} ms`, subparts: flagged.join(', ') } });
    }
    return results.length > 0 ? results : [notEvaluated(missingFieldReason(page))];
  },
};

export const cruxNavigationTypes: RuleImplementation = {
  id: 'perf-crux-navigation-types',
  evaluate({ page, evidence }) {
    const results: RuleResult[] = [];
    for (const form of formFactors) {
      const field = fieldRecord(page, form);
      const types = field?.record.navigationTypes;
      if (!field || !types) continue;
      const missed = types.back_forward ?? 0;
      const restored = types.back_forward_cache ?? 0;
      const excerpt = Object.entries(types).map(([type, fraction]) => `${type}=${fraction.toFixed(3)}`).join(', ');
      const cited = fieldEvidence(evidence, field, 'navigation_types', excerpt);
      if (missed > restored && missed + restored >= 0.05) {
        results.push({ outcome: 'fail', severity: 'low', evidence: [cited], params: { formFactor: form, scope: scopeLabel(field), backForward: percent(missed), restored: percent(restored) } });
      } else {
        results.push({ outcome: 'pass', evidence: [cited] });
      }
    }
    return results.length > 0 ? results : [notEvaluated(missingFieldReason(page, 'no-navigation-types'))];
  },
};

/** Context only: round-trip time describes the users' connections, never a defect of the site. */
export const cruxRtt: RuleImplementation = {
  id: 'perf-crux-rtt-context',
  evaluate({ page, evidence }) {
    const cited = formFactors.flatMap(form => {
      const field = fieldRecord(page, form);
      const value = p75(field, 'round_trip_time');
      return field && value !== undefined ? [fieldEvidence(evidence, field, 'round_trip_time', `p75=${Math.round(value)} ms`)] : [];
    });
    return cited.length > 0 ? { outcome: 'pass', evidence: cited } : notEvaluated(missingFieldReason(page, 'no-rtt-data'));
  },
};

const softnavPairs: ReadonlyArray<readonly [MetricSpec, string]> = [
  [lcpMetric, 'experimental_largest_contentful_paint_with_softnavs'],
  [inpMetric, 'experimental_interaction_to_next_paint_with_softnavs'],
  [clsMetric, 'experimental_cumulative_layout_shift_with_softnavs'],
];

export const cruxSoftnav: RuleImplementation = {
  id: 'perf-crux-softnav-experimental',
  evaluate({ page, evidence }) {
    const results: RuleResult[] = [];
    for (const form of formFactors) {
      const field = fieldRecord(page, form);
      if (!field) continue;
      const compared = softnavPairs.flatMap(([spec, experimental]) => {
        const stable = p75(field, spec.name);
        const withSoftnavs = p75(field, experimental);
        return stable === undefined || withSoftnavs === undefined ? [] : [{ spec, experimental, stable, withSoftnavs }];
      });
      if (compared.length === 0) continue;
      const cited = compared.flatMap(entry => [
        fieldEvidence(evidence, field, entry.spec.name, `p75=${formatMetric(entry.spec, entry.stable)}`),
        fieldEvidence(evidence, field, entry.experimental, `p75=${formatMetric(entry.spec, entry.withSoftnavs)}`),
      ]);
      const differing = compared.filter(entry => band(entry.stable, entry.spec.good, entry.spec.poor) !== band(entry.withSoftnavs, entry.spec.good, entry.spec.poor));
      if (differing.length === 0) {
        results.push({ outcome: 'pass', evidence: cited });
        continue;
      }
      results.push({
        outcome: 'fail',
        severity: 'info',
        evidence: cited,
        params: {
          formFactor: form,
          scope: scopeLabel(field),
          metrics: differing.map(entry => `${entry.spec.label} ${formatMetric(entry.spec, entry.stable)} vs ${formatMetric(entry.spec, entry.withSoftnavs)} with soft navigations`).join(', '),
        },
      });
    }
    if (results.length > 0) return results;
    return formFactors.some(form => fieldRecord(page, form)) ? [notApplicable('no-softnav-data')] : [notEvaluated(missingFieldReason(page))];
  },
};

export const fieldImplementations: readonly RuleImplementation[] = [
  cruxLcp, cruxInp, cruxCls, cruxAssessment, cruxAvailability, cruxFcp, cruxTtfb, cruxSubparts, cruxNavigationTypes, cruxRtt, cruxSoftnav,
];
