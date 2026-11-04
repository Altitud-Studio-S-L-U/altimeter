import type { SiteFacts, SitemapFacts } from '../../core/facts.ts';
import { decodeSitemapBody, type SitemapUrl } from '../../fetch/sitemap.ts';
import type { RuleImplementation } from '../engine.ts';
import { linksWithRel } from '../helpers.ts';
import { normalizeUrl } from './annotations.ts';
import { parseHreflang } from './codes.ts';
import { fail, groupBy, list, maxEvidence, notApplicable, notEvaluated, pass } from './shared.ts';

type SitemapProblem = 'namespace' | 'missing-self' | 'relative-href' | 'invalid-value' | 'alternate-not-listed' | 'not-reciprocal';

interface Flag {
  readonly problem: SitemapProblem;
  readonly sitemap: SitemapFacts;
  readonly entry?: SitemapUrl;
  readonly excerpt: string;
  readonly line: number;
}

const label: Readonly<Record<SitemapProblem, string>> = {
  namespace: 'hreflang links in a sitemap whose xhtml namespace is missing or wrong, so they are not read',
  'missing-self': 'sitemap entry with alternates but no xhtml:link to its own loc',
  'relative-href': 'sitemap xhtml:link with a URL that is not absolute',
  'invalid-value': 'sitemap xhtml:link with a hreflang value outside Google\'s format',
  'alternate-not-listed': 'alternate URL with no <url> entry of its own in the sitemaps',
  'not-reciprocal': 'alternate URL whose own sitemap entry does not list this loc',
};

function entryExcerpt(entry: SitemapUrl): string {
  return [`<loc>${entry.loc}</loc>`, ...entry.alternates.map(alternate => `hreflang="${alternate.hreflang}" href="${alternate.href}"`)].join('\n');
}

/**
 * True when every sitemap robots.txt or a page declares was fetched (the collector reads only the first few), every
 * child sitemap an index lists was fetched and parsed, and none was cut at the 50,000-entry limit, so a missing entry
 * is really missing.
 */
function complete(site: SiteFacts): boolean {
  const sitemaps = site.sitemaps;
  const key = (url: string) => normalizeUrl(url) ?? url;
  const fetched = new Set(sitemaps.map(sitemap => key(sitemap.url)));
  const declared = [
    ...(site.robots?.availability.kind === 'parsed' ? site.robots.availability.file.sitemaps.map(line => line.value) : []),
    ...[...site.pages.values()].flatMap(page => linksWithRel(page.raw, 'sitemap').map(link => normalizeUrl(link.attrs.href, page.url) ?? '')),
  ].filter(Boolean);
  const listed = new Set(sitemaps.flatMap(sitemap => sitemap.document?.sitemaps.map(reference => reference.loc) ?? []));
  const parsed = new Set(sitemaps.filter(sitemap => sitemap.document).map(sitemap => sitemap.url));
  return declared.every(url => fetched.has(key(url))) && [...listed].every(url => parsed.has(url))
    && sitemaps.every(sitemap => (sitemap.document ? !sitemap.document.overEntryLimit : sitemap.fetch.status === 404 || sitemap.source === 'default'));
}

export const sitemapFormat: RuleImplementation = {
  id: 'intl-hreflang-sitemap-format',
  evaluate({ site, evidence }) {
    const parsed = site.sitemaps.filter(sitemap => sitemap.document);
    if (parsed.length === 0) return notEvaluated('no-parsed-sitemap');
    const flags: Flag[] = [];
    const audited = new Set([...site.pages.values()].map(page => normalizeUrl(page.fetch.finalUrl)));
    const entries = new Map<string, SitemapUrl>();
    for (const sitemap of parsed) for (const entry of sitemap.document!.urls) {
      const loc = normalizeUrl(entry.loc);
      if (loc && !entries.has(loc)) entries.set(loc, entry);
    }
    let annotated = 0;
    for (const sitemap of parsed) {
      const document = sitemap.document!;
      const withAlternates = document.urls.filter(entry => entry.alternates.length > 0);
      annotated += withAlternates.length;
      if (withAlternates.length === 0) {
        const xml = decodeSitemapBody(sitemap.fetch.body).xml.toString('utf8');
        const match = /<[\w.-]*:?link\b[^>]*hreflang[^>]*>/iu.exec(xml);
        if (match) {
          annotated += 1;
          flags.push({ problem: 'namespace', sitemap, excerpt: `${match[0]}\n${/<urlset\b[^>]*>/iu.exec(xml)?.[0] ?? ''}`.trim(), line: xml.slice(0, match.index).split('\n').length });
        }
        continue;
      }
      for (const entry of withAlternates) {
        const loc = normalizeUrl(entry.loc);
        if (loc && !entry.alternates.some(alternate => normalizeUrl(alternate.href) === loc)) flags.push({ problem: 'missing-self', sitemap, entry, excerpt: entryExcerpt(entry), line: entry.line });
        for (const alternate of entry.alternates) {
          if (!/^https?:\/\/[^/]/iu.test(alternate.href.trim())) flags.push({ problem: 'relative-href', sitemap, entry, excerpt: `hreflang="${alternate.hreflang}" href="${alternate.href}"`, line: entry.line });
          // Values of audited pages are reported by the hreflang value rules, which read sitemaps too.
          if (!audited.has(loc) && parseHreflang(alternate.hreflang).problems.length > 0) {
            flags.push({ problem: 'invalid-value', sitemap, entry, excerpt: `hreflang="${alternate.hreflang}" href="${alternate.href}"`, line: entry.line });
          }
        }
      }
    }
    if (annotated === 0) return notApplicable('no-sitemap-hreflang');
    if (complete(site)) {
      const sitemapHosts = new Set(parsed.map(sitemap => new URL(sitemap.url).hostname));
      for (const sitemap of parsed) {
        for (const entry of sitemap.document!.urls) {
          const loc = normalizeUrl(entry.loc);
          for (const alternate of entry.alternates) {
            const href = normalizeUrl(alternate.href);
            // Alternates on other hosts may be listed in those hosts' sitemaps, which are not fetched.
            if (!href || href === loc || !sitemapHosts.has(new URL(href).hostname)) continue;
            const own = entries.get(href);
            if (!own) flags.push({ problem: 'alternate-not-listed', sitemap, entry, excerpt: `hreflang="${alternate.hreflang}" href="${alternate.href}"`, line: entry.line });
            else if (own.alternates.length > 0 && !own.alternates.some(back => normalizeUrl(back.href) === loc)) {
              flags.push({ problem: 'not-reciprocal', sitemap, entry: own, excerpt: entryExcerpt(own), line: own.line });
            }
          }
        }
      }
    }
    if (flags.length === 0) return pass();
    return [...groupBy(flags, flag => flag.problem)].map(([problem, group]) => {
      const unique = [...new Map(group.map(flag => [`${flag.sitemap.url} ${flag.line} ${flag.excerpt}`, flag])).values()];
      return fail('medium', unique.slice(0, maxEvidence).map(flag => evidence.add({ kind: 'sitemap', url: flag.sitemap.url, label: label[flag.problem], excerpt: flag.excerpt, line: flag.line })),
        { count: unique.length, sitemaps: list(unique.map(flag => flag.sitemap.url), 2) }, problem);
    });
  },
};
