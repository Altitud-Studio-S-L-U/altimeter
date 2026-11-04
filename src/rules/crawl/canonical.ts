import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts, SiteFacts } from '../../core/facts.ts';
import { linkGraph } from '../../analyze/graph.ts';
import { urlVariants } from '../../collect/probes.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, pageDocument, sameSite, summarizeList } from '../helpers.ts';
import {
  canonicalLinks, canonicalTargets, declaredCanonical, documentBase, effectiveDirectives, factsAt, failure, isLocaleEntryRedirect, isStagingHost,
  knownResponses, normalizeUrl, notApplicable, notEvaluated, passed, robotsDecision, sitemapEntryFor, usableCanonical, type CanonicalTarget,
} from './shared.ts';

function renderedDoc(page: PageFacts): DocumentFacts | undefined {
  return page.rendered && page.rendered.result.error === undefined ? page.rendered : undefined;
}

function citeTarget(evidence: Parameters<RuleImplementation['evaluate']>[0]['evidence'], url: string, target: CanonicalTarget): string {
  const label = target.source === 'header' ? evidenceLabel('canonical in the Link header')
    : target.source === 'raw' ? evidenceLabel('rel=canonical in the raw HTML') : evidenceLabel('rel=canonical in the rendered DOM');
  return evidence.add({ kind: target.source === 'header' ? 'header' : target.source === 'raw' ? 'html' : 'render', url, label, excerpt: target.href, ...(target.line ? { line: target.line } : {}) });
}

const headInvalidElement: RuleImplementation = {
  id: 'crawl-head-invalid-element',
  evaluate({ page, evidence }) {
    const target = page!;
    const closure = target.raw!.parsed.headClosure;
    if (!closure) return passed();
    const url = target.fetch.finalUrl;
    const cause = closure.cause.kind === 'element' ? `<${closure.cause.tag}>` : closure.cause.text;
    const ids = [evidence.add({ kind: 'html', url, label: evidenceLabel('first content that ends the head early'), excerpt: cause, line: closure.cause.line })];
    const rel = (attrs: Readonly<Record<string, string>>) => (attrs.rel ?? '').toLowerCase().split(/\s+/u);
    const important = closure.displaced.filter(entry => entry.tag === 'link' && (rel(entry.attrs).includes('canonical') || (rel(entry.attrs).includes('alternate') && entry.attrs.hreflang !== undefined)));
    const shown = important.length > 0 ? important : closure.displaced;
    for (const entry of shown.slice(0, 5)) {
      ids.push(evidence.add({ kind: 'html', url, label: evidenceLabel('head metadata that the parser placed in the body'), excerpt: `<${entry.tag} ${Object.entries(entry.attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}>`, line: entry.line }));
    }
    return failure({
      severity: important.length > 0 ? 'high' : 'low', evidence: ids, reason: important.length > 0 ? 'canonical-or-hreflang-ignored' : 'metadata-displaced',
      params: { url, cause, line: closure.cause.line, count: closure.displaced.length },
    });
  },
};

function indexableCandidate(page: PageFacts): string | undefined {
  if (page.fetch.status !== 200) return 'non-200';
  if (['utility', 'error'].includes(page.pageType)) return 'utility-or-error-page';
  if (effectiveDirectives(page, pageDocument(page)).has('noindex')) return 'noindex';
  return undefined;
}

const canonicalPresence: RuleImplementation = {
  id: 'crawl-canonical-presence',
  evaluate({ site, page, evidence }) {
    const target = page!;
    const skip = indexableCandidate(target);
    if (skip) return notApplicable(skip);
    const url = target.fetch.finalUrl;
    const declared = [...canonicalTargets(target, target.raw, 'raw'), ...canonicalTargets(target, renderedDoc(target), 'rendered')];
    if (declared.length > 0) return passed([citeTarget(evidence, url, declared[0]!)]);
    const own = new Set(urlVariants(url).map(variant => variant.url));
    const duplicates = site.variants.filter(variant => own.has(variant.url) && variant.fetch.status === 200 && variant.fetch.hops.length === 1);
    const ids = [evidence.add({ kind: 'html', url, label: evidenceLabel('canonical declarations found in the raw HTML, rendered DOM and Link header'), excerpt: '(none)' })];
    for (const variant of duplicates.slice(0, 3)) ids.push(evidence.add({ kind: 'probe', url: variant.url, label: evidenceLabel('URL variant ({variant}) answering 200 without a redirect', { variant: variant.label }), excerpt: `HTTP ${variant.fetch.status}` }));
    return failure({ severity: duplicates.length > 0 ? 'medium' : 'low', evidence: ids, reason: duplicates.length > 0 ? 'duplicates-answer' : 'missing', params: { url, variants: duplicates.length } });
  },
};

const canonicalMultiple: RuleImplementation = {
  id: 'crawl-canonical-multiple',
  evaluate({ page, evidence }) {
    const target = page!;
    const url = target.fetch.finalUrl;
    const sets = [canonicalTargets(target, target.raw, 'raw'), canonicalTargets(target, renderedDoc(target), 'rendered')].filter(set => set.length > 0);
    if (sets.length === 0) return notApplicable('no-canonical');
    for (const set of sets) {
      const distinct = new Set(set.map(entry => entry.url ?? entry.href));
      if (distinct.size > 1) {
        return failure({ severity: 'high', evidence: set.map(entry => citeTarget(evidence, url, entry)), reason: 'conflicting-targets', params: { url, count: distinct.size, targets: summarizeList([...distinct]) } });
      }
    }
    const repeated = sets.find(set => set.length > 1);
    if (repeated) return failure({ severity: 'low', evidence: repeated.map(entry => citeTarget(evidence, url, entry)), reason: 'repeated', params: { url, count: 1, targets: repeated[0]!.url ?? repeated[0]!.href } });
    return passed([citeTarget(evidence, url, sets[0]![0]!)]);
  },
};

const canonicalJsChanged: RuleImplementation = {
  id: 'crawl-canonical-js-changed',
  evaluate({ page, evidence }) {
    const target = page!;
    const url = target.fetch.finalUrl;
    const raw = canonicalTargets(target, target.raw, 'raw').find(entry => entry.source === 'raw');
    const rendered = canonicalTargets(target, renderedDoc(target), 'rendered').find(entry => entry.source === 'rendered');
    if (!raw && !rendered) return notApplicable('no-canonical');
    if (raw && rendered && (raw.url ?? raw.href) === (rendered.url ?? rendered.href)) return passed([citeTarget(evidence, url, raw)]);
    if (raw && !rendered) {
      const none = evidence.add({ kind: 'render', url, label: evidenceLabel('rel=canonical in the rendered DOM'), excerpt: '(none)' });
      return failure({ severity: 'high', evidence: [citeTarget(evidence, url, raw), none], reason: 'removed', params: { url, raw: raw.href, rendered: '(none)' } });
    }
    if (!raw) return failure({ severity: 'low', evidence: [citeTarget(evidence, url, rendered!)], reason: 'added', params: { url, raw: '(none)', rendered: rendered!.href } });
    return failure({ severity: 'high', evidence: [citeTarget(evidence, url, raw), citeTarget(evidence, url, rendered!)], reason: 'changed', params: { url, raw: raw.href, rendered: rendered!.href } });
  },
};

const placeholder = /\{\{|\}\}|\$\{|%7B%7B|^(?:undefined|null|about:blank|#)$|\[\[|<%/iu;

function formatProblem(href: string, base: string): { severity: 'medium' | 'low'; reason: string } | undefined {
  const value = href.trim();
  if (value === '') return { severity: 'medium', reason: 'empty' };
  if (placeholder.test(value)) return { severity: 'medium', reason: 'placeholder' };
  const resolved = absoluteUrl(value, base);
  if (!resolved) return { severity: 'medium', reason: 'unparseable' };
  if (!/^https?:$/u.test(new URL(resolved).protocol)) return { severity: 'medium', reason: 'not-http' };
  if (value.includes('#')) return { severity: 'medium', reason: 'fragment' };
  if (!/^https?:\/\//iu.test(value)) return { severity: 'low', reason: 'relative' };
  return undefined;
}

const canonicalFormat: RuleImplementation = {
  id: 'crawl-canonical-format',
  evaluate({ page, evidence }) {
    const target = page!;
    const url = target.fetch.finalUrl;
    const declared = canonicalTargets(target, target.raw, 'raw');
    if (declared.length === 0) return notApplicable('no-canonical');
    const base = documentBase(target.raw, url);
    const problems = declared.map(entry => ({ entry, problem: formatProblem(entry.href, entry.source === 'header' ? url : base) }))
      .filter((item): item is typeof item & { problem: NonNullable<ReturnType<typeof formatProblem>> } => item.problem !== undefined);
    if (problems.length === 0) return passed([citeTarget(evidence, url, declared[0]!)]);
    const chosen = problems.find(item => item.problem.severity === 'medium') ?? problems[0]!;
    return failure({ severity: chosen.problem.severity, evidence: problems.map(item => citeTarget(evidence, url, item.entry)), reason: chosen.problem.reason, params: { url, href: chosen.entry.href } });
  },
};

const canonicalPlacement: RuleImplementation = {
  id: 'crawl-canonical-ignored-attributes-placement',
  evaluate({ page, evidence }) {
    const target = page!;
    const url = target.fetch.finalUrl;
    // Canonicals that an early-closed head pushed into the body belong to crawl-head-invalid-element.
    const displaced = new Set((target.raw!.parsed.headClosure?.displaced ?? []).filter(entry => entry.tag === 'link').map(entry => entry.attrs.href));
    const docs = [{ doc: target.raw, kind: 'html' as const }, { doc: renderedDoc(target), kind: 'render' as const }].filter(item => item.doc !== undefined);
    const all = docs.flatMap(item => canonicalLinks(item.doc).map(link => ({ link, kind: item.kind })));
    if (all.length === 0) return notApplicable('no-canonical');
    const unusable = all.filter(item => !usableCanonical(item.link) && !(!item.link.inHead && displaced.has(item.link.attrs.href)));
    if (unusable.length === 0) return passed();
    const attributes = (item: (typeof unusable)[number]) => ['hreflang', 'lang', 'media', 'type'].filter(name => item.link.attrs[name] !== undefined).join(', ');
    const why = (item: (typeof unusable)[number]) => (item.link.inHead ? `carries ${attributes(item)}` : 'in the body');
    const ids = unusable.slice(0, 4).map(item => evidence.add({ kind: item.kind, url,
      label: item.link.inHead ? evidenceLabel('rel=canonical that Google ignores (carries {attributes})', { attributes: attributes(item) }) : evidenceLabel('rel=canonical that Google ignores (in the body)'),
      excerpt: `<link rel="canonical" href="${item.link.attrs.href ?? ''}"${Object.entries(item.link.attrs).filter(([key]) => key !== 'rel' && key !== 'href').map(([key, value]) => ` ${key}="${value}"`).join('')}>`, line: item.link.line }));
    const usable = all.some(item => usableCanonical(item.link));
    return failure({ severity: usable ? 'low' : 'high', evidence: ids, reason: usable ? 'extra-unusable' : 'only-unusable', params: { url, problem: why(unusable[0]!) } });
  },
};

const canonicalTargetHealth: RuleImplementation = {
  id: 'crawl-canonical-target-health',
  evaluate({ site, page, evidence }) {
    const source = page!;
    if (source.fetch.status !== 200) return notApplicable('non-200');
    const declared = canonicalTargets(source, source.raw, 'raw').find(entry => entry.url !== undefined);
    if (!declared) return notApplicable('no-canonical');
    const url = source.fetch.finalUrl;
    const targetUrl = declared.url!;
    const declaredId = citeTarget(evidence, url, declared);
    if (targetUrl === normalizeUrl(url)) return passed([declaredId]);
    const known = knownResponses(site).get(targetUrl);
    if (!known) return notEvaluated('target-not-fetched');
    const statusId = evidence.add({ kind: 'http', url: known.url, label: evidenceLabel('canonical target response'), excerpt: `HTTP ${known.status}${known.location ? ` -> ${known.location}` : ''}` });
    const params = { url, target: targetUrl, status: known.status };
    if (known.status >= 400) return failure({ severity: 'high', evidence: [declaredId, statusId], reason: 'target-error', params });
    if (known.status >= 300) {
      if (isLocaleEntryRedirect(site, targetUrl, known.location)) return passed([declaredId, statusId]);
      return failure({ severity: 'medium', evidence: [declaredId, statusId], reason: 'target-redirects', params: { ...params, location: known.location ?? '' } });
    }
    const blocked = robotsDecision(site, targetUrl);
    if (blocked && !blocked.allowed) {
      const rule = evidence.add({ kind: 'robots', url: site.robots!.url, label: evidenceLabel('rule that disallows the canonical target for Googlebot'), excerpt: `${blocked.rule!.type}: ${blocked.rule!.pattern}`, line: blocked.rule!.line });
      return failure({ severity: 'high', evidence: [declaredId, rule], reason: 'target-blocked', params });
    }
    const facts = factsAt(site, targetUrl);
    if (facts?.raw && effectiveDirectives(facts, facts.raw).has('noindex')) {
      const id = evidence.add({ kind: 'html', url: facts.fetch.finalUrl, label: evidenceLabel('canonical target robots directives'), excerpt: [...effectiveDirectives(facts, facts.raw)].join(', ') });
      return failure({ severity: 'high', evidence: [declaredId, id], reason: 'target-noindex', params });
    }
    return passed([declaredId, statusId]);
  },
};

const canonicalProtocolHost: RuleImplementation = {
  id: 'crawl-canonical-protocol-host',
  evaluate({ site, evidence }) {
    const pages = [...site.pages.values()].filter(page => page.fetch.status === 200);
    const declared = pages.map(page => ({ page, target: declaredCanonical(page) })).filter((item): item is { page: PageFacts; target: string } => item.target !== undefined);
    if (declared.length === 0) return notApplicable('no-canonical');
    for (const { page, target } of declared) {
      if (new URL(page.fetch.finalUrl).protocol === 'https:' && new URL(target).protocol === 'http:') {
        const id = evidence.add({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('canonical target on an HTTPS page'), excerpt: target });
        return failure({ severity: 'high', evidence: [id], reason: 'canonical-to-http', params: { url: page.fetch.finalUrl, target } });
      }
    }
    const hostVariant = site.variants.find(variant => variant.label === 'www' && variant.fetch.status === 200 && variant.fetch.hops.length > 1);
    if (hostVariant) {
      const preferred = new URL(hostVariant.fetch.finalUrl).hostname;
      const mismatch = declared.find(item => new URL(item.target).hostname !== preferred && sameSite(item.target, hostVariant.fetch.finalUrl));
      if (mismatch) {
        const ids = [
          evidence.add({ kind: 'html', url: mismatch.page.fetch.finalUrl, label: evidenceLabel('canonical target'), excerpt: mismatch.target }),
          evidence.add({ kind: 'redirect', url: hostVariant.url, label: evidenceLabel('host variant redirect destination'), excerpt: hostVariant.fetch.finalUrl }),
        ];
        return failure({ severity: 'high', evidence: ids, reason: 'canonical-host-mismatch', params: { url: mismatch.page.fetch.finalUrl, target: mismatch.target, host: preferred } });
      }
    }
    return passed();
  },
};

const secondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'gob', 'ac', 'edu', 'ne', 'or', 'nom']);

/** An approximation of the registrable domain: the last two labels, or three under common second-level labels such as co.uk. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/u, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const take = labels.at(-1)!.length === 2 && secondLevel.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const canonicalCrossDomain: RuleImplementation = {
  id: 'crawl-canonical-cross-domain',
  evaluate({ page, evidence }) {
    const source = page!;
    const declared = [...canonicalTargets(source, source.raw, 'raw'), ...canonicalTargets(source, renderedDoc(source), 'rendered')].find(entry => entry.url !== undefined);
    if (!declared) return notApplicable('no-canonical');
    const url = source.fetch.finalUrl;
    const pageHost = new URL(url).hostname;
    const targetHost = new URL(declared.url!).hostname;
    if (registrableDomain(pageHost) === registrableDomain(targetHost)) return passed([citeTarget(evidence, url, declared)]);
    if (isStagingHost(pageHost)) return passed([citeTarget(evidence, url, declared)]);
    const id = citeTarget(evidence, url, declared);
    if (isStagingHost(targetHost)) return failure({ severity: 'high', evidence: [id], reason: 'canonical-to-staging', params: { url, target: declared.url!, host: targetHost } });
    return failure({ severity: 'medium', evidence: [id], reason: 'cross-domain', params: { url, target: declared.url!, host: targetHost }, needsJudgment: true });
  },
};

const pageParameter = /^(?:page|p|pg|paged|pagina|pag)$/iu;
const viewAll = /view-?all|show-?all|ver-?todo|all=1|viewall/iu;

function firstPageOf(url: string): { first: string; number: number } | undefined {
  const parsed = new URL(url);
  parsed.hash = '';
  for (const [key, value] of parsed.searchParams) {
    if (pageParameter.test(key) && /^\d+$/u.test(value) && Number(value) > 1) {
      parsed.searchParams.delete(key);
      return { first: parsed.href, number: Number(value) };
    }
  }
  const match = /^(.*?\/)(?:page|pagina|p)\/(\d+)\/?$/iu.exec(parsed.pathname);
  if (match && Number(match[2]) > 1) {
    parsed.pathname = match[1]!;
    return { first: parsed.href, number: Number(match[2]) };
  }
  return undefined;
}

const canonicalPagination: RuleImplementation = {
  id: 'crawl-canonical-pagination',
  evaluate({ site, evidence }) {
    const paginated = [...site.pages.values()].filter(page => page.fetch.status === 200).map(page => ({ page, series: firstPageOf(page.fetch.finalUrl) }))
      .filter((item): item is { page: PageFacts; series: { first: string; number: number } } => item.series !== undefined);
    if (paginated.length === 0) return notApplicable('no-paginated-pages');
    const firstVariants = (first: string) => new Set([first, first.replace(/\/$/u, ''), first.endsWith('/') ? first : `${first}/`].map(normalizeUrl));
    const collapsed = paginated.filter(item => {
      const target = declaredCanonical(item.page);
      return target !== undefined && !viewAll.test(target) && firstVariants(item.series.first).has(normalizeUrl(target));
    });
    if (collapsed.length === 0) return passed();
    const ids = collapsed.slice(0, 5).map(item => evidence.add({ kind: 'html', url: item.page.fetch.finalUrl, label: evidenceLabel('canonical of page {number} of a series', { number: item.series.number }), excerpt: declaredCanonical(item.page)! }));
    return failure({ severity: 'medium', evidence: ids, params: { url: collapsed[0]!.page.fetch.finalUrl, count: collapsed.length } });
  },
};

function canonicalMap(site: SiteFacts): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of site.pages.values()) {
    const target = declaredCanonical(page);
    const from = normalizeUrl(page.fetch.finalUrl);
    if (target && from && page.fetch.status === 200) map.set(from, target);
  }
  return map;
}

const canonicalChains: RuleImplementation = {
  id: 'crawl-canonical-chains',
  evaluate({ site, evidence }) {
    const map = canonicalMap(site);
    const edges = [...map].filter(([from, to]) => from !== to && map.has(to));
    if (edges.length === 0) return notApplicable('no-canonical-edges');
    let worstChain: { path: string[]; loop: boolean } | undefined;
    for (const [from] of edges) {
      const path = [from];
      let current = from;
      let loop = false;
      while (map.has(current) && map.get(current) !== current && path.length < 12) {
        current = map.get(current)!;
        if (path.includes(current)) {
          loop = true;
          path.push(current);
          break;
        }
        path.push(current);
      }
      if (path.length > 2 && (!worstChain || (loop && !worstChain.loop) || (loop === worstChain.loop && path.length > worstChain.path.length))) worstChain = { path, loop };
    }
    if (!worstChain) return passed();
    const ids = worstChain.path.slice(0, -1).map((url, index) => evidence.add({ kind: 'crawl', url, label: evidenceLabel('canonical hop {number}', { number: index + 1 }), excerpt: worstChain!.path[index + 1]! }));
    return failure({ severity: worstChain.loop ? 'medium' : 'low', evidence: ids, reason: worstChain.loop ? 'loop' : 'chain',
      params: { url: worstChain.path[0]!, hops: worstChain.path.length - 1, path: summarizeList(worstChain.path, 4) } });
  },
};

const canonicalSignalConsistency: RuleImplementation = {
  id: 'crawl-canonical-signal-consistency',
  evaluate({ site, evidence }) {
    const map = canonicalMap(site);
    let compared = 0;
    const results: RuleResult[] = [];
    for (const page of site.pages.values()) {
      const from = normalizeUrl(page.fetch.finalUrl)!;
      const listed = sitemapEntryFor(site, from);
      if (!listed || !map.has(from)) continue;
      compared += 1;
      const target = map.get(from)!;
      if (target === from) continue;
      const ids = [
        evidence.add({ kind: 'sitemap', url: listed.sitemap, label: evidenceLabel('sitemap entry'), excerpt: listed.loc, line: listed.line }),
        evidence.add({ kind: 'html', url: from, label: evidenceLabel('canonical of the listed URL'), excerpt: target }),
      ];
      results.push(failure({ severity: 'medium', evidence: ids, reason: 'sitemap-non-canonical', params: { url: from, target } }));
    }
    if (site.crawled) {
      const graph = linkGraph(site);
      const clusters = new Map<string, string[]>();
      for (const [from, to] of map) if (from !== to) clusters.set(to, [...(clusters.get(to) ?? []), from]);
      for (const [canonical, members] of clusters) {
        compared += 1;
        const toCanonical = graph.inlinks.get(canonical)?.length ?? 0;
        const toMembers = members.reduce((sum, member) => sum + (graph.inlinks.get(member)?.length ?? 0), 0);
        if (toMembers > toCanonical) {
          const ids = [evidence.add({ kind: 'crawl', url: canonical, label: evidenceLabel('internal links to the canonical URL and to the URLs that name it as canonical'), excerpt: `${toCanonical} vs ${toMembers}` })];
          results.push(failure({ severity: 'medium', evidence: ids, reason: 'links-to-non-canonical', params: { url: canonical, canonicalLinks: toCanonical, otherLinks: toMembers } }));
        }
      }
    }
    if (compared === 0) return notApplicable('no-overlap');
    return results.length > 0 ? results : passed();
  },
};

function relativeReference(href: string | undefined): boolean {
  if (href === undefined) return false;
  const value = href.trim();
  return value !== '' && !value.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/iu.test(value) && !value.startsWith('//');
}

const baseHref: RuleImplementation = {
  id: 'crawl-base-href',
  evaluate({ site, page, evidence }) {
    const target = page!;
    const doc = pageDocument(target)!;
    const element = doc.parsed.bases.find(base => base.attrs.href !== undefined);
    if (!element) return notApplicable('no-base');
    const url = target.fetch.finalUrl;
    const base = absoluteUrl(element.attrs.href, url);
    const baseId = evidence.add({ kind: 'html', url, label: evidenceLabel('first base element'), excerpt: element.attrs.href!, line: element.line });
    if (!base) return failure({ severity: 'high', evidence: [baseId], reason: 'unparseable', params: { url, base: element.attrs.href! } });
    const relatives = [...doc.parsed.anchors, ...doc.parsed.links.filter(link => link.rel.includes('canonical') || link.rel.includes('alternate'))].filter(entry => relativeReference(entry.attrs.href));
    const baseHost = new URL(base).hostname;
    if (baseHost !== new URL(url).hostname) {
      if (!sameSite(base, url)) {
        return failure({ severity: relatives.length > 0 ? 'high' : 'low', evidence: [baseId], reason: relatives.length > 0 ? 'other-host' : 'other-host-unused', params: { url, base, count: relatives.length } });
      }
      return failure({ severity: 'low', evidence: [baseId], reason: 'other-host-same-site', params: { url, base, count: relatives.length } });
    }
    const known = knownResponses(site);
    const broken = relatives.map(entry => ({ entry, resolved: normalizeUrl(absoluteUrl(entry.attrs.href, base)) }))
      .filter(item => item.resolved !== undefined && (known.get(item.resolved)?.status ?? 0) >= 400);
    if (broken.length > 0) {
      const ids = [baseId, ...broken.slice(0, 4).map(item => evidence.add({ kind: 'http', url: item.resolved!, label: evidenceLabel('relative link {href} resolved against the base', { href: item.entry.attrs.href ?? '' }), excerpt: `HTTP ${known.get(item.resolved!)!.status}` }))];
      return failure({ severity: 'high', evidence: ids, reason: 'relative-links-broken', params: { url, base, count: broken.length } });
    }
    return passed([baseId]);
  },
};

export const canonicalRules: readonly RuleImplementation[] = [
  headInvalidElement, canonicalPresence, canonicalMultiple, canonicalJsChanged, canonicalFormat, canonicalPlacement, canonicalTargetHealth,
  canonicalProtocolHost, canonicalCrossDomain, canonicalPagination, canonicalChains, canonicalSignalConsistency, baseHref,
];
