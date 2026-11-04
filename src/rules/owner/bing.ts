import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import { severities, type Severity } from '../../core/types.ts';
import { issueNames, lowCtrPages, onBingSite, recentRows, trafficTotals, type CrawlIssueName, type TrafficWindow } from '../../owner/bing-analyses.ts';
import type { BingCrawlIssue, BingData, BingUrlInfo } from '../../owner/bing.ts';
import { robotsDecision } from '../crawl/shared.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, directivesFor, linksWithRel, pageDocument, robotsDirectives, summarizeList } from '../helpers.ts';
import { searchQueriesPath } from './search-console.ts';

const bingOf = (context: RuleContext): BingData => context.site.owner!.bing!;

/** The query as written, or a numbered label when the owner asked for a report without queries. */
const queryLabel = (context: RuleContext, query: string, index: number) => (context.site.owner?.redactQueries ? `query ${index + 1}` : query);

function normalized(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * A URL from Bing's data, ready for a message: serialised again, with the characters that build Markdown links,
 * code spans and tables percent-encoded, so a URL someone linked to cannot become a link or markup in a report.
 */
function displayUrl(url: string): string {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return 'an unreadable URL';
  }
  return href.replace(/[[\]()`*!|\\]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const dayOf = (instant: string | undefined) => instant?.slice(0, 10) ?? 'unknown';
const gravity = (severity: Severity) => severities.indexOf(severity);

interface IssueKind {
  readonly reason: string;
  /** Severity of the type across the site's list. */
  readonly site: Severity;
  /** Severity for an audited page that is meant to be in search. */
  readonly page: Severity;
  /** An HTTP answer, or its absence, that this audit's own fetch can try to reproduce. */
  readonly fetched?: true;
  readonly robots?: true;
}

/**
 * Bing documents the issue types, not their weight, so the grading is a tool convention: malware makes Bing warn
 * searchers, server and DNS failures stop Bing from fetching anything, robots.txt blocks on the site are usually
 * deliberate, and redirects are normal.
 */
const kinds: Readonly<Record<CrawlIssueName, IssueKind>> = {
  ContainsMalware: { reason: 'malware', site: 'critical', page: 'critical' },
  Code5xx: { reason: 'server-error', site: 'high', page: 'high', fetched: true },
  DnsErrors: { reason: 'dns-error', site: 'high', page: 'high', fetched: true },
  TimeOutErrors: { reason: 'timeout', site: 'medium', page: 'medium', fetched: true },
  ImportantUrlBlockedByRobotsTxt: { reason: 'important-url-blocked', site: 'medium', page: 'medium', robots: true },
  Code4xx: { reason: 'client-error', site: 'low', page: 'medium', fetched: true },
  BlockedByRobotsTxt: { reason: 'blocked-by-robots', site: 'info', page: 'medium', robots: true },
  Code301: { reason: 'permanent-redirect', site: 'info', page: 'info' },
  Code302: { reason: 'temporary-redirect', site: 'info', page: 'info' },
};

const reportingOrder = Object.keys(kinds) as CrawlIssueName[];

function issueLine(entry: BingCrawlIssue): string {
  return `${entry.url} (${issueNames(entry.issues).join(', ')}; HTTP ${entry.httpCode ?? 'unknown'}; ${entry.inLinks} inbound links)`;
}

const crawlIssues: RuleImplementation = {
  id: 'crawl-bing-crawl-issues',
  evaluate(context) {
    const bing = bingOf(context);
    if (!bing.crawlIssues) return { outcome: 'not_evaluated', reason: 'crawl-issues-not-read' };
    const results: RuleResult[] = [];
    for (const name of reportingOrder) {
      const listed = bing.crawlIssues.filter(entry => issueNames(entry.issues).includes(name)).sort((a, b) => b.inLinks - a.inLinks || a.url.localeCompare(b.url));
      if (listed.length === 0) continue;
      const kind = kinds[name];
      const linked = listed.filter(entry => entry.inLinks > 0).length;
      const evidence = [context.evidence.add({ kind: 'owner-data', url: bing.site, label: `URLs Bing lists with the crawl issue ${name}`, excerpt: listed.slice(0, 20).map(issueLine).join('\n') })];
      results.push({
        outcome: 'fail',
        // A missing URL that other pages link to loses visitors and link value; one nothing links to was usually removed on purpose.
        severity: name === 'Code4xx' && linked > 0 ? 'medium' : kind.site,
        reason: kind.reason,
        evidence,
        params: { issue: name, count: listed.length, linked, examples: summarizeList(listed.map(entry => displayUrl(entry.url)), 3) },
      });
    }
    if (results.length > 0) return results;
    return { outcome: 'pass', evidence: [context.evidence.add({ kind: 'owner-data', url: bing.site, label: 'crawl issue list Bing returned for the site', excerpt: '0 URLs' })] };
  },
};

function citeIssue(context: RuleContext, entry: BingCrawlIssue): string {
  return context.evidence.add({
    kind: 'owner-data', url: entry.url, label: 'crawl issues Bing lists for the URL',
    excerpt: `issues=${issueNames(entry.issues).join(', ')}; httpCode=${entry.httpCode ?? 'unknown'}; inLinks=${entry.inLinks}`,
  });
}

function citeDetails(context: RuleContext, details: BingUrlInfo): string {
  return context.evidence.add({
    kind: 'owner-data', url: details.url, label: 'index details Bing keeps for the URL',
    excerpt: `httpStatus=${details.httpStatus ?? 'unknown'}; lastCrawled=${dayOf(details.lastCrawled)}; discovered=${dayOf(details.discovered)}${details.documentSize === undefined ? '' : `; documentSize=${details.documentSize}`}`,
  });
}

/** The status this audit received for one of the page's URLs: the requested URL or a hop of its redirects. */
function liveStatus(page: PageFacts, url: string): number | undefined {
  const wanted = normalized(url);
  return page.fetch.hops.find(hop => normalized(hop.url) === wanted)?.status;
}

/** The page asks to stay out of Bing: noindex for robots or bingbot, in a header or the HTML, or a canonical naming another URL. */
function keptOut(page: PageFacts): boolean {
  if (page.fetch.status !== 200) return false;
  const docs: Array<DocumentFacts | undefined> = [undefined, page.raw, page.rendered?.result.error === undefined ? page.rendered : undefined];
  if (docs.some(doc => directivesFor(robotsDirectives(page.fetch.headers, doc), 'bingbot').has('noindex'))) return true;
  const canonical = absoluteUrl(linksWithRel(pageDocument(page), 'canonical')[0]?.attrs.href, page.fetch.finalUrl);
  return canonical !== undefined && normalized(canonical) !== normalized(page.fetch.finalUrl);
}

interface Statement {
  readonly url: string;
  readonly name: CrawlIssueName;
  readonly status: number | undefined;
  /** From the index details rather than the crawl issue list. */
  readonly fromDetails: boolean;
}

const pageIssues: RuleImplementation = {
  id: 'crawl-bing-page-issues',
  evaluate(context) {
    const bing = bingOf(context);
    const page = context.page!;
    const urls = [...new Set([page.url, page.fetch.finalUrl])].filter(url => onBingSite(bing.site, url));
    if (urls.length === 0) return { outcome: 'not_applicable', reason: 'outside-bing-site' };
    const wanted = new Set(urls.map(normalized));
    const listed = (bing.crawlIssues ?? []).filter(entry => wanted.has(normalized(entry.url)));
    const details = bing.urlInfo.find(entry => entry.error === undefined && wanted.has(normalized(entry.url)));
    const statements: Statement[] = listed.flatMap(entry => issueNames(entry.issues).map(name => ({ url: entry.url, name, status: entry.httpCode, fromDetails: false })));
    const detailsName: CrawlIssueName | undefined = details?.httpStatus === undefined ? undefined : details.httpStatus >= 500 ? 'Code5xx' : details.httpStatus >= 400 ? 'Code4xx' : undefined;
    if (details && detailsName && !statements.some(statement => statement.name === detailsName)) {
      statements.push({ url: details.url, name: detailsName, status: details.httpStatus, fromDetails: true });
    }
    const evidence = [...listed.map(entry => citeIssue(context, entry)), ...(details ? [citeDetails(context, details)] : [])];
    if (statements.length === 0) {
      // A clean record needs both sources: the issue list can name a block that the index details predate.
      if (!bing.crawlIssues) return { outcome: 'not_evaluated', reason: 'crawl-issues-not-read' };
      if (!details) return { outcome: 'not_applicable', reason: 'no-index-details' };
      // Without a crawl date Bing has said nothing about how the page answers.
      if (!details.lastCrawled) return { outcome: 'not_applicable', reason: 'not-crawled-by-bing' };
      return { outcome: 'pass', evidence };
    }
    const malware = statements.some(statement => statement.name === 'ContainsMalware');
    if (!malware && keptOut(page)) return { outcome: 'not_applicable', reason: 'kept-out-of-index' };
    const worst = statements.reduce((a, b) => (gravity(kinds[b.name].page) < gravity(kinds[a.name].page) ? b : a));
    const kind = kinds[worst.name];
    // Login, cart and internal search pages are blocked on purpose, as crawl-robots-blocks-page assumes too.
    if (kind.robots && page.pageType === 'utility') return { outcome: 'not_applicable', reason: 'utility-page' };
    const live = liveStatus(page, worst.url);
    const params = {
      url: displayUrl(worst.url),
      issues: [...new Set(statements.map(statement => (statement.fromDetails ? `HTTP ${statement.status} in its index details` : statement.name)))].join(', '),
      status: worst.status ?? 'unknown',
      live: live === undefined ? 'no response' : `HTTP ${live}`,
    };
    if (kind.fetched && live === 200) {
      // Fixed since Bing's crawl, intermittent, or served only to Bingbot: only the server logs tell which.
      evidence.push(context.evidence.add({ kind: 'http', url: worst.url, label: 'status this audit received for the URL', excerpt: `HTTP ${live}` }));
      return { outcome: 'fail', severity: gravity(kind.page) < gravity('medium') ? 'medium' : kind.page, reason: 'not-reproduced', evidence, params };
    }
    if (kind.robots) {
      const decision = robotsDecision(context.site, worst.url, ['bingbot']);
      if (decision) {
        evidence.push(context.evidence.add({
          kind: 'robots', url: context.site.robots!.url,
          label: decision.allowed ? 'robots.txt read by this audit lets Bingbot fetch the URL' : 'robots.txt rule that still disallows the URL for Bingbot',
          excerpt: decision.rule ? `${decision.rule.type}: ${decision.rule.pattern} (group ${decision.matchedToken ?? '*'})` : 'no rule matches the URL',
          ...(decision.rule?.line === undefined ? {} : { line: decision.rule.line }),
        }));
        if (decision.allowed) return { outcome: 'fail', severity: 'low', reason: 'robots-allows-now', evidence, params };
      }
    }
    return { outcome: 'fail', severity: kind.page, reason: kind.reason, evidence, params };
  },
};

function topQueries(bing: BingData, page: string, window: TrafficWindow) {
  const rows = bing.pageQueries.find(entry => entry.page === page)?.rows.filter(row => row.date >= window.start && row.date <= window.end) ?? [];
  return trafficTotals(rows).sort((a, b) => b.impressions - a.impressions || a.key.localeCompare(b.key)).slice(0, 5);
}

const lowCtr: RuleImplementation = {
  id: 'content-bing-low-ctr',
  evaluate(context) {
    const bing = bingOf(context);
    if (!bing.pageStats) return { outcome: 'not_evaluated', reason: 'page-traffic-not-read' };
    const window = recentRows(bing.pageStats);
    if (window.rows.length === 0) return { outcome: 'not_applicable', reason: 'no-search-data' };
    const analysis = lowCtrPages(window.rows);
    // No page had the impressions, or no band the other pages, that a comparison needs.
    if (analysis.compared === 0) return { outcome: 'not_applicable', reason: 'too-little-data' };
    if (analysis.pages.length === 0) return { outcome: 'pass' };
    return analysis.pages.slice(0, 5).map(page => {
      const queries = topQueries(bing, page.page, window);
      const evidence = [context.evidence.add({
        kind: 'owner-data', url: page.page, label: `Bing performance of the page from ${window.start} to ${window.end}`,
        excerpt: `impressions=${page.impressions}; clicks=${page.clicks}; ctr=${percent(page.ctr)}; position=${page.position.toFixed(1)}; CTR of the site's other pages at that position=${percent(page.expectedCtr)}`,
      })];
      if (queries.length > 0) {
        evidence.push(context.evidence.add({
          kind: 'owner-data', url: page.page, label: 'queries with the most Bing impressions for the page', path: searchQueriesPath,
          excerpt: queries.map((query, index) => `${queryLabel(context, query.key, index)} (${query.impressions} impressions${query.position === undefined ? '' : `, position ${query.position.toFixed(1)}`})`).join('\n'),
        }));
      }
      return {
        outcome: 'fail' as const, severity: 'low' as const, evidence,
        params: { page: displayUrl(page.page), impressions: page.impressions, position: page.position.toFixed(1), ctr: percent(page.ctr), expected: percent(page.expectedCtr), start: window.start, end: window.end },
      };
    });
  },
};

/** Context, not a judgment: the report Bing keeps of AI citations is only in its web interface. */
const aiPerformance: RuleImplementation = {
  id: 'content-bing-ai-performance',
  evaluate(context) {
    const bing = bingOf(context);
    const evidence = [context.evidence.add({ kind: 'owner-data', url: bing.site, label: 'verified Bing Webmaster Tools site whose AI Performance report holds the citations', excerpt: bing.site })];
    return { outcome: 'fail', severity: 'info', evidence, params: { site: displayUrl(bing.site) } };
  },
};

export const implementations: readonly RuleImplementation[] = [crawlIssues, pageIssues, lowCtr, aiPerformance];
