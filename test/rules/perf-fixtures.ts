/**
 * Builders for perf rule fixtures: Lighthouse summaries, CrUX records and a one-call evaluation of a page rule.
 */
import assert from 'node:assert/strict';
import type { EvidenceStore } from '../../src/core/evidence.ts';
import type { PageFacts } from '../../src/core/facts.ts';
import type { Severity } from '../../src/core/types.ts';
import type { CruxFormFactor, CruxOutcome } from '../../src/data/crux.ts';
import type { LighthouseAudit, LighthouseOutcome } from '../../src/render/lighthouse.ts';
import { findingMessage } from '../../src/i18n/messages.ts';
import type { Finding, RuleImplementation } from '../../src/rules/engine.ts';
import { evaluate, site, type SiteSpec } from '../support/facts.ts';

export type AuditSpec = Partial<LighthouseAudit>;

export interface LabSpec {
  readonly formFactor?: 'mobile' | 'desktop';
  readonly runs?: number;
  readonly validRuns?: number;
  readonly runWarnings?: readonly string[];
  readonly performance?: number | null;
  readonly lcpRangeMs?: readonly [number, number];
}

export function lab(audits: Readonly<Record<string, AuditSpec>>, spec: LabSpec = {}): LighthouseOutcome {
  const formFactor = spec.formFactor ?? 'mobile';
  return {
    ok: true,
    summary: {
      lighthouseVersion: '13.6.0',
      fetchTime: '2026-11-01T10:00:00.000Z',
      finalUrl: 'https://example.com/',
      runs: spec.runs ?? 5,
      validRuns: spec.validRuns ?? 5,
      runWarnings: spec.runWarnings ?? [],
      categories: { performance: spec.performance === undefined ? 0.95 : spec.performance },
      audits: Object.fromEntries(Object.entries(audits).map(([id, audit]) => [id, { title: id, score: null, scoreDisplayMode: 'numeric', ...audit }])),
      settings: {
        formFactor,
        throttlingMethod: 'simulate',
        throttling: {},
        screenEmulation: formFactor === 'mobile' ? { mobile: true, width: 412, height: 823 } : { mobile: false, width: 1350, height: 940 },
      },
      benchmarkIndex: 1500,
      lcpRangeMs: spec.lcpRangeMs ?? [2000, 2200],
    },
  };
}

export const failedLab: LighthouseOutcome = { ok: false, error: 'Lighthouse returned no result' };

export function table(items: readonly Readonly<Record<string, unknown>>[], extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { type: 'table', headings: [], items, ...extra };
}

export function opportunity(items: readonly Readonly<Record<string, unknown>>[], overallSavingsBytes: number): Record<string, unknown> {
  return { type: 'opportunity', headings: [], items, overallSavingsBytes, overallSavingsMs: 0 };
}

export function list(...items: readonly unknown[]): Record<string, unknown> {
  return { type: 'list', items };
}

export function node(snippet: string, selector: string, top = 100): Record<string, unknown> {
  return { type: 'node', snippet, selector, nodeLabel: selector, boundingRect: { top, left: 0, width: 300, height: 200, right: 300, bottom: top + 200 } };
}

export function checklist(entries: Readonly<Record<string, boolean>>, lcpNode?: Record<string, unknown>): Record<string, unknown> {
  const items = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { label: `${key} ${value ? 'passes' : 'fails'}`, value }]));
  return list({ type: 'checklist', items }, ...(lcpNode ? [lcpNode] : []));
}

export function breakdown(subparts: { ttfb: number; loadDelay?: number; loadDuration?: number; renderDelay: number }, lcpNode?: Record<string, unknown>): Record<string, unknown> {
  const items = [
    { subpart: 'timeToFirstByte', label: 'Time to first byte', duration: subparts.ttfb },
    ...(subparts.loadDelay === undefined ? [] : [{ subpart: 'resourceLoadDelay', label: 'Resource load delay', duration: subparts.loadDelay }]),
    ...(subparts.loadDuration === undefined ? [] : [{ subpart: 'resourceLoadDuration', label: 'Resource load duration', duration: subparts.loadDuration }]),
    { subpart: 'elementRenderDelay', label: 'Element render delay', duration: subparts.renderDelay },
  ];
  return list(table(items), ...(lcpNode ? [lcpNode] : []));
}

export function requests(entries: readonly Readonly<Record<string, unknown>>[]): AuditSpec {
  return { scoreDisplayMode: 'informative', details: table(entries.map(entry => ({ statusCode: 200, transferSize: 1000, resourceSize: 3000, networkRequestTime: 100, ...entry }))) };
}

type Metrics = Readonly<Record<string, number>>;

export interface CruxEntry {
  readonly metrics?: Metrics;
  readonly navigationTypes?: Readonly<Record<string, number>>;
}

function outcome(scope: 'url' | 'origin', form: CruxFormFactor, entry: CruxEntry | 'no-data' | 'error'): CruxOutcome {
  if (entry === 'no-data') return { status: 'no-data' };
  if (entry === 'error') return { status: 'error', message: 'CrUX answered 500' };
  return {
    status: 'ok',
    record: {
      scope,
      key: scope === 'url' ? 'https://example.com/' : 'https://example.com',
      formFactor: form,
      metrics: Object.fromEntries(Object.entries(entry.metrics ?? {}).map(([name, p75]) => [name, { p75, histogram: [] }])),
      ...(entry.navigationTypes ? { navigationTypes: entry.navigationTypes } : {}),
      collectionPeriod: { first: '2026-10-01', last: '2026-10-28' },
    },
  };
}

type ByForm = Partial<Record<CruxFormFactor, CruxEntry | 'no-data' | 'error'>>;

/** CrUX outcomes; a form factor left out answers no-data. */
export function crux(spec: { readonly url?: ByForm; readonly origin?: ByForm }): NonNullable<PageFacts['crux']> {
  const build = (scope: 'url' | 'origin', byForm: ByForm = {}) => Object.fromEntries((['PHONE', 'DESKTOP'] as const).map(form => [form, outcome(scope, form, byForm[form] ?? 'no-data')]));
  return { url: build('url', spec.url), origin: build('origin', spec.origin) };
}

export const goodVitals: Metrics = { largest_contentful_paint: 1800, interaction_to_next_paint: 120, cumulative_layout_shift: 0.04 };

export interface Checked {
  readonly findings: readonly Finding[];
  readonly finding: Finding;
  readonly evidence: EvidenceStore;
  excerpts(finding?: Finding): string[];
}

/** Evaluates one rule on one page, inside a site built from `extra`. */
export function check(implementation: RuleImplementation, target: PageFacts, extra: Partial<SiteSpec> = {}): Checked {
  const { findings, evidence } = evaluate(implementation, site({ pages: [target], ...extra }));
  const mine = findings.filter(entry => entry.scope.kind === 'page' && entry.scope.url === target.url);
  for (const entry of mine) assertMessage(entry);
  return {
    findings: mine,
    finding: mine[0]!,
    evidence,
    excerpts: (finding = mine[0]!) => finding.evidence.map(id => evidence.get(id)?.excerpt ?? ''),
  };
}

/** Every failure has an English message whose placeholders are all filled by the params the rule emitted. */
export function assertMessage(finding: Finding): void {
  if (finding.outcome !== 'fail') return;
  const message = findingMessage('en', finding.ruleId, 'fail', finding.reason, finding.params);
  assert.ok(message, `${finding.ruleId} has no message for ${finding.reason ?? 'fail'}`);
  assert.doesNotMatch(message, /\{[a-zA-Z][a-zA-Z0-9]*\}/u, `${finding.ruleId}: unfilled placeholder in "${message}"`);
}

export function assertFail(checked: Checked, severity: Severity, reason?: string, finding = checked.finding): void {
  assert.equal(finding.outcome, 'fail', `expected a failure, got ${finding.outcome} ${finding.reason ?? ''}`);
  assert.equal(finding.severity, severity);
  assert.equal(finding.reason, reason);
}

export function assertExcerpt(checked: Checked, pattern: RegExp, finding = checked.finding): void {
  assert.ok(checked.excerpts(finding).some(excerpt => pattern.test(excerpt)), `no evidence excerpt matches ${pattern}: ${JSON.stringify(checked.excerpts(finding))}`);
}

export function assertOutcome(checked: Checked, outcome: Finding['outcome'], reason?: string, finding = checked.finding): void {
  assert.equal(finding.outcome, outcome, `expected ${outcome}, got ${finding.outcome} ${finding.reason ?? ''}`);
  if (reason !== undefined) assert.equal(finding.reason, reason);
}

export const html = (head: string, body = '<main><h1>Title</h1><p>Some content for the page.</p></main>') => `<!doctype html><html lang="en"><head><title>Page</title>${head}</head><body>${body}</body></html>`;
