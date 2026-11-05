import type { CruxFormFactor, CruxOutcome } from '../data/crux.ts';
import type { ProbeAgent } from '../data/agents.ts';
import type { FetchResult } from '../fetch/http.ts';
import type { RobotsAvailability } from '../fetch/robots.ts';
import type { SitemapDocument } from '../fetch/sitemap.ts';
import type { TlsFacts } from '../fetch/tls.ts';
import type { BingData } from '../owner/bing.ts';
import type { BotActivity } from '../owner/bots/activity.ts';
import type { GscData } from '../owner/gsc.ts';
import type { ParsedHtml } from '../parse/html.ts';
import type { StructuredData } from '../parse/structured-data.ts';
import type { RenderResult } from '../render/chrome.ts';
import type { LighthouseOutcome } from '../render/lighthouse.ts';
import type { PageType } from './types.ts';

export interface DocumentFacts {
  readonly html: string;
  readonly parsed: ParsedHtml;
  readonly data: StructuredData;
}

export interface RenderFacts extends DocumentFacts {
  readonly result: RenderResult;
}

/** Everything collected about one URL. Absent members mean the collector did not run or failed. */
export interface PageFacts {
  readonly url: string;
  readonly fetch: FetchResult;
  readonly pageType: PageType;
  readonly pageTypeReason: string;
  readonly raw?: DocumentFacts;
  readonly rendered?: RenderFacts;
  readonly userRender?: RenderFacts;
  readonly unblockedRender?: RenderFacts;
  readonly lighthouse?: LighthouseOutcome;
  readonly crux?: Readonly<Record<'url' | 'origin', Readonly<Partial<Record<CruxFormFactor, CruxOutcome>>>>>;
  /** The raw page fetched again as Googlebot and as a browser, to compare what each receives. */
  readonly uaProbes?: readonly AgentProbe[];
  /**
   * Why the page cannot be audited, when the response is a firewall challenge, a login or a consent wall rather
   * than the page. No page rule is evaluated on it.
   */
  readonly notAuditable?: string;
}

export interface OwnerData {
  readonly gsc?: GscData;
  readonly bing?: BingData;
  readonly bots?: BotActivity;
  /** Write "query 1", "query 2" instead of the owner's search queries, for a report meant to be shared. */
  readonly redactQueries?: boolean;
}

export interface AgentProbe {
  readonly agent: ProbeAgent;
  readonly url: string;
  readonly fetch: FetchResult;
}

export interface SitemapFacts {
  readonly url: string;
  readonly source: 'robots' | 'link' | 'default' | 'index';
  readonly fetch: FetchResult;
  readonly document?: SitemapDocument;
}

export interface ProbeFacts {
  readonly label: string;
  readonly url: string;
  readonly fetch: FetchResult;
}

export type ResourcePurpose = 'favicon' | 'apple-touch-icon' | 'og-image' | 'logo' | 'llms-txt';

/** A file referenced by the audited pages and fetched so its status, type and size can be checked. */
export interface ResourceFacts extends ProbeFacts {
  readonly purpose: ResourcePurpose;
  /** The page that referenced it, or undefined for well-known paths such as /llms.txt. */
  readonly referencedBy?: string;
}

export interface SiteFacts {
  readonly origin: string;
  readonly robots?: { readonly url: string; readonly fetch: FetchResult; readonly availability: RobotsAvailability };
  readonly sitemaps: readonly SitemapFacts[];
  /** Variant URLs of audited pages (no trailing slash, /index.html, upper case, tracking parameter, http, www). */
  readonly variants: readonly ProbeFacts[];
  readonly notFound?: ProbeFacts & { readonly parsed?: ParsedHtml };
  /** Pages fetched only to tell template text from page content. */
  readonly siblings: readonly PageFacts[];
  /**
   * The audited page's hreflang alternates that no other step fetched, fetched raw without Accept-Language or
   * cookies (at most ten), so reciprocity and target checks work without a crawl.
   */
  readonly alternates?: readonly PageFacts[];
  /**
   * Links of the audited page that its base element sends elsewhere on the same host, fetched where the base sends
   * them (at most four), so crawl-base-href can tell whether they land on errors without a crawl.
   */
  readonly baseLinks?: readonly ProbeFacts[];
  readonly pages: ReadonlyMap<string, PageFacts>;
  /** True when a crawl ran, so site-scope graph rules can be evaluated. */
  readonly crawled: boolean;
  /** Internal URLs the crawl found but did not fetch because robots.txt disallows them for Googlebot. */
  readonly crawlBlocked?: readonly string[];
  /** Internal URLs left out because the page limit was reached. */
  readonly crawlSkipped?: number;
  readonly homeUrl?: string;
  /** Certificate of the audited host, for https targets. */
  readonly tls?: TlsFacts;
  /** Certificate of the www or apex counterpart of the audited host; its error says when that host is unreachable. */
  readonly counterpartTls?: TlsFacts;
  /** The home page fetched with the user agent of each crawler that decides search and AI-answer visibility. */
  readonly agentProbes: readonly AgentProbe[];
  /** Data the site owner authorised: Search Console today, more sources later. */
  readonly owner?: OwnerData;
  /** Favicons, Open Graph images, logos and /llms.txt, fetched once each. */
  readonly resources: readonly ResourceFacts[];
  /**
   * The root and the audited URL fetched with different Accept-Language headers (label `accept-language:<value>`,
   * or `accept-language:none` without the header, as Googlebot sends it), to detect language-based redirects.
   */
  readonly localeProbes: readonly ProbeFacts[];
}
