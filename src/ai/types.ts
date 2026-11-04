import type { EvidenceItem } from '../core/evidence.ts';
import type { Category } from '../core/types.ts';
import type { Finding, FindingScope } from '../rules/engine.ts';

export type ProviderName = 'claude' | 'codex';
export type Role = 'analyst' | 'verifier';
export type PassId = 'content' | 'serp' | 'schema' | 'intl';
export type Confidence = 'high' | 'medium' | 'low';
export type Verdict = 'confirmed' | 'likely' | 'not_confirmed' | 'not_assessable';

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
}

/** What one provider call returns once its protocol checks pass; `value` is still unvalidated model output. */
export interface CallResult {
  readonly value: unknown;
  readonly model?: string;
  readonly costUsd?: number;
  readonly usage?: Usage;
  readonly cliVersion: string;
}

export const providerErrorCodes = [
  'unavailable',
  'invalid-input',
  'unsafe-directory',
  'command-too-long',
  'start-failed',
  'timeout',
  'cancelled',
  'output-limit',
  'termination-failed',
  'exit-nonzero',
  'invalid-response',
  'missing-output',
  'structured-output-retries',
  'permission-denied',
  'tool-use',
  'provider-failed',
] as const;
export type ProviderErrorCode = (typeof providerErrorCodes)[number];

/**
 * A provider call that did not produce a trustworthy answer. Messages reach report files, so they never contain
 * model output, stderr or a local path; the file or folder concerned, when there is one, is kept apart.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ProviderName | undefined;
  /** The local file or folder the error is about, for the terminal only. */
  readonly path: string | undefined;

  constructor(code: ProviderErrorCode, message: string, provider?: ProviderName, path?: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    this.path = path;
  }
}

export interface Quote {
  readonly evidenceId: string;
  readonly text: string;
}

/** Display-only remarks from the model, cleaned and bounded; report text comes from templates. */
export interface Notes {
  readonly en: string;
  readonly es: string;
  readonly ca: string;
}

export interface AiFinding extends Finding {
  /** `F-<evidenceSignature>`, like deterministic report findings. */
  readonly id: string;
  readonly category: Category;
  readonly title: string;
  /** English message from the rule's template, when one exists for the reason. */
  readonly message?: string;
  readonly origin: 'ai';
  readonly pass: PassId;
  readonly verdict: Exclude<Verdict, 'not_assessable'>;
  readonly quotes: readonly Quote[];
  readonly notes: Notes;
  readonly verification: 'supported' | 'partial' | 'unverified';
  /** Report id of the deterministic candidate this finding confirms or dismisses. */
  readonly candidateId?: string;
  /** Corrections code applied to the model's claim, such as a severity cap. */
  readonly adjustments?: readonly string[];
}

export const dropReasons = [
  'schema',
  'rule-not-in-catalog',
  'rule-out-of-scope',
  'scope-not-audited',
  'scope-outside-call',
  'missing-evidence',
  'unknown-evidence',
  'missing-quote',
  'quote-too-short',
  'quote-uncited-evidence',
  'quote-other-evidence',
  'quote-not-found',
  'absence-on-incomplete-slice',
  'myth',
  'new-market',
  'new-fact',
  'discriminating-words',
  'duplicate',
  'ambiguous-candidate',
  'duplicate-of-deterministic',
  'contradicts-deterministic',
  'length',
  'unchanged',
  'not-unique',
  'brand-missing',
  'wrong-language',
  'too-many',
  'invalid-json-ld',
  'retired-feature',
  'verification-unsupported',
  'verification-partial-low',
] as const;
export type DropReason = (typeof dropReasons)[number];

/** A claim the model made that did not survive validation or verification, kept with its reason for the report. */
export interface DroppedClaim {
  readonly pass: PassId;
  readonly role: Role;
  readonly kind: 'answer' | 'finding' | 'proposal' | 'assessment';
  readonly page?: string;
  readonly ruleId?: string;
  readonly reason: DropReason;
  readonly detail?: string;
  /** The claim as returned, cleaned and bounded. */
  readonly claim: Readonly<Record<string, unknown>>;
}

export interface SerpProposal {
  readonly kind: 'title' | 'meta-description';
  readonly pass: 'serp';
  readonly scope: string;
  readonly text: string;
  readonly language: string;
  /** The value on the page today, when it has one. */
  readonly current?: string;
  readonly evidenceIds: readonly string[];
  readonly notes: Notes;
  /** URLs replaced by OWNER_TO_SUPPLY because they are not links found on the crawled pages. */
  readonly placeholders: number;
}

export interface JsonLdProposal {
  readonly kind: 'json-ld';
  readonly pass: 'schema';
  readonly scope: string;
  /** Parsed and re-serialised JSON-LD. */
  readonly jsonLd: string;
  readonly evidenceIds: readonly string[];
  readonly notes: Notes;
  readonly placeholders: number;
}

export type Proposal = SerpProposal | JsonLdProposal;

export interface JudgedValue {
  readonly value: string;
  readonly evidenceId?: string;
  readonly quote?: string;
}

export interface SelfAssessmentAnswer {
  readonly question: string;
  readonly answer: 'yes' | 'no' | 'not_assessable';
  readonly evidenceId?: string;
  readonly quote?: string;
}

/** Context from the content pass: YMYL, entity clarity, non-commodity value, intent and Google's self-assessment questions. */
export interface PageAssessment {
  readonly page: string;
  readonly ymyl?: JudgedValue;
  readonly entityClarity?: JudgedValue;
  readonly nonCommodityValue?: JudgedValue;
  readonly intent?: JudgedValue & { readonly inferred: boolean };
  readonly selfAssessment: readonly SelfAssessmentAnswer[];
}

/** What the analysis concluded about a deterministic candidate (a finding with needsJudgment). */
export interface CandidateDecision {
  readonly candidateId: string;
  readonly ruleId: string;
  readonly scope: FindingScope;
  readonly decision: 'confirmed' | 'dismissed';
  readonly findingId: string;
  readonly verification: 'supported' | 'partial' | 'unverified';
}

/** Site text that addresses AI systems, for the ai-hidden-llm-instructions rule to judge. Never acted on. */
export interface InjectionCandidate {
  readonly ruleId: 'ai-hidden-llm-instructions';
  readonly page: string;
  readonly evidenceId: string;
  readonly where: string;
  readonly pattern: string;
  readonly excerpt: string;
  /** False when users do not see the text, as with alt text, JSON-LD or hidden elements. */
  readonly visible: boolean;
}

/** A pass that did not run on a page, and why: its inputs were missing or nothing was left to judge. */
export interface SkippedPass {
  readonly pass: PassId;
  readonly page: string;
  readonly reason: string;
}

export interface CallRecord {
  readonly id: string;
  readonly role: Role;
  readonly pass: PassId;
  readonly pages: readonly string[];
  readonly provider?: ProviderName;
  readonly cliVersion?: string;
  readonly model?: string;
  readonly status: 'ok' | 'cached' | 'failed' | 'skipped' | 'planned';
  readonly error?: { readonly code: string; readonly message: string };
  readonly durationMs: number;
  readonly costUsd?: number;
  readonly usage?: Usage;
  readonly promptChars: number;
  /** Characters divided by four, a rough guide rather than a tokenizer count. */
  readonly estimatedTokens: number;
}

export interface ProviderSummary {
  readonly name: ProviderName;
  readonly cliVersion: string;
  /** True when this exact CLI version is in the verified capability table. */
  readonly verifiedVersion: boolean;
  readonly model?: string;
  readonly source: 'env' | 'path' | 'app';
}

/** The analysis as stored in a report: verified findings, the appendix and everything that was dropped. */
export interface ReportAnalysis {
  readonly schemaVersion: 1;
  readonly provider: { readonly analyst?: ProviderSummary; readonly verifier?: ProviderSummary };
  readonly pages: readonly string[];
  readonly calls: readonly CallRecord[];
  readonly costUsd: number;
  /** Findings that passed validation and verification. They never change the score or the task list. */
  readonly findings: readonly AiFinding[];
  /** Findings whose verification could not run; shown in an appendix only. */
  readonly unverified: readonly AiFinding[];
  readonly proposals: readonly Proposal[];
  readonly assessments: readonly PageAssessment[];
  readonly confirmations: readonly CandidateDecision[];
  readonly dropped: readonly DroppedClaim[];
  readonly skipped: readonly SkippedPass[];
  readonly injectionCandidates: readonly InjectionCandidate[];
  /** Site text cited by the analysis, with ids starting with A. */
  readonly evidence: readonly EvidenceItem[];
  readonly warnings: readonly string[];
}
