import type { PageFacts, SiteFacts } from '../../core/facts.ts';
import type { FetchResult } from '../../fetch/http.ts';
import { effectiveAnnotations, normalizeUrl, sitemapAnnotations, type Annotation } from './annotations.ts';
import { parseHreflang } from './codes.ts';

// Facts are immutable once collected, so per-site indexes are computed once and shared by every rule and page.
const memo = <K extends object, V>(compute: (key: K) => V) => {
  const cache = new WeakMap<K, V>();
  return (key: K): V => {
    if (!cache.has(key)) cache.set(key, compute(key));
    return cache.get(key)!;
  };
};

/** Every page whose HTML Altimeter fetched: audited pages, the siblings fetched for comparison and the hreflang alternates. */
export const fetchedPages = memo((site: SiteFacts): readonly PageFacts[] => [...new Set([...site.pages.values(), ...site.siblings, ...(site.alternates ?? [])])]);

const byFinalUrl = memo((site: SiteFacts) => {
  const index = new Map<string, PageFacts>();
  for (const page of fetchedPages(site)) {
    const url = normalizeUrl(page.fetch.finalUrl);
    if (url && page.fetch.status === 200 && !index.has(url)) index.set(url, page);
  }
  return index;
});

const byRequestedUrl = memo((site: SiteFacts) => {
  const index = new Map<string, PageFacts>();
  for (const page of fetchedPages(site)) {
    for (const url of [normalizeUrl(page.fetch.requestedUrl), normalizeUrl(page.url)]) if (url && !index.has(url)) index.set(url, page);
  }
  return index;
});

/** The fetched page whose final URL is `url` and that answered 200. */
export function documentAt(site: SiteFacts, url: string): PageFacts | undefined {
  return byFinalUrl(site).get(url);
}

export interface ObservedFetch {
  readonly fetch: FetchResult;
  /** What the request was: a page fetch, a URL variant probe or a language probe without Accept-Language. */
  readonly via: 'page' | 'variant' | 'locale-probe';
  readonly page?: PageFacts;
}

/** A request for exactly `url` made with default crawler headers, when one was made. */
export function fetchOf(site: SiteFacts, url: string): ObservedFetch | undefined {
  const page = byRequestedUrl(site).get(url);
  if (page) return { fetch: page.fetch, via: 'page', page };
  for (const probe of site.localeProbes) {
    if (probe.label === 'accept-language:none' && normalizeUrl(probe.url) === url) return { fetch: probe.fetch, via: 'locale-probe' };
  }
  for (const probe of site.variants) if (normalizeUrl(probe.url) === url) return { fetch: probe.fetch, via: 'variant' };
  return undefined;
}

/** Status of the first response to a request, before any redirect was followed. */
export function firstStatus(fetch: FetchResult): number | undefined {
  return fetch.hops[0]?.status ?? fetch.status;
}

export interface DeclaredSet {
  readonly url: string;
  readonly annotations: readonly Annotation[];
  /** The fetched page at this URL, when the set comes from its HTML or headers. */
  readonly page?: PageFacts;
}

/**
 * The hreflang set each known URL declares: fetched pages (HTML, rendered fallback, Link header and sitemap) and
 * sitemap entries for URLs that were not fetched.
 */
export const declaredSets = memo((site: SiteFacts): ReadonlyMap<string, DeclaredSet> => {
  const sets = new Map<string, DeclaredSet>();
  for (const page of fetchedPages(site)) {
    if (page.fetch.status !== 200 || (!page.raw && !(page.fetch.headers.link?.length))) continue;
    const url = normalizeUrl(page.fetch.finalUrl);
    if (!url || sets.has(url)) continue;
    const annotations = effectiveAnnotations(page, site);
    if (annotations.length > 0) sets.set(url, { url, annotations, page });
  }
  for (const sitemap of site.sitemaps) {
    for (const entry of sitemap.document?.urls ?? []) {
      const url = normalizeUrl(entry.loc);
      if (!url || sets.has(url) || entry.alternates.length === 0) continue;
      sets.set(url, { url, annotations: sitemapAnnotations(site, url) });
    }
  }
  return sets;
});

export function isXDefault(annotation: Annotation): boolean {
  return parseHreflang(annotation.value).xDefault;
}

/**
 * Groups URLs into clusters: connected components of the hreflang graph over language entries. x-default edges
 * are left out, because many clusters share one x-default (often the home page) without being one cluster.
 */
export const clusters = memo((sets: ReadonlyMap<string, DeclaredSet>): readonly string[][] => {
  const parent = new Map<string, string>();
  const find = (url: string): string => {
    if (!parent.has(url)) parent.set(url, url);
    let root = url;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(url, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const set of sets.values()) {
    find(set.url);
    for (const annotation of set.annotations) if (annotation.href && !isXDefault(annotation)) union(set.url, annotation.href);
  }
  const groups = new Map<string, string[]>();
  for (const url of parent.keys()) {
    const root = find(url);
    groups.set(root, [...(groups.get(root) ?? []), url]);
  }
  return [...groups.values()].map(group => group.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
});

/** All annotations declared by members of one cluster. */
export function clusterAnnotations(sets: ReadonlyMap<string, DeclaredSet>, cluster: readonly string[]): Annotation[] {
  return cluster.flatMap(url => sets.get(url)?.annotations ?? []);
}

const byTarget = memo((sets: ReadonlyMap<string, DeclaredSet>) => {
  const index = new Map<string, Annotation[]>();
  for (const set of sets.values()) {
    for (const annotation of set.annotations) if (annotation.href) index.set(annotation.href, [...(index.get(annotation.href) ?? []), annotation]);
  }
  return index;
});

/** Values the cluster assigns to `url`, from every member's set. */
export function valuesFor(sets: ReadonlyMap<string, DeclaredSet>, url: string): readonly Annotation[] {
  return byTarget(sets).get(url) ?? [];
}

/** The site's own pages are https when the audited page is. */
export function siteScheme(site: SiteFacts): string {
  return new URL(site.origin).protocol;
}
