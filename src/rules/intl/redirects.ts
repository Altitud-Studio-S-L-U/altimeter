import { detectLanguage } from '../../analyze/language.ts';
import { documentFacts, decodeHtml, isHtmlResponse } from '../../collect/page.ts';
import { evidenceLabel, joinLabels, type EvidenceLabel, type EvidenceStore } from '../../core/evidence.ts';
import type { ProbeFacts, SiteFacts } from '../../core/facts.ts';
import { headerValue, type HeaderMap } from '../../fetch/http.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, documentBase, sameSite } from '../helpers.ts';
import { annotationEvidence, normalizeUrl } from './annotations.ts';
import { declaredSets, fetchedPages } from './cluster.ts';
import { primaryLanguage } from './codes.ts';
import { fail, groupBy, list, maxEvidence, notApplicable, notEvaluated, pass } from './shared.ts';
import { jaccard, languageLabel, mainText, shingles } from './text.ts';

/** Language probes grouped by the URL they requested. */
function probesByUrl(site: SiteFacts): Map<string, ProbeFacts[]> {
  return groupBy(site.localeProbes.filter(probe => probe.fetch.hops.length > 0), probe => normalizeUrl(probe.url) ?? probe.url);
}

const acceptLanguage = (probe: ProbeFacts) => probe.label.replace(/^accept-language:/u, '');
const finalOf = (probe: ProbeFacts) => normalizeUrl(probe.fetch.finalUrl) ?? probe.fetch.finalUrl;
const isRoot = (url: string) => new URL(url).pathname === '/' && new URL(url).search === '';

function probeEvidence(evidence: EvidenceStore, probe: ProbeFacts, label: EvidenceLabel): string {
  const chain = probe.fetch.hops.map(hop => `${hop.status} ${hop.url}${hop.location ? ` -> ${hop.location}` : ''}`).join('\n');
  return evidence.add({ kind: 'probe', url: probe.url, label: joinLabels(label, evidenceLabel('(Accept-Language: {value})', { value: acceptLanguage(probe) })), excerpt: chain });
}

export const autoRedirectByLanguage: RuleImplementation = {
  id: 'intl-auto-redirect-by-language',
  evaluate({ site, evidence }) {
    if (site.localeProbes.length === 0) return notEvaluated('no-locale-probes');
    const localized = [...probesByUrl(site)].filter(([url]) => !isRoot(url));
    // A root that redirects by language is judged by intl-root-locale-redirector.
    if (localized.length === 0) return notApplicable('only-root-probed');
    const results: RuleResult[] = [];
    for (const [url, probes] of localized) {
      const finals = groupBy(probes, finalOf);
      if (finals.size < 2) continue;
      results.push(fail('high', probes.slice(0, maxEvidence).map(probe => probeEvidence(evidence, probe, evidenceLabel('response to the same URL with a different Accept-Language'))),
        { url, targets: list(finals.keys(), 3), count: finals.size }));
    }
    return results.length > 0 ? results : pass(localized.map(([, probes]) => probeEvidence(evidence, probes[0]!, evidenceLabel('response that did not change with Accept-Language'))));
  },
};

/** Whether a shared cache may store a response with these headers. */
function sharedCacheable(status: number, headers: HeaderMap): boolean {
  const control = (headerValue(headers, 'cache-control') ?? '').toLowerCase();
  if (/\b(no-store|private)\b/u.test(control)) return false;
  if (/\bs-maxage=0\b/u.test(control) || (/\bmax-age=0\b/u.test(control) && !/\bs-maxage=[1-9]/u.test(control))) return false;
  // 301 and 308 are cacheable by default; 302 and 307 only with explicit freshness.
  if (status === 301 || status === 308) return true;
  return /\b(public|s-maxage=[1-9]|max-age=[1-9])/u.test(control) || headerValue(headers, 'expires') !== undefined;
}

export const rootLocaleRedirector: RuleImplementation = {
  id: 'intl-root-locale-redirector',
  evaluate({ site, evidence }) {
    const root = normalizeUrl(new URL('/', site.origin).href)!;
    const probes = probesByUrl(site).get(root) ?? [];
    if (probes.length === 0) return notEvaluated('no-root-probes');
    const redirecting = probes.filter(probe => probe.fetch.hops.length > 1);
    if (redirecting.length === 0) return notApplicable('root-does-not-redirect');
    const targets = groupBy(probes, finalOf);
    // One target whatever the language is an ordinary redirect of the root, not a locale redirector.
    if (targets.size < 2) return pass([probeEvidence(evidence, probes[0]!, evidenceLabel('root response, the same for every Accept-Language'))]);
    const results: RuleResult[] = [];
    const permanent = redirecting.filter(probe => (probe.fetch.hops[0]!.status === 301 || probe.fetch.hops[0]!.status === 308) && sharedCacheable(probe.fetch.hops[0]!.status, probe.fetch.hops[0]!.headers));
    if (permanent.length > 0) {
      results.push(fail('low', permanent.slice(0, maxEvidence).map(probe => probeEvidence(evidence, probe, evidenceLabel('permanent, cacheable redirect of the root that depends on Accept-Language'))),
        { status: permanent[0]!.fetch.hops[0]!.status, count: targets.size }, 'permanent-redirect'));
    }
    const unvaried = redirecting.filter(probe => {
      const hop = probe.fetch.hops[0]!;
      return !/accept-language|\*/iu.test(headerValue(hop.headers, 'vary') ?? '') && sharedCacheable(hop.status, hop.headers);
    });
    if (unvaried.length > 0) {
      results.push(fail('low', unvaried.slice(0, maxEvidence).map(probe => {
        const names = ['cache-control', 'vary', 'location'];
        const value = (name: string) => headerValue(probe.fetch.hops[0]!.headers, name);
        return evidence.add({
          kind: 'header', url: probe.url,
          label: joinLabels(evidenceLabel('cacheable root redirect without Vary: Accept-Language (Accept-Language: {value})', { value: acceptLanguage(probe) }),
            ...names.filter(name => value(name) === undefined).map(name => evidenceLabel('(no {header} header)', { header: name }))),
          excerpt: names.filter(name => value(name) !== undefined).map(name => `${name}: ${value(name)}`).join('\n'),
        });
      }), { count: unvaried.length }, 'missing-vary'));
    }
    return results.length > 0 ? results : pass(redirecting.slice(0, 3).map(probe => probeEvidence(evidence, probe, evidenceLabel('temporary or uncacheable locale redirect of the root'))));
  },
};

interface ProbeLanguage {
  readonly probe: ProbeFacts;
  readonly language: string | undefined;
  readonly lang: string | undefined;
  readonly text: string;
}

function probeLanguage(probe: ProbeFacts): ProbeLanguage | undefined {
  const { fetch } = probe;
  if (fetch.status !== 200 || fetch.hops.length !== 1 || !isHtmlResponse(fetch.headers, fetch.body)) return undefined;
  const doc = documentFacts(decodeHtml(fetch.headers, fetch.body));
  const text = mainText(doc);
  const guess = detectLanguage(text);
  return { probe, language: guess.language !== 'und' && guess.confidence >= 0.9 ? guess.language : undefined, lang: primaryLanguage(doc.parsed.htmlLang), text };
}

export const localeAdaptiveSameUrl: RuleImplementation = {
  id: 'intl-locale-adaptive-same-url',
  evaluate({ site, evidence }) {
    if (site.localeProbes.length === 0) return notEvaluated('no-locale-probes');
    const results: RuleResult[] = [];
    let compared = 0;
    for (const [url, probes] of probesByUrl(site)) {
      const served = probes.map(probeLanguage).filter((entry): entry is ProbeLanguage => entry !== undefined);
      if (served.length < 2) continue;
      compared += 1;
      const detected = groupBy(served.filter(entry => entry.language), entry => entry.language!);
      const label = (entry: ProbeLanguage, what: EvidenceLabel) => evidence.add({ kind: 'probe', url, label: joinLabels(what, evidenceLabel('(Accept-Language: {value})', { value: acceptLanguage(entry.probe) })), excerpt: entry.text.slice(0, 300) });
      if (detected.size > 1) {
        const shown = [...detected.values()].map(group => group[0]!);
        results.push(fail('high', shown.map(entry => label(entry, evidenceLabel('main content served at this URL, detected as {language}', { language: languageLabel(entry.language!) }))),
          { url, languages: list(shown.map(entry => languageLabel(entry.language!))) }, 'content-language'));
        continue;
      }
      // When detection is inconclusive, a lang attribute that changes together with the text is the signal.
      const byLang = groupBy(served.filter(entry => entry.lang), entry => entry.lang!);
      if (byLang.size < 2) continue;
      const shown = [...byLang.values()].map(group => group[0]!);
      const similarity = jaccard(shingles(shown[0]!.text), shingles(shown[1]!.text));
      if (similarity >= 0.5) continue;
      results.push(fail('high', shown.map(entry => label(entry, evidenceLabel('main content served at this URL with lang="{lang}"', { lang: entry.lang! }))),
        { url, languages: list(shown.map(entry => entry.lang!)) }, 'lang-attribute'));
    }
    if (results.length > 0) return results;
    return compared === 0 ? notEvaluated('no-comparable-responses') : pass();
  },
};

const localeParameter = /^(lang|language|hl|locale|lng|lc|idioma|langue|sprache)$/iu;

function parameterLocale(url: string): string | undefined {
  try {
    for (const [name, value] of new URL(url).searchParams) if (localeParameter.test(name) && /^[a-z]{2,3}([-_][a-z0-9]{2,4})?$/iu.test(value)) return name;
  } catch {
    return undefined;
  }
  return undefined;
}

export const separateUrlsPerLocale: RuleImplementation = {
  id: 'intl-separate-urls-per-locale',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    const ids: string[] = [];
    const urls = new Set<string>();
    for (const set of sets.values()) {
      for (const annotation of set.annotations) {
        if (!annotation.href || !parameterLocale(annotation.href) || urls.has(annotation.href)) continue;
        urls.add(annotation.href);
        if (ids.length < maxEvidence) ids.push(annotationEvidence(evidence, annotation, evidenceLabel('hreflang target that selects the locale with a URL parameter')));
      }
    }
    let switcherLinks = 0;
    for (const page of fetchedPages(site)) {
      const base = documentBase(page.raw, page.fetch.finalUrl);
      for (const anchor of page.raw?.parsed.anchors ?? []) {
        const href = absoluteUrl(anchor.attrs.href, base);
        if (!href || !sameSite(href, page.fetch.finalUrl) || !parameterLocale(href) || urls.has(href)) continue;
        urls.add(href);
        switcherLinks += 1;
        if (ids.length < maxEvidence) ids.push(evidence.add({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('link that selects the locale with a URL parameter'), excerpt: page.raw!.html.slice(anchor.offset, page.raw!.html.indexOf('>', anchor.offset) + 1), line: anchor.line }));
      }
    }
    if (urls.size > 0) return fail('medium', ids, { count: urls.size, urls: list(urls), links: switcherLinks }, 'locale-parameter');
    return sets.size === 0 ? notApplicable('no-locale-signals') : pass();
  },
};

export const redirectImplementations: readonly RuleImplementation[] = [autoRedirectByLanguage, rootLocaleRedirector, localeAdaptiveSameUrl, separateUrlsPerLocale];
