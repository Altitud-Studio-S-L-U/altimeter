import { fetchPage } from '../collect/page.ts';
import type { PageFacts, SiteFacts } from '../core/facts.ts';
import type { HttpClient } from '../fetch/http.ts';
import { cleanLine } from '../report/sanitize.ts';
import { siteNames } from '../rules/content/common.ts';
import type { SiteNotice, SitePage, SiteProfile } from './types.ts';
import { domainOf, parseUrl, urlKey } from './urls.ts';

/** Internal pages read besides the home page. A tool convention: enough for a few topics, light on the site. */
export const extraPages = 3;

const maxBrandNames = 5;

/** Organization types whose name is the brand; LocalBusiness subtypes declare it the same way. */
const organizationTypes = new Set(['Organization', 'Corporation', 'LocalBusiness', 'OnlineBusiness', 'OnlineStore', 'ProfessionalService', 'NGO']);

const fileLike = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|gz|docx?|xlsx?|pptx?|mp[34]|webm|xml|txt|json|css|js)$/iu;

function siteOf(origin: string, pages: readonly PageFacts[]): SiteFacts {
  return { origin, sitemaps: [], variants: [], siblings: [], pages: new Map(pages.map(page => [page.url, page])), crawled: false, agentProbes: [], resources: [], localeProbes: [] };
}

function organizationNames(page: PageFacts): string[] {
  const nodes = page.raw?.data.nodes ?? [];
  return nodes.filter(node => node.types.some(type => organizationTypes.has(type))).flatMap(node => {
    const name = node.properties.name;
    return typeof name === 'string' ? [name] : Array.isArray(name) ? name.filter((entry): entry is string => typeof entry === 'string') : [];
  });
}

/** Links on the home page to other pages of the same registrable domain, in document order. */
function internalLinks(home: PageFacts, domain: string): string[] {
  const base = home.fetch.finalUrl;
  const seen = new Set([urlKey(base)]);
  const links: string[] = [];
  for (const anchor of home.raw?.parsed.anchors ?? []) {
    const href = anchor.attrs.href;
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    resolved.hash = '';
    const url = parseUrl(resolved.href);
    if (!url || domainOf(url.href) !== domain || fileLike.test(url.pathname)) continue;
    const key = urlKey(url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(url.href);
  }
  return links;
}

function describe(page: PageFacts): SitePage {
  const parsed = page.raw?.parsed;
  const title = parsed?.titles[0]?.text;
  const h1 = parsed?.headings.find(heading => heading.level === 1)?.text;
  return {
    url: page.fetch.finalUrl,
    ...(page.fetch.status === undefined ? {} : { status: page.fetch.status }),
    pageType: page.pageType,
    ...(title && cleanLine(title, 200) !== '' ? { title: cleanLine(title, 200) } : {}),
    ...(h1 && cleanLine(h1, 200) !== '' ? { h1: cleanLine(h1, 200) } : {}),
  };
}

const readable = (page: PageFacts) => page.fetch.error === undefined && page.fetch.status !== undefined && page.fetch.status >= 200 && page.fetch.status < 300 && page.raw !== undefined;

/**
 * Reads the home page and a few pages it links to, for the names the site declares and for topics to infer
 * queries from. Requests go through the guarded client, so private addresses stay blocked unless its policy
 * allows them. Nothing read here is sent anywhere except as a query the plan shows first.
 */
export async function readSite(origin: string, client: HttpClient, options: { readonly extraPages?: number } = {}): Promise<SiteProfile> {
  const host = new URL(origin).hostname.replace(/^www\./u, '');
  const domain = domainOf(origin) ?? host;
  const notices: SiteNotice[] = [];
  const home = await fetchPage(client, `${origin}/`, { isHome: true });
  if (!readable(home)) {
    const reason = home.fetch.error ? home.fetch.error.code : home.fetch.status === undefined ? 'no response' : `HTTP ${home.fetch.status}`;
    notices.push({ code: 'home-unreadable', reason });
    return { origin, host, domain, brandNames: [], pages: [describe(home)], notices };
  }
  if (domainOf(home.fetch.finalUrl) !== domain) notices.push({ code: 'home-redirects', to: cleanLine(home.fetch.finalUrl, 200) });
  const pages: PageFacts[] = [home];
  for (const url of internalLinks(home, domain).slice(0, options.extraPages ?? extraPages)) {
    const page = await fetchPage(client, url);
    if (readable(page) && domainOf(page.fetch.finalUrl) === domain) pages.push(page);
  }
  const names = [...siteNames(siteOf(origin, pages)), ...pages.flatMap(organizationNames)]
    .map(name => cleanLine(name, 100))
    .filter(name => name.length >= 2);
  const brandNames = [...new Map(names.map(name => [name.toLowerCase(), name])).values()].slice(0, maxBrandNames);
  const language = /^([a-z]{2,3})(?:-|$)/iu.exec(home.raw?.parsed.htmlLang ?? '')?.[1]?.toLowerCase();
  return { origin, host, domain, brandNames, ...(language ? { language } : {}), pages: pages.map(describe), notices };
}
