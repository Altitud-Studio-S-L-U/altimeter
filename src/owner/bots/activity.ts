/**
 * Crawler visits read from the owner's access logs or CDN analytics, each identity verified where the operator allows.
 *
 * Every request whose user agent names a known crawler is a claim. A claim is verified when it passes a check the
 * operator documents (its published IP list, reverse DNS with forward confirmation, or the CDN's own verified-bot
 * flag), spoofed when every documented check could be run and it failed them all, and unverified when a check could
 * not be run (no client address, a list that could not be read, DNS disabled or failing). Operators that document no
 * check at all are unverifiable: their requests stay claims and are never reported as zero verified visits.
 */
export type BotPurpose = 'search' | 'training' | 'user-triggered';

/** How a verified request was recognised. `operator-ip-list` proves the operator, not which of its crawlers it was. */
export type VerificationMethod = 'ip-list' | 'operator-ip-list' | 'reverse-dns' | 'edge';

export type Verdict = 'verified' | 'unverified' | 'spoofed';

/** Requests of one crawler in one verification class. */
export interface RequestTally {
  /** Requests; estimates when the source samples. */
  readonly hits: number;
  /** Response bytes, when the source records them. */
  readonly bytes: number;
  /** ISO timestamps of the first and last request; midnight UTC of the day for sources grouped by day. */
  readonly firstSeen?: string;
  readonly lastSeen?: string;
  /** UTC days with at least one request. */
  readonly activeDays: number;
  /** Requests by response status; "0" when the client closed the connection before a response. */
  readonly statuses: Readonly<Record<string, number>>;
  /** Requests the edge recorded as challenged, for sources that record it. */
  readonly challenges: number;
}

export interface PathCount {
  /** Path and query as requested, cleaned of control and invisible characters. Untrusted. */
  readonly path: string;
  readonly hits: number;
  readonly statuses: Readonly<Record<string, number>>;
}

/** Sitemap URLs of the audited host against the paths a crawler requested. */
export interface SitemapCoverage {
  readonly urls: number;
  /** Sitemap URLs requested at least once, whatever the answer. */
  readonly fetched: number;
  /** Sitemap URLs answered with a 2xx or 304 at least once. */
  readonly ok: number;
  /** Up to 25 sitemap URLs the crawler never requested. */
  readonly missing: readonly string[];
}

export interface DisallowedPath {
  readonly path: string;
  readonly hits: number;
  readonly lastSeen: string;
  /** The robots.txt rule that disallows the path, and its line. */
  readonly rule: string;
  readonly line: number;
}

/**
 * Requests for paths the current robots.txt disallows, counted only from the moment the crawler must have known the
 * current file: its caching window after the file took effect, or its first fetch of robots.txt after that.
 */
export interface RobotsCompliance {
  readonly cacheHours: number;
  /** `documented` when the operator states its caching window, `standard` for the 24 hours of RFC 9309. */
  readonly cacheBasis: 'documented' | 'standard';
  /** Requests from this moment on were checked; absent when the window ends before it. */
  readonly checkedFrom?: string;
  readonly disallowed: number;
  /** Up to 20 disallowed paths, most requested first. */
  readonly paths: readonly DisallowedPath[];
  /** True when more requests fell inside the caching window than could be kept, so the count is a lower bound. */
  readonly incomplete: boolean;
}

export interface BotSummary {
  /** Stable id from the operator table, e.g. `oai-searchbot`. */
  readonly id: string;
  readonly name: string;
  readonly operator: string;
  readonly purpose: BotPurpose;
  /** Lowercase robots.txt product token. */
  readonly token: string;
  /** False when the operator documents no way to verify the crawler. */
  readonly verifiable: boolean;
  /**
   * What the path, robots.txt, asset and coverage figures count: verified requests, or every claimed request when the
   * operator documents no check or none of the claims could be checked.
   */
  readonly basis: 'verified' | 'claimed';
  readonly verified: RequestTally;
  readonly unverified: RequestTally;
  readonly spoofed: RequestTally;
  readonly verifiedBy: Readonly<Partial<Record<VerificationMethod, number>>>;
  /** Why claims stayed unverified, such as `no-client-ip`, `proxy-address`, `list-unavailable` or `dns-error`. */
  readonly unverifiedReasons: Readonly<Record<string, number>>;
  /** Basis requests for paths the current robots.txt allows the crawler, when robots.txt is known. */
  readonly onAllowedPaths?: RequestTally;
  /** Basis requests for /robots.txt and for /llms.txt or /llms-full.txt. */
  readonly robotsTxt: number;
  readonly llmsTxt: number;
  /** Basis requests for scripts and style sheets, a hint that the crawler renders pages. */
  readonly scripts: number;
  readonly stylesheets: number;
  readonly paths: { readonly distinct: number; readonly capped: boolean; readonly top: readonly PathCount[] };
  readonly coverage?: SitemapCoverage;
  readonly compliance?: RobotsCompliance;
  /** One claimed user agent, cleaned and shortened. Untrusted. */
  readonly userAgent?: string;
  /** True when the source returned only its top rows for this crawler, so counts are lower bounds. */
  readonly truncated: boolean;
}

export type LogFormat = 'combined' | 'common' | 'nginx-json' | 'iis' | 'cloudfront' | 'alb' | 'cloudflare' | 'vercel' | 'netlify';

/**
 * Where the client address comes from. `remote` is the address the server logged. `xff-last` is the last
 * X-Forwarded-For entry, the address the nearest proxy saw, which is the right choice behind one trusted proxy or
 * load balancer. `xff-first` is the first entry, which any client can forge, so use it only when every hop is trusted.
 */
export type IpSource = 'remote' | 'xff-first' | 'xff-last';

export interface LogSourceSummary {
  readonly kind: 'access-log';
  /** File name without its folder. */
  readonly file: string;
  readonly format: LogFormat;
  readonly lines: number;
  readonly records: number;
  readonly malformed: number;
  /** Lines read but not counted, by reason: outside the window, not a request, duplicate. */
  readonly skipped: Readonly<Record<string, number>>;
  readonly firstRecord?: string;
  readonly lastRecord?: string;
  /** Which fields the records carried, so missing measurements are explained rather than reported as zero. */
  readonly fields: { readonly userAgent: boolean; readonly clientIp: boolean; readonly referer: boolean; readonly host: boolean; readonly bytes: boolean };
}

export interface CloudflareSourceSummary {
  readonly kind: 'cloudflare-graphql';
  readonly zone: string;
  readonly dataset: 'httpRequestsAdaptiveGroups';
  /** Adaptive sampling: every count is an estimate. */
  readonly sampled: true;
  readonly queries: number;
  /** Dimensions the queries grouped by, as the zone's plan allows. */
  readonly dimensions: readonly string[];
  /** True when a query returned its maximum rows, so rare crawlers or paths may be missing. */
  readonly truncated: boolean;
  /** Mean sample interval reported by Cloudflare, when available; 1 means unsampled. */
  readonly sampleInterval?: number;
}

export interface IpListStatus {
  readonly id: string;
  readonly url: string;
  /** The list's own creationTime. */
  readonly creationTime?: string;
  /** When Altimeter downloaded it. */
  readonly fetchedAt?: string;
  readonly from: 'network' | 'cache' | 'stale-cache' | 'unavailable';
  readonly prefixes: number;
  readonly error?: string;
}

export interface ReferralCount {
  readonly host: string;
  readonly assistant: string;
  readonly visits: number;
}

export interface BotActivity {
  /** When the data was read; windows such as "the last 30 days" end here. */
  readonly fetchedAt: string;
  readonly window: { readonly start: string; readonly end: string; readonly days: number; readonly firstRecord?: string; readonly lastRecord?: string };
  readonly sources: readonly (LogSourceSummary | CloudflareSourceSummary)[];
  /** True when a source samples, so counts are approximate. */
  readonly sampled: boolean;
  readonly clientIp: {
    readonly source: IpSource;
    /** Claimed crawler requests, and those with an address that could be checked. */
    readonly claims: number;
    readonly checkable: number;
    /** Addresses set aside because they cannot be a crawler's, by reason (`private-address`, `proxy-address`, `proxy-suspected`). */
    readonly discarded: Readonly<Record<string, number>>;
  };
  readonly ipLists: readonly IpListStatus[];
  readonly dns: { readonly enabled: boolean; readonly lookups: number; readonly errors: number; readonly capped: boolean };
  readonly site?: {
    readonly origin: string;
    readonly sitemapUrls: number;
    /** When the current robots.txt is taken to apply from, and how that was decided. */
    readonly robots?: { readonly url: string; readonly effectiveFrom: string; readonly effectiveFromSource: 'owner' | 'last-modified' | 'assumed' };
  };
  /** Crawlers with at least one claimed request. */
  readonly bots: readonly BotSummary[];
  /** robots.txt tokens no request carries, so logs cannot show them (Google-Extended, Applebot-Extended). */
  readonly notObservable: readonly { readonly name: string; readonly token: string; readonly operator: string }[];
  /** Browser requests referred by AI assistants; absent when no source records referrers. */
  readonly referrals?: { readonly byHost: readonly ReferralCount[]; readonly tagged: number; readonly total: number };
  readonly warnings: readonly string[];
}
