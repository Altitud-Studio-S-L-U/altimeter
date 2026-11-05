import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { myths as catalogMyths } from '../catalog/index.ts';
import type { CollectResult } from '../collect/index.ts';
import type { EvidenceItem } from '../core/evidence.ts';
import { filledMessage } from '../i18n/messages.ts';
import type { Report } from '../report/model.ts';
import { analysisCacheDirectory, cacheKey, readCache, writeCache } from './cache.ts';
import * as claude from './claude.ts';
import * as codex from './codex.ts';
import { buildPack, catalogSlice, estimateTokens, maxPackBytes, mythsSlice, newNonce, trustedPrompt, type EvidencePack } from './pack.ts';
import { factLines, judgmentCap, mythsFor, packSections, passDefinition, passDefinitions, passInstructions, passSchema, planPasses, type PassPlan } from './passes.ts';
import { resolveProvider, type Environment, type ResolvedProvider } from './providers.ts';
import { assertStrictSchema, type Schema } from './schema.ts';
import { buildCorpus, collectSiteStrings, injectionCandidates, selectPages, sliceEvidence, toEvidence, type SiteStrings } from './site.ts';
import { systemPrompt } from './system-prompt.ts';
import { cleanDisplay } from './text.ts';
import {
  ProviderError, type AiFinding, type CallRecord, type CallResult, type CandidateDecision, type DroppedClaim, type PageAssessment, type PassId, type Proposal,
  type ProviderName, type ProviderSummary, type ReportAnalysis, type Role, type SkippedPass,
} from './types.ts';
import { defaultMythMatcher, distinctProposals, validateAnswer, type DraftFinding, type MythMatcher } from './validate.ts';
import { allUnverified, applyVerification, buildVerificationRequest, type VerifiedFinding } from './verify.ts';

export interface AnalysisOptions {
  readonly report: Report;
  readonly collected: CollectResult;
  /** auto tries Claude Code, then Codex. Default auto. */
  readonly provider?: 'auto' | 'claude' | 'codex' | 'none';
  /** Who checks each finding against its evidence: the same CLI (default), the other one, or nobody. */
  readonly verifier?: 'same' | 'other' | 'none';
  readonly model?: string;
  /** Model for a verifier from the other provider; the analyst's model applies when the verifier is the same CLI. */
  readonly verifierModel?: string;
  /** How many pages to analyse: the audited page, the home page, then the most linked pages. Default 3. */
  readonly aiPages?: number;
  /** Provider calls allowed for analysis and verification together. Default 16. */
  readonly maxCalls?: number;
  readonly concurrency?: number;
  readonly callTimeoutMs?: number;
  /** Deadline for the whole analysis. Default 15 minutes. */
  readonly deadlineMs?: number;
  /** Forward API key variables to the CLIs; off by default so a key exported for another tool is never spent. */
  readonly useApiKeys?: boolean;
  /** Writes every prompt and the call plan here and calls nothing. */
  readonly dryRunDir?: string;
  /** The owner's target keywords; intent is judged only against one. */
  readonly keyword?: readonly string[];
  /** Replaces the catalog's myth filter (mythMatches from src/rules/myth-filter.ts), for tests. */
  readonly mythMatches?: MythMatcher;
  /** Reuse answers from the cache folder (default true). */
  readonly cache?: boolean;
  readonly cacheDir?: string;
  readonly env?: Environment;
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
  /** Working directory for Claude Code; defaults to the stable folder in the user cache. Tests only. */
  readonly claudeWorkingDirectory?: string;
}

export type AnalysisResult = ReportAnalysis;

const defaults = { aiPages: 3, maxCalls: 16, concurrency: 2, callTimeoutMs: 180_000, deadlineMs: 900_000 };
const minimumCallMs = 5000;

const rubrics = new Map<string, string | undefined>();

/** Rubrics are Markdown files next to this module in the sources, or in the sources of a checkout when run from dist. */
export function loadRubric(category: string): string | undefined {
  if (rubrics.has(category)) return rubrics.get(category);
  let text: string | undefined;
  for (const url of [new URL(`./rubrics/${category}.md`, import.meta.url), new URL(`../../src/ai/rubrics/${category}.md`, import.meta.url)]) {
    try {
      text = readFileSync(url, 'utf8');
      break;
    } catch {
      // Try the next location.
    }
  }
  rubrics.set(category, text);
  return text;
}

interface Prepared {
  readonly plan: PassPlan;
  readonly pack: EvidencePack;
  readonly schema: Schema;
  readonly catalog: string;
  readonly myths: string;
  readonly rubric: string;
}

function prepare(plan: PassPlan, report: Report, strings: SiteStrings, keyword: readonly string[], nonce: string): Prepared | string {
  const definition = passDefinition(plan.pass);
  const rubric = loadRubric(definition.category);
  if (rubric === undefined) return `The ${definition.category} rubric is missing, so the ${plan.pass} pass did not run.`;
  const myths = mythsFor(plan.pass, catalogMyths);
  const cap = (rule: Parameters<typeof judgmentCap>[0]) => judgmentCap(rule, keyword);
  const candidates = new Set(plan.candidates.map(finding => finding.ruleId));
  const trusted = trustedPrompt({
    heading: `${definition.heading}: analyst request for ${plan.page.label}`,
    instructions: passInstructions(plan, keyword),
    rubric,
    rules: plan.rules,
    candidates,
    myths,
    facts: factLines(plan),
    pages: [plan.page, ...plan.contextPages],
    keyword,
    severityCap: cap,
  });
  const schema = passSchema(plan);
  assertStrictSchema(schema);
  const pack = buildPack({ trusted, sections: packSections(plan, strings, report), nonce });
  // Only the untrusted sections can be cut; a trusted part that alone breaks the limit means no call at all.
  if (pack.bytes > maxPackBytes) return `The ${plan.pass} request for ${plan.page.label} would exceed ${maxPackBytes} bytes, so it was not sent.`;
  return {
    plan,
    pack,
    schema,
    catalog: catalogSlice(plan.rules, candidates, cap),
    myths: mythsSlice(myths),
    rubric,
  };
}

/** Keeps plans in priority order while every pass that runs keeps a verification call in the budget. */
function withinBudget(prepared: readonly Prepared[], maxCalls: number, verifying: boolean): { selected: Prepared[]; skipped: Prepared[] } {
  const selected: Prepared[] = [];
  const skipped: Prepared[] = [];
  const passes = new Set<PassId>();
  let used = 0;
  for (const entry of prepared) {
    const cost = 1 + (verifying && !passes.has(entry.plan.pass) ? 1 : 0);
    if (used + cost > maxCalls) {
      skipped.push(entry);
      continue;
    }
    used += cost;
    passes.add(entry.plan.pass);
    selected.push(entry);
  }
  return { selected, skipped };
}

function limiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async task => {
    if (active < concurrency) active += 1;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // The slot passes straight to the next waiter, so no new caller can slip in between.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function summaryOf(resolved: ResolvedProvider, model: string | undefined): ProviderSummary {
  return { name: resolved.command.name, cliVersion: resolved.version, verifiedVersion: resolved.capabilities.verified, ...(model ? { model } : {}), source: resolved.command.source };
}

function signature(draft: DraftFinding, strings: SiteStrings, report: Report): string {
  const deterministic = new Map(report.evidence.map(item => [item.id, item]));
  const facts = draft.evidenceIds.map(id => {
    const item = strings.items.get(id);
    if (item) return [item.kind, item.url, item.label, item.text, item.path ?? ''];
    const fact = deterministic.get(id);
    return fact ? [fact.kind, fact.url ?? '', fact.label, fact.excerpt ?? '', fact.path ?? ''] : [id];
  });
  facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(['ai', draft.rule.id, draft.scope, draft.reasonCode, draft.outcome, facts])).digest('hex').slice(0, 16);
}

function toFinding(finding: VerifiedFinding, strings: SiteStrings, report: Report): AiFinding {
  const evidenceSignature = signature(finding, strings, report);
  // The model gives no values for a template, so a finding reads its candidate's message or a template that needs none.
  const candidate = finding.candidate;
  const message = finding.outcome !== 'fail' ? undefined
    : candidate ? filledMessage('en', candidate.ruleId, 'fail', candidate.reason, candidate.params) : filledMessage('en', finding.rule.id, 'fail', finding.reasonCode);
  return {
    ruleId: finding.rule.id,
    scope: finding.scope,
    outcome: finding.outcome,
    ...(finding.severity ? { severity: finding.severity } : {}),
    reason: finding.reasonCode,
    evidence: finding.evidenceIds,
    evidenceSignature,
    confidence: finding.confidence,
    origin: 'ai',
    id: `F-${evidenceSignature}`,
    category: finding.rule.category,
    title: finding.rule.title,
    ...(message ? { message } : {}),
    pass: finding.pass,
    verdict: finding.verdict,
    quotes: finding.quotes,
    notes: finding.notes,
    verification: finding.verification,
    ...(finding.candidate ? { candidateId: finding.candidate.id } : {}),
    ...(finding.adjustments.length > 0 ? { adjustments: finding.adjustments } : {}),
  };
}

/**
 * What a report may say about a failure. Altimeter's own errors have path-free messages; any other error, such as
 * one from the file system, can name local paths, so only its code is kept.
 */
function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ProviderError) return cleanDisplay(error.message, 300);
  const code = (error as { code?: unknown } | undefined)?.code;
  return `${fallback}${typeof code === 'string' ? ` (${cleanDisplay(code, 40)})` : ''}.`;
}

interface CallPlan {
  readonly role: Role;
  readonly pass: PassId;
  readonly pages: readonly string[];
  readonly pack: EvidencePack;
  readonly schema: Schema;
  readonly catalog: string;
  readonly myths: string;
  readonly rubric: string;
}

interface Executor {
  run(plan: CallPlan, provider: ResolvedProvider, model: string | undefined): Promise<{ record: CallRecord; value?: unknown }>;
}

function executor(options: AnalysisOptions, keyword: readonly string[], deadline: { at: number; signal: AbortSignal }): Executor {
  const env = options.env ?? process.env;
  const cacheDirectory = options.cacheDir ?? analysisCacheDirectory(env);
  const useCache = options.cache !== false;
  const timeout = options.callTimeoutMs ?? defaults.callTimeoutMs;
  let next = 1;
  return {
    async run(plan, provider, model) {
      const id = `C${next++}`;
      const name = provider.command.name;
      const promptChars = systemPrompt.length + plan.pack.prompt.length + JSON.stringify(plan.schema).length;
      const base = { id, role: plan.role, pass: plan.pass, pages: plan.pages, provider: name, cliVersion: provider.version, ...(model ? { model } : {}), promptChars, estimatedTokens: estimateTokens(promptChars) };
      const key = cacheKey({ canonicalPrompt: plan.pack.canonical, provider: name, cliVersion: provider.version, ...(model ? { model } : {}), schema: plan.schema, catalogSlice: plan.catalog, myths: plan.myths, rubric: plan.rubric, keyword, role: plan.role });
      if (useCache) {
        const cached = await readCache(key, plan.schema, { directory: cacheDirectory });
        if (cached) return { record: { ...base, status: 'cached', durationMs: 0, ...(cached.usage ? { usage: cached.usage } : {}) }, value: cached.value };
      }
      const remaining = deadline.at - Date.now();
      if (remaining < minimumCallMs || deadline.signal.aborted) {
        return { record: { ...base, status: 'skipped', durationMs: 0, error: { code: 'deadline', message: 'The analysis deadline was reached before this call.' } } };
      }
      const started = performance.now();
      try {
        options.log?.(`Asking ${name === 'claude' ? 'Claude Code' : 'Codex'} (${plan.role}, ${plan.pass})`);
        const adapter = name === 'claude' ? claude.call : codex.call;
        const result: CallResult = await adapter({
          prompt: plan.pack.prompt,
          schema: plan.schema,
          ...(model ? { model } : {}),
          timeoutMs: Math.min(timeout, remaining),
          signal: deadline.signal,
          provider,
          env,
          useApiKeys: options.useApiKeys === true,
          ...(name === 'claude' && options.claudeWorkingDirectory ? { workingDirectory: options.claudeWorkingDirectory } : {}),
        });
        if (useCache) await writeCache(key, plan.schema, result, { directory: cacheDirectory }).catch(() => {});
        return {
          record: { ...base, status: 'ok', durationMs: Math.round(performance.now() - started), ...(result.model ? { model: result.model } : {}), ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }), ...(result.usage ? { usage: result.usage } : {}) },
          value: result.value,
        };
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'provider-failed';
        return { record: { ...base, status: 'failed', durationMs: Math.round(performance.now() - started), error: { code, message: failureMessage(error, 'The call failed unexpectedly') } } };
      }
    },
  };
}

async function writeDryRun(directory: string, prepared: readonly Prepared[], skipped: readonly Prepared[], planning: readonly SkippedPass[], options: AnalysisOptions, strings: SiteStrings): Promise<CallRecord[]> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'system-prompt.txt'), `${systemPrompt}\n`, 'utf8');
  const records: CallRecord[] = [];
  for (const [index, entry] of prepared.entries()) {
    const base = `${String(index + 1).padStart(2, '0')}-${entry.plan.pass}-${entry.plan.page.label.toLowerCase()}`;
    await writeFile(join(directory, `${base}.prompt.txt`), entry.pack.prompt, 'utf8');
    await writeFile(join(directory, `${base}.schema.json`), `${JSON.stringify(entry.schema, null, 2)}\n`, 'utf8');
    const promptChars = systemPrompt.length + entry.pack.prompt.length + JSON.stringify(entry.schema).length;
    records.push({ id: `C${index + 1}`, role: 'analyst', pass: entry.plan.pass, pages: [entry.plan.page.key], status: 'planned', durationMs: 0, promptChars, estimatedTokens: estimateTokens(promptChars) });
  }
  const passes = [...new Set(prepared.map(entry => entry.plan.pass))];
  const verifying = (options.verifier ?? 'same') !== 'none';
  const plan = {
    provider: options.provider ?? 'auto',
    verifier: options.verifier ?? 'same',
    model: options.model ?? 'default',
    pages: strings.pages.filter(page => page.role !== 'context').map(page => ({ page: page.label, url: page.url, role: page.role, type: page.pageType })),
    calls: records.map((record, index) => ({ ...record, promptFile: `${String(index + 1).padStart(2, '0')}-${record.pass}-${prepared[index]!.plan.page.label.toLowerCase()}.prompt.txt` })),
    verification: verifying ? passes.map(pass => ({ pass, calls: 1, note: 'One batched call after validation; its size depends on the findings that survive, so it is not estimated.' })) : [],
    overBudget: skipped.map(entry => ({ pass: entry.plan.pass, page: entry.plan.page.key })),
    notNeeded: planning,
    totals: { analystCalls: records.length, verificationCalls: verifying ? passes.length : 0, estimatedTokens: records.reduce((sum, record) => sum + record.estimatedTokens, 0) },
  };
  await writeFile(join(directory, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return records;
}

async function resolveProviders(options: AnalysisOptions, warnings: string[]): Promise<{ analyst?: ResolvedProvider; verifier?: ResolvedProvider }> {
  const env = options.env ?? process.env;
  const choice = options.provider ?? 'auto';
  const order: ProviderName[] = choice === 'auto' ? ['claude', 'codex'] : choice === 'none' ? [] : [choice];
  let analyst: ResolvedProvider | undefined;
  const problems: string[] = [];
  for (const name of order) {
    try {
      analyst = await resolveProvider(name, { env });
      break;
    } catch (error) {
      problems.push(failureMessage(error, `${name === 'claude' ? 'Claude Code' : 'Codex CLI'} is unavailable`));
    }
  }
  if (!analyst) {
    warnings.push(...problems.map(problem => cleanDisplay(problem, 300)), 'The analysis did not run because no provider CLI is available.');
    return {};
  }
  warnings.push(...analyst.warnings);
  const verifierChoice = options.verifier ?? 'same';
  if (verifierChoice === 'none') {
    warnings.push('Verification was turned off, so every analysis finding stays unverified.');
    return { analyst };
  }
  if (verifierChoice === 'same') return { analyst, verifier: analyst };
  const other: ProviderName = analyst.command.name === 'claude' ? 'codex' : 'claude';
  try {
    const verifier = await resolveProvider(other, { env });
    warnings.push(...verifier.warnings);
    return { analyst, verifier };
  } catch (error) {
    warnings.push(`${failureMessage(error, 'The other provider is unavailable')} Findings stay unverified.`);
    return { analyst };
  }
}

function emptyAnalysis(warnings: readonly string[], extra: Partial<ReportAnalysis> = {}): ReportAnalysis {
  return {
    schemaVersion: 1, provider: {}, pages: [], calls: [], costUsd: 0, findings: [], unverified: [], proposals: [], assessments: [], confirmations: [],
    dropped: [], skipped: [], injectionCandidates: [], evidence: [], warnings, ...extra,
  };
}

interface PassOutcome {
  readonly records: CallRecord[];
  readonly kept: VerifiedFinding[];
  readonly unverified: VerifiedFinding[];
  readonly proposals: Proposal[];
  readonly assessments: PageAssessment[];
  readonly dropped: DroppedClaim[];
}

/**
 * Runs the analysis of an audit: at most four passes per page, each answer validated deterministically, then
 * one batched verification call per pass. Nothing the models return reaches the report without passing both.
 */
export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisResult> {
  const warnings: string[] = [];
  if ((options.provider ?? 'auto') === 'none') return emptyAnalysis(warnings);
  const keyword = (options.keyword ?? []).map(entry => cleanDisplay(entry, 100)).filter(entry => entry !== '').slice(0, 5);
  const mythMatches = options.mythMatches ?? defaultMythMatcher;
  const { report } = options;
  const site = options.collected.site;
  const facts = selectPages(site, Math.max(1, Math.floor(options.aiPages ?? defaults.aiPages)));
  if (facts.length === 0) return emptyAnalysis(['No page could be analysed: none returned HTML with a 2xx status.']);
  const strings = collectSiteStrings(site, facts);
  const pages = strings.pages.filter(page => page.role !== 'context');
  const corpus = buildCorpus(site, strings);
  const injections = injectionCandidates(strings);
  const nonce = newNonce();
  const planned = planPasses({ report, site, strings, pages });
  const prepared: Prepared[] = [];
  for (const plan of planned.plans) {
    const entry = prepare(plan, report, strings, keyword, nonce);
    if (typeof entry === 'string') {
      if (!warnings.includes(entry)) warnings.push(entry);
    } else prepared.push(entry);
  }
  const verifying = (options.verifier ?? 'same') !== 'none';
  const budget = withinBudget(prepared, Math.max(0, Math.floor(options.maxCalls ?? defaults.maxCalls)), verifying);
  if (budget.skipped.length > 0) warnings.push(`${budget.skipped.length} analysis call${budget.skipped.length === 1 ? ' was' : 's were'} left out to stay within the call limit.`);
  const base = { pages: pages.map(page => page.key), skipped: planned.skipped, injectionCandidates: injections };
  if (options.dryRunDir) {
    const calls = await writeDryRun(options.dryRunDir, budget.selected, budget.skipped, planned.skipped, options, strings);
    return emptyAnalysis(warnings, { ...base, calls });
  }
  const providers = await resolveProviders(options, warnings);
  if (!providers.analyst) return emptyAnalysis(warnings, base);
  const deadlineMs = options.deadlineMs ?? defaults.deadlineMs;
  const signal = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(options.signal ? [options.signal] : [])]);
  const run = executor(options, keyword, { at: Date.now() + deadlineMs, signal });
  const limit = limiter(Math.max(1, Math.floor(options.concurrency ?? defaults.concurrency)));
  const analyst = providers.analyst;
  const verifier = providers.verifier;
  const verifierModel = verifier && verifier !== analyst ? options.verifierModel : options.model;

  const runPass = async (pass: PassId): Promise<PassOutcome> => {
    const entries = budget.selected.filter(entry => entry.plan.pass === pass);
    const outcome: PassOutcome = { records: [], kept: [], unverified: [], proposals: [], assessments: [], dropped: [] };
    if (entries.length === 0) return outcome;
    const answers = await Promise.all(entries.map(entry => limit(() => run.run({
      role: 'analyst', pass, pages: [entry.plan.page.key], pack: entry.pack, schema: entry.schema, catalog: entry.catalog, myths: entry.myths, rubric: entry.rubric,
    }, analyst, options.model))));
    const drafts: DraftFinding[] = [];
    const proposals: Proposal[] = [];
    answers.forEach((answer, index) => {
      outcome.records.push(answer.record);
      if (answer.value === undefined) return;
      const entry = entries[index]!;
      const validation = validateAnswer(answer.value, { plan: entry.plan, pack: entry.pack, schema: entry.schema, report, strings, corpus, keyword, mythMatches });
      drafts.push(...validation.findings);
      proposals.push(...validation.proposals);
      if (validation.assessment) outcome.assessments.push(validation.assessment);
      outcome.dropped.push(...validation.dropped);
    });
    const distinct = distinctProposals(proposals);
    outcome.proposals.push(...distinct.kept);
    outcome.dropped.push(...distinct.dropped);
    if (drafts.length === 0) return outcome;
    if (!verifier) {
      outcome.unverified.push(...allUnverified(drafts).unverified);
      return outcome;
    }
    const request = buildVerificationRequest(pass, drafts, strings, report, nonce);
    const answer = await limit(() => run.run({ role: 'verifier', pass, pages: [...new Set(drafts.map(draft => draft.page.key))], pack: request.pack, schema: request.schema, catalog: request.catalog, myths: '', rubric: '' }, verifier, verifierModel));
    outcome.records.push(answer.record);
    const verified = answer.value === undefined ? allUnverified(drafts) : applyVerification(answer.value, request);
    outcome.kept.push(...verified.kept);
    outcome.unverified.push(...verified.unverified);
    outcome.dropped.push(...verified.dropped);
    return outcome;
  };

  const outcomes = await Promise.all(passDefinitions.map(definition => runPass(definition.id)));
  const calls = outcomes.flatMap(entry => entry.records).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const record of calls) if (record.status === 'failed' || record.status === 'skipped') warnings.push(`${record.role} call ${record.id} (${record.pass}) ${record.status}: ${record.error?.message ?? 'no answer'}`);
  const findings = outcomes.flatMap(entry => entry.kept).map(finding => toFinding(finding, strings, report));
  const unverified = outcomes.flatMap(entry => entry.unverified).map(finding => toFinding(finding, strings, report));
  const proposals = outcomes.flatMap(entry => entry.proposals);
  const assessments = outcomes.flatMap(entry => entry.assessments);
  const confirmations: CandidateDecision[] = [...findings, ...unverified].filter(finding => finding.candidateId !== undefined).map(finding => ({
    candidateId: finding.candidateId!,
    ruleId: finding.ruleId,
    scope: finding.scope,
    decision: finding.outcome === 'fail' ? 'confirmed' : 'dismissed',
    findingId: finding.id,
    verification: finding.verification,
  }));
  return {
    schemaVersion: 1,
    provider: { analyst: summaryOf(analyst, options.model), ...(verifier ? { verifier: summaryOf(verifier, verifierModel) } : {}) },
    pages: base.pages,
    calls,
    costUsd: calls.reduce((sum, record) => sum + (record.status === 'ok' ? record.costUsd ?? 0 : 0), 0),
    findings,
    unverified,
    proposals,
    assessments,
    confirmations,
    dropped: outcomes.flatMap(entry => entry.dropped),
    skipped: planned.skipped,
    injectionCandidates: injections,
    evidence: citedEvidence(strings, findings, unverified, proposals, assessments, injections.map(entry => entry.evidenceId)),
    warnings,
  };
}

/** The A evidence the analysis cites, so the report can show every quoted item and slice. */
function citedEvidence(strings: SiteStrings, findings: readonly AiFinding[], unverified: readonly AiFinding[], proposals: readonly Proposal[], assessments: readonly PageAssessment[], extra: readonly string[]): EvidenceItem[] {
  const ids = new Set<string>(extra);
  for (const finding of [...findings, ...unverified]) for (const id of finding.evidence) ids.add(id);
  for (const proposal of proposals) for (const id of proposal.evidenceIds) ids.add(id);
  for (const assessment of assessments) {
    for (const entry of [assessment.ymyl, assessment.entityClarity, assessment.nonCommodityValue, assessment.intent, ...assessment.selfAssessment]) if (entry?.evidenceId) ids.add(entry.evidenceId);
  }
  const evidence: EvidenceItem[] = [];
  for (const id of ids) {
    const item = strings.items.get(id);
    if (item) {
      evidence.push(toEvidence(item));
      continue;
    }
    const slice = strings.slices.find(entry => entry.id === id);
    if (slice) evidence.push(sliceEvidence(slice, strings.pages.find(page => page.key === slice.page)));
  }
  return evidence.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}
