import type { SiteFacts, SitemapFacts } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import { headerValue } from '../../fetch/http.ts';
import { isW3cDatetime, sitemapLimits } from '../../fetch/sitemap.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import {
  declaredCanonical, effectiveDirectives, factsAt, failure, knownResponses, normalizeUrl, notApplicable, passed, robotsDecision,
  robotsFile, sitemapLocs, worst,
} from './shared.ts';

const sitemapNamespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function looksLikeHtml(entry: SitemapFacts): boolean {
  const type = (headerValue(entry.fetch.headers, 'content-type') ?? '').toLowerCase();
  return type.includes('text/html') || /^\s*(?:<!doctype html|<html)/iu.test(entry.fetch.body.subarray(0, 256).toString('latin1'));
}

function isTextSitemap(entry: SitemapFacts): boolean {
  const start = entry.fetch.body.subarray(0, 256).toString('utf8').trimStart();
  return start !== '' && !start.startsWith('<') && entry.fetch.body[0] !== 0x1f;
}

function validLoc(loc: string): boolean {
  if (loc.length >= 2048) return false;
  try {
    return /^https?:$/u.test(new URL(loc).protocol) && /^https?:\/\//iu.test(loc);
  } catch {
    return false;
  }
}

/** Sitemaps that answered with a document; an absent default /sitemap.xml is not a sitemap at all. */
function readable(site: SiteFacts): SitemapFacts[] {
  return site.sitemaps.filter(entry => entry.fetch.status === 200 && !(entry.source === 'default' && (looksLikeHtml(entry) || !entry.document || entry.document.kind === 'unknown')));
}

const sitemapValidity: RuleImplementation = {
  id: 'crawl-sitemap-validity',
  evaluate({ site, evidence }) {
    const results: RuleResult[] = [];
    let checked = 0;
    for (const entry of site.sitemaps.filter(item => item.source === 'index' && item.fetch.status !== 200)) {
      checked += 1;
      const id = evidence.add({ kind: 'sitemap', url: entry.url, label: 'child sitemap listed in a sitemap index', excerpt: entry.fetch.status === undefined ? 'no response' : `HTTP ${entry.fetch.status}` });
      results.push(failure({ severity: 'medium', evidence: [id], reason: 'child-unreachable', params: { url: entry.url, detail: `HTTP ${entry.fetch.status ?? 'error'}` } }));
    }
    for (const entry of readable(site)) {
      checked += 1;
      const url = entry.url;
      if (isTextSitemap(entry)) {
        const lines = entry.fetch.body.toString('utf8').split(/\r\n|\r|\n/u).map(line => line.trim()).filter(Boolean);
        const invalid = lines.map((line, index) => ({ line, number: index + 1 })).filter(item => !validLoc(item.line));
        if (lines.length > sitemapLimits.entries || entry.fetch.body.length > sitemapLimits.bytes) {
          results.push(failure({ severity: 'high', evidence: [evidence.add({ kind: 'sitemap', url, label: 'URLs in the text sitemap', excerpt: String(lines.length) })], reason: 'over-limit', params: { url, detail: `${lines.length} URLs` } }));
        } else if (invalid.length > 0) {
          const ids = invalid.slice(0, 5).map(item => evidence.add({ kind: 'sitemap', url, label: 'text sitemap line that is not an absolute URL', excerpt: item.line, line: item.number }));
          results.push(failure({ severity: 'medium', evidence: ids, reason: 'invalid-urls', params: { url, detail: `${invalid.length} lines` } }));
        }
        continue;
      }
      const document = entry.document;
      if (!document || looksLikeHtml(entry) || document.kind === 'unknown' || document.errors.length > 0) {
        const error = document?.errors[0];
        const id = evidence.add({ kind: 'sitemap', url, label: 'sitemap parse result', excerpt: error ? error.message : looksLikeHtml(entry) ? 'HTML document instead of XML' : 'root element is not urlset or sitemapindex', ...(error?.line ? { line: error.line } : {}) });
        results.push(failure({ severity: 'high', evidence: [id], reason: 'unparseable', params: { url, detail: error?.message ?? 'not a sitemap' } }));
        continue;
      }
      if (document.namespace !== sitemapNamespace) {
        const id = evidence.add({ kind: 'sitemap', url, label: 'namespace of the root element', excerpt: document.namespace ?? '(none)' });
        results.push(failure({ severity: 'high', evidence: [id], reason: 'wrong-namespace', params: { url, detail: document.namespace ?? '(none)' } }));
        continue;
      }
      if (document.overEntryLimit || document.overByteLimit) {
        const id = evidence.add({ kind: 'sitemap', url, label: 'entries and uncompressed bytes', excerpt: `${document.urls.length + document.sitemaps.length} entries, ${document.bytes} bytes` });
        results.push(failure({ severity: 'high', evidence: [id], reason: 'over-limit', params: { url, detail: `${document.urls.length + document.sitemaps.length} entries, ${document.bytes} bytes` } }));
        continue;
      }
      if (entry.source === 'index' && document.kind === 'sitemapindex') {
        const id = evidence.add({ kind: 'sitemap', url, label: 'sitemap index listed inside another sitemap index', excerpt: `${document.sitemaps.length} child sitemaps` });
        results.push(failure({ severity: 'medium', evidence: [id], reason: 'nested-index', params: { url, detail: 'index inside an index' } }));
      }
      const invalid = [...document.urls, ...document.sitemaps].filter(item => !validLoc(item.loc));
      if (invalid.length > 0) {
        const ids = invalid.slice(0, 5).map(item => evidence.add({ kind: 'sitemap', url, label: 'loc that is not an absolute http(s) URL under 2,048 characters', excerpt: item.loc, line: item.line }));
        results.push(failure({ severity: 'medium', evidence: ids, reason: 'invalid-urls', params: { url, detail: `${invalid.length} entries` } }));
      }
    }
    if (checked === 0) return notApplicable('no-sitemap-document');
    return results.length > 0 ? results : passed();
  },
};

function directoryOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1)}`;
}

const sitemapScope: RuleImplementation = {
  id: 'crawl-sitemap-scope',
  evaluate({ site, evidence }) {
    const documents = readable(site).filter(entry => entry.document?.kind === 'urlset');
    if (documents.length === 0) return notApplicable('no-sitemap-document');
    const declared = new Set((robotsFile(site)?.sitemaps ?? []).map(line => normalizeUrl(line.value)));
    const robotsOrigin = new URL(site.robots?.url ?? `${site.origin}/robots.txt`).origin;
    const httpsSite = site.origin.startsWith('https:');
    const outside: { loc: string; line: number; sitemap: string }[] = [];
    const insecure: { loc: string; line: number; sitemap: string }[] = [];
    for (const entry of documents) {
      const directory = directoryOf(entry.url);
      const crossSubmitted = declared.has(normalizeUrl(entry.url));
      for (const item of entry.document!.urls) {
        let loc: URL;
        try { loc = new URL(item.loc); } catch { continue; }
        if (httpsSite && loc.protocol === 'http:') insecure.push({ loc: item.loc, line: item.line, sitemap: entry.url });
        const inScope = item.loc.startsWith(directory) || (crossSubmitted && loc.origin === robotsOrigin);
        if (!inScope && !(httpsSite && loc.protocol === 'http:')) outside.push({ loc: item.loc, line: item.line, sitemap: entry.url });
      }
    }
    const results: RuleResult[] = [];
    if (outside.length > 0) {
      const ids = outside.slice(0, 5).map(item => evidence.add({ kind: 'sitemap', url: item.sitemap, label: 'URL outside the sitemap location scope', excerpt: item.loc, line: item.line }));
      results.push(failure({ severity: 'medium', evidence: ids, reason: 'out-of-scope', params: { count: outside.length, sitemap: outside[0]!.sitemap } }));
    }
    if (insecure.length > 0) {
      const ids = insecure.slice(0, 5).map(item => evidence.add({ kind: 'sitemap', url: item.sitemap, label: 'http URL in a sitemap of an https site', excerpt: item.loc, line: item.line }));
      results.push(failure({ severity: 'medium', evidence: ids, reason: 'http-urls', params: { count: insecure.length, sitemap: insecure[0]!.sitemap } }));
    }
    return results.length > 0 ? results : passed();
  },
};

const sitemapUrlQuality: RuleImplementation = {
  id: 'crawl-sitemap-url-quality',
  evaluate({ site, evidence }) {
    const locs = [...new Map(sitemapLocs(site).map(entry => [normalizeUrl(entry.loc), entry])).values()].filter(entry => normalizeUrl(entry.loc) !== undefined);
    if (locs.length === 0) return notApplicable('no-sitemap-urls');
    const known = knownResponses(site);
    const problems: { loc: string; sitemap: string; line: number; kind: string; detail: string; severity: Severity }[] = [];
    let classified = 0;
    for (const entry of locs) {
      const url = normalizeUrl(entry.loc)!;
      const decision = robotsDecision(site, url);
      const response = known.get(url);
      if (decision || response) classified += 1;
      const add = (kind: string, detail: string, severity: Severity) => problems.push({ loc: entry.loc, sitemap: entry.sitemap, line: entry.line, kind, detail, severity });
      if (decision && !decision.allowed) {
        add('robots-blocked', `${decision.rule!.type}: ${decision.rule!.pattern}`, 'medium');
        continue;
      }
      if (!response) continue;
      if (response.status >= 400) add('error', `HTTP ${response.status}`, 'low');
      else if (response.status >= 300) add('redirect', `HTTP ${response.status} -> ${response.location ?? ''}`, 'low');
      else {
        const facts = factsAt(site, url);
        if (facts?.raw && effectiveDirectives(facts, facts.raw).has('noindex')) add('noindex', [...effectiveDirectives(facts, facts.raw)].join(', '), 'medium');
        else if (facts?.raw) {
          const canonical = declaredCanonical(facts);
          if (canonical && canonical !== normalizeUrl(facts.fetch.finalUrl)) add('canonicalised', `canonical ${canonical}`, 'low');
        }
      }
    }
    if (problems.length === 0) return passed();
    const ratio = classified > 0 ? problems.length / classified : 0;
    let severity = problems.reduce<Severity>((current, problem) => worst(current, problem.severity), 'info');
    if (classified >= 10 && ratio > 0.1) severity = 'high';
    const ids = problems.slice(0, 8).map(problem => evidence.add({ kind: 'sitemap', url: problem.sitemap, label: `sitemap URL that is not an indexable canonical page (${problem.kind})`, excerpt: `${problem.loc} | ${problem.detail}`, line: problem.line }));
    const reason = severity === 'high' ? 'high-share' : problems.find(problem => problem.severity === severity)!.kind;
    return failure({ severity, evidence: ids, reason, params: { count: problems.length, classified, share: `${Math.round(ratio * 100)}%` } });
  },
};

const sitemapLastmod: RuleImplementation = {
  id: 'crawl-sitemap-lastmod',
  evaluate({ site, evidence }) {
    const documents = readable(site).filter(entry => entry.document?.kind === 'urlset');
    const dated = documents.flatMap(entry => entry.document!.urls.filter(url => url.lastmod !== undefined).map(url => ({ entry, url, lastmod: url.lastmod! })));
    if (dated.length === 0) return notApplicable('no-lastmod');
    const invalid = dated.filter(item => !isW3cDatetime(item.lastmod));
    if (invalid.length > 0) {
      const ids = invalid.slice(0, 5).map(item => evidence.add({ kind: 'sitemap', url: item.entry.url, label: 'lastmod that is not a W3C Datetime', excerpt: item.lastmod, line: item.url.line }));
      return failure({ severity: 'medium', evidence: ids, reason: 'invalid-format', params: { count: invalid.length, value: invalid[0]!.lastmod } });
    }
    const results: RuleResult[] = [];
    const counts = new Map<string, number>();
    for (const item of dated) counts.set(item.lastmod, (counts.get(item.lastmod) ?? 0) + 1);
    const [common, commonCount] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
    const sample = dated.find(item => item.lastmod === common)!;
    const served = Date.parse(headerValue(sample.entry.fetch.headers, 'date') ?? '');
    if (dated.length >= 20 && commonCount / dated.length > 0.9) {
      const ids = [evidence.add({ kind: 'sitemap', url: sample.entry.url, label: 'lastmod value shared by most URLs, with its count', excerpt: `${common} (${commonCount} of ${dated.length})` })];
      const generated = common.includes('T') && !Number.isNaN(served) && Math.abs(Date.parse(common) - served) <= 10 * 60_000;
      if (generated) {
        ids.push(evidence.add({ kind: 'header', url: sample.entry.url, label: 'Date header of the sitemap response', excerpt: headerValue(sample.entry.fetch.headers, 'date')! }));
        results.push(failure({ severity: 'medium', evidence: ids, reason: 'generation-time', params: { count: commonCount, value: common } }));
      } else {
        results.push(failure({ severity: 'medium', evidence: ids, reason: 'uniform', params: { count: commonCount, value: common }, needsJudgment: true }));
      }
    }
    if (!Number.isNaN(served)) {
      const future = dated.filter(item => Date.parse(item.lastmod.length === 10 ? `${item.lastmod}T00:00:00Z` : item.lastmod) > served + 86_400_000);
      if (future.length > 0) {
        const ids = future.slice(0, 5).map(item => evidence.add({ kind: 'sitemap', url: item.entry.url, label: 'lastmod later than the sitemap response date', excerpt: `${item.url.loc} | ${item.lastmod}`, line: item.url.line }));
        results.push(failure({ severity: 'low', evidence: ids, reason: 'future-dates', params: { count: future.length, value: future[0]!.lastmod } }));
      }
    }
    return results.length > 0 ? results : passed();
  },
};

const sitemapIgnoredTags: RuleImplementation = {
  id: 'crawl-sitemap-ignored-tags',
  evaluate({ site, evidence }) {
    const documents = readable(site).filter(entry => entry.document?.kind === 'urlset');
    if (documents.length === 0) return notApplicable('no-sitemap-document');
    const tagged = documents.flatMap(entry => entry.document!.urls.filter(url => url.changefreq !== undefined || url.priority !== undefined).map(url => ({ entry, url })));
    if (tagged.length === 0) return passed();
    const first = tagged[0]!;
    const excerpt = [first.url.changefreq ? `changefreq ${first.url.changefreq}` : '', first.url.priority ? `priority ${first.url.priority}` : ''].filter(Boolean).join(', ');
    const id = evidence.add({ kind: 'sitemap', url: first.entry.url, label: 'sitemap entry with changefreq or priority', excerpt: `${first.url.loc} | ${excerpt}`, line: first.url.line });
    return failure({ severity: 'info', evidence: [id], params: { count: tagged.length } });
  },
};

export const sitemapRules: readonly RuleImplementation[] = [sitemapValidity, sitemapScope, sitemapUrlQuality, sitemapLastmod, sitemapIgnoredTags];
