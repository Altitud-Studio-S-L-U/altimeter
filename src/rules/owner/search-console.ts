import { evidenceLabel } from '../../core/evidence.ts';
import type { Severity } from '../../core/types.ts';
import { brandPattern, cannibalization, lowCtrPages, pageTrends, strikingDistance } from '../../owner/gsc-analyses.ts';
import type { GscData, GscProperty, UrlInspection } from '../../owner/gsc.ts';
import { indexability, siteNames } from '../content/common.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';
import { isSiteOwner } from '../schema/commerce.ts';
import { graphOf, texts } from '../schema/graph.ts';
import { nodesOfType } from '../schema/support.ts';

/**
 * Evidence `path` of excerpts that list the owner's search queries. Queries can hold personal data: with
 * --redact-queries they become numbered labels, and analyst calls never receive owner data.
 */
export const searchQueriesPath = 'search-queries';

const gscOf = (context: RuleContext): GscData => context.site.owner!.gsc!;

/** The query as written, or a numbered label when the owner asked for a report without queries. */
const queryLabel = (context: RuleContext, query: string, index: number) => (context.site.owner?.redactQueries ? `query ${index + 1}` : query);

function normalized(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.href;
  } catch {
    return url;
  }
}

/** Whether a URL belongs to the property: a domain property covers its subdomains, a URL-prefix property its prefix. */
function covers(property: GscProperty, url: string): boolean {
  if (property.siteUrl.startsWith('sc-domain:')) {
    const domain = property.siteUrl.slice('sc-domain:'.length).toLowerCase();
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  }
  return normalized(url).startsWith(normalized(property.siteUrl));
}

/** The URL Inspection result for the audited page, matched on the URL Altimeter asked about. */
function inspectionOf(context: RuleContext): UrlInspection | undefined {
  const page = context.page!;
  const wanted = new Set([normalized(page.url), normalized(page.fetch.finalUrl)]);
  return gscOf(context).inspections.find(entry => !entry.error && wanted.has(normalized(entry.url)));
}

function citeInspection(context: RuleContext, entry: UrlInspection): string {
  const fields = [
    `verdict=${entry.verdict ?? '-'}`, `coverageState=${entry.coverageState ?? '-'}`,
    ...(entry.indexingState ? [`indexingState=${entry.indexingState}`] : []), ...(entry.robotsTxtState ? [`robotsTxtState=${entry.robotsTxtState}`] : []),
    ...(entry.pageFetchState ? [`pageFetchState=${entry.pageFetchState}`] : []), ...(entry.userCanonical ? [`userCanonical=${entry.userCanonical}`] : []),
    ...(entry.googleCanonical ? [`googleCanonical=${entry.googleCanonical}`] : []), `lastCrawlTime=${entry.lastCrawlTime ?? '-'}`,
    ...(entry.crawledAs ? [`crawledAs=${entry.crawledAs}`] : []),
  ];
  return context.evidence.add({ kind: 'owner-data', url: entry.url, label: evidenceLabel('Search Console URL Inspection of the indexed version'), excerpt: fields.join('; ') });
}

const notInspected: RuleResult = { outcome: 'not_applicable', reason: 'not-inspected' };
const keptOut: RuleResult = { outcome: 'not_applicable', reason: 'kept-out-of-index' };

/** Coverage states as Search Console words them, most specific first. */
const coverageReasons: ReadonlyArray<readonly [RegExp, string, Severity]> = [
  [/indexed, though blocked by robots/iu, 'indexed-blocked-by-robots', 'low'],
  [/indexed without content/iu, 'indexed-without-content', 'high'],
  [/soft 404/iu, 'soft-404', 'high'],
  [/redirect error/iu, 'redirect-error', 'high'],
  [/not found|\b404\b/iu, 'not-found', 'high'],
  [/server error|\b5xx\b/iu, 'server-error', 'high'],
  [/blocked by robots/iu, 'blocked-by-robots', 'high'],
  [/noindex/iu, 'noindex', 'high'],
  [/unauthorized|forbidden|\b40[13]\b|other 4xx/iu, 'access-blocked', 'high'],
  [/crawled.*not indexed/iu, 'crawled-not-indexed', 'medium'],
  [/discovered.*not indexed/iu, 'discovered-not-indexed', 'medium'],
  [/duplicate without user-selected canonical/iu, 'duplicate-without-canonical', 'medium'],
  [/unknown to google/iu, 'unknown-to-google', 'low'],
];

/** States the site asked for, and the canonical disagreement crawl-gsc-google-canonical reports. */
const expectedStates = /alternate page with proper canonical|page with redirect|google chose different canonical/iu;

const indexStatus: RuleImplementation = {
  id: 'crawl-gsc-index-status',
  evaluate(context) {
    const entry = inspectionOf(context);
    if (!entry?.coverageState) return notInspected;
    // A page that is noindex, canonicalised elsewhere or not 200 is meant to stay out, whatever state Google gives it.
    if (!indexability(context.page!).indexable) return keptOut;
    const evidence = [citeInspection(context, entry)];
    const state = entry.coverageState;
    if (expectedStates.test(state)) return { outcome: 'pass', evidence };
    const match = coverageReasons.find(([pattern]) => pattern.test(state));
    if (!match && entry.verdict === 'PASS') return { outcome: 'pass', evidence };
    const params = { url: entry.url, state, lastCrawl: entry.lastCrawlTime?.slice(0, 10) ?? 'never' };
    if (!match) return { outcome: 'fail', severity: 'medium', evidence, params };
    return { outcome: 'fail', severity: match[2], reason: match[1], evidence, params };
  },
};

const googleCanonical: RuleImplementation = {
  id: 'crawl-gsc-google-canonical',
  evaluate(context) {
    const entry = inspectionOf(context);
    if (!entry) return notInspected;
    if (!entry.googleCanonical) return { outcome: 'not_applicable', reason: 'no-google-canonical' };
    const evidence = [citeInspection(context, entry)];
    const chosen = normalized(entry.googleCanonical);
    if (entry.userCanonical) {
      if (normalized(entry.userCanonical) === chosen) return { outcome: 'pass', evidence };
      return { outcome: 'fail', severity: 'medium', reason: 'differs', evidence, params: { url: entry.url, declared: entry.userCanonical, chosen: entry.googleCanonical } };
    }
    if (chosen === normalized(entry.url)) return { outcome: 'pass', evidence };
    return { outcome: 'fail', severity: 'low', reason: 'chosen-without-declared', evidence, params: { url: entry.url, chosen: entry.googleCanonical } };
  },
};

/** A tool convention: Google sets no recrawl target and crawls small, stable sites less often. */
const staleCrawlDays = 90;

const crawlRecency: RuleImplementation = {
  id: 'crawl-gsc-crawl-recency',
  evaluate(context) {
    const entry = inspectionOf(context);
    if (!entry) return notInspected;
    if (!entry.lastCrawlTime) return { outcome: 'not_applicable', reason: 'never-crawled' };
    if (!indexability(context.page!).indexable) return keptOut;
    const evidence = [citeInspection(context, entry)];
    const days = Math.floor((Date.parse(gscOf(context).fetchedAt) - Date.parse(entry.lastCrawlTime)) / 86_400_000);
    if (days > staleCrawlDays) return { outcome: 'fail', severity: 'low', reason: 'stale-crawl', evidence, params: { url: entry.url, days } };
    if (entry.crawledAs === 'DESKTOP') return { outcome: 'fail', severity: 'info', reason: 'desktop-crawler', evidence, params: { url: entry.url } };
    return { outcome: 'pass', evidence };
  },
};

/** Labels for a sitemap Search Console does not list, by how the audit found it. */
const unsubmittedLabel = {
  robots: evidenceLabel('sitemap found through robots that the Search Console list does not include'),
  link: evidenceLabel('sitemap found through link that the Search Console list does not include'),
  default: evidenceLabel('sitemap found through default that the Search Console list does not include'),
} as const;

const sitemapReports: RuleImplementation = {
  id: 'crawl-gsc-sitemaps',
  evaluate(context) {
    const gsc = gscOf(context);
    const results: RuleResult[] = [];
    for (const map of gsc.sitemaps) {
      const excerpt = `errors=${map.errors}; warnings=${map.warnings}; lastDownloaded=${map.lastDownloaded ?? '-'}${map.isPending ? '; isPending=true' : ''}`;
      const cited = () => [context.evidence.add({ kind: 'owner-data', url: map.path, label: evidenceLabel('Search Console report for a submitted sitemap'), excerpt })];
      if (map.errors > 0) results.push({ outcome: 'fail', severity: 'medium', reason: 'errors', evidence: cited(), params: { sitemap: map.path, count: map.errors } });
      else if (map.warnings > 0) results.push({ outcome: 'fail', severity: 'low', reason: 'warnings', evidence: cited(), params: { sitemap: map.path, count: map.warnings } });
    }
    // Submitting a sitemap index covers its children, so only the sitemaps the site points to are compared.
    const submitted = new Set(gsc.sitemaps.map(map => normalized(map.path)));
    for (const declared of context.site.sitemaps.filter(entry => entry.source !== 'index' && entry.document !== undefined)) {
      if (submitted.has(normalized(declared.url))) continue;
      const id = context.evidence.add({ kind: 'sitemap', url: declared.url, label: unsubmittedLabel[declared.source as keyof typeof unsubmittedLabel], excerpt: declared.url });
      results.push({ outcome: 'fail', severity: 'info', reason: 'not-submitted', evidence: [id], params: { sitemap: declared.url } });
    }
    if (results.length > 0) return results;
    if (gsc.sitemaps.length === 0 && context.site.sitemaps.length === 0) return { outcome: 'not_applicable', reason: 'no-sitemaps' };
    return { outcome: 'pass' };
  },
};

const sitemapUrlsWithoutImpressions: RuleImplementation = {
  id: 'crawl-gsc-sitemap-urls-without-impressions',
  evaluate(context) {
    const gsc = gscOf(context);
    const listed = [...new Set(context.site.sitemaps.flatMap(entry => entry.document?.kind === 'urlset' ? entry.document.urls.map(url => url.loc) : []))]
      .filter(url => covers(gsc.property, url));
    if (listed.length === 0) return { outcome: 'not_applicable', reason: 'no-sitemap-urls' };
    // With the row cap reached, a missing page may only be beyond the rows read.
    if (gsc.truncated) return { outcome: 'not_evaluated', reason: 'performance-data-truncated' };
    const shown = new Set(gsc.byPage.map(row => normalized(row.keys[0]!)));
    const silent = listed.filter(url => !shown.has(normalized(url)));
    if (silent.length === 0) return { outcome: 'pass' };
    const id = context.evidence.add({ kind: 'owner-data', label: evidenceLabel('sitemap URLs without impressions from {start} to {end}', { start: gsc.period.start, end: gsc.period.end }), excerpt: silent.slice(0, 50).join('\n') });
    return { outcome: 'fail', severity: 'info', evidence: [id], params: { count: silent.length, total: listed.length, examples: summarizeList(silent, 3) } };
  },
};

const noSearchData: RuleResult = { outcome: 'not_applicable', reason: 'no-search-data' };

const lowCtr: RuleImplementation = {
  id: 'content-gsc-low-ctr',
  evaluate(context) {
    const gsc = gscOf(context);
    if (gsc.byPage.length === 0) return noSearchData;
    const pages = lowCtrPages(gsc).slice(0, 5);
    if (pages.length === 0) return { outcome: 'pass' };
    return pages.map(page => ({
      outcome: 'fail' as const, severity: 'low' as const,
      evidence: [
        context.evidence.add({
          kind: 'owner-data', url: page.page,
          label: evidenceLabel('Search Console performance of the page from {start} to {end}: impressions: {impressions}; clicks: {clicks}; CTR: {ctr, number, ::percent .0}; average position: {position, number, ::.0}; site CTR at that position: {expected, number, ::percent .0}', {
            start: gsc.period.start, end: gsc.period.end, impressions: page.impressions, clicks: page.clicks, ctr: page.ctr, position: page.position, expected: page.expectedCtr,
          }),
        }),
        ...page.topQueries.map((query, index) => context.evidence.add({
          kind: 'owner-data', url: page.page, path: searchQueriesPath,
          label: evidenceLabel('query with impressions for the page: {query} (impressions: {impressions}; average position: {position, number, ::.0})', { query: queryLabel(context, query.query, index), impressions: query.impressions, position: query.position }),
        })),
      ],
      params: { page: page.page, impressions: page.impressions, position: page.position, ctr: page.ctr, expected: page.expectedCtr },
    }));
  },
};

/** The name and alternate names of the Organization the audited pages declare as the site's own. */
function organizationNames(context: RuleContext): string[] {
  return [...context.site.pages.values()].flatMap(page => {
    const graph = graphOf(page);
    if (!graph) return [];
    return nodesOfType(graph, 'Organization').filter(node => isSiteOwner(graph, node))
      .flatMap(node => [...texts(graph, node, 'name'), ...texts(graph, node, 'alternateName')]);
  });
}

/** Names a brand query may contain: the declared site and organization names and the first label of the host. */
function brandOf(context: RuleContext): RegExp | undefined {
  const host = new URL(context.site.origin).hostname.replace(/^www\./u, '').split('.')[0] ?? '';
  return brandPattern([...siteNames(context.site), ...organizationNames(context), host]);
}

const competingPages: RuleImplementation = {
  id: 'content-gsc-cannibalization',
  evaluate(context) {
    const gsc = gscOf(context);
    if (gsc.byPageQuery.length === 0) return noSearchData;
    const found = cannibalization(gsc, brandOf(context)).slice(0, 5);
    if (found.length === 0) return { outcome: 'pass' };
    return found.map((entry, index) => ({
      outcome: 'fail' as const, severity: 'info' as const,
      evidence: entry.pages.map(page => context.evidence.add({
        kind: 'owner-data', path: searchQueriesPath,
        label: evidenceLabel('page sharing the impressions of the query {query} ({impressions} in all): {page} gets {impressionShare, number, ::percent .0} of the impressions and {clickShare, number, ::percent .0} of the clicks, at an average position of {position, number, ::.0}', {
          query: queryLabel(context, entry.query, index), impressions: entry.impressions, page: page.page, impressionShare: page.impressionShare, clickShare: page.clickShare, position: page.position,
        }),
      })),
      params: { query: queryLabel(context, entry.query, index), count: entry.pages.length, pages: summarizeList(entry.pages.map(page => page.page), 3) },
    }));
  },
};

const nearFirstPage: RuleImplementation = {
  id: 'content-gsc-striking-distance',
  evaluate(context) {
    const gsc = gscOf(context);
    if (gsc.byPageQuery.length === 0) return noSearchData;
    const found = strikingDistance(gsc).slice(0, 10);
    if (found.length === 0) return { outcome: 'pass' };
    const ids = found.map((entry, index) => context.evidence.add({
      kind: 'owner-data', path: searchQueriesPath,
      label: evidenceLabel('query at positions 11 to 20: {query} for {page} (average position: {position, number, ::.0}; impressions: {impressions})', { query: queryLabel(context, entry.query, index), page: entry.page, position: entry.position, impressions: entry.impressions }),
    }));
    const first = found[0]!;
    return { outcome: 'fail', severity: 'info', evidence: ids, params: { count: found.length, query: queryLabel(context, first.query, 0), page: first.page, position: first.position } };
  },
};

const trafficDrop: RuleImplementation = {
  id: 'content-gsc-traffic-drop',
  evaluate(context) {
    const gsc = gscOf(context);
    if (gsc.byPage.length === 0 && gsc.previousByPage.length === 0) return noSearchData;
    const drops = pageTrends(gsc).filter(trend => trend.z < 0).slice(0, 5);
    if (drops.length === 0) return { outcome: 'pass' };
    return drops.map(trend => ({
      outcome: 'fail' as const, severity: 'low' as const,
      evidence: [context.evidence.add({
        kind: 'owner-data', url: trend.page,
        label: evidenceLabel('clicks from {previousStart} to {previousEnd} and from {start} to {end}: {before} and {now} (z-score {z, number, ::.00})', {
          previousStart: gsc.previousPeriod.start, previousEnd: gsc.previousPeriod.end, start: gsc.period.start, end: gsc.period.end, before: trend.clicksBefore, now: trend.clicksNow, z: trend.z,
        }),
      })],
      params: { page: trend.page, before: trend.clicksBefore, now: trend.clicksNow },
    }));
  },
};

const richResults: RuleImplementation = {
  id: 'schema-url-inspection-rich-results',
  evaluate(context) {
    const entry = inspectionOf(context);
    if (!entry) return notInspected;
    if (entry.richResults.length === 0) return { outcome: 'not_applicable', reason: 'no-rich-results-detected' };
    const issues = (severity: string) => entry.richResults.flatMap(result => result.issues.filter(issue => issue.severity === severity).map(issue => `${result.type}: ${issue.message}`));
    const evidence = entry.richResults.map(result => (result.issues.length === 0
      ? context.evidence.add({ kind: 'owner-data', url: entry.url, label: evidenceLabel('rich result {type} that Google detected in the indexed version, without issues', { type: result.type }) })
      : context.evidence.add({
        kind: 'owner-data', url: entry.url, excerpt: result.issues.map(issue => `${issue.severity} ${issue.message}`).join('\n'),
        label: evidenceLabel('rich result {type} that Google detected in the indexed version, with these issues', { type: result.type }),
      })));
    const errors = issues('ERROR');
    if (errors.length > 0) return { outcome: 'fail', severity: 'high', reason: 'errors', evidence, params: { url: entry.url, count: errors.length, items: summarizeList(errors, 3) } };
    const warnings = issues('WARNING');
    if (warnings.length > 0) return { outcome: 'fail', severity: 'low', reason: 'warnings', evidence, params: { url: entry.url, count: warnings.length, items: summarizeList(warnings, 3) } };
    return { outcome: 'pass', evidence };
  },
};

/** The site-wide control for Google's AI features lives in the property's settings, which no API exposes. */
const genAiControl: RuleImplementation = {
  id: 'ai-google-genai-control-context',
  evaluate(context) {
    const { property } = gscOf(context);
    const evidence = [context.evidence.add({ kind: 'owner-data', label: evidenceLabel('Search Console property whose settings hold the generative AI control'), excerpt: property.siteUrl })];
    return { outcome: 'fail', severity: 'info', evidence, params: { property: property.siteUrl } };
  },
};

/** What the owner sources read for this report say about AI search, and what none of their APIs expose. */
const measurementContext: RuleImplementation = {
  id: 'ai-measurement-context',
  evaluate(context) {
    const owner = context.site.owner!;
    const { property } = gscOf(context);
    const bots = owner.bots;
    const window = bots ? { start: bots.window.start.slice(0, 10), end: bots.window.end.slice(0, 10) } : undefined;
    const sources = [
      evidenceLabel('Search Console {property}: AI Overviews and AI Mode are counted in the web search type, and the generative AI performance report has no API', { property: property.siteUrl }),
      owner.bing ? evidenceLabel('Bing Webmaster Tools {site}: the AI Performance report has no API', { site: owner.bing.site }) : evidenceLabel('Bing Webmaster Tools: not read'),
      !window ? evidenceLabel('crawler activity: not read')
        : bots!.referrals ? evidenceLabel('crawler activity from {start} to {end}, with referrers', window) : evidenceLabel('crawler activity from {start} to {end}, without referrers', window),
    ];
    const reason = owner.bing && bots ? 'all-sources' : owner.bing ? 'without-bots' : bots ? 'without-bing' : 'without-both';
    const evidence = sources.map(label => context.evidence.add({ kind: 'owner-data', label }));
    return { outcome: 'fail', severity: 'info', reason, evidence, params: { property: property.siteUrl } };
  },
};

export const implementations: readonly RuleImplementation[] = [
  indexStatus, googleCanonical, crawlRecency, sitemapReports, sitemapUrlsWithoutImpressions, lowCtr, competingPages, nearFirstPage, trafficDrop, richResults,
  genAiControl, measurementContext,
];
