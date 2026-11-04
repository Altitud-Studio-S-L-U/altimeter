import type { EvidenceStore } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import { headerValue } from '../../fetch/http.ts';
import type { RuleImplementation } from '../engine.ts';
import { pageDocument, robotsDirectives, summarizeList, type RobotsDirectives } from '../helpers.ts';
import {
  effectiveDirectives, errorWording, failure, internalLinks, isHomePage, isStagingHost, namedByOtherPage, notApplicable, notEvaluated,
  pageHeadlines, passed, robotsSources, sitemapEntryFor, worst,
} from './shared.ts';

function citeSource(evidence: EvidenceStore, url: string, entry: RobotsDirectives, prefix = ''): string {
  return evidence.add({
    kind: entry.source === 'meta' ? 'html' : 'header',
    url,
    label: `${prefix}${entry.source === 'meta' ? `robots meta element (${entry.agent === 'all' ? 'robots' : entry.agent})` : 'X-Robots-Tag header'}`,
    excerpt: entry.raw,
    ...(entry.line ? { line: entry.line } : {}),
  });
}

function sourcesWith(page: PageFacts, doc: DocumentFacts | undefined, directive: string, agent = 'googlebot'): RobotsDirectives[] {
  return robotsSources(page, doc, agent).filter(entry => entry.directives.includes(directive) || (directive !== 'none' && entry.directives.includes('none') && (directive === 'noindex' || directive === 'nofollow')));
}

function usableRender(page: PageFacts): DocumentFacts | undefined {
  return page.rendered && page.rendered.result.error === undefined ? page.rendered : undefined;
}

const metaRobotsNoindex: RuleImplementation = {
  id: 'crawl-meta-robots-noindex',
  evaluate({ site, page, evidence }) {
    const target = page!;
    if (target.fetch.status !== 200) return notApplicable('non-200');
    const docs = [target.raw, usableRender(target)].filter((doc): doc is DocumentFacts => doc !== undefined);
    const googleSources = docs.flatMap(doc => sourcesWith(target, doc, 'noindex'));
    const bingSources = docs.flatMap(doc => sourcesWith(target, doc, 'noindex', 'bingbot'));
    if (googleSources.length === 0 && bingSources.length === 0) return passed();
    const url = target.fetch.finalUrl;
    const ids = [...new Map([...googleSources, ...bingSources].map(entry => [entry.raw + entry.source, entry])).values()].slice(0, 3).map(entry => citeSource(evidence, url, entry));
    if (['legal', 'utility', 'error'].includes(target.pageType)) return passed(ids);
    if (isStagingHost(new URL(url).hostname)) return notApplicable('staging-host');
    const crawler = googleSources.length > 0 ? 'Googlebot' : 'Bingbot';
    const listed = sitemapEntryFor(site, url) ?? sitemapEntryFor(site, target.url);
    const named = namedByOtherPage(site, url);
    const home = isHomePage(site, target);
    if (listed) ids.push(evidence.add({ kind: 'sitemap', url: listed.sitemap, label: 'sitemap entry for the noindex page', excerpt: listed.loc, line: listed.line }));
    if (named) ids.push(evidence.add({ kind: 'html', url: named.by, label: `page that names the noindex page as its ${named.as} target`, excerpt: url }));
    const conflict = home ? 'home' : listed ? 'sitemap' : named ? named.as : undefined;
    if (googleSources.length === 0) return failure({ severity: 'medium', evidence: ids, reason: 'bingbot-only', params: { url, crawler } });
    if (conflict) return failure({ severity: 'critical', evidence: ids, reason: `conflict-${conflict}`, params: { url, crawler } });
    return failure({ severity: 'medium', evidence: ids, reason: 'content-page', params: { url, crawler } });
  },
};

const noindexRawVsRendered: RuleImplementation = {
  id: 'crawl-noindex-raw-vs-rendered',
  evaluate({ page, evidence }) {
    const target = page!;
    const rendered = usableRender(target)!;
    const rawNoindex = effectiveDirectives(target, target.raw).has('noindex');
    const renderedNoindex = effectiveDirectives(target, rendered).has('noindex');
    const url = target.fetch.finalUrl;
    if (rawNoindex === renderedNoindex) return passed();
    const rawIds = sourcesWith(target, target.raw, 'noindex').map(entry => citeSource(evidence, url, entry, 'raw HTML: '));
    const renderedIds = sourcesWith(target, rendered, 'noindex').map(entry => citeSource(evidence, url, entry, 'rendered DOM: '));
    if (rawNoindex) {
      const none = evidence.add({ kind: 'render', url, label: 'robots directives in the rendered DOM', excerpt: [...effectiveDirectives(target, rendered)].join(', ') || '(none)' });
      return failure({ severity: 'critical', evidence: [...rawIds, none], reason: 'removed-by-js', params: { url } });
    }
    const errorView = target.pageType === 'error' || errorWording.test(pageHeadlines(rendered));
    if (errorView) {
      const heading = evidence.add({ kind: 'render', url, label: 'rendered title and h1', excerpt: pageHeadlines(rendered) });
      return failure({ severity: 'info', evidence: [...renderedIds, heading], reason: 'error-view', params: { url } });
    }
    return failure({ severity: 'high', evidence: renderedIds, reason: 'added-by-js', params: { url } });
  },
};

const snippetDirective = /^max-snippet:(-?\d+)$/u;

const robotsDirectivesConflict: RuleImplementation = {
  id: 'crawl-robots-directives-conflict',
  evaluate({ page, evidence }) {
    const target = page!;
    const doc = pageDocument(target);
    const sources = robotsSources(target, doc);
    if (sources.length === 0) return notApplicable('no-robots-directives');
    const all = sources.flatMap(entry => entry.directives.map(directive => ({ directive, entry })));
    const has = (directive: string) => all.some(item => item.directive === directive);
    const values = (prefix: string) => new Set(all.filter(item => item.directive.startsWith(`${prefix}:`)).map(item => item.directive));
    const snippetValues = [...values('max-snippet')].map(value => Number(snippetDirective.exec(value)?.[1]));
    const issues: { severity: Severity; reason: string; directives: string[] }[] = [];
    if ((has('noindex') || has('none')) && (has('index') || has('all'))) issues.push({ severity: 'medium', reason: 'index-noindex', directives: ['index', 'all', 'noindex', 'none'] });
    if (has('nosnippet') && snippetValues.some(value => value !== 0)) issues.push({ severity: 'medium', reason: 'snippet', directives: ['nosnippet', ...values('max-snippet')] });
    else if (values('max-snippet').size > 1) issues.push({ severity: 'medium', reason: 'snippet', directives: [...values('max-snippet')] });
    if ((has('nofollow') || has('none')) && (has('follow') || has('all'))) issues.push({ severity: 'low', reason: 'follow-nofollow', directives: ['follow', 'all', 'nofollow', 'none'] });
    for (const prefix of ['max-image-preview', 'max-video-preview']) {
      if (values(prefix).size > 1) issues.push({ severity: 'low', reason: 'differing-values', directives: [...values(prefix)] });
    }
    if (issues.length === 0) {
      const counts = new Map<string, number>();
      for (const entry of sources) for (const directive of new Set(entry.directives)) counts.set(directive, (counts.get(directive) ?? 0) + 1);
      const repeated = [...counts].filter(([, count]) => count > 1).map(([directive]) => directive);
      if (repeated.length > 0 && sources.length > 1) issues.push({ severity: 'low', reason: 'duplicate', directives: repeated });
    }
    if (issues.length === 0) return passed(sources.map(entry => citeSource(evidence, target.fetch.finalUrl, entry)));
    const top = issues.reduce<Severity>((current, issue) => worst(current, issue.severity), 'info');
    const chosen = issues.find(issue => issue.severity === top)!;
    const involved = sources.filter(entry => entry.directives.some(directive => chosen.directives.includes(directive)));
    const ids = involved.map(entry => citeSource(evidence, target.fetch.finalUrl, entry));
    const effective = [...effectiveDirectives(target, doc)].filter(directive => directive !== 'index' && directive !== 'follow' && directive !== 'all');
    return failure({ severity: top, evidence: ids, reason: chosen.reason, params: { url: target.fetch.finalUrl, effective: effective.join(', ') || 'all' } });
  },
};

const plainDirectives = new Set(['all', 'none', 'noindex', 'nofollow', 'nosnippet', 'noimageindex', 'notranslate', 'indexifembedded', 'index', 'follow']);
const noOps = new Set(['noarchive', 'nocache', 'nositelinkssearchbox', 'noodp', 'noydir']);

function tokenProblem(token: string): { severity: Severity; reason: string } | undefined {
  if (plainDirectives.has(token) || token.startsWith('unavailable_after')) return undefined;
  if (noOps.has(token)) return { severity: 'info', reason: 'no-op' };
  const valued = /^(max-snippet|max-video-preview|max-image-preview):(.*)$/u.exec(token);
  if (valued) {
    const [, name, value] = valued;
    const valid = name === 'max-image-preview' ? /^(none|standard|large)$/u.test(value!) : /^-?\d+$/u.test(value!) && Number(value) >= -1;
    return valid ? undefined : { severity: 'medium', reason: 'malformed-value' };
  }
  const parts = token.split(/\s+/u);
  if (parts.length > 1 && parts.every(part => plainDirectives.has(part) || noOps.has(part))) return { severity: 'low', reason: 'space-separated' };
  return { severity: 'medium', reason: 'unknown-token' };
}

const robotsDirectiveValidity: RuleImplementation = {
  id: 'crawl-robots-directive-validity',
  evaluate({ page, evidence }) {
    const target = page!;
    const sources = robotsDirectives(target.fetch.headers, pageDocument(target));
    if (sources.length === 0) return notApplicable('no-robots-directives');
    const problems = sources.flatMap(entry => entry.directives.map(token => ({ token, entry, problem: tokenProblem(token) })))
      .filter((item): item is typeof item & { problem: { severity: Severity; reason: string } } => item.problem !== undefined);
    if (problems.length === 0) return passed();
    const top = problems.reduce<Severity>((current, item) => worst(current, item.problem.severity), 'info');
    const chosen = problems.filter(item => item.problem.severity === top);
    const ids = [...new Set(chosen.map(item => item.entry))].slice(0, 4).map(entry => citeSource(evidence, target.fetch.finalUrl, entry));
    return failure({ severity: top, evidence: ids, reason: chosen[0]!.problem.reason, params: { url: target.fetch.finalUrl, tokens: summarizeList([...new Set(chosen.map(item => item.token))]) } });
  },
};

const expiringTypes = /^(?:\w*Event|JobPosting|Offer|AggregateOffer)$/u;

const unavailableAfter: RuleImplementation = {
  id: 'crawl-unavailable-after',
  evaluate({ page, evidence }) {
    const target = page!;
    const doc = pageDocument(target);
    const found = robotsSources(target, doc).flatMap(entry => entry.directives.filter(token => token.startsWith('unavailable_after')).map(token => ({ token, entry })));
    if (found.length === 0) return notApplicable('no-unavailable-after');
    const url = target.fetch.finalUrl;
    const { token, entry } = found[0]!;
    const value = token.replace(/^unavailable_after\s*:?/u, '').trim();
    const id = citeSource(evidence, url, entry);
    const time = /\d{2,4}/u.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(time)) return failure({ severity: 'low', evidence: [id], reason: 'unparseable', params: { url, date: value } });
    const served = Date.parse(headerValue(target.fetch.headers, 'date') ?? '');
    if (Number.isNaN(served)) return notEvaluated('no-response-date');
    const days = Math.floor((time - served) / 86_400_000);
    if (days > 30) return passed([id]);
    if (doc?.data.nodes.some(node => node.types.some(type => expiringTypes.test(type)))) return notApplicable('expiring-content');
    const dated = evidence.add({ kind: 'header', url, label: 'Date response header', excerpt: headerValue(target.fetch.headers, 'date')! });
    if (time <= served) return failure({ severity: target.fetch.status === 200 ? 'critical' : 'low', evidence: [id, dated], reason: 'past', params: { url, date: value } });
    return failure({ severity: 'medium', evidence: [id, dated], reason: 'soon', params: { url, date: value, days } });
  },
};

const snippetRestrictions: RuleImplementation = {
  id: 'crawl-snippet-restrictions',
  evaluate({ page, evidence }) {
    const target = page!;
    if (target.fetch.status !== 200) return notApplicable('non-200');
    if (target.pageType === 'legal' || target.pageType === 'utility') return notApplicable('policy-or-utility-page');
    const doc = pageDocument(target);
    const directives = effectiveDirectives(target, doc);
    if (directives.has('noindex')) return notApplicable('noindex');
    const url = target.fetch.finalUrl;
    const cite = (directive: string) => robotsSources(target, doc).filter(entry => entry.directives.includes(directive)).map(entry => citeSource(evidence, url, entry));
    const snippet = [...directives].map(value => snippetDirective.exec(value)).find(match => match !== null);
    if (directives.has('nosnippet')) return failure({ severity: 'medium', evidence: cite('nosnippet'), reason: 'nosnippet', params: { url, directive: 'nosnippet' }, needsJudgment: true });
    if (snippet && Number(snippet[1]) === 0) return failure({ severity: 'medium', evidence: cite(snippet[0]), reason: 'nosnippet', params: { url, directive: snippet[0] }, needsJudgment: true });
    if (snippet && Number(snippet[1]) > 0 && Number(snippet[1]) < 50) {
      return failure({ severity: 'medium', evidence: cite(snippet[0]), reason: 'short-snippet', params: { url, directive: snippet[0] }, needsJudgment: true });
    }
    const image = [...directives].find(value => value === 'max-image-preview:none' || value === 'max-image-preview:standard');
    if (image && target.pageType === 'article') return failure({ severity: 'low', evidence: cite(image), reason: 'image-preview', params: { url, directive: image }, needsJudgment: true });
    if (directives.has('max-video-preview:0')) return failure({ severity: 'low', evidence: cite('max-video-preview:0'), reason: 'video-preview', params: { url, directive: 'max-video-preview:0' }, needsJudgment: true });
    return passed();
  },
};

const pageNofollow: RuleImplementation = {
  id: 'crawl-page-nofollow',
  evaluate({ site, page, evidence }) {
    const target = page!;
    const doc = pageDocument(target);
    const url = target.fetch.finalUrl;
    if (internalLinks(doc, url).length === 0) return notApplicable('no-internal-links');
    if (!effectiveDirectives(target, doc).has('nofollow')) return passed();
    const ids = sourcesWith(target, doc, 'nofollow').map(entry => citeSource(evidence, url, entry));
    const hub = isHomePage(site, target) || target.pageType === 'listing';
    return failure({ severity: hub ? 'medium' : 'low', evidence: ids, reason: hub ? 'hub-page' : 'leaf-page', params: { url, links: internalLinks(doc, url).length } });
  },
};

const indexIfEmbedded: RuleImplementation = {
  id: 'crawl-indexifembedded',
  evaluate({ page, evidence }) {
    const target = page!;
    const doc = pageDocument(target);
    const sources = sourcesWith(target, doc, 'indexifembedded');
    if (sources.length === 0) return notApplicable('no-indexifembedded');
    const ids = sources.map(entry => citeSource(evidence, target.fetch.finalUrl, entry));
    if (effectiveDirectives(target, doc).has('noindex')) return passed(ids);
    return failure({ severity: 'info', evidence: ids, params: { url: target.fetch.finalUrl } });
  },
};

export const directiveRules: readonly RuleImplementation[] = [
  metaRobotsNoindex, noindexRawVsRendered, robotsDirectivesConflict, robotsDirectiveValidity, unavailableAfter, snippetRestrictions, pageNofollow,
  indexIfEmbedded,
];
