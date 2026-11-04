import { createHash } from 'node:crypto';
import type { EvidenceStore } from '../core/evidence.ts';
import type { PageFacts, SiteFacts } from '../core/facts.ts';
import { severities, type InputId, type Outcome, type RuleMeta, type Severity } from '../core/types.ts';

export type RuleResult =
  | { readonly outcome: 'pass'; readonly evidence?: readonly string[] }
  | {
    readonly outcome: 'fail';
    readonly severity: Severity;
    readonly evidence: readonly string[];
    /** Values for the report's message template, such as a count or the observed value. */
    readonly params?: Readonly<Record<string, string | number>>;
    /** A machine-readable variant of the failure when a rule detects several, e.g. `relative-url`. */
    readonly reason?: string;
  }
  | { readonly outcome: 'not_applicable'; readonly reason: string }
  | { readonly outcome: 'not_evaluated'; readonly reason: string };

export interface RuleContext {
  readonly rule: RuleMeta;
  readonly site: SiteFacts;
  /** Set for page-scope rules. */
  readonly page?: PageFacts;
  readonly evidence: EvidenceStore;
}

export interface RuleImplementation {
  readonly id: string;
  evaluate(context: RuleContext): RuleResult | readonly RuleResult[];
}

export type FindingScope = { readonly kind: 'page'; readonly url: string } | { readonly kind: 'site'; readonly origin: string };

export interface Finding {
  readonly ruleId: string;
  readonly scope: FindingScope;
  readonly outcome: Outcome;
  readonly severity?: Severity;
  readonly reason?: string;
  readonly evidence: readonly string[];
  /** Hash of what the finding is about, stable across runs; it keys tasks and comparisons. */
  readonly evidenceSignature: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly origin: 'deterministic' | 'ai' | 'owner-data';
}

/** Whether a collected input exists for this page or site. */
export function inputAvailable(input: InputId, site: SiteFacts, page: PageFacts | undefined): boolean {
  switch (input) {
    case 'http':
    case 'redirects':
      return page ? page.fetch.status !== undefined : site.pages.size > 0;
    case 'raw-html':
      return page?.raw !== undefined;
    case 'rendered-dom':
      return page?.rendered !== undefined && page.rendered.result.error === undefined;
    case 'user-render':
      return page?.userRender !== undefined && page.userRender.result.error === undefined;
    case 'unblocked-render':
      return page?.unblockedRender !== undefined && page.unblockedRender.result.error === undefined;
    case 'resources':
      return page?.lighthouse?.ok === true;
    case 'robots':
      return site.robots !== undefined;
    case 'sitemaps':
      return site.sitemaps.length > 0;
    case 'variants':
      return site.variants.length > 0;
    case 'not-found-probe':
      return site.notFound !== undefined;
    case 'siblings':
      return site.siblings.length >= 2;
    case 'crawl':
      return site.crawled;
    case 'lighthouse':
      return page?.lighthouse?.ok === true;
    case 'crux':
      return page?.crux !== undefined && Object.values(page.crux).some(byForm => Object.values(byForm).some(result => result?.status !== 'no-key'));
    case 'tls':
      return site.tls !== undefined;
    case 'ua-probe':
      return page ? (page.uaProbes?.length ?? 0) > 0 : site.agentProbes.length > 0;
    case 'gsc':
    case 'bing':
    case 'bot-activity':
    case 'ai':
      // Collected by later stages; until they report facts, rules that need them are not evaluated.
      return false;
  }
}

function clampSeverity(requested: Severity, max: Severity): Severity {
  return severities.indexOf(requested) < severities.indexOf(max) ? max : requested;
}

export function evidenceSignature(ruleId: string, scope: FindingScope, evidence: EvidenceStore, ids: readonly string[], reason?: string): string {
  const facts = ids.map(id => evidence.get(id)).filter(Boolean).map(item => [item!.kind, item!.url, item!.label, item!.excerpt, item!.path]);
  facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify([ruleId, scope, reason ?? '', facts])).digest('hex').slice(0, 16);
}

function toFinding(rule: RuleMeta, scope: FindingScope, result: RuleResult, evidence: EvidenceStore): Finding {
  const ids = result.outcome === 'fail' || result.outcome === 'pass' ? [...(result.evidence ?? [])] : [];
  for (const id of ids) if (!evidence.has(id)) throw new Error(`${rule.id} cited unknown evidence ${id}`);
  const reason = result.outcome === 'pass' ? undefined : result.reason;
  return {
    ruleId: rule.id,
    scope,
    outcome: result.outcome,
    ...(result.outcome === 'fail' ? { severity: clampSeverity(result.severity, rule.maxSeverity) } : {}),
    ...(reason === undefined ? {} : { reason }),
    evidence: ids,
    evidenceSignature: evidenceSignature(rule.id, scope, evidence, ids, reason),
    ...(result.outcome === 'fail' && result.params ? { params: result.params } : {}),
    confidence: rule.method === 'deterministic' ? 'high' : 'medium',
    origin: 'deterministic',
  };
}

export interface EngineInput {
  readonly rules: readonly RuleMeta[];
  readonly implementations: ReadonlyMap<string, RuleImplementation>;
  readonly site: SiteFacts;
  readonly evidence: EvidenceStore;
}

/**
 * Runs every implemented rule over the site and each audited page. A rule whose inputs were not collected
 * is reported as not evaluated, and a rule outside its page types as not applicable, so coverage stays honest.
 */
export function runRules(input: EngineInput): Finding[] {
  const findings: Finding[] = [];
  const run = (rule: RuleMeta, implementation: RuleImplementation, scope: FindingScope, page: PageFacts | undefined) => {
    const missing = rule.inputs.filter(entry => !inputAvailable(entry, input.site, page));
    if (missing.length > 0) {
      findings.push(toFinding(rule, scope, { outcome: 'not_evaluated', reason: `missing-input:${missing.join(',')}` }, input.evidence));
      return;
    }
    if (page && rule.appliesTo !== 'all' && !rule.appliesTo.includes(page.pageType)) {
      findings.push(toFinding(rule, scope, { outcome: 'not_applicable', reason: `page-type:${page.pageType}` }, input.evidence));
      return;
    }
    let results: readonly RuleResult[];
    try {
      const value = implementation.evaluate({ rule, site: input.site, evidence: input.evidence, ...(page ? { page } : {}) });
      results = Array.isArray(value) ? value : [value as RuleResult];
    } catch (error) {
      results = [{ outcome: 'not_evaluated', reason: `rule-error:${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}` }];
    }
    for (const result of results) findings.push(toFinding(rule, scope, result, input.evidence));
  };
  for (const rule of input.rules) {
    const implementation = input.implementations.get(rule.id);
    if (!implementation || rule.status !== 'v1') continue;
    if (rule.scope === 'site') run(rule, implementation, { kind: 'site', origin: input.site.origin }, undefined);
    else for (const page of input.site.pages.values()) run(rule, implementation, { kind: 'page', url: page.url }, page);
  }
  return findings;
}
