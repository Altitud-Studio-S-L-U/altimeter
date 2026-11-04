/**
 * Builders for rule micro-fixtures: describe a page or a site in a few lines and evaluate one rule against it.
 * Every rule ships at least a passing fixture, a failing fixture and a fixture where it cannot be evaluated.
 */
import { rule as catalogRule } from '../../src/catalog/index.ts';
import { classifyPage } from '../../src/analyze/page-type.ts';
import { documentFacts } from '../../src/collect/page.ts';
import { EvidenceStore } from '../../src/core/evidence.ts';
import type { PageFacts, ProbeFacts, RenderFacts, SiteFacts, SitemapFacts } from '../../src/core/facts.ts';
import type { PageType } from '../../src/core/types.ts';
import type { FetchResult, HeaderMap, Hop } from '../../src/fetch/http.ts';
import { robotsAvailability } from '../../src/fetch/robots.ts';
import { parseSitemap } from '../../src/fetch/sitemap.ts';
import type { RenderResult, TextBlock } from '../../src/render/chrome.ts';
import type { LighthouseOutcome } from '../../src/render/lighthouse.ts';
import { runRules, type Finding, type RuleImplementation } from '../../src/rules/engine.ts';

export function headers(values: Readonly<Record<string, string | readonly string[]>>): HeaderMap {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name.toLowerCase(), typeof value === 'string' ? [value] : [...value]]));
}

export interface ResponseSpec {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string | Buffer;
  /** Redirect hops before the final response, as [status, location] pairs. */
  readonly redirects?: ReadonlyArray<readonly [number, string]>;
  readonly ttfbMs?: number;
}

export function response(url: string, spec: ResponseSpec = {}): FetchResult {
  const hops: Hop[] = [];
  let current = url;
  for (const [status, location] of spec.redirects ?? []) {
    const target = new URL(location, current).href;
    hops.push({ url: current, status, headers: headers({ location }), location: target, ttfbMs: spec.ttfbMs ?? 50 });
    current = target;
  }
  const finalHeaders = headers({ 'content-type': 'text/html; charset=utf-8', ...spec.headers });
  const status = spec.status ?? 200;
  hops.push({ url: current, status, headers: finalHeaders, ttfbMs: spec.ttfbMs ?? 50 });
  const body = typeof spec.body === 'string' ? Buffer.from(spec.body, 'utf8') : spec.body ?? Buffer.alloc(0);
  return { requestedUrl: url, finalUrl: current, hops, status, headers: finalHeaders, body, transferBytes: body.length, truncated: false, durationMs: 100 };
}

export interface RenderSpec {
  readonly html: string;
  readonly textBlocks?: readonly TextBlock[];
  readonly blockedByRobots?: readonly string[];
  readonly layoutShifts?: RenderResult['layoutShifts'];
  readonly console?: RenderResult['console'];
  readonly failed?: RenderResult['failed'];
  readonly lcp?: RenderResult['lcp'];
  readonly scrollWidth?: number;
  readonly innerWidth?: number;
  readonly error?: RenderResult['error'];
  readonly mode?: RenderResult['mode'];
}

export function render(url: string, spec: RenderSpec): RenderFacts {
  const result: RenderResult = {
    mode: spec.mode ?? 'googlebot',
    url,
    finalUrl: url,
    status: 200,
    html: spec.html,
    viewport: { width: 412, height: 823 },
    documentHeight: 823,
    scrollWidth: spec.scrollWidth ?? 412,
    innerWidth: spec.innerWidth ?? 412,
    console: spec.console ?? [],
    failed: spec.failed ?? [],
    blockedByRobots: spec.blockedByRobots ?? [],
    layoutShifts: spec.layoutShifts ?? [],
    lcp: spec.lcp,
    textBlocks: spec.textBlocks ?? [],
    durationMs: 100,
    ...(spec.error ? { error: spec.error } : {}),
  };
  return { result, ...documentFacts(spec.html) };
}

export interface PageSpec extends ResponseSpec {
  readonly html?: string;
  readonly pageType?: PageType;
  readonly rendered?: RenderSpec | string;
  readonly userRender?: RenderSpec | string;
  readonly unblockedRender?: RenderSpec | string;
  readonly lighthouse?: LighthouseOutcome;
  readonly crux?: PageFacts['crux'];
}

const asRender = (url: string, spec: RenderSpec | string | undefined, mode: RenderResult['mode']) =>
  spec === undefined ? undefined : render(url, typeof spec === 'string' ? { html: spec, mode } : { mode, ...spec });

/** A page whose raw HTML is `html`; rendered and other inputs exist only when given. */
export function page(url: string, spec: PageSpec = {}): PageFacts {
  const fetch = response(url, { ...spec, ...(spec.html === undefined ? {} : { body: spec.html }) });
  const raw = spec.html === undefined ? undefined : documentFacts(spec.html);
  const decision = classifyPage({
    url: fetch.finalUrl, status: fetch.status, title: raw?.parsed.titles[0]?.text,
    h1: raw?.parsed.headings.find(heading => heading.level === 1)?.text, ogType: undefined, data: raw?.data,
  });
  const rendered = asRender(fetch.finalUrl, spec.rendered, 'googlebot');
  const userRender = asRender(fetch.finalUrl, spec.userRender, 'user');
  const unblockedRender = asRender(fetch.finalUrl, spec.unblockedRender, 'unblocked');
  return {
    url,
    fetch,
    pageType: spec.pageType ?? decision.type,
    pageTypeReason: spec.pageType ? 'fixture' : decision.reason,
    ...(raw ? { raw } : {}),
    ...(rendered ? { rendered } : {}),
    ...(userRender ? { userRender } : {}),
    ...(unblockedRender ? { unblockedRender } : {}),
    ...(spec.lighthouse ? { lighthouse: spec.lighthouse } : {}),
    ...(spec.crux ? { crux: spec.crux } : {}),
  };
}

export interface SiteSpec {
  readonly origin?: string;
  readonly pages: readonly PageFacts[];
  /** robots.txt body, or how the fetch failed. Omit to leave robots.txt uncollected. */
  readonly robots?: string | { readonly status: number; readonly body?: string } | 'unreachable';
  readonly sitemaps?: ReadonlyArray<{ readonly url: string; readonly xml?: string; readonly status?: number; readonly source?: SitemapFacts['source'] }>;
  readonly variants?: ReadonlyArray<{ readonly label: string; readonly url: string } & ResponseSpec>;
  readonly notFound?: ResponseSpec & { readonly html?: string };
  readonly siblings?: readonly PageFacts[];
  readonly crawled?: boolean;
  readonly homeUrl?: string;
}

export function site(spec: SiteSpec): SiteFacts {
  const origin = spec.origin ?? (spec.pages[0] ? new URL(spec.pages[0].url).origin : 'https://example.com');
  let robots: SiteFacts['robots'];
  if (spec.robots !== undefined) {
    const url = `${origin}/robots.txt`;
    if (spec.robots === 'unreachable') {
      const fetch = { ...response(url, { status: 503 }), status: undefined, hops: [], error: { code: 'connection' as const, message: 'refused' } };
      robots = { url, fetch, availability: robotsAvailability(undefined, undefined) };
    } else {
      const status = typeof spec.robots === 'string' ? 200 : spec.robots.status;
      const body = typeof spec.robots === 'string' ? spec.robots : spec.robots.body ?? '';
      const fetch = response(url, { status, body, headers: { 'content-type': 'text/plain' } });
      robots = { url, fetch, availability: robotsAvailability(status, Buffer.from(body)) };
    }
  }
  const sitemaps: SitemapFacts[] = (spec.sitemaps ?? []).map(entry => {
    const fetch = response(entry.url, { status: entry.status ?? 200, body: entry.xml ?? '', headers: { 'content-type': 'application/xml' } });
    return { url: entry.url, source: entry.source ?? 'robots', fetch, ...((entry.status ?? 200) === 200 && entry.xml ? { document: parseSitemap(entry.xml) } : {}) };
  });
  const variants: ProbeFacts[] = (spec.variants ?? []).map(entry => ({ label: entry.label, url: entry.url, fetch: response(entry.url, entry) }));
  const notFoundUrl = `${origin}/altimeter-probe-000000000000/`;
  const notFound = spec.notFound === undefined ? undefined : {
    label: 'not-found',
    url: notFoundUrl,
    fetch: response(notFoundUrl, { ...spec.notFound, ...(spec.notFound.html === undefined ? {} : { body: spec.notFound.html }) }),
    ...(spec.notFound.html === undefined ? {} : { parsed: documentFacts(spec.notFound.html).parsed }),
  };
  return {
    origin,
    ...(robots ? { robots } : {}),
    sitemaps,
    variants,
    ...(notFound ? { notFound } : {}),
    siblings: spec.siblings ?? [],
    pages: new Map(spec.pages.map(entry => [entry.url, entry])),
    crawled: spec.crawled ?? false,
    ...(spec.homeUrl ? { homeUrl: spec.homeUrl } : {}),
  };
}

/** Evaluates one catalog rule with its implementation, returning findings and the evidence they cite. */
export function evaluate(implementation: RuleImplementation, facts: SiteFacts): { findings: Finding[]; evidence: EvidenceStore } {
  const meta = catalogRule(implementation.id);
  if (!meta) throw new Error(`${implementation.id} is not in the catalog`);
  const evidence = new EvidenceStore();
  const findings = runRules({ rules: [{ ...meta, status: 'v1' }], implementations: new Map([[implementation.id, implementation]]), site: facts, evidence });
  return { findings, evidence };
}

/** The single outcome of a page rule on one page, for concise assertions. */
export function outcomeOn(findings: readonly Finding[], url: string): Finding | undefined {
  return findings.find(finding => finding.scope.kind === 'page' && finding.scope.url === url);
}
