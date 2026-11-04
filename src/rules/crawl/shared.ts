import type { DocumentFacts, PageFacts, SiteFacts } from '../../core/facts.ts';
import type { NotEvaluatedReason, Severity } from '../../core/types.ts';
import type { FetchResult, HeaderMap } from '../../fetch/http.ts';
import { isAllowed, type RobotsDecision, type RobotsFile } from '../../fetch/robots.ts';
import type { LinkRef } from '../../parse/html.ts';
import type { RuleResult } from '../engine.ts';
import { absoluteUrl, directivesFor, hreflangLinks, linksWithRel, robotsDirectives } from '../helpers.ts';

const order: readonly Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

export function worst(a: Severity, b: Severity): Severity {
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

export interface FailureSpec {
  readonly severity: Severity;
  readonly evidence: readonly string[];
  readonly reason?: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly needsJudgment?: boolean;
}

export function failure(spec: FailureSpec): RuleResult {
  return {
    outcome: 'fail',
    severity: spec.severity,
    evidence: spec.evidence,
    ...(spec.reason === undefined ? {} : { reason: spec.reason }),
    ...(spec.params === undefined ? {} : { params: spec.params }),
    ...(spec.needsJudgment ? { needsJudgment: true } : {}),
  };
}

export function passed(evidence: readonly string[] = []): RuleResult {
  return evidence.length > 0 ? { outcome: 'pass', evidence } : { outcome: 'pass' };
}

export const notApplicable = (reason: string): RuleResult => ({ outcome: 'not_applicable', reason });
export const notEvaluated = (reason: NotEvaluatedReason): RuleResult => ({ outcome: 'not_evaluated', reason });

/** The URL without its fragment, or undefined when it does not parse. */
export function normalizeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function robotsFile(site: SiteFacts): RobotsFile | undefined {
  return site.robots?.availability.kind === 'parsed' ? site.robots.availability.file : undefined;
}

/** Whether robots.txt of the audited origin lets a crawler fetch `url`; undefined when the file was not parsed or covers another origin. */
export function robotsDecision(site: SiteFacts, url: string, tokens: readonly string[] = ['googlebot']): RobotsDecision | undefined {
  const file = robotsFile(site);
  if (!file || originOf(url) !== originOf(site.robots!.url)) return undefined;
  return isAllowed(file, tokens, pathAndQuery(url));
}

/** The directives a crawler applies to a page: X-Robots-Tag headers plus robots meta elements of `doc`. */
export function effectiveDirectives(page: PageFacts, doc: DocumentFacts | undefined, agent = 'googlebot'): Set<string> {
  return directivesFor(robotsDirectives(page.fetch.headers, doc), agent);
}

export function robotsSources(page: PageFacts, doc: DocumentFacts | undefined, agent = 'googlebot') {
  return robotsDirectives(page.fetch.headers, doc).filter(entry => entry.agent === 'all' || entry.agent === agent);
}

/** The first `<base href>`, resolved against the document URL, which is how relative URLs in the document resolve. */
export function documentBase(doc: DocumentFacts | undefined, url: string): string {
  const href = doc?.parsed.bases.find(base => base.attrs.href !== undefined)?.attrs.href;
  return absoluteUrl(href, url) ?? url;
}

export function canonicalLinks(doc: DocumentFacts | undefined): LinkRef[] {
  return linksWithRel(doc, 'canonical');
}

/** Google ignores rel=canonical link elements that carry these attributes. */
export const ignoredCanonicalAttributes = ['hreflang', 'lang', 'media', 'type'] as const;

export function usableCanonical(link: LinkRef): boolean {
  return link.inHead && !ignoredCanonicalAttributes.some(name => link.attrs[name] !== undefined);
}

export interface LinkHeaderEntry {
  readonly target: string;
  readonly rels: readonly string[];
  readonly raw: string;
}

/** Entries of every Link response header, e.g. `<https://example.com/>; rel="canonical"`. */
export function linkHeaderEntries(headers: HeaderMap): LinkHeaderEntry[] {
  const entries: LinkHeaderEntry[] = [];
  for (const value of headers.link ?? []) {
    for (const match of value.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+)*)/gu)) {
      const rel = /;\s*rel\s*=\s*"?([^";]+)"?/iu.exec(match[2] ?? '')?.[1] ?? '';
      entries.push({ target: match[1]!.trim(), rels: rel.toLowerCase().split(/\s+/u).filter(Boolean), raw: match[0].trim() });
    }
  }
  return entries;
}

export interface CanonicalTarget {
  readonly source: 'raw' | 'rendered' | 'header';
  readonly href: string;
  /** The resolved URL without fragment, or undefined when the value does not parse. */
  readonly url: string | undefined;
  readonly line?: number;
}

/** Usable canonical declarations of one document plus the Link header, resolved against the base URL. */
export function canonicalTargets(page: PageFacts, doc: DocumentFacts | undefined, source: 'raw' | 'rendered'): CanonicalTarget[] {
  const base = documentBase(doc, page.fetch.finalUrl);
  const fromDoc = canonicalLinks(doc).filter(usableCanonical).map(link => ({
    source, href: link.attrs.href ?? '', url: normalizeUrl(absoluteUrl(link.attrs.href, base)), line: link.line,
  }));
  const fromHeader = linkHeaderEntries(page.fetch.headers).filter(entry => entry.rels.includes('canonical')).map(entry => ({
    source: 'header' as const, href: entry.target, url: normalizeUrl(absoluteUrl(entry.target, page.fetch.finalUrl)),
  }));
  return [...fromDoc, ...fromHeader];
}

/** The canonical target Google would most likely read first: the raw head, else the Link header. */
export function declaredCanonical(page: PageFacts): string | undefined {
  return canonicalTargets(page, page.raw, 'raw').find(target => target.url !== undefined)?.url;
}

export interface SitemapLoc {
  readonly loc: string;
  readonly sitemap: string;
  readonly line: number;
  readonly lastmod?: string;
}

export function sitemapLocs(site: SiteFacts): SitemapLoc[] {
  return site.sitemaps.flatMap(entry => (entry.document?.urls ?? []).map(url => ({
    loc: url.loc, sitemap: entry.url, line: url.line, ...(url.lastmod === undefined ? {} : { lastmod: url.lastmod }),
  })));
}

export function sitemapEntryFor(site: SiteFacts, url: string): SitemapLoc | undefined {
  const wanted = normalizeUrl(url);
  return sitemapLocs(site).find(entry => normalizeUrl(entry.loc) === wanted);
}

/** Another audited page that names `url` as its canonical or as an hreflang alternate. */
export function namedByOtherPage(site: SiteFacts, url: string): { readonly by: string; readonly as: 'canonical' | 'hreflang' } | undefined {
  const wanted = normalizeUrl(url);
  for (const other of site.pages.values()) {
    if (normalizeUrl(other.fetch.finalUrl) === wanted) continue;
    if (canonicalTargets(other, other.raw, 'raw').some(target => target.url === wanted)) return { by: other.fetch.finalUrl, as: 'canonical' };
    if (hreflangLinks(other.raw, documentBase(other.raw, other.fetch.finalUrl)).some(link => normalizeUrl(link.href) === wanted)) {
      return { by: other.fetch.finalUrl, as: 'hreflang' };
    }
  }
  return undefined;
}

export function isHomePage(site: SiteFacts, page: PageFacts): boolean {
  if (page.pageType === 'home') return true;
  const home = normalizeUrl(site.homeUrl);
  return home !== undefined && (normalizeUrl(page.fetch.finalUrl) === home || normalizeUrl(page.url) === home);
}

export interface KnownResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: HeaderMap;
  readonly location?: string;
  /** The whole fetch that started at this URL, when one did. */
  readonly fetch?: FetchResult;
}

/** Every response the collector received, keyed by URL without fragment: each redirect hop and each final response. */
export function knownResponses(site: SiteFacts): Map<string, KnownResponse> {
  const known = new Map<string, KnownResponse>();
  const record = (fetch: FetchResult) => {
    for (const [index, hop] of fetch.hops.entries()) {
      const key = normalizeUrl(hop.url);
      if (!key || known.has(key)) continue;
      known.set(key, { url: hop.url, status: hop.status, headers: hop.headers, ...(hop.location ? { location: hop.location } : {}), ...(index === 0 ? { fetch } : {}) });
    }
  };
  for (const page of site.pages.values()) record(page.fetch);
  for (const sibling of site.siblings) record(sibling.fetch);
  for (const variant of site.variants) record(variant.fetch);
  for (const probe of site.localeProbes) if (probe.label === 'accept-language:none') record(probe.fetch);
  return known;
}

/** Pages whose requested or final URL is `url`. */
export function factsAt(site: SiteFacts, url: string): PageFacts | undefined {
  const wanted = normalizeUrl(url);
  return [...site.pages.values(), ...site.siblings].find(entry => normalizeUrl(entry.fetch.finalUrl) === wanted || normalizeUrl(entry.url) === wanted);
}

const localeRootPath = /^\/[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?\/?$/iu;

export function isLocaleRootPath(path: string): boolean {
  return localeRootPath.test(path);
}

/**
 * A redirect from the site root to a locale home page on the same site, which is an intentional entry point when the
 * locale page answers 200 and, when its HTML is known, lists itself among its hreflang alternates.
 */
export function isLocaleEntryRedirect(site: SiteFacts, from: string, to: string | undefined): boolean {
  if (to === undefined) return false;
  let source: URL;
  let target: URL;
  try {
    source = new URL(from);
    target = new URL(to);
  } catch {
    return false;
  }
  if (source.pathname !== '/' || source.search !== '' || !isLocaleRootPath(target.pathname)) return false;
  if (source.hostname.replace(/^www\./u, '') !== target.hostname.replace(/^www\./u, '')) return false;
  const known = knownResponses(site).get(normalizeUrl(target.href)!);
  if (known && known.status !== 200 && !(known.status >= 300 && known.status < 400)) return false;
  const facts = factsAt(site, target.href);
  if (!facts?.raw) return true;
  const alternates = hreflangLinks(facts.raw, documentBase(facts.raw, facts.fetch.finalUrl));
  return alternates.length > 0 && alternates.some(link => normalizeUrl(link.href) === normalizeUrl(facts.fetch.finalUrl));
}

export function isStagingHost(host: string): boolean {
  return /^(?:staging|stage|preview|dev|development|test|testing|uat|qa|sandbox)[.-]/iu.test(host) || /\.(?:local|localhost|test|internal)$/iu.test(host);
}

/** Wording that says a page does not exist, in the languages the page classifier knows. */
export const errorWording = /(?:^|[^\p{L}\p{N}])(?:404|410|not found|page not found|no encontrad[ao]|p[aá]gina no existe|no trobada|no existeix|introuvable|nicht gefunden|non trovata|niet gevonden|não encontrada)(?:$|[^\p{L}\p{N}])/iu;

export function pageHeadlines(doc: DocumentFacts | undefined): string {
  if (!doc) return '';
  return [doc.parsed.titles[0]?.text ?? '', ...doc.parsed.headings.filter(heading => heading.level === 1).map(heading => heading.text)].join(' | ');
}

/** Lowercase word tokens of a text, for coarse comparisons between two versions of a page. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

/** Share of the words in `text` (as a multiset) that are missing from `reference`. */
export function missingShare(text: string, reference: string): number {
  const available = new Map<string, number>();
  for (const word of words(reference)) available.set(word, (available.get(word) ?? 0) + 1);
  const wanted = words(text);
  if (wanted.length === 0) return 0;
  let missing = 0;
  for (const word of wanted) {
    const left = available.get(word) ?? 0;
    if (left > 0) available.set(word, left - 1);
    else missing += 1;
  }
  return missing / wanted.length;
}

/** Internal http(s) link targets of a document, without fragments. */
export function internalLinks(doc: DocumentFacts | undefined, pageUrl: string): string[] {
  const base = documentBase(doc, pageUrl);
  const host = new URL(pageUrl).hostname.replace(/^www\./u, '');
  const result = new Set<string>();
  for (const anchor of doc?.parsed.anchors ?? []) {
    const target = normalizeUrl(absoluteUrl(anchor.attrs.href, base));
    if (!target || !/^https?:/u.test(target) || new URL(target).hostname.replace(/^www\./u, '') !== host) continue;
    result.add(target);
  }
  return [...result];
}

export function excerptOf(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
