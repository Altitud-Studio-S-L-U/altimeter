import type { lookup as dnsLookup } from 'node:dns';
import { performance } from 'node:perf_hooks';
import type { AgentProbe, PageFacts, ProbeFacts, RenderFacts, SiteFacts, SitemapFacts } from '../core/facts.ts';
import { browserAgent, googlebotSmartphone, probeAgents, type ProbeAgent } from '../data/agents.ts';
import { queryCrux, cruxEndpoint, type CruxFormFactor, type CruxOutcome } from '../data/crux.ts';
import { HttpClient, defaultUserAgent } from '../fetch/http.ts';
import { publicOnly, type NetworkPolicy } from '../fetch/ip-guard.ts';
import { isAllowed, robotsAvailability, type RobotsAvailability } from '../fetch/robots.ts';
import { parseSitemap } from '../fetch/sitemap.ts';
import { inspectTls } from '../fetch/tls.ts';
import { findChrome, launchAuditBrowser, renderPage, type AuditBrowser, type RenderMode } from '../render/chrome.ts';
import { runLighthouse } from '../render/lighthouse.ts';
import { documentFacts, fetchPage, isHtmlResponse, decodeHtml } from './page.ts';
import { notFoundProbeUrl, urlVariants } from './probes.ts';

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
  readonly cruxEndpoint?: string;
}

export interface CollectResult {
  readonly site: SiteFacts;
  readonly versions: { readonly chrome?: string; readonly lighthouse?: string };
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

const maxDeclaredSitemaps = 5;
const maxChildSitemaps = 10;

async function fetchRobots(client: HttpClient, origin: string) {
  const url = new URL('/robots.txt', origin).href;
  const fetch = await client.fetch(url, { maxRedirects: 5, maxBytes: 1024 * 1024 });
  const availability = robotsAvailability(fetch.error ? undefined : fetch.status, fetch.body, fetch.error?.code === 'too-many-redirects');
  return { url, fetch, availability };
}

async function collectSitemaps(client: HttpClient, origin: string, declared: string[]): Promise<SitemapFacts[]> {
  const results: SitemapFacts[] = [];
  const queue: Array<{ url: string; source: SitemapFacts['source'] }> = declared.length > 0
    ? declared.slice(0, maxDeclaredSitemaps).map(url => ({ url, source: 'robots' as const }))
    : [{ url: new URL('/sitemap.xml', origin).href, source: 'default' as const }];
  const seen = new Set<string>();
  let children = 0;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    const fetch = await client.fetch(next.url, { maxBytes: 50 * 1024 * 1024 + 1, timeoutMs: 30_000 });
    const document = fetch.status === 200 && !fetch.error ? parseSitemap(fetch.body) : undefined;
    results.push({ url: next.url, source: next.source, fetch, ...(document ? { document } : {}) });
    for (const child of document?.sitemaps ?? []) {
      if (children >= maxChildSitemaps) break;
      children += 1;
      queue.push({ url: child.loc, source: 'index' });
    }
  }
  return results;
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
    if (/\.(pdf|jpe?g|png|gif|webp|avif|svg|zip|xml|txt|json)$/iu.test(url.pathname)) continue;
    exclude.add(url.href);
    picks.push(url.href);
    if (picks.length === 2) break;
  }
  return picks;
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
  const client = new HttpClient({ policy: options.policy ?? publicOnly, userAgent, ...(options.lookup ? { lookup: options.lookup } : {}) });
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
    }

    const declared = robots.availability.kind === 'parsed' ? robots.availability.file.sitemaps.map(line => line.value) : [];
    for (const link of [...pages.values()].flatMap(entry => entry.raw?.parsed.links ?? [])) {
      if (link.rel.includes('sitemap') && link.attrs.href) declared.push(new URL(link.attrs.href, target).href);
    }
    log('Reading sitemaps');
    const sitemaps = await collectSitemaps(client, target.origin, [...new Set(declared)]);

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
    const tls = target.protocol === 'https:' ? await inspectTls(target.hostname, { policy: options.policy ?? publicOnly, ...(target.port ? { port: Number(target.port) } : {}), ...(options.lookup ? { lookup: options.lookup } : {}) }) : undefined;
    const siblingUrls = pickSiblings(page, new Set([page.url, page.fetch.finalUrl, homeUrl, homeFinal]));
    const siblings = await Promise.all(siblingUrls.map(url => fetchPage(client, url)));

    const versions: { chrome?: string; lighthouse?: string } = {};
    const chromePath = options.chromePath ?? findChrome();
    const wantRender = options.render ?? chromePath !== undefined;
    if (wantRender && !chromePath) warnings.push('Chrome was not found, so rendered checks were not evaluated.');
    if (wantRender && chromePath) {
      browser = await launchAuditBrowser({ policy: options.policy ?? publicOnly, executablePath: chromePath, ...(options.lookup ? { lookup: options.lookup } : {}) });
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
      for (const [key, entry] of pages) {
        if (!entry.raw) continue;
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
      for (const form of forms) {
        byUrl[form] = await queryCrux(client, options.cruxKey, { url: page.fetch.finalUrl }, form, endpoint);
        byOrigin[form] = await queryCrux(client, options.cruxKey, { origin: target.origin }, form, endpoint);
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
      pages,
      crawled: false,
      homeUrl: homeFinal,
      agentProbes,
      ...(tls ? { tls } : {}),
    };
    return { site, versions, warnings, durationMs: performance.now() - started };
  } finally {
    await browser?.close();
    await client.close();
  }
}
