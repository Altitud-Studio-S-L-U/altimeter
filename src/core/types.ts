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

/**
 * What a rule reads. The collector guarantees each input exists, or the rule is not evaluated.
 * http/redirects: the page's fetch and hops. raw-html: the HTML as served. rendered-dom: the Googlebot-like render
 * (tall viewport, no scrolling, robots-blocked subresources not loaded). user-render: a phone-sized render that
 * scrolls; it is the only source of lab layout shifts. unblocked-render: the render without robots.txt blocking,
 * present only when something was blocked. resources: favicons, Open Graph images, logos and /llms.txt fetched by
 * the collector. variants: URL variants (no trailing slash, /index.html, upper case, tracking parameter, //, http,
 * www) fetched with redirects. not-found-probe: a random unknown path. siblings: two other pages of the site, to
 * tell template text from page content. crawl: a crawl ran and site.pages holds the crawled pages. lighthouse:
 * the median Lighthouse run, including network requests. crux: Chrome UX Report field data. tls: the certificate.
 * ua-probe: the page fetched as Googlebot and as a browser (page scope) or the home page fetched with each crawler's
 * user agent (site scope). gsc, bing, bot-activity: owner data. ai: the analyst.
 * A site-scope rule that lists a per-page input runs when at least one auditable page has it.
 */
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

/**
 * Why a rule could not evaluate a check, as it returns it. Each reason has a label in every language of
 * src/i18n/ui.ts; the engine adds missing-input, page-not-auditable and rule-error reasons of its own.
 */
export const notEvaluatedReasons = [
  'baseline-not-ok',
  'bfcache-not-tested',
  'browser-shell-without-render',
  'challenge-page',
  'consent-or-challenge',
  'consent-or-login-redirect',
  'crawl-issues-not-read',
  'crux-error',
  'default-sitemap-not-fetched',
  'http-probe-failed',
  'invalid-og-url',
  'language-not-detectable',
  'language-undetermined',
  'llms-txt-not-fetched',
  'llms-txt-unreachable',
  'logo-not-fetched',
  'missing-probe',
  'no-accessibility-category',
  'no-animations-audit',
  'no-baseline',
  'no-best-practices-category',
  'no-cache-insight',
  'no-client-address',
  'no-cls-culprits',
  'no-comparable-responses',
  'no-coverage-audits',
  'no-dependency-tree',
  'no-document',
  'no-field-data',
  'no-font-display-insight',
  'no-forced-reflow-insight',
  'no-home-page',
  'no-image-delivery-insight',
  'no-inp-data',
  'no-javascript-insights',
  'no-lab-value',
  'no-layout-metrics',
  'no-lcp-breakdown',
  'no-lcp-element',
  'no-lcp-text',
  'no-lighthouse',
  'no-locale-probes',
  'no-long-tasks-audit',
  'no-minification-audits',
  'no-navigation-types',
  'no-network-requests',
  'no-overlay-data',
  'no-parsed-sitemap',
  'no-performance-score',
  'no-referrer-data',
  'no-response',
  'no-response-date',
  'no-root-probes',
  'no-seo-category',
  'no-served-date',
  'no-site-name',
  'no-subpart-data',
  'no-third-parties-insight',
  'no-unblocked-render',
  'no-unsized-images-audit',
  'no-user-agents',
  'not-assessable',
  'og-image-not-fetched',
  'other-origin',
  'page-language-unknown',
  'page-traffic-not-read',
  'performance-data-truncated',
  'probe-failed',
  'probe-not-200',
  'probe-not-comparable',
  'probe-server-error',
  'render-url-differs',
  'robots-not-compared',
  'robots-not-fetched',
  'robots-unreachable',
  'short-window',
  'single-member-clusters',
  'single-page',
  'site-size-unknown',
  'size-unmeasurable',
  'svg-size-not-measurable',
  'svg-size-unmeasurable',
  'target-not-fetched',
  'targets-not-fetched',
  'targets-not-rendered',
  'targets-on-other-hosts',
  'tls-unreachable',
  'too-little-text',
  'unfollowed-redirect',
  'unparseable-url',
  'unverified-only',
  'variants-not-fetched',
] as const;
export type NotEvaluatedReason = (typeof notEvaluatedReasons)[number];

export const fixLocations = ['repo', 'platform-config', 'cdn-dashboard', 'content', 'external-account', 'owner-decision'] as const;
export type FixLocation = (typeof fixLocations)[number];

export const verifications = ['local', 'deployed', 'field-28d', 'owner-data', 'manual'] as const;
export type Verification = (typeof verifications)[number];

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
  /** Inputs that must have been collected for the rule to be evaluated at all. */
  inputs: InputId[];
  /** Inputs the rule uses when present, for example to escalate severity; their absence never blocks evaluation. */
  optionalInputs?: InputId[];
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
  /** Where a fix is usually made; external accounts and owner decisions are never handed to a coding agent. Default: repo. */
  fixLocation?: FixLocation;
  /** How a fix can be confirmed: against a local build, only once deployed, after 28 days of field data, with owner data, or by hand. */
  verifiableBy?: Verification;
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
