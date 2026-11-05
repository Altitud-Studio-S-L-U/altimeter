import { evidenceLabel, type EvidenceLabel, type EvidenceStore } from '../../core/evidence.ts';
import type { PageFacts, SiteFacts } from '../../core/facts.ts';
import { isAllowed } from '../../fetch/robots.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, directivesFor, linksWithRel, robotsDirectives, sameSite } from '../helpers.ts';
import { annotationEvidence, effectiveAnnotations, normalizeUrl, parseLinkHeader, relTokens, type Annotation } from './annotations.ts';
import { clusters, declaredSets, documentAt, fetchOf, firstStatus, isXDefault, valuesFor, type DeclaredSet } from './cluster.ts';
import { primaryLanguage, sameLanguage } from './codes.ts';
import { fail, groupBy, list, maxEvidence, notApplicable, notEvaluated, pass } from './shared.ts';
import { isDecisive, languageEvidence, languageLabel, needsConfirmation, pageLanguage } from './text.ts';

interface Target {
  readonly href: string;
  /** The annotations that point to it, from every declaring URL. */
  readonly annotations: readonly Annotation[];
  readonly cluster: readonly string[];
}

/** Every distinct hreflang target, with the cluster it belongs to. */
function targets(sets: ReadonlyMap<string, DeclaredSet>): Target[] {
  const result: Target[] = [];
  for (const cluster of clusters(sets)) {
    const annotations = cluster.flatMap(url => sets.get(url)?.annotations ?? []).filter(annotation => annotation.href);
    for (const [href, group] of groupBy(annotations, annotation => annotation.href!)) result.push({ href, annotations: group, cluster });
  }
  // x-default targets outside every language cluster still need their status checked.
  const known = new Set(result.map(target => target.href));
  for (const set of sets.values()) {
    for (const annotation of set.annotations) {
      if (!annotation.href || known.has(annotation.href)) continue;
      known.add(annotation.href);
      result.push({ href: annotation.href, annotations: [annotation], cluster: [set.url] });
    }
  }
  return result;
}

function languagesOf(sets: ReadonlyMap<string, DeclaredSet>, url: string): string[] {
  const languages: string[] = [];
  for (const annotation of valuesFor(sets, url)) {
    const language = primaryLanguage(annotation.value);
    if (language && !languages.some(known => sameLanguage(known, language))) languages.push(language);
  }
  return languages;
}

const disjoint = (a: readonly string[], b: readonly string[]) => a.length > 0 && b.length > 0 && !a.some(x => b.some(y => sameLanguage(x, y)));

/** True when a redirect from `href` lands on the site root or on a URL the cluster assigns to another language. */
function redirectsToOtherLocale(sets: ReadonlyMap<string, DeclaredSet>, href: string, final: string): boolean {
  if (final === href) return false;
  const theirs = languagesOf(sets, final);
  // A root that the cluster assigns to the same language (the default locale at /) is not another locale.
  if (theirs.length > 0) return disjoint(languagesOf(sets, href), theirs);
  return new URL(final).pathname === '/' && new URL(href).pathname !== '/';
}

const onlyXDefault = (target: Target) => target.annotations.every(isXDefault);

function hopEvidence(evidence: EvidenceStore, url: string, fetch: PageFacts['fetch']): string {
  const chain = fetch.hops.map(hop => `${hop.status} ${hop.url}${hop.location ? ` -> ${hop.location}` : ''}`).join('\n');
  const excerpt = chain || fetch.error?.message;
  return evidence.add({
    kind: fetch.hops.length > 1 ? 'redirect' : 'http',
    url,
    label: fetch.error ? evidenceLabel('request for the hreflang target failed ({fetchError})', { fetchError: fetch.error.code }) : evidenceLabel('response to a request for the hreflang target without Accept-Language'),
    ...(excerpt ? { excerpt } : {}),
  });
}

/** http targets on an https site and host variants that redirect are owned by intl-hreflang-mixed-protocol-or-host. */
function protocolHostIssue(site: SiteFacts, href: string): 'http-scheme' | 'host-variant' | undefined {
  const target = new URL(href);
  const origin = new URL(site.origin);
  if (!sameSite(href, site.origin)) return undefined;
  if (origin.protocol === 'https:' && target.protocol === 'http:') return 'http-scheme';
  if (target.hostname === origin.hostname) return undefined;
  const observed = fetchOf(site, href);
  if (observed && observed.fetch.hops.length > 1 && new URL(observed.fetch.finalUrl).hostname !== target.hostname) return 'host-variant';
  const variant = site.variants.find(probe => probe.label === 'www' && new URL(probe.url).hostname === target.hostname);
  if (variant && variant.fetch.hops.length > 1 && new URL(variant.fetch.finalUrl).hostname !== target.hostname) return 'host-variant';
  return undefined;
}

export const targetNot200: RuleImplementation = {
  id: 'intl-hreflang-target-not-200',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const flagged: Array<{ target: Target; reason: 'redirect' | 'error' | 'unreachable'; fetch: PageFacts['fetch'] }> = [];
    let verified = 0;
    for (const target of targets(sets)) {
      if (protocolHostIssue(site, target.href)) continue;
      const observed = fetchOf(site, target.href);
      if (!observed) continue;
      verified += 1;
      const { fetch } = observed;
      const status = firstStatus(fetch);
      if (status === 200) continue;
      if (status === undefined) {
        // Redirect loops are reported by intl-localized-urls-unreachable when they hit a locale URL.
        if (!onlyXDefault(target) && (fetch.error?.code === 'redirect-loop' || fetch.error?.code === 'too-many-redirects')) continue;
        flagged.push({ target, reason: 'unreachable', fetch });
        continue;
      }
      if (status >= 300 && status < 400) {
        const final = normalizeUrl(fetch.finalUrl) ?? fetch.finalUrl;
        // The x-default entry point may redirect by locale to URLs of the cluster; a locale URL that does is owned
        // by intl-localized-urls-unreachable.
        if (onlyXDefault(target) && fetch.status === 200 && (target.cluster.includes(final) || languagesOf(sets, final).length > 0)) continue;
        if (!onlyXDefault(target) && redirectsToOtherLocale(sets, target.href, final)) continue;
        flagged.push({ target, reason: 'redirect', fetch });
        continue;
      }
      flagged.push({ target, reason: 'error', fetch });
    }
    if (flagged.length === 0) return verified === 0 ? notEvaluated('targets-not-fetched') : pass();
    return [...groupBy(flagged, entry => entry.reason)].map(([reason, group]) => fail(reason === 'redirect' ? 'medium' : 'high',
      group.slice(0, maxEvidence).flatMap(entry => [
        annotationEvidence(evidence, entry.target.annotations[0]!, evidenceLabel('hreflang entry for a URL that does not answer 200')),
        hopEvidence(evidence, entry.target.href, entry.fetch),
      ]),
      { count: group.length, urls: list(group.map(entry => entry.target.href)), status: list(group.map(entry => String(firstStatus(entry.fetch) ?? entry.fetch.error?.code ?? 'none'))) },
      reason));
  },
};

export const localizedUrlsUnreachable: RuleImplementation = {
  id: 'intl-localized-urls-unreachable',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = [];
    let verified = 0;
    for (const target of targets(sets)) {
      // The x-default may be a root entry point that redirects by locale; only language versions must be reachable.
      if (onlyXDefault(target) || protocolHostIssue(site, target.href)) continue;
      const observed = fetchOf(site, target.href);
      if (!observed) continue;
      verified += 1;
      const { fetch } = observed;
      const loop = fetch.error?.code === 'redirect-loop' || fetch.error?.code === 'too-many-redirects';
      const final = normalizeUrl(fetch.finalUrl) ?? fetch.finalUrl;
      const away = (firstStatus(fetch) ?? 0) >= 300 && (firstStatus(fetch) ?? 0) < 400 && redirectsToOtherLocale(sets, target.href, final);
      if (!loop && !away) continue;
      const ids = [annotationEvidence(evidence, target.annotations.find(annotation => !isXDefault(annotation))!, evidenceLabel('hreflang entry for a localized URL')), hopEvidence(evidence, target.href, fetch)];
      results.push(fail('critical', ids, { url: target.href, final, language: list(languagesOf(sets, target.href)) }, loop ? 'redirect-loop' : 'redirected-away'));
    }
    if (results.length > 0) return results;
    return verified === 0 ? notEvaluated('targets-not-fetched') : pass();
  },
};

function noindexDirective(page: PageFacts): string | undefined {
  for (const doc of [page.raw, page.rendered && page.rendered.result.error === undefined ? page.rendered : undefined]) {
    const all = robotsDirectives(page.fetch.headers, doc);
    if (!directivesFor(all).has('noindex')) continue;
    return all.find(entry => entry.directives.includes('noindex') || entry.directives.includes('none'))?.raw;
  }
  return undefined;
}

export const targetNoindex: RuleImplementation = {
  id: 'intl-hreflang-target-noindex',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const flagged: Array<{ target: Target; directive: string; page: PageFacts }> = [];
    let verified = 0;
    for (const target of targets(sets)) {
      const page = documentAt(site, target.href);
      if (!page?.raw) continue;
      verified += 1;
      const directive = noindexDirective(page);
      if (!directive) continue;
      // When the declaring pages are noindex too, the whole set is deliberately out of Search.
      const indexableDeclarer = target.annotations.some(annotation => {
        const declarer = sets.get(annotation.declaringUrl)?.page;
        return annotation.declaringUrl !== target.href && (!declarer || !noindexDirective(declarer));
      });
      if (indexableDeclarer) flagged.push({ target, directive, page });
    }
    if (flagged.length === 0) return verified === 0 ? notEvaluated('targets-not-fetched') : pass();
    return fail('high', flagged.slice(0, maxEvidence).flatMap(entry => [
      annotationEvidence(evidence, entry.target.annotations.find(annotation => annotation.declaringUrl !== entry.target.href) ?? entry.target.annotations[0]!, evidenceLabel('hreflang entry for a noindex URL')),
      evidence.add({ kind: 'html', url: entry.target.href, label: evidenceLabel('robots directive on the hreflang target'), excerpt: entry.directive }),
    ]), { count: flagged.length, urls: list(flagged.map(entry => entry.target.href)) });
  },
};

export const targetBlockedByRobots: RuleImplementation = {
  id: 'intl-hreflang-target-blocked-by-robots',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const robots = site.robots!;
    if (robots.availability.kind === 'unreachable') return notEvaluated('robots-unreachable');
    const origin = new URL(robots.url).origin;
    const local = targets(sets).filter(target => new URL(target.href).origin === origin);
    if (local.length === 0) return notEvaluated('targets-on-other-hosts');
    if (robots.availability.kind === 'unrestricted') return pass();
    const file = robots.availability.file;
    const blocked = local.flatMap(target => {
      const url = new URL(target.href);
      const decision = isAllowed(file, ['googlebot'], `${url.pathname}${url.search}`);
      return decision.allowed ? [] : [{ target, decision }];
    });
    if (blocked.length === 0) return pass();
    return fail('high', blocked.slice(0, maxEvidence).flatMap(({ target, decision }) => [
      annotationEvidence(evidence, target.annotations[0]!, evidenceLabel('hreflang entry for a URL that robots.txt disallows')),
      evidence.add({ kind: 'robots', url: robots.url, label: evidenceLabel('robots.txt rule that blocks {url} for Googlebot', { url: target.href }), excerpt: `${decision.rule?.type === 'disallow' ? 'Disallow' : 'Allow'}: ${decision.rule?.pattern ?? ''}`, ...(decision.rule ? { line: decision.rule.line } : {}) }),
    ]), { count: blocked.length, urls: list(blocked.map(entry => entry.target.href)) });
  },
};

/** The canonical a page declares, in its HTML or its Link header, resolved against its URL. */
export function declaredCanonical(page: PageFacts): { readonly url: string; readonly excerpt: string; readonly source: 'html' | 'header'; readonly line?: number } | undefined {
  const base = page.fetch.finalUrl;
  const link = linksWithRel(page.raw, 'canonical')[0];
  const fromHtml = normalizeUrl(absoluteUrl(link?.attrs.href, base));
  if (link && fromHtml) return { url: fromHtml, excerpt: page.raw!.html.slice(link.offset, page.raw!.html.indexOf('>', link.offset) + 1), source: 'html', line: link.line };
  const header = parseLinkHeader(page.fetch.headers.link ?? []).links.find(entry => relTokens(entry.params.rel).includes('canonical'));
  const fromHeader = normalizeUrl(header?.uri, base);
  return header && fromHeader ? { url: fromHeader, excerpt: header.raw, source: 'header' } : undefined;
}

function canonicalEvidence(evidence: EvidenceStore, url: string, canonical: NonNullable<ReturnType<typeof declaredCanonical>>, label: EvidenceLabel): string {
  return evidence.add({ kind: canonical.source === 'html' ? 'html' : 'header', url, label, excerpt: canonical.excerpt, ...(canonical.line ? { line: canonical.line } : {}) });
}

export const targetNotCanonical: RuleImplementation = {
  id: 'intl-hreflang-target-not-canonical',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const flagged: Array<{ target: Target; canonical: NonNullable<ReturnType<typeof declaredCanonical>>; annotation: Annotation }> = [];
    let verified = 0;
    for (const target of targets(sets)) {
      // A page's own entry is judged by intl-hreflang-on-non-canonical-page.
      const annotation = target.annotations.find(entry => entry.declaringUrl !== target.href);
      if (!annotation) continue;
      const page = documentAt(site, target.href);
      if (!page?.raw) continue;
      verified += 1;
      const canonical = declaredCanonical(page);
      if (canonical && canonical.url !== target.href) flagged.push({ target, canonical, annotation });
    }
    if (flagged.length === 0) return verified === 0 ? notEvaluated('targets-not-fetched') : pass();
    return fail('high', flagged.slice(0, maxEvidence).flatMap(entry => [
      annotationEvidence(evidence, entry.annotation, evidenceLabel('hreflang entry for a URL that canonicalises elsewhere')),
      canonicalEvidence(evidence, entry.target.href, entry.canonical, evidenceLabel('canonical declared by the hreflang target')),
    ]), { count: flagged.length, urls: list(flagged.map(entry => entry.target.href)), canonicals: list(flagged.map(entry => entry.canonical.url)) });
  },
};

export const mixedProtocolOrHost: RuleImplementation = {
  id: 'intl-hreflang-mixed-protocol-or-host',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const flagged = targets(sets).flatMap(target => {
      const issue = protocolHostIssue(site, target.href);
      return issue ? [{ target, issue }] : [];
    });
    if (flagged.length === 0) return pass();
    return [...groupBy(flagged, entry => entry.issue)].map(([issue, group]) => fail('medium',
      group.slice(0, maxEvidence).map(entry => annotationEvidence(evidence, entry.target.annotations[0]!, issue === 'http-scheme' ? evidenceLabel('hreflang entry with an http URL on an https site') : evidenceLabel('hreflang entry on a host variant that redirects'))),
      { count: group.length, urls: list(group.map(entry => entry.target.href)), origin: site.origin }, issue));
  },
};

export const onNonCanonicalPage: RuleImplementation = {
  id: 'intl-hreflang-on-non-canonical-page',
  evaluate({ page, site, evidence }) {
    const annotations = effectiveAnnotations(page!, site);
    if (annotations.length === 0) return notApplicable('no-hreflang');
    const self = normalizeUrl(page!.fetch.finalUrl)!;
    const first = annotationEvidence(evidence, annotations[0]!, evidenceLabel('hreflang annotation on this page'));
    if (page!.fetch.status !== 200) {
      const status = page!.fetch.status === undefined
        ? evidence.add({ kind: 'http', url: self, label: evidenceLabel('page that declares hreflang, which got no response ({fetchError})', { fetchError: page!.fetch.error?.code ?? 'connection' }) })
        : evidence.add({ kind: 'http', url: self, label: evidenceLabel('HTTP status of the page that declares hreflang'), excerpt: `HTTP ${page!.fetch.status}` });
      return fail('medium', [first, status],
        { status: String(page!.fetch.status ?? 'none'), url: self }, 'not-200');
    }
    const results: RuleResult[] = [];
    const canonical = declaredCanonical(page!);
    if (canonical && canonical.url !== self) {
      results.push(fail('medium', [first, canonicalEvidence(evidence, self, canonical, evidenceLabel('canonical pointing to another URL'))], { url: self, canonical: canonical.url }, 'canonical-elsewhere'));
    }
    // Legal and utility pages are often noindex on purpose; their hreflang is then simply unused.
    const directive = page!.pageType === 'legal' || page!.pageType === 'utility' ? undefined : noindexDirective(page!);
    if (directive) {
      results.push(fail('low', [first, evidence.add({ kind: 'html', url: self, label: evidenceLabel('robots directive on the page that declares hreflang'), excerpt: directive })], { url: self, directive }, 'noindex'));
    }
    return results.length > 0 ? results : pass();
  },
};

export const canonicalCrossLanguage: RuleImplementation = {
  id: 'intl-canonical-cross-language',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    const results: RuleResult[] = [];
    let candidates = 0;
    for (const page of [...site.pages.values(), ...site.siblings]) {
      if (page.fetch.status !== 200 || !page.raw) continue;
      const self = normalizeUrl(page.fetch.finalUrl)!;
      const canonical = declaredCanonical(page);
      if (!canonical || canonical.url === self) continue;
      candidates += 1;
      const own = languagesOf(sets, self);
      const target = languagesOf(sets, canonical.url);
      const language = pageLanguage(page);
      const canonicalId = canonicalEvidence(evidence, self, canonical, evidenceLabel('canonical pointing to another URL'));
      if (disjoint(own, target)) {
        // A variant left untranslated may canonicalise to the original; then its hreflang label is what is wrong.
        if (language && isDecisive(language.guess, 100) && target.some(code => sameLanguage(code, language.guess.language))) continue;
        const labels = valuesFor(sets, self).filter(annotation => !isXDefault(annotation)).slice(0, 2)
          .concat(valuesFor(sets, canonical.url).filter(annotation => !isXDefault(annotation)).slice(0, 2));
        results.push(fail('high', [canonicalId, ...labels.map(annotation => annotationEvidence(evidence, annotation, evidenceLabel('hreflang value assigned to {url}', { url: annotation.href ?? '' })))],
          { url: self, canonical: canonical.url, language: list(own.map(languageLabel)), canonicalLanguage: list(target.map(languageLabel)) }, 'hreflang-languages'));
        continue;
      }
      const targetPage = documentAt(site, canonical.url);
      const other = targetPage ? pageLanguage(targetPage) : undefined;
      if (!language || !other || !isDecisive(language.guess, 100) || !isDecisive(other.guess, 100)) continue;
      const mine = language.guess.language;
      const theirs = other.guess.language;
      if (mine === theirs) continue;
      const confirm = needsConfirmation(mine, theirs);
      results.push(fail(confirm ? 'medium' : 'high', [canonicalId, languageEvidence(evidence, self, language), languageEvidence(evidence, canonical.url, other)],
        { url: self, canonical: canonical.url, language: languageLabel(mine), canonicalLanguage: languageLabel(theirs) }, 'detected-languages', confirm));
    }
    if (results.length > 0) return results;
    return candidates === 0 ? notApplicable('no-cross-url-canonical') : pass();
  },
};

export const targetImplementations: readonly RuleImplementation[] = [
  targetNot200, localizedUrlsUnreachable, targetNoindex, targetBlockedByRobots, targetNotCanonical, mixedProtocolOrHost,
  onNonCanonicalPage, canonicalCrossLanguage,
];
