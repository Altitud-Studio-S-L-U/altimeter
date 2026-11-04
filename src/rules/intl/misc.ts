import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, directivesFor, documentBase, pageDocument, robotsDirectives, sameSite } from '../helpers.ts';
import { attribute, isElement, textOf, walk } from '../../parse/html.ts';
import { annotationEvidence, effectiveAnnotations, elementSource, normalizeUrl } from './annotations.ts';
import { declaredSets, isXDefault } from './cluster.ts';
import { parseHreflang } from './codes.ts';
import { fail, groupBy, list, maxEvidence, notApplicable, pass } from './shared.ts';

const geoNames = new Set(['geo.position', 'geo.region', 'geo.placename', 'geo.country', 'icbm', 'dc.language', 'language', 'content-language', 'country']);

export const geoMetaTagsIgnored: RuleImplementation = {
  id: 'intl-geo-meta-tags-ignored',
  evaluate({ page, evidence }) {
    const doc = page!.raw!;
    const found = doc.parsed.metas.filter(meta => geoNames.has((meta.attrs.name ?? '').trim().toLowerCase()));
    if (found.length === 0) return pass();
    return fail('info', found.slice(0, maxEvidence).map(meta => evidence.add({ kind: 'html', url: page!.fetch.finalUrl, label: evidenceLabel('locational meta element'), excerpt: elementSource(doc.html, meta), line: meta.line })),
      { names: list(found.map(meta => (meta.attrs.name ?? '').trim()), 5), count: found.length });
  },
};

/** Country-code TLDs that Google treats as generic, plus regional TLDs, as listed in the catalog source. */
const genericCcTlds = new Set(['ad', 'ai', 'as', 'bz', 'cc', 'cd', 'co', 'dj', 'fm', 'io', 'la', 'me', 'ms', 'nu', 'sc', 'sr', 'su', 'tv', 'tk', 'ws', 'eu', 'asia']);
const tldCountry: Readonly<Record<string, string>> = { uk: 'GB' };

export const tldGeotargetingClassification: RuleImplementation = {
  id: 'intl-tld-geotargeting-classification',
  evaluate({ site, evidence }) {
    const host = new URL(site.origin).hostname;
    if (/^[\d.]+$|:/u.test(host) || !host.includes('.')) return notApplicable('no-domain-name');
    const tld = host.split('.').at(-1)!.toLowerCase();
    const country = tldCountry[tld] ?? tld.toUpperCase();
    const kind = tld.length !== 2 && tld !== 'asia' ? 'generic' : genericCcTlds.has(tld) ? 'generic-cctld' : 'cctld';
    const id = evidence.add({ kind: 'http', url: site.origin, label: kind === 'cctld' ? evidenceLabel('country-code TLD .{tld}, a signal for {country}', { tld, country })
      : kind === 'generic-cctld' ? evidenceLabel('.{tld}, which Google treats as generic', { tld }) : evidenceLabel('generic TLD .{tld}', { tld }), excerpt: host });
    if (kind !== 'cctld') return pass([id]);
    const foreign = [...declaredSets(site).values()].flatMap(set => set.annotations)
      .filter(annotation => annotation.href && new URL(annotation.href).hostname === host)
      .filter(annotation => {
        const region = parseHreflang(annotation.value).region;
        return region !== undefined && region !== country && /^[A-Z]{2}$/u.test(region);
      });
    if (foreign.length === 0) return pass([id]);
    return fail('info', [id, ...foreign.slice(0, maxEvidence - 1).map(annotation => annotationEvidence(evidence, annotation, evidenceLabel('hreflang region other than the TLD country')))],
      { tld, country, regions: list(foreign.map(annotation => parseHreflang(annotation.value).region!)) }, 'cctld-foreign-regions');
  },
};

type Structure = 'cctld' | 'subdomain' | 'subdirectory' | 'parameter' | 'same-path';

const structureLabel: Readonly<Record<Structure, EvidenceLabel>> = {
  cctld: evidenceLabel('locale URL classified as cctld'),
  subdomain: evidenceLabel('locale URL classified as subdomain'),
  subdirectory: evidenceLabel('locale URL classified as subdirectory'),
  parameter: evidenceLabel('locale URL classified as parameter'),
  'same-path': evidenceLabel('locale URL classified as same-path'),
};

function structureOf(href: string, base: URL, value: string): Structure {
  const url = new URL(href);
  if (url.hostname !== base.hostname) {
    const tld = (host: string) => host.split('.').at(-1);
    return sameSite(href, base.href) || tld(url.hostname) === tld(base.hostname) ? 'subdomain' : 'cctld';
  }
  if ([...url.searchParams.keys()].some(name => /^(lang|language|hl|locale|lng|lc)$/iu.test(name))) return 'parameter';
  const first = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  const tag = value.toLowerCase();
  if (first && (first === tag || first === tag.split('-')[0] || /^[a-z]{2}(?:[-_][a-z]{2,4})?$/u.test(first))) return 'subdirectory';
  return 'same-path';
}

export const urlStructureAssessment: RuleImplementation = {
  id: 'intl-url-structure-assessment',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const base = new URL(site.homeUrl ?? site.origin);
    const annotations = [...sets.values()].flatMap(set => set.annotations).filter(annotation => annotation.href && !isXDefault(annotation));
    const classified = annotations.map(annotation => ({ annotation, structure: structureOf(annotation.href!, base, annotation.value) }));
    // The default locale often lives at the unprefixed path; it does not make the scheme mixed.
    const schemes = groupBy(classified.filter(entry => entry.structure !== 'same-path'), entry => entry.structure);
    const ids = [...schemes.values()].map(group => annotationEvidence(evidence, group[0]!.annotation, structureLabel[group[0]!.structure]));
    if (schemes.size > 1) return fail('info', ids, { schemes: list(schemes.keys(), 4) }, 'mixed-schemes');
    return pass(ids);
  },
};

const placeTypes = new Set(['PostalAddress', 'GeoCoordinates', 'Person', 'Organization', 'Corporation', 'WebPage', 'WebSite', 'Service', 'Offer', 'Product', 'ContactPoint', 'PropertyValue', 'QuantitativeValue', 'Thing']);
const invalidParents = new Set(['WebPage', 'WebSite', 'Article', 'BlogPosting', 'NewsArticle', 'Product', 'Person', 'Event', 'BreadcrumbList', 'ItemList', 'FAQPage', 'ImageObject', 'VideoObject', 'CreativeWork', 'CollectionPage', 'AboutPage', 'ContactPage']);
const validParents = /Organization|Business|Service|Offer|ContactPoint|Demand|DeliveryChargeSpecification|Store|Restaurant|Agency|Office|Center|Clinic|Hotel|School|Corporation/u;

export const areaServedFormat: RuleImplementation = {
  id: 'intl-area-served-format',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!)!;
    const url = page!.fetch.finalUrl;
    const nodes = doc.data.nodes.filter(node => node.properties.areaServed !== undefined);
    if (nodes.length === 0) return notApplicable('no-area-served');
    const results: RuleResult[] = [];
    for (const node of nodes) {
      const excerpt = JSON.stringify(node.properties.areaServed).slice(0, 400);
      const path = `${node.path}.areaServed`;
      if (node.types.length > 0 && node.types.every(type => invalidParents.has(type)) && !node.types.some(type => validParents.test(type))) {
        results.push(fail('low', [evidence.add({ kind: 'structured-data', url, label: evidenceLabel('areaServed on a {type} node, a type that does not take it', { type: node.types.join('/') }), excerpt, path, line: node.line })], { type: node.types.join('/') }, 'invalid-parent'));
      }
      const values = Array.isArray(node.properties.areaServed) ? node.properties.areaServed : [node.properties.areaServed];
      for (const value of values) {
        if (typeof value === 'string') {
          const target = /^https?:\/\//iu.test(value.trim()) ? absoluteUrl(value, url) : undefined;
          if (target && sameSite(target, url)) results.push(fail('low', [evidence.add({ kind: 'structured-data', url, label: evidenceLabel('areaServed given as a URL of this site'), excerpt: value, path, line: node.line })], { value }, 'url-value'));
          continue;
        }
        if (!value || typeof value !== 'object') continue;
        const type = (value as Record<string, unknown>)['@type'];
        const types = (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === 'string').map(entry => entry.replace(/^https?:\/\/schema\.org\//u, ''));
        if (types.length > 0 && types.every(entry => placeTypes.has(entry))) {
          results.push(fail('low', [evidence.add({ kind: 'structured-data', url, label: evidenceLabel('areaServed value of type {type}, which is not a Place, AdministrativeArea or GeoShape', { type: types.join('/') }), excerpt: JSON.stringify(value).slice(0, 400), path, line: node.line })], { value: types.join('/') }, 'invalid-value-type'));
        }
      }
    }
    return results.length > 0 ? results : pass();
  },
};

export const notranslateInUse: RuleImplementation = {
  id: 'intl-notranslate-in-use',
  evaluate({ page, evidence }) {
    const all = robotsDirectives(page!.fetch.headers, page!.raw);
    if (!directivesFor(all).has('notranslate')) return pass();
    const entry = all.find(directives => directives.directives.includes('notranslate') && (directives.agent === 'all' || directives.agent === 'googlebot'))!;
    return fail('info', [evidence.add({ kind: entry.source === 'meta' ? 'html' : 'header', url: page!.fetch.finalUrl, label: evidenceLabel('robots directive with notranslate'), excerpt: entry.raw, ...(entry.line ? { line: entry.line } : {}) })], { source: entry.source });
  },
};

const languageWords = /^(english|español|espanol|castellano|català|catala|français|francais|deutsch|italiano|português|portugues|occitan|aranés|euskara|galego|nederlands|en|es|ca|fr|de|it|pt|oc|eng|esp|cat|fra|deu)$/iu;
const localeRoot = /^\/[a-z]{2}(?:[-_][a-z]{2,4})?\/?$/iu;

export const languageSwitcherCrawlable: RuleImplementation = {
  id: 'intl-language-switcher-crawlable',
  evaluate({ page, site, evidence }) {
    const self = normalizeUrl(page!.fetch.finalUrl)!;
    const alternates = effectiveAnnotations(page!, site).filter(annotation => annotation.href && annotation.href !== self && !isXDefault(annotation));
    if (alternates.length === 0) return notApplicable('no-alternates');
    const doc = pageDocument(page!)!;
    const base = documentBase(doc, page!.fetch.finalUrl);
    const hrefs = new Map<string, (typeof doc.parsed.anchors)[number]>();
    for (const anchor of doc.parsed.anchors) {
      const href = normalizeUrl(absoluteUrl(anchor.attrs.href, base));
      if (href && !hrefs.has(href)) hrefs.set(href, anchor);
    }
    const linked = alternates.find(annotation => hrefs.has(annotation.href!));
    if (linked) {
      const anchor = hrefs.get(linked.href!)!;
      return pass([evidence.add({ kind: 'html', url: self, label: evidenceLabel('link to another language version of this page'), excerpt: elementSource(doc.html, anchor), ...(anchor.line ? { line: anchor.line } : {}) })]);
    }
    const isHome = new URL(self).pathname === '/' || localeRoot.test(new URL(self).pathname);
    const hosts = new Set(alternates.map(annotation => new URL(annotation.href!).hostname));
    const homes = [...hrefs].filter(([href]) => {
      const url = new URL(href);
      return href !== self && (localeRoot.test(url.pathname) || (url.pathname === '/' && hosts.has(url.hostname) && url.hostname !== new URL(self).hostname));
    });
    if (homes.length > 0 && !isHome) {
      return fail('info', homes.slice(0, 3).map(([, anchor]) => evidence.add({ kind: 'html', url: self, label: evidenceLabel('language link that goes to a locale home page instead of the equivalent page'), excerpt: elementSource(doc.html, anchor), ...(anchor.line ? { line: anchor.line } : {}) })),
        { count: homes.length }, 'homepages-only');
    }
    // Buttons, selects or elements naming languages without an href suggest a script-driven switcher.
    const widgets: string[] = [];
    walk(doc.parsed.document, node => {
      if (!isElement(node) || widgets.length >= 3) return;
      if (node.tagName === 'a' && attribute(node, 'href')) return false;
      const text = textOf(node).trim();
      if ((node.tagName === 'button' || node.tagName === 'option' || attribute(node, 'onclick') !== undefined) && languageWords.test(text)) {
        widgets.push(`<${node.tagName}>${text}</${node.tagName}>`);
        return false;
      }
      return undefined;
    });
    const ids = [
      ...alternates.slice(0, 3).map(annotation => annotationEvidence(evidence, annotation, evidenceLabel('language version not linked from the page'))),
      ...widgets.map(widget => evidence.add({ kind: 'html', url: self, label: evidenceLabel('language control without a crawlable link'), excerpt: widget })),
    ];
    return fail('medium', ids, { count: alternates.length, controls: widgets.length }, 'no-crawlable-links', true);
  },
};

export const miscImplementations: readonly RuleImplementation[] = [
  geoMetaTagsIgnored, tldGeotargetingClassification, urlStructureAssessment, areaServedFormat, notranslateInUse, languageSwitcherCrawlable,
];

