import type { ProviderName, Usage } from '../ai/types.ts';
import type { PageType } from '../core/types.ts';
import type { Language } from '../i18n/messages.ts';

/** The answer engines the probe drives: the Claude Code and Codex CLIs, signed in with the user's own login. */
export type ProbeEngine = ProviderName;
export const probeEngines: readonly ProbeEngine[] = ['claude', 'codex'];

/**
 * Where a query came from. A brand question names the brand, so it measures recognition rather than
 * visibility; the other classes are queries a searcher could type without knowing the site.
 */
export const queryClasses = ['keyword', 'search-console', 'inferred', 'brand'] as const;
export type QueryClass = (typeof queryClasses)[number];

export type QueryOrigin =
  | { readonly kind: 'keyword' }
  | {
    readonly kind: 'search-console';
    readonly property: string;
    readonly start: string;
    readonly end: string;
    readonly impressions: number;
    readonly clicks: number;
    readonly position: number;
  }
  | { readonly kind: 'inferred'; readonly page: string; readonly element: 'h1' | 'title' }
  | { readonly kind: 'brand'; readonly name: string; readonly language: Language };

export interface PlannedQuery {
  /** Q1, Q2 and so on, in plan order. */
  readonly id: string;
  readonly text: string;
  readonly class: QueryClass;
  readonly origin: QueryOrigin;
}

/** A page of the site read to find its names and to infer queries. Titles and headings are untrusted site text. */
export interface SitePage {
  readonly url: string;
  readonly status?: number;
  readonly pageType: PageType;
  readonly title?: string;
  readonly h1?: string;
}

export interface SiteProfile {
  /** The origin the probe reads, such as https://example.com. */
  readonly origin: string;
  /** The host of that origin, without a www. prefix. */
  readonly host: string;
  /** The registrable domain whose URLs count as the site's, such as example.com for blog.example.com. */
  readonly domain: string;
  /** Names the site declares for itself: WebSite name and alternateName, og:site_name, Organization name. */
  readonly brandNames: readonly string[];
  /** Primary language subtag of the home page, when it declares one. */
  readonly language?: string;
  readonly pages: readonly SitePage[];
  readonly notices: readonly SiteNotice[];
}

export interface ProbePlan {
  readonly site: SiteProfile;
  readonly queries: readonly PlannedQuery[];
  readonly engines: readonly ProbeEngine[];
  readonly runsPerQuery: number;
  /** queries x runs x engines: the most CLI calls the probe can make. */
  readonly calls: number;
  /** Why something was left out of the plan, as codes with parameters for the report. */
  readonly notes: readonly PlanNote[];
}

export type PlanNote =
  | { readonly code: 'brand-left-out'; readonly reason: 'no-name' | 'names-domain' | 'no-room' }
  | { readonly code: 'search-console-failed'; readonly message: string }
  | { readonly code: 'search-console-empty' }
  | { readonly code: 'inferred-fallback' };

/** Something about reading the site that the report explains; parameters are written by Altimeter or cleaned. */
export type SiteNotice =
  | { readonly code: 'home-unreadable'; readonly reason: string }
  | { readonly code: 'home-redirects'; readonly to: string };

/** Something about one engine's runs that the report explains. */
export type EngineNotice =
  | { readonly code: 'unverified-version'; readonly version: string }
  | { readonly code: 'stopped'; readonly reason: RunFailureCode; readonly consecutive: number }
  | { readonly code: 'unrecognised-results'; readonly runs: number };

/** How retrieved URLs were read from one Claude WebSearch result; text and empty mean the format was not recognised. */
export type RetrievalFormat = 'links-json' | 'structured' | 'text' | 'empty';

/** What one engine run produced once its protocol checks passed. Every string is cleaned and bounded. */
export interface RawRun {
  /** The final answer, cleaned of control, bidirectional and zero-width characters and cut at answerLimit. */
  readonly answer: string;
  /** Canonical URLs the engine's search returned. Absent when the engine does not expose them, as with Codex. */
  readonly retrieved?: readonly string[];
  readonly formats?: readonly RetrievalFormat[];
  readonly searches: number;
  readonly model?: string;
  /** Claude Code's own client-side estimate of the API-equivalent cost, not what a subscription is charged. */
  readonly costUsd?: number;
  readonly usage?: Usage;
  readonly durationMs: number;
  /** When the run finished, as UTC ISO 8601. */
  readonly at: string;
}

/** Answers longer than this are cut before they are evaluated or stored. */
export const answerLimit = 16_000;

export const runFailureCodes = [
  'unavailable',
  'unsafe-directory',
  'command-too-long',
  'start-failed',
  'timeout',
  'cancelled',
  'output-limit',
  'termination-failed',
  'exit-nonzero',
  'invalid-response',
  'incomplete',
  'missing-answer',
  'tool-use',
  'isolation',
  'permission-denied',
  'limit-or-auth',
  'provider-failed',
] as const;
export type RunFailureCode = (typeof runFailureCodes)[number];

/** A run that did not produce a trustworthy answer. Messages never contain engine output or stderr. */
export class ProbeRunError extends Error {
  readonly code: RunFailureCode;

  constructor(code: RunFailureCode, message: string) {
    super(message);
    this.name = 'ProbeRunError';
    this.code = code;
  }
}

export type SkipReason = 'call-cap' | 'deadline' | 'engine-stopped' | 'cancelled';

export interface RunRecord {
  readonly queryId: string;
  /** 1-based index of the run among the runs of its query. */
  readonly run: number;
  readonly status: 'ok' | 'cached' | 'failed' | 'skipped';
  readonly at?: string;
  readonly durationMs?: number;
  readonly model?: string;
  readonly searches?: number;
  /** links-json or structured when every search result was read as such; text when any result fell back to its text. */
  readonly retrievalFormat?: 'links-json' | 'structured' | 'text' | 'none';
  readonly retrieved?: readonly string[];
  readonly cited?: readonly string[];
  readonly brandMentioned?: boolean;
  /** The line of the answer that mentions the brand, cleaned and cut at 200 characters. Untrusted. */
  readonly mention?: string;
  readonly error?: { readonly code: RunFailureCode; readonly message: string };
  readonly skipped?: SkipReason;
  /** Cache entry of the run, so a result can be inspected again; never a local path. */
  readonly cacheKey?: string;
  readonly costUsd?: number;
  readonly usage?: Usage;
}

export interface Count {
  readonly value: string;
  readonly runs: number;
}

/** Counts for one query and one engine. Only completed runs (made now or read from the cache) are counted. */
export interface QueryMetrics {
  readonly queryId: string;
  readonly planned: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly fromCache: number;
  /**
   * Runs whose answer cites a page of the site. For Claude only pages its own search returned count; for Codex,
   * whose search results are not exposed, the answer's citations are counted as reported.
   */
  readonly cited: number;
  /** Claude runs that cite the site only with pages its search did not return; they are not in `cited`. */
  readonly citedUnconfirmed?: number;
  readonly brandMentioned: number;
  readonly searched: number;
  /** The site's pages cited, by the number of runs that cite each. */
  readonly siteUrls: readonly Count[];
  /** Claude: the site's pages its search returned that the answer did not cite. */
  readonly retrievedNotCited?: readonly Count[];
  /** Registrable domains other than the site's that the answers cite. */
  readonly competitors: readonly Count[];
  /** Claude: URLs of any site that the answers cite but its search did not return. */
  readonly citedNotRetrieved?: readonly Count[];
  /** True below three completed runs, the smallest sample the report counts as a sample. */
  readonly insufficientSample: boolean;
}

export type SearchMode = 'claude-websearch' | 'codex-live';
export type SearchLocale = 'united-states' | 'not-set';

export interface EngineSection {
  readonly engine: ProbeEngine;
  readonly status: 'ran' | 'unavailable';
  /** Why the engine could not run, written by Altimeter. */
  readonly problem?: string;
  readonly cliVersion?: string;
  /** True when this CLI version is in the verified capability table. */
  readonly verifiedVersion?: boolean;
  /** Models the runs reported; empty when the CLI does not report one. */
  readonly models: readonly string[];
  readonly searchMode: SearchMode;
  readonly locale: SearchLocale;
  /** retrieval: citations are checked against what the engine's search returned; unverifiable: they cannot be. */
  readonly provenance: 'retrieval' | 'unverifiable';
  /** Dates (UTC) of the first and last completed run; cached runs keep the date they were made. */
  readonly firstRun?: string;
  readonly lastRun?: string;
  readonly runsPerQuery: number;
  readonly queries: readonly QueryMetrics[];
  readonly runs: readonly RunRecord[];
  /** Sum of the cost estimates Claude Code reported for the calls made in this probe. */
  readonly costUsd?: number;
  readonly notices: readonly EngineNotice[];
}

export interface ProbeReport {
  readonly schemaVersion: 1;
  readonly kind: 'ai-probe';
  readonly tool: { readonly name: 'altimeter'; readonly version: string };
  readonly promptVersion: string;
  readonly generatedAt: string;
  readonly language: Language;
  readonly site: {
    readonly origin: string;
    readonly host: string;
    readonly domain: string;
    readonly brandNames: readonly string[];
    readonly pagesRead: readonly SitePage[];
  };
  readonly runsPerQuery: number;
  readonly queries: readonly PlannedQuery[];
  readonly notes: readonly PlanNote[];
  readonly siteNotices: readonly SiteNotice[];
  readonly engines: readonly EngineSection[];
  readonly calls: { readonly planned: number; readonly cap: number; readonly made: number; readonly fromCache: number; readonly skipped: number };
}
