import type { ReportAnalysis } from '../ai/types.ts';
import { catalogHash, rules as catalogRules } from '../catalog/index.ts';
import type { CollectResult } from '../collect/index.ts';
import type { EvidenceItem, EvidenceStore } from '../core/evidence.ts';
import type { Category, InputId, RuleMeta } from '../core/types.ts';
import type { Language } from '../i18n/messages.ts';
import { findingMessage } from '../i18n/messages.ts';
import type { Finding } from '../rules/engine.ts';
import { computeScore, type Score } from '../score/score.ts';
import { version } from '../version.ts';
import { buildTasks, type Task } from './tasks.ts';

export const reportSchemaVersion = 1;

export interface ReportFinding extends Finding {
  /** `F-<evidenceSignature>`. */
  readonly id: string;
  readonly category: Category;
  readonly title: string;
  /** English message for failures; renderers produce other languages from the rule id and params. */
  readonly message?: string;
}

export interface ReportPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number | undefined;
  readonly pageType: string;
  readonly pageTypeReason: string;
  readonly rendered: boolean;
  readonly lighthouse: boolean;
}

export interface Report {
  readonly schemaVersion: typeof reportSchemaVersion;
  readonly tool: { readonly name: 'altimeter'; readonly version: string };
  readonly catalog: { readonly hash: string; readonly rules: number; readonly implemented: number };
  readonly run: {
    readonly startedAt: string;
    readonly durationMs: number;
    readonly language: Language;
    readonly versions: { readonly node: string; readonly chrome?: string; readonly lighthouse?: string };
    readonly options: Readonly<Record<string, string | number | boolean>>;
    readonly warnings: readonly string[];
  };
  readonly target: { readonly url: string; readonly finalUrl: string; readonly origin: string };
  readonly pages: readonly ReportPage[];
  readonly coverage: {
    readonly implemented: number;
    readonly evaluated: number;
    readonly notEvaluated: number;
    readonly notApplicable: number;
    /** How many checks could not run for lack of each input. */
    readonly missingInputs: Readonly<Partial<Record<InputId, number>>>;
  };
  readonly score: Score;
  readonly findings: readonly ReportFinding[];
  readonly evidence: readonly EvidenceItem[];
  readonly tasks: readonly Task[];
  /**
   * The Claude Code or Codex analysis, when one ran. Its own findings never change the score, the tasks or
   * --fail-on. Code candidates it decided carry `judgment`: a confirmed one becomes a task and still stays out of
   * the score and --fail-on.
   */
  readonly ai?: ReportAnalysis;
}

/**
 * Adds an analysis to a report, replacing any earlier one. A decision on a code candidate counts only when the
 * verifier supported it (or, for a dismissal, at least partly); the tasks are rebuilt when any decision counts.
 */
export function mergeAnalysis(report: Report, analysis: ReportAnalysis): Report {
  const decisions = new Map(analysis.confirmations.map(decision => [decision.candidateId, decision]));
  let changed = false;
  const findings = report.findings.map((finding): ReportFinding => {
    const decision = finding.needsJudgment ? decisions.get(finding.id) : undefined;
    const judgment: ReportFinding['judgment'] = decision?.decision === 'confirmed' && decision.verification === 'supported' ? 'confirmed'
      : decision?.decision === 'dismissed' && decision.verification !== 'unverified' ? 'dismissed' : undefined;
    const { judgment: _earlier, ...rest } = finding;
    if (judgment !== finding.judgment) changed = true;
    return judgment ? { ...rest, judgment } : rest;
  });
  if (!changed) return { ...report, ai: analysis };
  const tasks = buildTasks(findings, new Map(catalogRules.map(rule => [rule.id, rule])), new Map(report.evidence.map(item => [item.id, item])));
  return { ...report, findings, tasks, ai: analysis };
}

export interface BuildReportInput {
  readonly collected: CollectResult;
  readonly findings: readonly Finding[];
  readonly evidence: EvidenceStore;
  readonly implemented: number;
  readonly language: Language;
  readonly startedAt: Date;
  readonly targetUrl: string;
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly rules?: readonly RuleMeta[];
}

export function buildReport(input: BuildReportInput): Report {
  const rules = input.rules ?? catalogRules;
  const rulesById = new Map(rules.map(rule => [rule.id, rule]));
  const findings: ReportFinding[] = input.findings.map(finding => {
    const rule = rulesById.get(finding.ruleId)!;
    const message = finding.outcome === 'fail' ? findingMessage('en', finding.ruleId, 'fail', finding.reason, finding.params) : undefined;
    return { ...finding, id: `F-${finding.evidenceSignature}`, category: rule.category, title: rule.title, ...(message ? { message } : {}) };
  });
  const missingInputs: Partial<Record<InputId, number>> = {};
  for (const finding of input.findings) {
    if (finding.outcome !== 'not_evaluated' || !finding.reason?.startsWith('missing-input:')) continue;
    for (const entry of finding.reason.slice('missing-input:'.length).split(',') as InputId[]) missingInputs[entry] = (missingInputs[entry] ?? 0) + 1;
  }
  const site = input.collected.site;
  const target = site.pages.values().next().value;
  return {
    schemaVersion: reportSchemaVersion,
    tool: { name: 'altimeter', version },
    catalog: { hash: catalogHash, rules: rules.length, implemented: input.implemented },
    run: {
      startedAt: input.startedAt.toISOString(),
      durationMs: Math.round(input.collected.durationMs),
      language: input.language,
      versions: {
        node: process.versions.node,
        ...(input.collected.versions.chrome ? { chrome: input.collected.versions.chrome } : {}),
        ...(input.collected.versions.lighthouse ? { lighthouse: input.collected.versions.lighthouse } : {}),
      },
      options: input.options,
      warnings: input.collected.warnings,
    },
    target: { url: input.targetUrl, finalUrl: target?.fetch.finalUrl ?? input.targetUrl, origin: site.origin },
    pages: [...site.pages.values()].map(page => ({
      url: page.url,
      finalUrl: page.fetch.finalUrl,
      status: page.fetch.status,
      pageType: page.pageType,
      pageTypeReason: page.pageTypeReason,
      rendered: page.rendered !== undefined,
      lighthouse: page.lighthouse?.ok === true,
    })),
    coverage: {
      implemented: input.implemented,
      evaluated: input.findings.filter(finding => finding.outcome === 'pass' || finding.outcome === 'fail').length,
      notEvaluated: input.findings.filter(finding => finding.outcome === 'not_evaluated').length,
      notApplicable: input.findings.filter(finding => finding.outcome === 'not_applicable').length,
      missingInputs,
    },
    score: computeScore(input.findings, rulesById),
    findings,
    evidence: input.evidence.all(),
    tasks: buildTasks(input.findings, rulesById, input.evidence),
  };
}
