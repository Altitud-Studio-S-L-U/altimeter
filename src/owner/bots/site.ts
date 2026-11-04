import type { SiteFacts, SitemapFacts } from '../../core/facts.ts';
import { headerValue, type HttpClient } from '../../fetch/http.ts';
import { parseRobots, robotsAvailability, type RobotsFile } from '../../fetch/robots.ts';
import { parseSitemap } from '../../fetch/sitemap.ts';

/** What crawler activity is compared with: the site's robots.txt and sitemap URLs. */
export interface BotSiteInput {
  readonly origin: string;
  /** The robots.txt rules; an empty file when robots.txt does not exist, so everything is allowed. */
  readonly robots?: { readonly url: string; readonly file: RobotsFile; readonly lastModified?: string };
  readonly sitemapUrls: readonly string[];
}

/** The comparison input from collected site facts, as an audit has them. */
export function botSiteInput(site: SiteFacts): BotSiteInput {
  const robots = site.robots;
  let robotsInput: BotSiteInput['robots'];
  if (robots && robots.availability.kind !== 'unreachable') {
    const file = robots.availability.kind === 'parsed' ? robots.availability.file : parseRobots('');
    const lastModified = headerValue(robots.fetch.headers, 'last-modified');
    robotsInput = { url: robots.url, file, ...(lastModified ? { lastModified } : {}) };
  }
  const sitemapUrls = [...new Set(site.sitemaps.flatMap(entry => entry.document?.kind === 'urlset' ? entry.document.urls.map(url => url.loc) : []))];
  return { origin: site.origin, ...(robotsInput ? { robots: robotsInput } : {}), sitemapUrls };
}

/** Sitemaps read per run, as the audit's collector reads them. */
const maxDeclaredSitemaps = 5;
const maxChildSitemaps = 10;

/**
 * Fetches robots.txt and the sitemaps it declares (or /sitemap.xml), for the bots command, which runs without an
 * audit. The result has the shape of an audit's site facts, with no page collected.
 */
export async function fetchSiteFacts(client: HttpClient, origin: string): Promise<SiteFacts> {
  const robotsUrl = new URL('/robots.txt', origin).href;
  const robotsFetch = await client.fetch(robotsUrl, { maxRedirects: 5, maxBytes: 1024 * 1024 });
  const availability = robotsAvailability(robotsFetch.error ? undefined : robotsFetch.status, robotsFetch.body, robotsFetch.error?.code === 'too-many-redirects');
  const declared = availability.kind === 'parsed' ? availability.file.sitemaps.map(line => line.value).filter(value => /^https?:\/\//iu.test(value)) : [];
  const queue: Array<{ url: string; source: SitemapFacts['source'] }> = declared.length > 0
    ? declared.slice(0, maxDeclaredSitemaps).map(url => ({ url, source: 'robots' as const }))
    : [{ url: new URL('/sitemap.xml', origin).href, source: 'default' as const }];
  const sitemaps: SitemapFacts[] = [];
  const seen = new Set<string>();
  let children = 0;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    const fetch = await client.fetch(next.url, { maxBytes: 50 * 1024 * 1024 + 1, timeoutMs: 30_000 });
    const document = fetch.status === 200 && !fetch.error ? parseSitemap(fetch.body) : undefined;
    sitemaps.push({ url: next.url, source: next.source, fetch, ...(document ? { document } : {}) });
    for (const child of document?.sitemaps ?? []) {
      if (children >= maxChildSitemaps) break;
      children += 1;
      queue.push({ url: child.loc, source: 'index' });
    }
  }
  return {
    origin, robots: { url: robotsUrl, fetch: robotsFetch, availability }, sitemaps, variants: [], siblings: [], pages: new Map(), crawled: false,
    agentProbes: [], resources: [], localeProbes: [],
  };
}
