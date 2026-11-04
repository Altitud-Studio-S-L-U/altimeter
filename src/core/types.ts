export const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof severities)[number];

export const categories = ['crawl', 'content', 'perf', 'schema', 'intl', 'tech', 'ai'] as const;
export type Category = (typeof categories)[number];

export const methods = ['deterministic', 'hybrid', 'ai-judgment', 'external-api', 'owner-data'] as const;
export type Method = (typeof methods)[number];

export const evidenceLevels = [
  'official-google',
  'official-other-engine',
  'web-standard',
  'measured-study',
  'industry-consensus',
  'speculative',
] as const;
export type EvidenceLevel = (typeof evidenceLevels)[number];

export const pageTypes = [
  'home',
  'service',
  'product',
  'article',
  'listing',
  'contact',
  'about',
  'legal',
  'utility',
  'error',
  'other',
] as const;
export type PageType = (typeof pageTypes)[number];

/** What a rule reads. The collector guarantees each input exists, or the rule is not evaluated. */
export const inputIds = [
  'http',
  'redirects',
  'raw-html',
  'rendered-dom',
  'user-render',
  'unblocked-render',
  'resources',
  'robots',
  'sitemaps',
  'variants',
  'not-found-probe',
  'siblings',
  'crawl',
  'lighthouse',
  'crux',
  'tls',
  'ua-probe',
  'gsc',
  'bing',
  'bot-activity',
  'ai',
] as const;
export type InputId = (typeof inputIds)[number];

export const ruleStatuses = ['v1', 'planned', 'requires-owner-data'] as const;
export type RuleStatus = (typeof ruleStatuses)[number];

export interface RuleSource {
  url: string;
  /** Date the source was last read and found to support the rule, as YYYY-MM-DD. */
  verified: string;
}

export interface RuleMeta {
  /** `<category>-<kebab-slug>`. */
  id: string;
  category: Category;
  /** English source text; translations are keyed by rule id. */
  title: string;
  why: string;
  fix: string;
  /** The most severe outcome the rule may report; a failure is graded at or below it. */
  maxSeverity: Severity;
  method: Method;
  scope: 'page' | 'site';
  inputs: InputId[];
  appliesTo: PageType[] | 'all';
  /** Conditions under which a failing pattern is intentional or harmless, so the rule passes or does not apply. */
  exemptWhen: string[];
  fpRisk: 'low' | 'medium' | 'high';
  /** Whether a failure counts toward the deterministic score. */
  scored: boolean;
  evidenceLevel: EvidenceLevel;
  /** Exact pass and fail criteria, or "none". */
  thresholds: string;
  sources: RuleSource[];
  status: RuleStatus;
  /** False-positive traps and edge cases for implementers. */
  notes?: string;
  related?: string[];
}

export interface Myth {
  id: string;
  claim: string;
  reality: string;
  sources: RuleSource[];
  /** Lowercase phrases that mark a recommendation as repeating the myth. */
  patterns: string[];
}

export const outcomes = ['pass', 'fail', 'not_applicable', 'not_evaluated'] as const;
export type Outcome = (typeof outcomes)[number];
