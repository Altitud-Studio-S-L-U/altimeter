import type { lookup as dnsLookup } from 'node:dns';
import { performance } from 'node:perf_hooks';
import type { AgentProbe, PageFacts, ProbeFacts, RenderFacts, ResourceFacts, ResourcePurpose, SiteFacts } from '../core/facts.ts';
import { browserAgent, googlebotSmartphone, probeAgents, type ProbeAgent } from '../data/agents.ts';
import { queryCrux, cruxEndpoint, type CruxFormFactor, type CruxOutcome } from '../data/crux.ts';
import { HttpClient, defaultUserAgent } from '../fetch/http.ts';
import { publicOnly, type NetworkPolicy } from '../fetch/ip-guard.ts';
import { isAllowed, robotsAvailability, type RobotsAvailability } from '../fetch/robots.ts';
import { inspectTls, trustedRoots } from '../fetch/tls.ts';
import { findChrome, launchAuditBrowser, renderPage, type AuditBrowser, type RenderMode } from '../render/chrome.ts';
import { runLighthouse } from '../render/lighthouse.ts';
import { crawlSite } from './crawl.ts';
import { collectSitemaps, linkedSitemaps } from './sitemaps.ts';
import { documentFacts, fetchPage, isHtmlResponse, decodeHtml, servedUrl } from './page.ts';
import { hostCounterpart, notFoundProbeUrl, urlVariants } from './probes.ts';

/** Googlebot's product tokens, most specific first, for robots.txt decisions on subresources. */
const googlebotTokens = ['googlebot'];

export interface CollectOptions {
  readonly url: string;
  readonly policy?: NetworkPolicy;
  readonly userAgent?: string;
  /** Render pages in Chrome (default: when Chrome is installed). */
  readonly render?: boolean;
  readonly lighthouse?: boolean;
  readonly labRuns?: number;
  readonly cruxKey?: string;
  readonly chromePath?: string;
  readonly log?: (message: string) => void;
  readonly lookup?: typeof dnsLookup;
  /** Extra CA certificates (PEM) trusted besides the default roots, such as the private CA of a staging site. */
  readonly ca?: string;
  readonly cruxEndpoint?: string;
  /** Crawl the site from the audited page, its home page and the sitemaps. */
  readonly crawl?: boolean;
  /** Total pages to audit when crawling, including the audited page and the home page (default 100). */
  readonly maxPages?: number;
  /** Pause between requests of one crawl worker in milliseconds (default 500, which with two workers keeps about 2 requests per second). */
  readonly crawlDelayMs?: number;
}

export interface CollectResult {
  readonly site: SiteFacts;
  readonly versions: { readonly chrome?: string; readonly lighthouse?: string };
  readonly warnings: readonly string[];
  readonly durationMs: number;
}


async function fetchRobots(client: HttpClient, origin: string) {
  const url = new URL('/robots.txt', origin).href;
  const fetch = await client.fetch(url, { maxRedirects: 5, maxBytes: 1024 * 1024 });
  // Google stops after five redirects and reads the file as missing, which a redirect loop always comes to.
  const redirectLimit = fetch.error?.code === 'too-many-redirects' || fetch.error?.code === 'redirect-loop';
  const availability = robotsAvailability(fetch.error ? undefined : fetch.status, fetch.body, redirectLimit);
  return { url, fetch, availability };
}

async function probe(client: HttpClient, label: string, url: string): Promise<ProbeFacts> {
  return { label, url, fetch: await client.fetch(url, { maxBytes: 1024 * 1024 }) };
}

function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./u, '') === new URL(b).hostname.replace(/^www\./u, '');
  } catch {
    return false;
  }
}

/** How many hreflang alternates of the audited page are fetched when no crawl runs. */
const maxAlternates = 10;

/** The hreflang alternates the page declares in its HTML, resolved against its base URL. */
function hreflangTargets(page: PageFacts): string[] {
  const parsed = page.raw?.parsed;
  if (!parsed) return [];
  let base = page.fetch.finalUrl;
  try {
    if (parsed.bases[0]?.attrs.href) base = new URL(parsed.bases[0].attrs.href, page.fetch.finalUrl).href;
  } catch {}
  const targets: string[] = [];
  for (const link of parsed.links) {
    if (!link.rel.includes('alternate') || link.attrs.hreflang === undefined || !link.attrs.href) continue;
    try {
      const url = new URL(link.attrs.href, base);
      url.hash = '';
      if (/^https?:$/u.test(url.protocol) && !targets.includes(url.href)) targets.push(url.href);
    } catch {}
  }
  return targets;
}

function pickSiblings(page: PageFacts, exclude: Set<string>): string[] {
  const picks: string[] = [];
  for (const anchor of page.raw?.parsed.anchors ?? []) {
    const href = anchor.attrs.href;
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, page.fetch.finalUrl);
    } catch {
      continue;
    }
    url.hash = '';
    if (!/^https?:$/u.test(url.protocol) || !sameSite(url.href, page.fetch.finalUrl) || exclude.has(url.href)) continue;
    // Cloudflare answers /cdn-cgi/ itself, so a page there, such as its email protection page, is not the site's template.
    if (/\.(pdf|jpe?g|png|gif|webp|avif|svg|zip|xml|txt|json)$/iu.test(url.pathname) || url.pathname.startsWith('/cdn-cgi/')) continue;
    exclude.add(url.href);
    picks.push(url.href);
    if (picks.length === 2) break;
  }
  return picks;
}

const maxResourcesPerPurpose = 4;

/** Fetches favicons, Open Graph images and Organization logos the pages reference, plus /llms.txt. */
async function collectResources(client: HttpClient, origin: string, pages: readonly PageFacts[]): Promise<ResourceFacts[]> {
  const wanted = new Map<string, { purpose: ResourcePurpose; referencedBy?: string }>();
  const want = (href: string | undefined, base: string, purpose: ResourcePurpose, referencedBy: string) => {
    if (!href) return;
    let url: string;
    try { url = new URL(href.trim(), base).href; } catch { return; }
    if (!/^https?:/u.test(url) || wanted.has(url)) return;
    if ([...wanted.values()].filter(entry => entry.purpose === purpose).length >= maxResourcesPerPurpose) return;
    wanted.set(url, { purpose, referencedBy });
  };
  for (const entry of pages) {
    const doc = entry.raw;
    if (!doc) continue;
    const base = entry.fetch.finalUrl;
    for (const link of doc.parsed.links) {
      if (link.rel.includes('icon')) want(link.attrs.href, base, 'favicon', base);
      if (link.rel.includes('apple-touch-icon')) want(link.attrs.href, base, 'apple-touch-icon', base);
    }
    for (const meta of doc.parsed.metas) {
      if ((meta.attrs.property ?? '').toLowerCase() === 'og:image') want(meta.attrs.content, base, 'og-image', base);
    }
    for (const node of doc.data.nodes.filter(item => item.types.some(type => type === 'Organization' || type.endsWith('Business')))) {
      const logo = node.properties.logo;
      const value = typeof logo === 'string' ? logo : logo && typeof logo === 'object' && !Array.isArray(logo) ? (logo as Record<string, unknown>).url ?? (logo as Record<string, unknown>).contentUrl : undefined;
      if (typeof value === 'string') want(value, base, 'logo', base);
    }
  }
  if (![...wanted.values()].some(entry => entry.purpose === 'favicon')) want('/favicon.ico', origin, 'favicon', new URL('/', origin).href);
  const results: ResourceFacts[] = [];
  for (const [url, info] of wanted) results.push({ label: info.purpose, url, purpose: info.purpose, ...(info.referencedBy ? { referencedBy: info.referencedBy } : {}), fetch: await client.fetch(url, { maxBytes: 8 * 1024 * 1024 }) });
  const llms = new URL('/llms.txt', origin).href;
  results.push({ label: 'llms-txt', url: llms, purpose: 'llms-txt', fetch: await client.fetch(llms, { maxBytes: 1024 * 1024 }) });
  return results;
}

/** Collects the facts an audit of one URL needs: the page, its home page and the site context around them. */
export async function collect(options: CollectOptions): Promise<CollectResult> {
  const started = performance.now();
  const warnings: string[] = [];
  const log = options.log ?? (() => {});
  const target = new URL(options.url);
  target.hash = '';
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only http and https URLs can be audited.');
  const userAgent = options.userAgent ?? defaultUserAgent;
  const ca = options.ca === undefined ? undefined : trustedRoots(options.ca);
  const client = new HttpClient({ policy: options.policy ?? publicOnly, userAgent, ...(options.lookup ? { lookup: options.lookup } : {}), ...(ca ? { ca } : {}) });
  const robotsCache = new Map<string, Promise<RobotsAvailability>>();
  const robotsFor = (origin: string) => {
    let cached = robotsCache.get(origin);
    if (!cached) {
      cached = fetchRobots(client, origin).then(result => result.availability);
      robotsCache.set(origin, cached);
    }
    return cached;
  };
  let browser: AuditBrowser | undefined;
  try {
    log(`Fetching ${target.href}`);
    const robots = await fetchRobots(client, target.origin);
    robotsCache.set(target.origin, Promise.resolve(robots.availability));
    const page = await fetchPage(client, target.href, { isHome: target.pathname === '/' });
    const pages = new Map<string, PageFacts>([[page.url, page]]);
    const homeUrl = new URL('/', target.origin).href;
    let homeFinal = page.fetch.finalUrl;
    if (target.pathname !== '/') {
      const home = await fetchPage(client, homeUrl, { isHome: true });
      homeFinal = home.fetch.finalUrl;
      if (home.fetch.finalUrl !== page.fetch.finalUrl) pages.set(home.url, home);
      // The root lands on the audited page, so it is the home page whatever its path and languages say.
      else pages.set(page.url, { ...page, pageType: home.pageType, pageTypeReason: home.pageTypeReason });
    }

    const declared = robots.availability.kind === 'parsed' ? robots.availability.file.sitemaps.map(line => line.value) : [];
    for (const entry of pages.values()) declared.push(...linkedSitemaps(entry));
    log('Reading sitemaps');
    const { sitemaps, warnings: sitemapWarnings } = await collectSitemaps(client, target.origin, [...new Set(declared)]);
    warnings.push(...sitemapWarnings);

    log('Probing URL variants and an unknown path');
    const variants = await Promise.all(urlVariants(page.fetch.finalUrl).map(variant => probe(client, variant.label, variant.url)));
    const missing = await probe(client, 'not-found', notFoundProbeUrl(target.origin));
    const notFound = missing.fetch.error === undefined && isHtmlResponse(missing.fetch.headers, missing.fetch.body)
      ? { ...missing, parsed: documentFacts(decodeHtml(missing.fetch.headers, missing.fetch.body)).parsed }
      : missing;
    log('Probing crawler user agents');
    const fetchAs = async (agent: ProbeAgent, url: string): Promise<AgentProbe> => ({ agent, url, fetch: await client.fetch(url, { headers: { 'user-agent': agent.userAgent }, maxBytes: 4 * 1024 * 1024 }) });
    const agentProbes = await Promise.all(probeAgents.map(agent => fetchAs(agent, homeUrl)));
    const uaProbes = page.raw ? await Promise.all([googlebotSmartphone, browserAgent].map(agent => fetchAs(agent, page.fetch.finalUrl))) : [];
    if (uaProbes.length > 0) pages.set(page.url, { ...pages.get(page.url)!, uaProbes });
    const tlsOptions = { policy: options.policy ?? publicOnly, ...(target.port ? { port: Number(target.port) } : {}), ...(options.lookup ? { lookup: options.lookup } : {}), ...(ca ? { ca } : {}) };
    const counterpart = hostCounterpart(target.hostname);
    const [tls, counterpartTls] = target.protocol === 'https:'
      ? await Promise.all([inspectTls(target.hostname, tlsOptions), counterpart ? inspectTls(counterpart, tlsOptions) : undefined])
      : [undefined, undefined];
    log('Fetching referenced resources and language probes');
    const resources = await collectResources(client, target.origin, [...pages.values()]);
    const localeProbes: ProbeFacts[] = [];
    for (const url of [...new Set([homeUrl, page.fetch.finalUrl])]) {
      for (const language of ['none', 'en', 'es', 'ca', 'fr', 'de']) {
        const fetch = await client.fetch(url, { maxBytes: 256 * 1024, ...(language === 'none' ? {} : { headers: { 'accept-language': language } }) });
        localeProbes.push({ label: `accept-language:${language}`, url, fetch });
      }
    }
    const siblingUrls = pickSiblings(page, new Set([page.url, page.fetch.finalUrl, homeUrl, homeFinal]));
    const siblings = await Promise.all(siblingUrls.map(url => fetchPage(client, url)));
    const fetched = new Set([...pages.values(), ...siblings].flatMap(entry => [entry.url, entry.fetch.finalUrl]));
    const alternateUrls = hreflangTargets(page).filter(url => !fetched.has(url)).slice(0, maxAlternates);
    if (alternateUrls.length > 0) log('Fetching the hreflang alternates of the page');
    const alternates: PageFacts[] = [];
    for (const url of alternateUrls) alternates.push(await fetchPage(client, url));

    let crawlBlocked: string[] = [];
    let crawlSkipped = 0;
    if (options.crawl) {
      const sitemapUrls = sitemaps.flatMap(entry => entry.document?.urls.map(url => url.loc) ?? []);
      const allows = async (url: string) => {
        const parsed = new URL(url);
        const availability = await robotsFor(parsed.origin);
        if (availability.kind === 'unrestricted') return true;
        if (availability.kind === 'unreachable') return false;
        return isAllowed(availability.file, googlebotTokens, `${parsed.pathname}${parsed.search}`).allowed;
      };
      log('Crawling the site');
      const crawled = await crawlSite(client, { seeds: [page.fetch.finalUrl, homeFinal, ...sitemapUrls], known: pages, maxPages: options.maxPages ?? 100,
        robotsAllows: allows, concurrency: 2, delayMs: options.crawlDelayMs ?? 500, log });
      for (const [url, entry] of crawled.pages) pages.set(url, entry);
      crawlBlocked = [...crawled.blockedByRobots];
      crawlSkipped = crawled.skipped;
    }

    const versions: { chrome?: string; lighthouse?: string } = {};
    const chromePath = options.chromePath ?? findChrome();
    const wantRender = options.render ?? chromePath !== undefined;
    if (wantRender && !chromePath) warnings.push('Chrome was not found, so rendered checks were not evaluated.');
    if (wantRender && chromePath) {
      browser = await launchAuditBrowser({ policy: options.policy ?? publicOnly, executablePath: chromePath, ...(options.lookup ? { lookup: options.lookup } : {}),
        ...(options.ca === undefined ? {} : { ca: options.ca }) });
      versions.chrome = browser.version;
      const robotsAllows = async (url: string) => {
        const parsed = new URL(url);
        const availability = await robotsFor(parsed.origin);
        if (availability.kind === 'unrestricted') return true;
        if (availability.kind === 'unreachable') return false;
        return isAllowed(availability.file, googlebotTokens, `${parsed.pathname}${parsed.search}`).allowed;
      };
      const renderAs = async (url: string, mode: RenderMode): Promise<RenderFacts> => {
        const result = await renderPage(browser!, url, { mode, userAgent, robotsAllows });
        return { result, ...documentFacts(result.html) };
      };
      const keyPages = new Set([page.url, homeUrl]);
      for (const [key, entry] of pages) {
        if (!entry.raw || !keyPages.has(key)) continue;
        log(`Rendering ${entry.fetch.finalUrl}`);
        const rendered = await renderAs(entry.fetch.finalUrl, 'googlebot');
        const userRender = await renderAs(entry.fetch.finalUrl, 'user');
        const unblockedRender = rendered.result.blockedByRobots.length > 0 ? await renderAs(entry.fetch.finalUrl, 'unblocked') : undefined;
        pages.set(key, { ...entry, rendered, userRender, ...(unblockedRender ? { unblockedRender } : {}) });
      }
      if (options.lighthouse !== false && page.raw) {
        log('Running Lighthouse');
        const outcome = await runLighthouse(browser, page.fetch.finalUrl, { runs: options.labRuns ?? 3 });
        if (outcome.ok) versions.lighthouse = outcome.summary.lighthouseVersion;
        else warnings.push(`Lighthouse did not complete: ${outcome.error}`);
        pages.set(page.url, { ...pages.get(page.url)!, lighthouse: outcome });
      }
    }

    if (options.cruxKey) {
      log('Querying Chrome UX Report field data');
      const forms: CruxFormFactor[] = ['PHONE', 'DESKTOP'];
      const endpoint = options.cruxEndpoint ?? cruxEndpoint;
      const byUrl: Partial<Record<CruxFormFactor, CruxOutcome>> = {};
      const byOrigin: Partial<Record<CruxFormFactor, CruxOutcome>> = {};
      const served = servedUrl(page, target.href);
      for (const form of forms) {
        byUrl[form] = await queryCrux(client, options.cruxKey, { url: served }, form, endpoint);
        byOrigin[form] = await queryCrux(client, options.cruxKey, { origin: new URL(served).origin }, form, endpoint);
      }
      pages.set(page.url, { ...pages.get(page.url)!, crux: { url: byUrl, origin: byOrigin } });
    }

    const site: SiteFacts = {
      origin: target.origin,
      robots,
      sitemaps,
      variants,
      notFound,
      siblings,
      ...(alternates.length > 0 ? { alternates } : {}),
      pages,
      crawled: options.crawl === true,
      ...(options.crawl ? { crawlBlocked, crawlSkipped } : {}),
      homeUrl: homeFinal,
      agentProbes,
      resources,
      localeProbes,
      ...(tls ? { tls } : {}),
      ...(counterpartTls ? { counterpartTls } : {}),
    };
    return { site, versions, warnings, durationMs: performance.now() - started };
  } finally {
    await browser?.close();
    await client.close();
  }
}
