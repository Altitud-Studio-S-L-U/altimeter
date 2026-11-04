import type { PageFacts } from '../core/facts.ts';
import type { HttpClient } from '../fetch/http.ts';
import { baseUrl } from '../parse/html.ts';
import { fetchPage } from './page.ts';

export interface CrawlOptions {
  /** URLs to start from, in order; the first four times `maxPages` that can be crawled are queued, since no more could be fetched. */
  readonly seeds: readonly string[];
  /** Pages already fetched (the audited page and the home page); they are not fetched again. */
  readonly known: ReadonlyMap<string, PageFacts>;
  readonly maxPages: number;
  readonly robotsAllows: (url: string) => Promise<boolean>;
  readonly concurrency?: number;
  /** Pause between two requests of one worker, to stay polite. */
  readonly delayMs?: number;
  /** Distinct query strings fetched per path, so faceted navigation cannot swallow the crawl. */
  readonly maxQueryVariants?: number;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export interface CrawlResult {
  readonly pages: ReadonlyMap<string, PageFacts>;
  /** Internal URLs found but not fetched because robots.txt disallows them for Googlebot. */
  readonly blockedByRobots: readonly string[];
  /** Internal URLs found but left out because the page limit was reached. */
  readonly skipped: number;
}

const nonHtml = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|mp3|wav|ogg|zip|gz|rar|7z|xml|txt|json|csv|xlsx?|docx?|pptx?|css|js|mjs|woff2?|ttf|otf|eot)$/iu;

/** Cloudflare answers this path itself on every site it proxies, for example with its email obfuscation page. */
const cloudflareReserved = /^\/cdn-cgi\//u;

function normalize(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function siteKey(url: string): string {
  return new URL(url).hostname.replace(/^www\./u, '');
}

/** Breadth-first crawl of HTML pages on the audited site, following <a href> links the parser found. */
export async function crawlSite(client: HttpClient, options: CrawlOptions): Promise<CrawlResult> {
  const site = siteKey(options.seeds[0] ?? [...options.known.keys()][0]!);
  const pages = new Map<string, PageFacts>();
  const queued = new Set<string>([...options.known.keys(), ...[...options.known.values()].map(page => page.fetch.finalUrl)].map(normalize));
  const queryVariants = new Map<string, number>();
  const blocked: string[] = [];
  const queue: string[] = [];
  let skipped = 0;
  const maxVariants = options.maxQueryVariants ?? 3;

  const enqueue = (candidate: string | undefined, base: string) => {
    if (!candidate) return;
    let url: string;
    try {
      url = normalize(new URL(candidate.trim(), base).href);
    } catch {
      return;
    }
    const parsed = new URL(url);
    if (!/^https?:$/u.test(parsed.protocol) || siteKey(url) !== site || nonHtml.test(parsed.pathname) || cloudflareReserved.test(parsed.pathname) || queued.has(url)) return;
    if (parsed.search !== '') {
      const count = queryVariants.get(parsed.pathname) ?? 0;
      if (count >= maxVariants) return;
      queryVariants.set(parsed.pathname, count + 1);
    }
    queued.add(url);
    queue.push(url);
  };

  // Sitemaps can list hundreds of thousands of URLs; queuing them all costs memory, and time when robots.txt blocks them.
  for (const seed of options.seeds) {
    if (queue.length >= 4 * options.maxPages) break;
    enqueue(seed, seed);
  }
  // Links resolve against the page's base element, as Googlebot and browsers resolve them.
  const enqueueLinks = (page: PageFacts) => {
    if (!page.raw) return;
    const base = baseUrl(page.raw.parsed, page.fetch.finalUrl);
    for (const anchor of page.raw.parsed.anchors) enqueue(anchor.attrs.href, base);
  };
  for (const page of options.known.values()) enqueueLinks(page);

  const budget = Math.max(0, options.maxPages - options.known.size);
  // Workers reserve a slot before fetching, so concurrent workers never exceed the page limit.
  let reserved = 0;
  const worker = async () => {
    while (queue.length > 0 && reserved < budget && !options.signal?.aborted) {
      const url = queue.shift()!;
      reserved += 1;
      if (!(await options.robotsAllows(url))) {
        reserved -= 1;
        blocked.push(url);
        continue;
      }
      const page = await fetchPage(client, url);
      pages.set(url, page);
      options.log?.(`Crawled ${pages.size + options.known.size}/${options.maxPages}`);
      if (page.fetch.status === 200) enqueueLinks(page);
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
  skipped = queue.length;
  return { pages, blockedByRobots: blocked, skipped };
}
