import { createHash } from 'node:crypto';
import type { EvidenceItem } from '../core/evidence.ts';
import type { Category, FixLocation, InputId, RuleMeta, RuleSource, Severity, Verification } from '../core/types.ts';
import { findingMessage } from '../i18n/messages.ts';
import type { Finding, FindingScope } from '../rules/engine.ts';
import { severityWeights } from '../score/score.ts';

export interface TaskCheck {
  readonly ruleId: string;
  readonly scope: FindingScope;
}

/** Every task id, which also names the task's file in tasks/. */
export const taskIdPattern = /^T-[0-9a-f]{10}$/u;

export interface Task {
  /** Stable across runs while the same rule fails for the same reason with evidence of the same shape: `T-<hash>`. */
  readonly id: string;
  readonly ruleId: string;
  readonly category: Category;
  readonly title: string;
  readonly severity: Severity;
  /** 1 is the first task to do. */
  readonly priority: number;
  /** Audited URLs the task covers, or the site origin for site-wide checks. */
  readonly scopes: readonly FindingScope[];
  /** What is wrong, in English, with the observed values. */
  readonly problem: string;
  /** The failure variant and message values, so the problem can be rendered in other languages. */
  readonly reason?: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** What the fixed state looks like, from the catalog. */
  readonly desired: string;
  readonly evidence: readonly string[];
  readonly fixLocation: FixLocation;
  readonly verifiableBy: Verification;
  /** True when a coding agent can make the fix in the site's code or content; never for accounts or owner decisions. */
  readonly agentReady: boolean;
  /** Checks that must pass once the task is done. */
  readonly acceptance: readonly TaskCheck[];
  /**
   * Checks that pass today on the same scope and must keep passing, so the fix does not trade one problem for another;
   * only those `altimeter verify` can run again.
   */
  readonly mustRemainPassing: readonly TaskCheck[];
  readonly sources: readonly RuleSource[];
  /** Files of the site's repository, given with --source, that most likely hold the fix; repository-relative paths. */
  readonly files?: readonly FileCandidate[];
  /** Data files that only contain the observed text: the fix belongs in the code that uses them, not in them. */
  readonly mustNotChange?: readonly string[];
}

export interface FileCandidate {
  readonly path: string;
  readonly confidence: 'high' | 'medium' | 'low';
  /** Why the file was picked, such as the markup it emits or the text it contains. */
  readonly reason: string;
}

const serverInputs: readonly InputId[] = ['http', 'redirects', 'variants', 'tls', 'robots', 'ua-probe', 'not-found-probe', 'sitemaps'];

/** How a fix can be confirmed when the catalog does not say. */
export function defaultVerification(rule: RuleMeta): Verification {
  if (rule.verifiableBy) return rule.verifiableBy;
  if (rule.inputs.includes('crux')) return 'field-28d';
  if (rule.inputs.some(input => input === 'gsc' || input === 'bing' || input === 'bot-activity')) return 'owner-data';
  if (rule.inputs.some(input => serverInputs.includes(input))) return 'deployed';
  return 'local';
}

/** Inputs `altimeter verify` never collects: it crawls nothing and runs no Lighthouse, field data, owner data or model analysis. */
const inputsVerifyLacks: readonly InputId[] = ['crawl', 'lighthouse', 'crux', 'gsc', 'bing', 'bot-activity', 'ai'];

/** Whether `altimeter verify` can run a check again: it confirms local and deployed checks whose inputs it collects. */
function recheckable(rule: RuleMeta): boolean {
  const verification = defaultVerification(rule);
  return (verification === 'local' || verification === 'deployed') && !rule.inputs.some(input => inputsVerifyLacks.includes(input));
}

/** Where task building reads evidence: the audit's store, or the evidence list of a saved report. */
export interface EvidenceLookup {
  get(id: string): EvidenceItem | undefined;
}

/** The random segment of the not-found probe's path, which is new on every run. */
const probeSegment = /altimeter-probe-[0-9a-f]+/gu;
/** An HTTP date such as a Date header, whose day and month names change too. */
const httpDate = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/gu;
const withoutProbe = (value: string) => value.replace(probeSegment, 'altimeter-probe');
/** Numbers and dates change from run to run while the problem stays the same. */
const shape = (value: string) => withoutProbe(value).replace(httpDate, '#').replace(/\d+/gu, '#');

/**
 * A defect repeated on several pages is usually one template fix, so page findings group by the shape of their
 * evidence while the observed values differ from page to page. Site findings keep what tells them apart: where each
 * item was observed and what was seen there, except the figures and lists of owner data, which move with the
 * reporting window. Numbers, dates and the not-found probe's random path never count, so an unchanged problem keeps
 * its id from run to run.
 */
function groupKey(finding: Finding, evidence: EvidenceLookup): string {
  const page = finding.scope.kind === 'page';
  const items = finding.evidence.map(id => evidence.get(id)).filter((item): item is EvidenceItem => item !== undefined);
  const fact = (item: EvidenceItem) => page
    ? [item.kind, shape(item.label), shape(item.path ?? '')]
    : [item.kind, withoutProbe(item.url ?? ''), shape(item.label), shape(item.path ?? ''), item.kind === 'owner-data' ? '' : shape(item.excerpt ?? '')];
  const facts = [...new Set(items.map(item => JSON.stringify(fact(item))))].sort();
  return JSON.stringify([finding.ruleId, finding.reason ?? '', page ? '' : (finding.scope as { readonly origin: string }).origin, facts]);
}

function scopeKey(scope: FindingScope): string {
  return scope.kind === 'page' ? scope.url : scope.origin;
}

/**
 * Turns failed checks into tasks for people and coding agents. Findings with the same rule, reason and evidence
 * on several pages become one task, which usually means one template fix. Candidates become tasks only once the
 * model analysis confirmed them and its verifier supported that.
 */
export function buildTasks(findings: readonly Finding[], rulesById: ReadonlyMap<string, RuleMeta>, evidence: EvidenceLookup): Task[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.outcome !== 'fail' || (finding.needsJudgment && finding.judgment !== 'confirmed') || !rulesById.has(finding.ruleId)) continue;
    const key = groupKey(finding, evidence);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  const passing = findings.filter(finding => finding.outcome === 'pass');
  const tasks: Omit<Task, 'priority'>[] = [];
  for (const [key, members] of groups) {
    const first = members[0]!;
    const rule = rulesById.get(first.ruleId)!;
    const scopes = [...new Map(members.map(member => [scopeKey(member.scope), member.scope])).values()];
    const scopeKeys = new Set(scopes.map(scopeKey));
    const severity = members.map(member => member.severity ?? rule.maxSeverity).sort((a, b) => severityWeights[b] - severityWeights[a])[0]!;
    const fixLocation = rule.fixLocation ?? 'repo';
    tasks.push({
      id: `T-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`,
      ruleId: rule.id,
      category: rule.category,
      title: rule.title,
      severity,
      scopes,
      problem: findingMessage('en', rule.id, 'fail', first.reason, first.params) ?? rule.title,
      ...(first.reason ? { reason: first.reason } : {}),
      ...(first.params ? { params: first.params } : {}),
      desired: rule.fix,
      evidence: [...new Set(members.flatMap(member => member.evidence))],
      fixLocation,
      verifiableBy: defaultVerification(rule),
      agentReady: fixLocation === 'repo' || fixLocation === 'platform-config' || fixLocation === 'content',
      acceptance: scopes.map(scope => ({ ruleId: rule.id, scope })),
      mustRemainPassing: passing
        .filter(pass => {
          const meta = rulesById.get(pass.ruleId);
          return meta?.category === rule.category && recheckable(meta) && scopeKeys.has(scopeKey(pass.scope));
        })
        .slice(0, 12)
        .map(pass => ({ ruleId: pass.ruleId, scope: pass.scope })),
      sources: rule.sources,
    });
  }
  tasks.sort((a, b) => severityWeights[b.severity] - severityWeights[a.severity] || b.scopes.length - a.scopes.length || a.ruleId.localeCompare(b.ruleId));
  return tasks.map((task, index) => ({ ...task, priority: index + 1 }));
}
