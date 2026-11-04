import { notAuditableReason } from './analyze/auditability.ts';
import { rules as catalogRules } from './catalog/index.ts';
import { collect, type CollectOptions, type CollectResult } from './collect/index.ts';
import { EvidenceStore } from './core/evidence.ts';
import type { PageFacts } from './core/facts.ts';
import type { Language } from './i18n/messages.ts';
import { runRules, type RuleImplementation } from './rules/engine.ts';
import { implementations as registered } from './rules/registry.ts';
import { buildReport, type Report } from './report/model.ts';

export interface AuditOptions extends CollectOptions {
  readonly language?: Language;
  /** Rule implementations to run; defaults to every registered implementation. */
  readonly implementations?: ReadonlyMap<string, RuleImplementation>;
  /** Options recorded in the report, already free of secrets. */
  readonly recordedOptions?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditResult {
  readonly report: Report;
  readonly collected: CollectResult;
}

function markAuditability(collected: CollectResult): CollectResult {
  const pages = new Map<string, PageFacts>();
  for (const [key, page] of collected.site.pages) {
    const reason = notAuditableReason(page.fetch, page.raw?.html);
    pages.set(key, reason ? { ...page, notAuditable: reason } : page);
  }
  return { ...collected, site: { ...collected.site, pages } };
}

/**
 * Runs a deterministic audit of one URL: collects the facts, evaluates every implemented rule and builds the report.
 * This programmatic API is experimental until 1.0.
 */
export async function audit(options: AuditOptions): Promise<AuditResult> {
  const startedAt = new Date();
  const collected = markAuditability(await collect(options));
  const evidence = new EvidenceStore();
  const implementations = options.implementations ?? registered;
  const findings = runRules({ rules: catalogRules, implementations, site: collected.site, evidence });
  const report = buildReport({
    collected,
    findings,
    evidence,
    implemented: [...implementations.keys()].filter(id => catalogRules.some(rule => rule.id === id && rule.status === 'v1')).length,
    language: options.language ?? 'en',
    startedAt,
    targetUrl: options.url,
    options: options.recordedOptions ?? {},
  });
  return { report, collected };
}

/** Exit status for the command line: 3 when the audited page could not be audited. */
export function auditExitCode(result: AuditResult, failOn: 'critical' | 'high' | 'medium' | 'low' | 'none'): 0 | 1 | 3 {
  const target = result.collected.site.pages.values().next().value as PageFacts | undefined;
  if (!target || target.notAuditable) return 3;
  if (failOn === 'none') return 0;
  const order = ['critical', 'high', 'medium', 'low'];
  const limit = order.indexOf(failOn);
  const failing = result.report.findings.some(finding => finding.outcome === 'fail' && !finding.needsJudgment && finding.origin !== 'ai'
    && order.indexOf(finding.severity ?? 'info') !== -1 && order.indexOf(finding.severity ?? 'info') <= limit);
  return failing ? 1 : 0;
}
