import { linkGraph } from '../../analyze/graph.ts';
import { urlVariants } from '../../collect/probes.ts';
import type { EvidenceStore } from '../../core/evidence.ts';
import type { PageFacts, ProbeFacts, SiteFacts } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import { headerValue, type Hop } from '../../fetch/http.ts';
import { parseHtml } from '../../parse/html.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, pageDocument, summarizeList } from '../helpers.ts';
import {
  errorWording, failure, internalLinks, isHomePage, isLocaleEntryRedirect, isLocaleRootPath, knownResponses, missingShare, namedByOtherPage,
  normalizeUrl, notApplicable, notEvaluated, pageHeadlines, passed, sitemapEntryFor,
} from './shared.ts';

function citeHop(evidence: EvidenceStore, hop: Hop, index: number): string {
  return evidence.add({ kind: 'redirect', url: hop.url, label: `redirect hop ${index + 1}`, excerpt: `${hop.status} -> ${hop.location ?? '(no location)'}` });
}

function redirectHops(hops: readonly Hop[]): Hop[] {
  return hops.filter(hop => hop.location !== undefined);
}

/** Whether another collected page links to `url`. */
function linkedFromOtherPage(site: SiteFacts, url: string): string | undefined {
  const wanted = normalizeUrl(url);
  for (const other of site.pages.values()) {
    if (normalizeUrl(other.fetch.finalUrl) === wanted) continue;
    if (internalLinks(pageDocument(other), other.fetch.finalUrl).includes(wanted!)) return other.fetch.finalUrl;
  }
  return undefined;
}

const statusFinal: RuleImplementation = {
  id: 'crawl-status-final',
  evaluate({ site, page, evidence }) {
    const target = page!;
    const status = target.fetch.status!;
    const url = target.fetch.finalUrl;
    const id = evidence.add({ kind: 'http', url, label: 'final response status', excerpt: `HTTP ${status}` });
    const params = { url, status };
    if (status === 204) return failure({ severity: 'high', evidence: [id], reason: 'no-content', params });
    if (status >= 200 && status < 300) return passed([id]);
    if (status >= 300 && status < 400) return notEvaluated('unfollowed-redirect');
    if (status === 429) return failure({ severity: 'high', evidence: [id], reason: 'rate-limited', params });
    if (status >= 500) return failure({ severity: 'critical', evidence: [id], reason: 'server-error', params });
    const listed = sitemapEntryFor(site, url) ?? sitemapEntryFor(site, target.url);
    const named = namedByOtherPage(site, url);
    const linkedBy = linkedFromOtherPage(site, url);
    // Every URL a crawl reaches is linked, so links alone never make a removed URL critical; crawl-internal-links-broken-redirected grades them.
    if (!listed && !named && !isHomePage(site, target)) return notApplicable(linkedBy ? 'linked-only' : 'removed-unreferenced');
    const ids = [id];
    if (listed) ids.push(evidence.add({ kind: 'sitemap', url: listed.sitemap, label: 'sitemap entry for the URL', excerpt: listed.loc, line: listed.line }));
    if (named) ids.push(evidence.add({ kind: 'html', url: named.by, label: `page that names the URL as its ${named.as} target`, excerpt: url }));
    if (linkedBy) ids.push(evidence.add({ kind: 'html', url: linkedBy, label: 'page that links to the URL', excerpt: url }));
    return failure({ severity: 'critical', evidence: ids, reason: 'client-error', params });
  },
};

const redirectChain: RuleImplementation = {
  id: 'crawl-redirect-chain',
  evaluate({ site, page, evidence }) {
    const target = page!;
    const hops = redirectHops(target.fetch.hops);
    const ids = () => hops.slice(0, 12).map((hop, index) => citeHop(evidence, hop, index));
    const code = target.fetch.error?.code;
    if (code === 'redirect-loop') return failure({ severity: 'medium', evidence: ids(), reason: 'loop', params: { url: target.url, hops: hops.length } });
    if (code === 'too-many-redirects') return failure({ severity: 'medium', evidence: ids(), reason: 'too-many', params: { url: target.url, hops: hops.length } });
    if (hops.length === 0) return notApplicable('no-redirect');
    const counted = hops.filter(hop => !isLocaleEntryRedirect(site, hop.url, hop.location));
    if (counted.length <= 1) return passed(ids());
    return failure({ severity: counted.length === 2 ? 'low' : 'medium', evidence: ids(), reason: counted.length === 2 ? 'two-hops' : 'long-chain', params: { url: target.url, hops: counted.length } });
  },
};

const temporaryStatuses = new Set([302, 303, 307]);
const loginPath = /\/(?:login|log-in|signin|sign-in|auth|sso|account|cuenta|compte|wp-login)/iu;

/** Whether a redirect only normalises the URL: protocol, www, trailing slash, case or an index file. */
export function consolidationRedirect(from: string, to: string): boolean {
  const a = new URL(from);
  const b = new URL(to);
  const host = (value: URL) => value.hostname.replace(/^www\./u, '');
  const path = (value: URL) => value.pathname.replace(/\/index\.(?:html?|php)$/iu, '/').replace(/\/+$/u, '').toLowerCase();
  return host(a) === host(b) && path(a) === path(b) && a.search === b.search && a.href !== b.href;
}

function perVisitor(hop: Hop): boolean {
  return /\b(?:private|no-store)\b/iu.test(headerValue(hop.headers, 'cache-control') ?? '');
}

const redirectType: RuleImplementation = {
  id: 'crawl-redirect-type',
  evaluate({ site, page, evidence }) {
    const target = page!;
    const hops = redirectHops(target.fetch.hops);
    if (hops.length === 0) return notApplicable('no-redirect');
    const results: RuleResult[] = [];
    for (const [index, hop] of hops.entries()) {
      if (!temporaryStatuses.has(hop.status)) continue;
      if (isLocaleEntryRedirect(site, hop.url, hop.location) || perVisitor(hop) || loginPath.test(new URL(hop.location!).pathname)) continue;
      const ids = [citeHop(evidence, hop, index)];
      const cache = headerValue(hop.headers, 'cache-control');
      if (cache) ids.push(evidence.add({ kind: 'header', url: hop.url, label: 'Cache-Control of the redirect response', excerpt: cache }));
      const params = { url: hop.url, location: hop.location!, status: hop.status };
      if (consolidationRedirect(hop.url, hop.location!)) results.push(failure({ severity: 'medium', evidence: ids, reason: 'temporary-consolidation', params }));
      else results.push(failure({ severity: 'medium', evidence: ids, reason: 'temporary-move', params, needsJudgment: true }));
    }
    return results.length > 0 ? results : passed(hops.map((hop, index) => citeHop(evidence, hop, index)));
  },
};

export function parseRefresh(value: string): { delay: number; url: string | undefined } | undefined {
  const match = /^\s*(\d+(?:\.\d*)?)?\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?([^'"]*)['"]?)?\s*$/iu.exec(value);
  if (!match || match[1] === undefined) return undefined;
  const url = match[2]?.trim();
  return { delay: Math.floor(Number(match[1])), url: url === '' ? undefined : url };
}

const metaRefreshJsRedirect: RuleImplementation = {
  id: 'crawl-meta-refresh-js-redirect',
  evaluate({ page, evidence }) {
    const target = page!;
    if (target.fetch.status !== 200) return notApplicable('non-200');
    const url = target.fetch.finalUrl;
    const self = normalizeUrl(url);
    const meta = target.raw!.parsed.metas.find(entry => (entry.attrs['http-equiv'] ?? '').toLowerCase() === 'refresh' && entry.attrs.content !== undefined);
    const header = headerValue(target.fetch.headers, 'refresh');
    const declared = meta ? { value: meta.attrs.content!, line: meta.line, kind: 'html' as const } : header ? { value: header, line: 0, kind: 'header' as const } : undefined;
    const refresh = declared ? parseRefresh(declared.value) : undefined;
    const destination = refresh?.url ? normalizeUrl(absoluteUrl(refresh.url, url)) : undefined;
    if (declared && refresh && destination && destination !== self) {
      const id = evidence.add({ kind: declared.kind, url, label: declared.kind === 'html' ? 'meta refresh element' : 'Refresh header', excerpt: declared.value, ...(declared.line ? { line: declared.line } : {}) });
      const params = { url, location: destination, delay: refresh.delay };
      return refresh.delay === 0 ? failure({ severity: 'low', evidence: [id], reason: 'instant-refresh', params }) : failure({ severity: 'medium', evidence: [id], reason: 'delayed-refresh', params });
    }
    const rendered = target.rendered && target.rendered.result.error === undefined ? target.rendered : undefined;
    const landed = rendered ? normalizeUrl(rendered.result.finalUrl) : undefined;
    if (landed && landed !== self) {
      const id = evidence.add({ kind: 'render', url, label: 'URL the render ended on', excerpt: rendered!.result.finalUrl });
      return failure({ severity: 'medium', evidence: [id], reason: 'js-redirect', params: { url, location: landed, delay: 0 } });
    }
    return passed();
  },
};

function probeLanding(probe: ProbeFacts | undefined): string | undefined {
  return probe && probe.fetch.hops.length > 1 ? normalizeUrl(probe.fetch.finalUrl) : undefined;
}

const soft404: RuleImplementation = {
  id: 'crawl-soft-404',
  evaluate({ site, evidence }) {
    const probe = site.notFound!;
    const status = probe.fetch.status;
    if (status === undefined) return notEvaluated('probe-failed');
    if (status >= 500) return notEvaluated('probe-server-error');
    const results: RuleResult[] = [];
    const probeId = evidence.add({ kind: 'probe', url: probe.url, label: 'response to a random unknown path', excerpt: `HTTP ${status}${probe.fetch.hops.length > 1 ? ` after redirect to ${probe.fetch.finalUrl}` : ''}` });
    if (status === 200 && probe.fetch.hops.length === 1) {
      const title = probe.parsed?.titles[0]?.text;
      const ids = [probeId, ...(title ? [evidence.add({ kind: 'probe', url: probe.url, label: 'title of the unknown path response', excerpt: title })] : [])];
      results.push(failure({ severity: 'high', evidence: ids, reason: 'probe-200', params: { url: probe.url } }));
    }
    for (const page of site.pages.values()) {
      if (page.fetch.status !== 200) continue;
      const headline = pageHeadlines(pageDocument(page));
      if (!errorWording.test(headline)) continue;
      const id = evidence.add({ kind: 'html', url: page.fetch.finalUrl, label: 'title and h1 of a page answering 200', excerpt: headline });
      results.push(failure({ severity: 'medium', evidence: [id], reason: 'error-page-200', params: { url: page.fetch.finalUrl }, needsJudgment: true }));
    }
    return results.length > 0 ? results : passed([probeId]);
  },
};

function homeUrls(site: SiteFacts): Set<string> {
  const homes = new Set<string>([normalizeUrl(`${site.origin}/`)!]);
  if (site.homeUrl) homes.add(normalizeUrl(site.homeUrl)!);
  for (const page of site.pages.values()) if (isHomePage(site, page)) homes.add(normalizeUrl(page.fetch.finalUrl)!);
  return homes;
}

function variantBase(site: SiteFacts, variant: ProbeFacts): PageFacts | undefined {
  return [...site.pages.values()].find(page => urlVariants(page.fetch.finalUrl).some(entry => entry.url === variant.url));
}

const redirectToHome: RuleImplementation = {
  id: 'crawl-redirect-to-home',
  evaluate({ site, evidence }) {
    const homes = homeUrls(site);
    let redirects = 0;
    const results: RuleResult[] = [];
    const landing = probeLanding(site.notFound);
    if (landing) {
      redirects += 1;
      if (homes.has(landing)) {
        const ids = redirectHops(site.notFound!.fetch.hops).map((hop, index) => citeHop(evidence, hop, index));
        results.push(failure({ severity: 'medium', evidence: ids, reason: 'probe-to-home', params: { url: site.notFound!.url, location: landing } }));
      }
    }
    for (const variant of site.variants) {
      const lands = probeLanding(variant);
      if (!lands) continue;
      redirects += 1;
      const base = variantBase(site, variant);
      if (!homes.has(lands) || !base || isHomePage(site, base)) continue;
      const ids = redirectHops(variant.fetch.hops).map((hop, index) => citeHop(evidence, hop, index));
      results.push(failure({ severity: 'medium', evidence: ids, reason: 'variant-to-home', params: { url: variant.url, location: lands } }));
    }
    for (const page of site.pages.values()) {
      if (page.fetch.hops.length <= 1) continue;
      redirects += 1;
      const lands = normalizeUrl(page.fetch.finalUrl)!;
      const path = new URL(page.url).pathname;
      if (!homes.has(lands) || path === '/' || isLocaleRootPath(path) || homes.has(normalizeUrl(page.url)!)) continue;
      const ids = redirectHops(page.fetch.hops).map((hop, index) => citeHop(evidence, hop, index));
      results.push(failure({ severity: 'medium', evidence: ids, reason: 'page-to-home', params: { url: page.url, location: lands }, needsJudgment: true }));
    }
    if (redirects === 0) return notApplicable('no-redirects');
    return results.length > 0 ? results : passed();
  },
};

const serverErrorsRate: RuleImplementation = {
  id: 'crawl-server-errors-rate',
  evaluate({ site, evidence }) {
    const fetched = [...site.pages.values()];
    if (fetched.length === 0) return notApplicable('no-pages');
    const failing = fetched.filter(page => page.fetch.error?.code === 'timeout' || (page.fetch.status ?? 0) >= 500 || page.fetch.status === 429);
    const share = failing.length / fetched.length;
    const ids = failing.slice(0, 5).map(page => evidence.add({ kind: 'http', url: page.fetch.finalUrl, label: 'crawled URL answering a server error', excerpt: page.fetch.status === undefined ? page.fetch.error?.code ?? 'error' : `HTTP ${page.fetch.status}` }));
    if (share >= 0.01) return failure({ severity: 'high', evidence: ids, reason: 'error-rate', params: { count: failing.length, total: fetched.length, share: `${(share * 100).toFixed(1)}%` } });
    // A 503 without Retry-After is tech-maintenance-503's; rate limiting is reported here.
    const noRetry = fetched.filter(page => page.fetch.status === 429 && headerValue(page.fetch.headers, 'retry-after') === undefined);
    if (noRetry.length > 0) {
      return failure({ severity: 'low', evidence: noRetry.slice(0, 5).map(page => evidence.add({ kind: 'header', url: page.fetch.finalUrl, label: 'Retry-After header', excerpt: '(absent)' })),
        reason: 'no-retry-after', params: { count: noRetry.length, total: fetched.length, share: `${(share * 100).toFixed(1)}%` } });
    }
    return passed();
  },
};

/** Text similarity check between a variant body and the preferred page. */
function sameContent(a: string, b: string): boolean {
  return missingShare(a, b) < 0.1 && missingShare(b, a) < 0.1;
}

const hostVariantConsolidation: RuleImplementation = {
  id: 'crawl-host-variant-consolidation',
  evaluate({ site, evidence }) {
    const results: RuleResult[] = [];
    let checked = 0;
    for (const variant of site.variants) {
      // Tracking parameters belong to crawl-parameter-urls and the http variant to tech-http-to-https-redirect.
      if (variant.label === 'tracking-parameter' || variant.label === 'http' || variant.fetch.status === undefined) continue;
      const base = variantBase(site, variant);
      if (!base) continue;
      checked += 1;
      const preferred = normalizeUrl(base.fetch.finalUrl)!;
      const status = variant.fetch.status;
      if (status >= 400) continue;
      if (variant.fetch.hops.length === 1 && status === 200) {
        const parsed = parseHtml(variant.fetch.body.toString('utf8'));
        const canonical = normalizeUrl(absoluteUrl(parsed.links.find(link => link.rel.includes('canonical'))?.attrs.href, variant.url));
        if (canonical === preferred) continue;
        if (!base.raw || !sameContent(parsed.bodyText, base.raw.parsed.bodyText)) continue;
        const ids = [
          evidence.add({ kind: 'probe', url: variant.url, label: `URL variant (${variant.label}) answering 200 with the same content`, excerpt: `HTTP 200, canonical ${canonical ?? '(none)'}` }),
          evidence.add({ kind: 'http', url: preferred, label: 'preferred URL', excerpt: `HTTP ${base.fetch.status}` }),
        ];
        results.push(failure({ severity: 'high', evidence: ids, reason: 'duplicate-200', params: { url: variant.url, preferred, variant: variant.label } }));
        continue;
      }
      if (normalizeUrl(variant.fetch.finalUrl) !== preferred || status !== 200) continue;
      const hops = redirectHops(variant.fetch.hops).filter(hop => !isLocaleEntryRedirect(site, hop.url, hop.location));
      const temporary = hops.filter(hop => temporaryStatuses.has(hop.status));
      if (temporary.length === 0 && hops.length <= 1) continue;
      const ids = redirectHops(variant.fetch.hops).map((hop, index) => citeHop(evidence, hop, index));
      const reason = temporary.length > 0 ? 'temporary-redirect' : 'multiple-hops';
      results.push(failure({ severity: 'low', evidence: ids, reason, params: { url: variant.url, preferred, variant: variant.label } }));
    }
    if (checked === 0) return notApplicable('no-variants-of-audited-pages');
    return results.length > 0 ? results : passed();
  },
};

const internalLinksBrokenRedirected: RuleImplementation = {
  id: 'crawl-internal-links-broken-redirected',
  evaluate({ site, evidence }) {
    const known = knownResponses(site);
    const graph = linkGraph(site);
    let resolved = 0;
    const broken: { from: string; to: string; status: number; template: boolean }[] = [];
    const redirected: { from: string; to: string; status: number; location: string }[] = [];
    for (const edges of graph.outlinks.values()) {
      for (const edge of edges) {
        const response = known.get(edge.to);
        if (!response) continue;
        resolved += 1;
        if (response.status >= 400) broken.push({ from: edge.from, to: edge.to, status: response.status, template: edge.template });
        else if (response.status >= 300 && !isLocaleEntryRedirect(site, edge.to, response.location)) {
          redirected.push({ from: edge.from, to: edge.to, status: response.status, location: response.location ?? '' });
        }
      }
    }
    if (resolved === 0) return notApplicable('no-known-targets');
    const results: RuleResult[] = [];
    if (broken.length > 0) {
      const template = broken.some(link => link.template);
      const ids = broken.slice(0, 6).map(link => evidence.add({ kind: 'crawl', url: link.from, label: `internal link${link.template ? ' in navigation, header or footer' : ''} to an error page`, excerpt: `${link.to} -> HTTP ${link.status}` }));
      results.push(failure({ severity: template ? 'medium' : 'low', evidence: ids, reason: 'broken', params: { count: broken.length, targets: summarizeList([...new Set(broken.map(link => link.to))]) } }));
    }
    if (redirected.length > 0) {
      const ids = redirected.slice(0, 6).map(link => evidence.add({ kind: 'crawl', url: link.from, label: 'internal link to a redirecting URL', excerpt: `${link.to} -> ${link.status} ${link.location}` }));
      const severity: Severity = redirected.length >= 10 ? 'medium' : 'low';
      results.push(failure({ severity, evidence: ids, reason: 'redirected', params: { count: redirected.length, targets: summarizeList([...new Set(redirected.map(link => link.to))]) } }));
    }
    return results.length > 0 ? results : passed();
  },
};

const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

const conditionalRequests: RuleImplementation = {
  id: 'crawl-conditional-requests',
  evaluate({ site, evidence }) {
    const html = [...site.pages.values()].filter(page => page.fetch.status === 200 && page.raw !== undefined);
    if (html.length === 0) return notApplicable('no-html-pages');
    const malformed = html.map(page => ({ page, value: headerValue(page.fetch.headers, 'last-modified') }))
      .filter(item => item.value !== undefined && !httpDate.test(item.value.trim()));
    if (malformed.length > 0) {
      const ids = malformed.slice(0, 3).map(item => evidence.add({ kind: 'header', url: item.page.fetch.finalUrl, label: 'Last-Modified header', excerpt: item.value! }));
      return failure({ severity: 'low', evidence: ids, reason: 'malformed-last-modified', params: { url: malformed[0]!.page.fetch.finalUrl, value: malformed[0]!.value! } });
    }
    const validated = html.filter(page => headerValue(page.fetch.headers, 'etag') !== undefined || headerValue(page.fetch.headers, 'last-modified') !== undefined);
    if (validated.length > 0) {
      const page = validated[0]!;
      return passed([evidence.add({ kind: 'header', url: page.fetch.finalUrl, label: 'cache validator on the HTML response', excerpt: headerValue(page.fetch.headers, 'etag') ?? headerValue(page.fetch.headers, 'last-modified')! })]);
    }
    if (!site.crawled || site.pages.size < 1000) return notEvaluated('site-size-unknown');
    const ids = html.slice(0, 3).map(page => evidence.add({ kind: 'header', url: page.fetch.finalUrl, label: 'ETag and Last-Modified headers', excerpt: '(absent)' }));
    return failure({ severity: 'low', evidence: ids, reason: 'no-validators', params: { url: html[0]!.fetch.finalUrl, value: '' } });
  },
};

export const googlebotHtmlLimit = 2 * 1024 * 1024;

/** The character index at which the UTF-8 encoding of `html` passes `bytes`. */
function charOffsetAtByte(html: string, bytes: number): number {
  let low = 0;
  let high = html.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(html.slice(0, middle), 'utf8') <= bytes) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

/** The markup after `cut`, without the rest of a script or style element that the cut falls inside. */
function trailingMarkup(html: string, cut: number): string {
  const before = html.slice(0, cut).toLowerCase();
  const opened = Math.max(before.lastIndexOf('<script'), before.lastIndexOf('<style'));
  const closed = Math.max(before.lastIndexOf('</script'), before.lastIndexOf('</style'));
  const rest = html.slice(cut);
  if (opened <= closed) return rest;
  const end = rest.search(/<\/(?:script|style)\s*>/iu);
  return end === -1 ? '' : rest.slice(end);
}

const htmlSizeLimit: RuleImplementation = {
  id: 'crawl-html-size-limit',
  evaluate({ page, evidence }) {
    const target = page!;
    const raw = target.raw!;
    const url = target.fetch.finalUrl;
    const bytes = Math.max(target.fetch.body.length, Buffer.byteLength(raw.html, 'utf8'));
    const sizeId = evidence.add({ kind: 'http', url, label: `uncompressed HTML size in bytes${target.fetch.truncated ? ' (at least; the fetch was cut)' : ''}`, excerpt: String(bytes) });
    if (bytes <= googlebotHtmlLimit) return passed([sizeId]);
    const cut = charOffsetAtByte(raw.html, googlebotHtmlLimit);
    const parsed = raw.parsed;
    const after = [
      ...parsed.anchors.filter(entry => entry.offset >= cut).map(entry => `<a href="${entry.attrs.href ?? ''}">`),
      ...parsed.links.filter(entry => entry.offset >= cut && (entry.rel.includes('canonical') || entry.rel.includes('alternate'))).map(entry => `<link rel="${entry.rel.join(' ')}">`),
      ...parsed.headings.filter(entry => entry.offset >= cut).map(entry => `<h${entry.level}>${entry.text.slice(0, 80)}`),
      ...parsed.scripts.filter(entry => entry.offset >= cut && (entry.attrs.type ?? '').toLowerCase() === 'application/ld+json').map(() => '<script type="application/ld+json">'),
    ];
    const trailingText = trailingMarkup(raw.html, cut).replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/giu, ' ').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
    const important = after.length > 0 || trailingText.length > 200;
    const ids = [sizeId, ...after.slice(0, 5).map(excerpt => evidence.add({ kind: 'html', url, label: 'element after the first 2 MB', excerpt }))];
    return failure({ severity: important ? 'high' : 'low', evidence: ids, reason: important ? 'content-after-limit' : 'scripts-after-limit', params: { url, bytes, count: after.length } });
  },
};

export const statusRules: readonly RuleImplementation[] = [
  statusFinal, redirectChain, redirectType, metaRefreshJsRedirect, soft404, redirectToHome, serverErrorsRate, hostVariantConsolidation,
  internalLinksBrokenRedirected, conditionalRequests, htmlSizeLimit,
];
