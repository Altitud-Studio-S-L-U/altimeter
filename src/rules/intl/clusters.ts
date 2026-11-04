import type { EvidenceStore } from '../../core/evidence.ts';
import type { SiteFacts } from '../../core/facts.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, linksWithRel } from '../helpers.ts';
import { annotationEvidence, effectiveAnnotations, normalizeUrl, pageAnnotations, type Annotation, type AnnotationSource } from './annotations.ts';
import { clusters, declaredSets, documentAt, fetchOf, isXDefault, type DeclaredSet } from './cluster.ts';
import { parseHreflang, primaryLanguage, sameLanguage } from './codes.ts';
import { fail, groupBy, list, maxEvidence, notApplicable, notEvaluated, pass } from './shared.ts';

/** A loose form of a URL, to explain near misses: no scheme, no www, no trailing slash or index file, lowercase. */
function loose(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\/(www\.)?/u, '').replace(/\/(index\.html?)?$/u, '');
}

function setEvidence(evidence: EvidenceStore, set: DeclaredSet, label: string): string {
  return evidence.add({
    kind: set.annotations[0]?.source === 'sitemap' ? 'sitemap' : 'html',
    url: set.url,
    label,
    excerpt: set.annotations.map(annotation => annotation.excerpt).join('\n'),
  });
}

export const missingSelfReference: RuleImplementation = {
  id: 'intl-hreflang-missing-self-reference',
  evaluate({ page, site, evidence }) {
    const annotations = effectiveAnnotations(page!, site);
    if (annotations.length === 0) return notApplicable('no-hreflang');
    if (page!.fetch.status !== 200) return notApplicable('page-not-200');
    const self = normalizeUrl(page!.fetch.finalUrl)!;
    const selfEntry = annotations.find(annotation => annotation.href === self);
    if (selfEntry) return pass([annotationEvidence(evidence, selfEntry, 'hreflang entry for the page itself')]);
    const canonical = normalizeUrl(absoluteUrl(linksWithRel(page!.raw, 'canonical')[0]?.attrs.href, self));
    // A page that canonicalises elsewhere is reported by intl-hreflang-on-non-canonical-page instead.
    if (canonical && canonical !== self && annotations.some(annotation => annotation.href === canonical)) return notApplicable('page-not-canonical');
    const near = annotations.find(annotation => annotation.href && loose(annotation.href) === loose(self));
    const ids = annotations.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, near === annotation ? 'hreflang entry that almost matches the page URL' : 'hreflang entry for another URL'));
    ids.push(evidence.add({ kind: 'http', url: self, label: 'final URL of the page', excerpt: self }));
    return near
      ? fail('medium', ids, { url: self, closest: near.href!, value: near.value }, 'near-miss')
      : fail('medium', ids, { url: self, count: annotations.length }, 'absent');
  },
};

export const oneUrlManyLanguages: RuleImplementation = {
  id: 'intl-hreflang-one-url-many-languages',
  evaluate({ page, site, evidence }) {
    const annotations = effectiveAnnotations(page!, site).filter(annotation => annotation.href && !isXDefault(annotation));
    if (annotations.length === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = [];
    for (const [href, group] of groupBy(annotations, annotation => annotation.href!)) {
      const languages: string[] = [];
      for (const annotation of group) {
        const language = primaryLanguage(annotation.value);
        if (language && !languages.some(known => sameLanguage(known, language))) languages.push(language);
      }
      if (languages.length < 2) continue;
      results.push(fail('medium', group.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang entry for a URL that is declared in several languages')),
        { target: href, languages: list(languages, 5), count: languages.length }));
    }
    return results.length > 0 ? results : pass();
  },
};

interface Edge {
  readonly from: DeclaredSet;
  readonly annotation: Annotation;
  readonly to: string;
}

type EdgeState = 'ok' | 'missing' | 'unverified';

function returnState(site: SiteFacts, sets: ReadonlyMap<string, DeclaredSet>, edge: Edge): EdgeState {
  const target = sets.get(edge.to);
  if (target) return target.annotations.some(annotation => annotation.href === edge.from.url) ? 'ok' : 'missing';
  // A target fetched at its own URL that declares no hreflang at all has no return link either.
  if (documentAt(site, edge.to)) return 'missing';
  return 'unverified';
}

export const missingReturnLink: RuleImplementation = {
  id: 'intl-hreflang-missing-return-link',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = [];
    let verified = 0;
    for (const cluster of clusters(sets)) {
      // x-default entries often point at a shared entry page; Google pairs language versions, so only those are checked.
      const edges: Edge[] = cluster.flatMap(url => (sets.get(url)?.annotations ?? [])
        .filter(annotation => annotation.href && annotation.href !== url && !isXDefault(annotation))
        .map(annotation => ({ from: sets.get(url)!, annotation, to: annotation.href! })));
      const unique = [...new Map(edges.map(edge => [`${edge.from.url} ${edge.to}`, edge])).values()];
      const states = unique.map(edge => ({ edge, state: returnState(site, sets, edge) }));
      const missing = states.filter(entry => entry.state === 'missing');
      const ok = states.filter(entry => entry.state === 'ok').length;
      verified += missing.length + ok;
      if (missing.length === 0) continue;
      const ids: string[] = [];
      for (const { edge } of missing.slice(0, maxEvidence)) {
        ids.push(annotationEvidence(evidence, edge.annotation, `hreflang entry pointing to ${edge.to}, which does not link back`));
        const target = sets.get(edge.to);
        ids.push(target
          ? setEvidence(evidence, target, `hreflang set of ${edge.to}, without an entry for ${edge.from.url}`)
          : evidence.add({ kind: 'html', url: edge.to, label: 'target page fetched without any hreflang annotation' }));
      }
      results.push(fail('high', ids, {
        count: missing.length,
        working: ok,
        unverified: states.filter(entry => entry.state === 'unverified').length,
        pairs: list(missing.map(({ edge }) => `${edge.from.url} -> ${edge.to}`), 2),
      }));
    }
    if (results.length > 0) return results;
    return verified === 0 ? notEvaluated('targets-not-fetched') : pass();
  },
};

/** Groups annotations by lowercase value, keeping only values that point to more than one URL. */
function conflictingValues(annotations: readonly Annotation[]): Map<string, Annotation[]> {
  const groups = groupBy(annotations.filter(annotation => annotation.href), annotation => annotation.value.toLowerCase());
  return new Map([...groups].filter(([, group]) => new Set(group.map(annotation => annotation.href)).size > 1));
}

export const duplicateLocaleInCluster: RuleImplementation = {
  id: 'intl-hreflang-duplicate-locale-in-cluster',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = [];
    const reported = new Set<string>();
    for (const set of sets.values()) {
      for (const [value, group] of conflictingValues(set.annotations)) {
        reported.add(value);
        results.push(fail('high', group.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, `hreflang "${value}" pointing to one of several URLs`)),
          { value, count: new Set(group.map(annotation => annotation.href)).size, urls: list(group.map(annotation => annotation.href!), 3), declaredBy: set.url }, 'within-page'));
      }
    }
    // Across members, different x-default targets are judged by intl-hreflang-x-default-inconsistent.
    for (const cluster of clusters(sets)) {
      const annotations = cluster.flatMap(url => sets.get(url)?.annotations ?? []).filter(annotation => !isXDefault(annotation));
      for (const [value, group] of conflictingValues(annotations)) {
        if (reported.has(value)) continue;
        const byTarget = [...groupBy(group, annotation => annotation.href!).values()].map(entries => entries[0]!);
        results.push(fail('medium', byTarget.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, `hreflang "${value}" as declared by ${annotation.declaringUrl}`)),
          { value, count: byTarget.length, urls: list(byTarget.map(annotation => annotation.href!), 3), declaredBy: list(byTarget.map(annotation => annotation.declaringUrl), 3) }, 'across-cluster'));
      }
    }
    return results.length > 0 ? results : pass();
  },
};

export const clusterInconsistentSets: RuleImplementation = {
  id: 'intl-hreflang-cluster-inconsistent-sets',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = [];
    let compared = 0;
    for (const cluster of clusters(sets)) {
      const members = cluster.map(url => sets.get(url)).filter((set): set is DeclaredSet => set !== undefined);
      if (members.length < 2) continue;
      compared += 1;
      const valuesOf = (set: DeclaredSet, href: string) => new Set(set.annotations.filter(annotation => annotation.href === href).map(annotation => annotation.value.toLowerCase()));
      const union = new Set(members.flatMap(set => set.annotations.map(annotation => annotation.href).filter((href): href is string => href !== undefined)));
      const conflicts: Annotation[] = [];
      const conflictTargets = new Set<string>();
      for (const href of union) {
        const views = members.map(set => ({ set, values: valuesOf(set, href) })).filter(view => view.values.size > 0);
        for (const [index, view] of views.entries()) {
          for (const other of views.slice(index + 1)) {
            if ([...view.values].some(value => other.values.has(value))) continue;
            conflictTargets.add(href);
            conflicts.push(...[view, other].flatMap(entry => entry.set.annotations.filter(annotation => annotation.href === href)));
          }
        }
      }
      if (conflicts.length > 0) {
        const unique = [...new Set(conflicts)];
        results.push(fail('medium', unique.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, `hreflang value for ${annotation.href} as declared by ${annotation.declaringUrl}`)),
          { count: conflictTargets.size, targets: list(conflictTargets, 3), members: members.length }, 'conflicting-values'));
      }
      const lacking = members.map(set => ({ set, missing: [...union].filter(href => valuesOf(set, href).size === 0) })).filter(entry => entry.missing.length > 0);
      if (lacking.length > 0) {
        results.push(fail('low', lacking.slice(0, maxEvidence).map(entry => setEvidence(evidence, entry.set, `hreflang set of ${entry.set.url}, lacking ${entry.missing.length} URL(s) other members list`)),
          { count: lacking.length, members: members.length, missing: list(lacking.flatMap(entry => entry.missing), 3) }, 'missing-entries'));
      }
    }
    if (results.length > 0) return results;
    return compared === 0 ? notEvaluated('single-member-clusters') : pass();
  },
};

/** The site root's redirect to a locale URL, when the root redirects. */
export function rootRedirect(site: SiteFacts): { readonly from: string; readonly to: string; readonly status: number } | undefined {
  const root = new URL('/', site.origin).href;
  const observed = fetchOf(site, root);
  const hop = observed?.fetch.hops[0];
  if (!observed || !hop?.location || hop.status < 300 || hop.status >= 400) return undefined;
  const to = normalizeUrl(observed.fetch.finalUrl);
  if (!to || to === root || new URL(to).pathname === '/') return undefined;
  return { from: root, to, status: hop.status };
}

export const xDefaultMissing: RuleImplementation = {
  id: 'intl-hreflang-x-default-missing',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const redirect = rootRedirect(site);
    const home = new Set([normalizeUrl(site.homeUrl), normalizeUrl(new URL('/', site.origin).href), redirect?.to].filter(Boolean));
    const results: RuleResult[] = [];
    for (const cluster of clusters(sets)) {
      const annotations = cluster.flatMap(url => sets.get(url)?.annotations ?? []);
      if (annotations.length === 0 || annotations.some(isXDefault)) continue;
      const isHome = cluster.some(url => home.has(url));
      const ids = [evidence.add({ kind: 'html', url: cluster[0]!, label: 'hreflang values declared in the cluster, none of them x-default', excerpt: list(annotations.map(annotation => annotation.value), 12) })];
      if (isHome && redirect) {
        ids.push(evidence.add({ kind: 'redirect', url: redirect.from, label: 'site root redirecting to a locale URL', excerpt: `${redirect.status} ${redirect.to}` }));
        results.push(fail('low', ids, { url: cluster[0]!, members: cluster.length, root: redirect.from }, 'redirecting-root'));
      } else results.push(fail('info', ids, { url: cluster[0]!, members: cluster.length }, 'no-x-default'));
    }
    return results.length > 0 ? results : pass();
  },
};

export const xDefaultInconsistent: RuleImplementation = {
  id: 'intl-hreflang-x-default-inconsistent',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = [];
    let withXDefault = 0;
    for (const cluster of clusters(sets)) {
      const defaults = cluster.flatMap(url => sets.get(url)?.annotations ?? []).filter(annotation => isXDefault(annotation) && annotation.href);
      if (defaults.length === 0) continue;
      withXDefault += 1;
      const byTarget = groupBy(defaults, annotation => annotation.href!);
      if (byTarget.size < 2) continue;
      const shown = [...byTarget.values()].map(group => group[0]!);
      results.push(fail('medium', shown.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, `x-default as declared by ${annotation.declaringUrl}`)),
        { count: byTarget.size, urls: list(byTarget.keys(), 3) }));
    }
    if (results.length > 0) return results;
    return withXDefault === 0 ? notApplicable('no-x-default') : pass();
  },
};

export const noLanguageCatchall: RuleImplementation = {
  id: 'intl-hreflang-no-language-catchall',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = [];
    for (const cluster of clusters(sets)) {
      const annotations = cluster.flatMap(url => sets.get(url)?.annotations ?? []);
      if (annotations.some(isXDefault)) continue;
      for (const [language, group] of groupBy(annotations.filter(annotation => parseHreflang(annotation.value).language), annotation => parseHreflang(annotation.value).language!)) {
        if (group.some(annotation => parseHreflang(annotation.value).region === undefined)) continue;
        const values = [...new Set(group.map(annotation => annotation.value))];
        results.push(fail('low', [...groupBy(group, annotation => annotation.value.toLowerCase()).values()].map(entries => entries[0]!).slice(0, maxEvidence)
          .map(annotation => annotationEvidence(evidence, annotation, `region-specific hreflang for ${language} without a language-only value`)),
        { language, values: list(values.map(value => `"${value}"`), 4) }));
      }
    }
    return results.length > 0 ? results : pass();
  },
};

const sourceGroup = (source: AnnotationSource): 'html' | 'header' | 'sitemap' => (source === 'rendered' ? 'html' : source);

export const sourceConflict: RuleImplementation = {
  id: 'intl-hreflang-source-conflict',
  evaluate({ page, site, evidence }) {
    const all = pageAnnotations(page!, site);
    const hasRaw = all.some(annotation => annotation.source === 'html');
    const annotations = all.filter(annotation => annotation.source !== 'rendered' || !hasRaw);
    const bySource = groupBy(annotations, annotation => sourceGroup(annotation.source));
    if (bySource.size === 0) return notApplicable('no-hreflang');
    if (bySource.size < 2) return notApplicable('single-source');
    const results: RuleResult[] = [];
    const sources = [...bySource.keys()];
    for (const [index, a] of sources.entries()) {
      for (const b of sources.slice(index + 1)) {
        const mapOf = (name: string) => groupBy(bySource.get(name)!, annotation => annotation.value.toLowerCase());
        const left = mapOf(a);
        const right = mapOf(b);
        const conflicts: Annotation[] = [];
        const onlyOne: Annotation[] = [];
        for (const [value, entries] of left) {
          const other = right.get(value);
          if (!other) onlyOne.push(...entries);
          else if (!entries.some(entry => other.some(candidate => candidate.href === entry.href))) conflicts.push(...entries, ...other);
        }
        for (const [value, entries] of right) if (!left.has(value)) onlyOne.push(...entries);
        if (conflicts.length > 0) {
          results.push(fail('medium', conflicts.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang target that another source contradicts')),
            { first: a, second: b, values: list(conflicts.map(annotation => `"${annotation.value}"`)) }, 'conflicting-target'));
        }
        if (onlyOne.length > 0) {
          results.push(fail('info', onlyOne.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang value present in only one source')),
            { first: a, second: b, values: list(onlyOne.map(annotation => `"${annotation.value}"`)) }, 'incomplete-source'));
        }
      }
    }
    return results.length > 0 ? results : pass();
  },
};

export const clusterImplementations: readonly RuleImplementation[] = [
  missingSelfReference, oneUrlManyLanguages, missingReturnLink, duplicateLocaleInCluster, clusterInconsistentSets,
  xDefaultMissing, xDefaultInconsistent, noLanguageCatchall, sourceConflict,
];
