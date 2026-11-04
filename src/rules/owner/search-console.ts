import { evidenceLabel } from '../../core/evidence.ts';
import type { Severity } from '../../core/types.ts';
import { brandPattern, cannibalization, lowCtrPages, pageTrends, strikingDistance } from '../../owner/gsc-analyses.ts';
import type { GscData, GscProperty, UrlInspection } from '../../owner/gsc.ts';
import { indexability, siteNames } from '../content/common.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';

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

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

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
    `verdict=${entry.verdict ?? 'unknown'}`, `coverageState=${entry.coverageState ?? 'unknown'}`,
    ...(entry.indexingState ? [`indexingState=${entry.indexingState}`] : []), ...(entry.robotsTxtState ? [`robotsTxtState=${entry.robotsTxtState}`] : []),
    ...(entry.pageFetchState ? [`pageFetchState=${entry.pageFetchState}`] : []), ...(entry.userCanonical ? [`userCanonical=${entry.userCanonical}`] : []),
    ...(entry.googleCanonical ? [`googleCanonical=${entry.googleCanonical}`] : []), `lastCrawlTime=${entry.lastCrawlTime ?? 'never'}`,
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
      const excerpt = `errors=${map.errors}; warnings=${map.warnings}; lastDownloaded=${map.lastDownloaded ?? 'never'}${map.isPending ? '; pending' : ''}`;
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
        context.evidence.add({ kind: 'owner-data', url: page.page, label: evidenceLabel('Search Console performance of the page from {start} to {end}', { start: gsc.period.start, end: gsc.period.end }),
          excerpt: `impressions=${page.impressions}; clicks=${page.clicks}; ctr=${percent(page.ctr)}; position=${page.position.toFixed(1)}; site CTR at that position=${percent(page.expectedCtr)}` }),
        context.evidence.add({ kind: 'owner-data', url: page.page, label: evidenceLabel('queries with the most impressions for the page'), path: searchQueriesPath,
          excerpt: page.topQueries.map((query, index) => `${queryLabel(context, query.query, index)} (${query.impressions} impressions, position ${query.position.toFixed(1)})`).join('\n') }),
      ],
      params: { page: page.page, impressions: page.impressions, position: page.position.toFixed(1), ctr: percent(page.ctr), expected: percent(page.expectedCtr) },
    }));
  },
};

/** Names a brand query may contain: the declared site names and the first label of the host. */
function brandOf(context: RuleContext): RegExp | undefined {
  const host = new URL(context.site.origin).hostname.replace(/^www\./u, '').split('.')[0] ?? '';
  return brandPattern([...siteNames(context.site), host]);
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
      evidence: [context.evidence.add({ kind: 'owner-data', label: evidenceLabel('pages sharing the impressions of one query ({impressions} impressions)', { impressions: entry.impressions }), path: searchQueriesPath,
        excerpt: [queryLabel(context, entry.query, index), ...entry.pages.map(page => `${page.page}: ${percent(page.impressionShare)} of impressions, ${percent(page.clickShare)} of clicks, position ${page.position.toFixed(1)}`)].join('\n') })],
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
    const id = context.evidence.add({ kind: 'owner-data', label: evidenceLabel('queries at positions 11 to 20 with their pages'), path: searchQueriesPath,
      excerpt: found.map((entry, index) => `${queryLabel(context, entry.query, index)} -> ${entry.page} (position ${entry.position.toFixed(1)}, ${entry.impressions} impressions)`).join('\n') });
    const first = found[0]!;
    return { outcome: 'fail', severity: 'info', evidence: [id], params: { count: found.length, query: queryLabel(context, first.query, 0), page: first.page, position: first.position.toFixed(1) } };
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
      evidence: [context.evidence.add({ kind: 'owner-data', url: trend.page, label: evidenceLabel('clicks from {previousStart} to {previousEnd} and from {start} to {end}', { previousStart: gsc.previousPeriod.start, previousEnd: gsc.previousPeriod.end, start: gsc.period.start, end: gsc.period.end }),
        excerpt: `clicks ${trend.clicksBefore} -> ${trend.clicksNow}; z=${trend.z}` })],
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
    const excerpt = entry.richResults.map(result => `${result.type}: ${result.issues.length === 0 ? 'no issues' : result.issues.map(issue => `${issue.severity} ${issue.message}`).join('; ')}`).join('\n');
    const evidence = [context.evidence.add({ kind: 'owner-data', url: entry.url, label: evidenceLabel('rich results Google detected in the indexed version'), excerpt })];
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
    const lines = [
      `Search Console ${property.siteUrl}: AI Overviews and AI Mode are counted in the web search type; the generative AI performance report has no API`,
      owner.bing ? `Bing Webmaster Tools ${owner.bing.site}: the AI Performance report has no API` : 'Bing Webmaster Tools: not read',
      bots ? `crawler activity from ${bots.window.start.slice(0, 10)} to ${bots.window.end.slice(0, 10)}, ${bots.referrals ? 'with' : 'without'} referrers` : 'crawler activity: not read',
    ];
    const reason = owner.bing && bots ? 'all-sources' : owner.bing ? 'without-bots' : bots ? 'without-bing' : 'without-both';
    const evidence = [context.evidence.add({ kind: 'owner-data', label: evidenceLabel('owner sources this report read about AI search'), excerpt: lines.join('\n') })];
    return { outcome: 'fail', severity: 'info', reason, evidence, params: { property: property.siteUrl } };
  },
};

export const implementations: readonly RuleImplementation[] = [
  indexStatus, googleCanonical, crawlRecency, sitemapReports, sitemapUrlsWithoutImpressions, lowCtr, competingPages, nearFirstPage, trafficDrop, richResults,
  genAiControl, measurementContext,
];
