import type { CruxFormFactor, CruxOutcome } from '../data/crux.ts';
import type { FetchResult } from '../fetch/http.ts';
import type { RobotsAvailability } from '../fetch/robots.ts';
import type { SitemapDocument } from '../fetch/sitemap.ts';
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

export interface SiteFacts {
  readonly origin: string;
  readonly robots?: { readonly url: string; readonly fetch: FetchResult; readonly availability: RobotsAvailability };
  readonly sitemaps: readonly SitemapFacts[];
  /** Variant URLs of audited pages (no trailing slash, /index.html, upper case, tracking parameter, http, www). */
  readonly variants: readonly ProbeFacts[];
  readonly notFound?: ProbeFacts & { readonly parsed?: ParsedHtml };
  /** Pages fetched only to tell template text from page content. */
  readonly siblings: readonly PageFacts[];
  readonly pages: ReadonlyMap<string, PageFacts>;
  /** True when a crawl ran, so site-scope graph rules can be evaluated. */
  readonly crawled: boolean;
  readonly homeUrl?: string;
}
