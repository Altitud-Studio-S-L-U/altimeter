import { collectSitemaps } from '../../collect/sitemaps.ts';
import type { SiteFacts } from '../../core/facts.ts';
import { headerValue, type HttpClient } from '../../fetch/http.ts';
import { parseRobots, robotsAvailability, type RobotsFile } from '../../fetch/robots.ts';

/** What crawler activity is compared with: the site's robots.txt and sitemap URLs. */
export interface BotSiteInput {
  readonly origin: string;
  /** The robots.txt rules; an empty file when robots.txt does not exist, so everything is allowed. */
  readonly robots?: { readonly url: string; readonly file: RobotsFile; readonly lastModified?: string };
  readonly sitemapUrls: readonly string[];
}

const bareHost = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./u, '');

/** The origin a redirect led to when it is the www or apex variant of `origin` (or the same host on another scheme). */
function movedWithinSite(finalUrl: string, origin: string): string | undefined {
  const moved = new URL(finalUrl).origin;
  return moved !== origin && bareHost(moved) === bareHost(origin) ? moved : undefined;
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
  // Logs record the host that serves the site: the variant robots.txt or the home page redirects to, as for the bots command.
  // Logs name hosts, not schemes, so a move to https alone gives way to the other redirect's change of host.
  const moves = [robots && !robots.fetch.error ? robots.fetch.finalUrl : undefined, site.homeUrl]
    .map(url => (url === undefined ? undefined : movedWithinSite(url, site.origin)))
    .filter((moved): moved is string => moved !== undefined);
  const host = new URL(site.origin).hostname;
  const origin = moves.find(moved => new URL(moved).hostname !== host) ?? moves[0] ?? site.origin;
  return { origin, ...(robotsInput ? { robots: robotsInput } : {}), sitemapUrls };
}

/**
 * Fetches robots.txt and the sitemaps it declares (or /sitemap.xml), for the bots command, which runs without an
 * audit. The result has the shape of an audit's site facts, with no page collected, and the warnings an audit gives
 * when the caps on sitemaps leave some unread. When robots.txt redirects to the www or apex variant of the host, that
 * variant is the site, since it serves the rules and the sitemap URLs.
 */
export async function fetchSiteFacts(client: HttpClient, requested: string): Promise<{ readonly site: SiteFacts; readonly warnings: readonly string[] }> {
  const robotsFetch = await client.fetch(new URL('/robots.txt', requested).href, { maxRedirects: 5, maxBytes: 1024 * 1024 });
  const origin = (robotsFetch.error ? undefined : movedWithinSite(robotsFetch.finalUrl, requested)) ?? requested;
  const robotsUrl = new URL('/robots.txt', origin).href;
  // As in an audit: Google stops after five redirects and reads the file as missing, which a redirect loop always comes to.
  const redirectLimit = robotsFetch.error?.code === 'too-many-redirects' || robotsFetch.error?.code === 'redirect-loop';
  const availability = robotsAvailability(robotsFetch.error ? undefined : robotsFetch.status, robotsFetch.body, redirectLimit);
  const declared = availability.kind === 'parsed' ? availability.file.sitemaps.map(line => line.value).filter(value => /^https?:\/\//iu.test(value)) : [];
  const { sitemaps, warnings } = await collectSitemaps(client, origin, [...new Set(declared)]);
  const site: SiteFacts = {
    origin, robots: { url: robotsUrl, fetch: robotsFetch, availability }, sitemaps, variants: [], siblings: [], pages: new Map(), crawled: false,
    agentProbes: [], resources: [], localeProbes: [],
  };
  return { site, warnings };
}
