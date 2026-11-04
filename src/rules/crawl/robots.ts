import { classifyPage } from '../../analyze/page-type.ts';
import { evidenceLabel, joinLabels, type EvidenceLabel } from '../../core/evidence.ts';
import type { SiteFacts } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import { headerValue } from '../../fetch/http.ts';
import { isAllowed, robotsByteLimit, selectGroup, type RobotsFile, type RobotsGroup, type RobotsRule } from '../../fetch/robots.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';
import {
  effectiveDirectives, failure, isHomePage, isStagingHost, namedByOtherPage, normalizeUrl, notApplicable, notEvaluated, passed,
  robotsDecision, robotsFile, sitemapEntryFor, sitemapLocs, worst,
} from './shared.ts';

function robotsUrl(site: SiteFacts): string {
  return site.robots!.url;
}

/**
 * A robots.txt body that is really an HTML page, such as an application shell served for every path. Google reads the
 * bytes whatever the Content-Type, so only the content decides; trimming also drops a byte order mark.
 */
export function robotsBodyIsHtml(site: SiteFacts): boolean {
  const start = site.robots?.fetch.body.subarray(0, 1024).toString('utf8').trimStart() ?? '';
  return start.startsWith('<') && /<(?:!doctype\s+html|html|head|body)[\s>]/iu.test(start);
}

function ruleLine(rule: RobotsRule): string {
  return `${rule.type === 'allow' ? 'Allow' : 'Disallow'}: ${rule.pattern}`;
}

const robotsFetchStatus: RuleImplementation = {
  id: 'crawl-robots-fetch-status',
  evaluate({ site, evidence }) {
    const robots = site.robots!;
    const status = robots.fetch.status;
    const fetchError = robots.fetch.error?.code ?? 'connection';
    const id = status === undefined
      ? evidence.add({ kind: 'robots', url: robots.url, label: evidenceLabel('robots.txt request that got no response ({fetchError})', { fetchError }) })
      : evidence.add({ kind: 'robots', url: robots.url, label: evidenceLabel('robots.txt fetch outcome'), excerpt: `HTTP ${status}` });
    // Google gives up on a redirect loop after five hops and reads the file as missing; crawl-robots-redirects reports the loop.
    if (robots.availability.kind === 'unreachable' && robots.fetch.error?.code !== 'redirect-loop') {
      return status === undefined
        ? failure({ severity: 'critical', evidence: [id], reason: 'network-error', params: { url: robots.url, fetchError } })
        : failure({ severity: 'critical', evidence: [id], reason: 'server-error', params: { url: robots.url, status: `HTTP ${status}` } });
    }
    if (status === 401 || status === 403) return failure({ severity: 'info', evidence: [id], reason: 'access-denied', params: { url: robots.url, status: `HTTP ${status}` } });
    return passed([id]);
  },
};

const robotsRedirects: RuleImplementation = {
  id: 'crawl-robots-redirects',
  evaluate({ site, evidence }) {
    const fetch = site.robots!.fetch;
    const redirects = fetch.hops.filter(hop => hop.location !== undefined);
    const loop = fetch.error?.code === 'redirect-loop';
    if (loop || fetch.error?.code === 'too-many-redirects' || redirects.length > 5) {
      const ids = redirects.map((hop, index) => evidence.add({ kind: 'redirect', url: hop.url, label: evidenceLabel('robots.txt redirect hop {number}', { number: index + 1 }), excerpt: `${hop.status} -> ${hop.location}` }));
      return failure({ severity: 'high', evidence: ids, reason: loop ? 'loop' : 'too-many-hops', params: { url: robotsUrl(site), hops: redirects.length } });
    }
    if (fetch.hops.length === 0) return notEvaluated('robots-unreachable');
    if (redirects.length === 0) return notApplicable('no-redirect');
    const ids = redirects.map((hop, index) => evidence.add({ kind: 'redirect', url: hop.url, label: evidenceLabel('robots.txt redirect hop {number}', { number: index + 1 }), excerpt: `${hop.status} -> ${hop.location}` }));
    return passed(ids);
  },
};

/** Rule-bearing lines that start after Google's 500 KiB parsing limit. */
function rulesAfterLimit(body: Buffer): { line: number; text: string }[] {
  if (body.length <= robotsByteLimit) return [];
  const before = body.subarray(0, robotsByteLimit).toString('utf8');
  const firstLine = before.split(/\r\n|\r|\n/u).length;
  const lines = body.subarray(robotsByteLimit).toString('utf8').split(/\r\n|\r|\n/u);
  const lost: { line: number; text: string }[] = [];
  for (const [index, text] of lines.entries()) {
    if (/^\s*(?:user-agent|allow|disallow|sitemap)\s*:/iu.test(text)) lost.push({ line: firstLine + index, text: text.trim() });
  }
  return lost;
}

function invalidUtf8RuleLines(body: Buffer): { line: number; text: string }[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const found: { line: number; text: string }[] = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index <= body.length; index += 1) {
    if (index < body.length && body[index] !== 0x0a) continue;
    const bytes = body.subarray(start, index);
    try {
      decoder.decode(bytes);
    } catch {
      const text = bytes.toString('latin1').trim();
      if (/^(?:allow|disallow)\s*:/iu.test(text)) found.push({ line, text });
    }
    start = index + 1;
    line += 1;
  }
  return found;
}

const robotsFormat: RuleImplementation = {
  id: 'crawl-robots-format',
  evaluate({ site, evidence }) {
    if (site.robots!.availability.kind !== 'parsed') return notApplicable('no-robots-file');
    const { body, headers } = site.robots!.fetch;
    const url = robotsUrl(site);
    if (robotsBodyIsHtml(site)) {
      const type = headerValue(headers, 'content-type');
      const id = evidence.add({
        kind: 'robots', url, excerpt: body.subarray(0, 120).toString('utf8').trim(),
        label: type === undefined ? evidenceLabel('start of the robots.txt body, served without a Content-Type header') : evidenceLabel('start of the robots.txt body, served as {type}', { type }),
      });
      return failure({ severity: 'medium', evidence: [id], reason: 'html-body', params: { url } });
    }
    const results: RuleResult[] = [];
    const lost = rulesAfterLimit(body);
    const invalid = lost.length > 0 ? [] : invalidUtf8RuleLines(body);
    if (lost.length > 0) {
      const ids = [
        evidence.add({ kind: 'robots', url, label: evidenceLabel('robots.txt uncompressed size: {bytes, plural, one {# byte} other {# bytes}}', { bytes: body.length }) }),
        ...lost.slice(0, 5).map(entry => evidence.add({ kind: 'robots', url, label: evidenceLabel('rule after the 500 KiB limit'), excerpt: entry.text, line: entry.line })),
      ];
      results.push(failure({ severity: 'high', evidence: ids, reason: 'over-size-limit', params: { url, bytes: body.length, lost: lost.length } }));
    } else if (invalid.length > 0) {
      const ids = invalid.slice(0, 5).map(entry => evidence.add({ kind: 'robots', url, label: evidenceLabel('rule path with bytes that are not UTF-8'), excerpt: entry.text, line: entry.line }));
      results.push(failure({ severity: 'medium', evidence: ids, reason: 'invalid-utf8', params: { url, count: invalid.length } }));
    }
    // RFC 9309 asks for text/plain, but Google reads the rules whatever the type.
    const type = headerValue(headers, 'content-type');
    if (type !== undefined && !/^\s*text\/plain\s*(?:;|$)/iu.test(type)) {
      const id = evidence.add({ kind: 'robots', url, label: evidenceLabel('robots.txt Content-Type header'), excerpt: type });
      results.push(failure({ severity: 'info', evidence: [id], reason: 'content-type', params: { url, type } }));
    }
    return results.length > 0 ? results : passed([evidence.add({ kind: 'robots', url, label: evidenceLabel('robots.txt uncompressed size: {bytes, plural, one {# byte} other {# bytes}}', { bytes: body.length }) })]);
  },
};

const robotsParseErrors: RuleImplementation = {
  id: 'crawl-robots-parse-errors',
  evaluate({ site, evidence }) {
    const file = robotsFile(site);
    if (!file) return notApplicable('no-robots-file');
    if (robotsBodyIsHtml(site)) return notApplicable('html-body');
    const url = robotsUrl(site);
    const issues: { severity: Severity; reason: string; label: EvidenceLabel; line: number; text: string }[] = [];
    for (const entry of file.misspelled) {
      issues.push({ severity: 'medium', reason: 'misspelled-field', label: evidenceLabel('robots.txt line that Google does not read as intended (misspelled-field)'), line: entry.line, text: `${entry.key}: ${entry.value}` });
    }
    for (const entry of file.orphanRules) {
      issues.push({ severity: 'low', reason: 'rule-outside-group', label: evidenceLabel('robots.txt line that Google does not read as intended (rule-outside-group)'), line: entry.line, text: `${entry.key}: ${entry.value}` });
    }
    for (const entry of file.invalid) {
      issues.push({ severity: 'low', reason: 'missing-separator', label: evidenceLabel('robots.txt line that Google does not read as intended (missing-separator)'), line: entry.line, text: entry.value });
    }
    for (const group of file.groups) {
      for (const rule of group.rules) {
        if (rule.pattern !== '' && !rule.pattern.startsWith('/') && !rule.pattern.startsWith('*')) {
          issues.push({ severity: 'low', reason: 'path-without-slash', label: evidenceLabel('robots.txt line that Google does not read as intended (path-without-slash)'), line: rule.line, text: `${rule.type}: ${rule.pattern}` });
        }
      }
    }
    if (issues.length === 0) return passed([evidence.add({ kind: 'robots', url, label: evidenceLabel('robots.txt groups parsed: {count}', { count: file.groups.length }) })]);
    issues.sort((a, b) => a.line - b.line);
    const top = issues.reduce<Severity>((current, issue) => worst(current, issue.severity), 'info');
    const ids = issues.slice(0, 8).map(issue => evidence.add({ kind: 'robots', url, label: issue.label, excerpt: issue.text, line: issue.line }));
    const reason = issues.find(issue => issue.severity === top)!.reason;
    const lines = [...new Set(issues.map(issue => issue.line))];
    return failure({ severity: top, evidence: ids, reason, params: { url, count: lines.length, lines: summarizeList(lines.map(String), 5) } });
  },
};

const unsupportedFields = new Set(['crawl-delay', 'noindex', 'nofollow', 'host', 'clean-param', 'request-rate', 'visit-time', 'noarchive']);

const robotsUnsupportedDirectives: RuleImplementation = {
  id: 'crawl-robots-unsupported-directives',
  evaluate({ site, evidence }) {
    const file = robotsFile(site);
    if (!file) return notApplicable('no-robots-file');
    if (robotsBodyIsHtml(site)) return notApplicable('html-body');
    const url = robotsUrl(site);
    const found = file.unsupported.filter(entry => unsupportedFields.has(entry.key));
    if (found.length === 0) return passed();
    const noindex = found.filter(entry => entry.key === 'noindex');
    const ids = (noindex.length > 0 ? [...noindex, ...found.filter(entry => entry.key !== 'noindex')] : found).slice(0, 8)
      .map(entry => evidence.add({ kind: 'robots', url, label: evidenceLabel('robots.txt field that Google does not support'), excerpt: `${entry.key}: ${entry.value}`, line: entry.line }));
    const fields = summarizeList([...new Set(found.map(entry => entry.key))]);
    if (noindex.length > 0) return failure({ severity: 'high', evidence: ids, reason: 'noindex', params: { url, count: noindex.length, fields } });
    return failure({ severity: 'info', evidence: ids, reason: 'ignored-fields', params: { url, fields } });
  },
};

/** Whether the site signals that it is not meant to be in search at all: a staging host, authentication or a noindex home. */
function privateHost(site: SiteFacts): string | undefined {
  const host = new URL(site.origin).hostname;
  if (isStagingHost(host)) return `staging-like host ${host}`;
  const home = [...site.pages.values()].find(page => isHomePage(site, page));
  if (home && (home.fetch.status === 401 || home.fetch.status === 403)) return `home page answers ${home.fetch.status}`;
  if (home && effectiveDirectives(home, home.raw).has('noindex')) return 'home page carries noindex';
  return undefined;
}

/** Whether a URL the crawl found but did not fetch looks meant for the index: no query string, and not a utility or policy path. */
function meantForIndex(url: string): boolean {
  const { type } = classifyPage({ url, status: undefined, title: undefined, h1: undefined, ogType: undefined, data: undefined });
  return new URL(url).search === '' && type !== 'utility' && type !== 'legal';
}

/** Whether the rules robots.txt has for Googlebot disallow the whole site, so that only what Allow lines open can be crawled. */
function disallowsWholeSite(file: RobotsFile): boolean {
  return selectGroup(file, ['googlebot']).rules.some(rule => rule.type === 'disallow' && rule.pattern !== '' && /^\/?\**$/u.test(rule.pattern));
}

/**
 * The crawled pages meant for the index, and those of them robots.txt disallows for Googlebot. The crawl never fetches
 * a disallowed URL, so when the rules disallow the whole site the URLs it found and left for that reason count too.
 * Under narrower rules they are left out: sites disallow wishlist, compare, comment or filter links on purpose, and
 * every crawled page can link to several of them.
 */
function crawlSample(site: SiteFacts, file: RobotsFile): { readonly total: number; readonly blocked: ReadonlyArray<{ readonly url: string; readonly fetched: boolean }> } {
  const sampled = [...site.pages.values()].filter(page => page.fetch.status === 200 && page.pageType !== 'utility' && page.pageType !== 'legal');
  const found = disallowsWholeSite(file) ? site.crawlBlocked ?? [] : [];
  const unfetched = found.filter(url => meantForIndex(url) && robotsDecision(site, url)?.allowed === false);
  const blocked = [
    ...sampled.filter(page => robotsDecision(site, page.fetch.finalUrl)?.allowed === false).map(page => ({ url: page.fetch.finalUrl, fetched: true })),
    ...unfetched.map(url => ({ url, fetched: false })),
  ];
  return { total: sampled.length + unfetched.length, blocked };
}

const robotsBlocksSite: RuleImplementation = {
  id: 'crawl-robots-blocks-site',
  evaluate({ site, evidence }) {
    const file = robotsFile(site);
    if (!file) return notApplicable('no-robots-rules');
    const url = robotsUrl(site);
    const homePaths = [...new Set([`${site.origin}/`, ...(site.homeUrl ? [site.homeUrl] : [])])];
    const blockedHome = (tokens: string[]) => homePaths.map(path => ({ path, decision: robotsDecision(site, path, tokens) }))
      .find(entry => entry.decision && !entry.decision.allowed);
    const google = blockedHome(['googlebot']);
    const bing = blockedHome(['bingbot']);
    const cite = (entry: NonNullable<typeof google>, crawler: string) => evidence.add({
      kind: 'robots', url, label: joinLabels(evidenceLabel('rule that disallows {path} for {crawler}', { path: entry.path, crawler }), evidenceLabel('(group {token})', { token: entry.decision!.matchedToken ?? '*' })),
      excerpt: `${entry.decision!.rule!.type}: ${entry.decision!.rule!.pattern}`, line: entry.decision!.rule!.line,
    });
    if (google || bing) {
      const exempt = privateHost(site);
      if (exempt) return notApplicable('private-host');
    }
    if (google) return failure({ severity: 'critical', evidence: [cite(google, 'Googlebot')], reason: 'home-googlebot', params: { url: google.path, crawler: 'Googlebot' } });
    if (site.crawled) {
      const { total, blocked } = crawlSample(site, file);
      if (total > 0 && blocked.length / total > 0.5) {
        if (privateHost(site)) return notApplicable('private-host');
        const ids = blocked.slice(0, 5).map(entry => {
          const decision = robotsDecision(site, entry.url)!;
          return evidence.add({
            kind: 'robots', url: entry.url,
            label: entry.fetched ? evidenceLabel('crawled URL disallowed for Googlebot') : evidenceLabel('URL the crawl found and did not fetch because robots.txt disallows it for Googlebot'),
            excerpt: `${decision.rule!.type}: ${decision.rule!.pattern}`, line: decision.rule!.line,
          });
        });
        return failure({ severity: 'critical', evidence: ids, reason: 'most-pages', params: { blocked: blocked.length, total } });
      }
    }
    if (bing) return failure({ severity: 'high', evidence: [cite(bing, 'Bingbot')], reason: 'home-bingbot', params: { url: bing.path, crawler: 'Bingbot' } });
    return passed([evidence.add({ kind: 'robots', url, label: evidenceLabel('home page allowed for Googlebot and Bingbot'), excerpt: homePaths.join(', ') })]);
  },
};

const robotsBlocksPage: RuleImplementation = {
  id: 'crawl-robots-blocks-page',
  evaluate({ site, page, evidence }) {
    if (!robotsFile(site)) return notApplicable('no-robots-rules');
    const target = page!;
    const urls = [...new Set([target.url, target.fetch.finalUrl])];
    const checks = urls.map(url => ({ url, google: robotsDecision(site, url), bing: robotsDecision(site, url, ['bingbot']) }));
    if (checks.every(check => check.google === undefined)) return notEvaluated('other-origin');
    if (target.pageType === 'utility') return notApplicable('utility-page');
    const blocked = checks.find(check => check.google?.allowed === false);
    const bingBlocked = checks.find(check => check.bing?.allowed === false);
    if (!blocked && !bingBlocked) return passed();
    const hit = blocked ?? bingBlocked!;
    const decision = blocked ? hit.google! : hit.bing!;
    const crawler = blocked ? 'Googlebot' : 'Bingbot';
    const ids = [evidence.add({ kind: 'robots', url: robotsUrl(site), label: joinLabels(evidenceLabel('rule that disallows the URL for {crawler}', { crawler }), evidenceLabel('(group {token})', { token: decision.matchedToken ?? '*' })),
      excerpt: `${decision.rule!.type}: ${decision.rule!.pattern}`, line: decision.rule!.line })];
    if (!blocked) return failure({ severity: 'medium', evidence: ids, reason: 'bingbot-only', params: { url: hit.url, crawler } });
    const listed = sitemapEntryFor(site, hit.url);
    const named = namedByOtherPage(site, hit.url);
    if (listed) ids.push(evidence.add({ kind: 'sitemap', url: listed.sitemap, label: evidenceLabel('sitemap entry for the disallowed URL'), excerpt: listed.loc, line: listed.line }));
    if (named) ids.push(evidence.add({ kind: 'html', url: named.by, label: named.as === 'canonical' ? evidenceLabel('page that names the disallowed URL as its canonical target') : evidenceLabel('page that names the disallowed URL as its hreflang target'), excerpt: hit.url }));
    const conflict = isHomePage(site, target) ? 'home' : listed ? 'sitemap' : named ? named.as : undefined;
    return failure({ severity: conflict ? 'critical' : 'medium', evidence: ids, reason: conflict ? `conflict-${conflict}` : 'disallowed', params: { url: hit.url, crawler } });
  },
};

function groupFile(group: RobotsGroup): RobotsFile {
  return { groups: [group], sitemaps: [], unsupported: [], misspelled: [], orphanRules: [], invalid: [], bytes: 0, truncated: false };
}

/** A path that the pattern matches, to test whether another group also disallows it. */
function samplePath(pattern: string): string {
  return pattern.replace(/\$$/u, '').replace(/\*/gu, 'x') || '/';
}

const crawlTrap = /search|buscar|cerca|\bq=|\?s=|cart|carrito|cistella|checkout|basket|account|cuenta|login|filter|filtro|sort|orderby|facet|[?&]/iu;
const searchEngines = new Set(['googlebot', 'bingbot']);

const robotsGroupOverride: RuleImplementation = {
  id: 'crawl-robots-group-override',
  evaluate({ site, evidence }) {
    const file = robotsFile(site);
    if (!file) return notApplicable('no-robots-file');
    const star = file.groups.filter(group => group.userAgents.includes('*'));
    const starDisallows = star.flatMap(group => group.rules).filter(rule => rule.type === 'disallow' && rule.pattern !== '');
    const specificTokens = [...new Set(file.groups.flatMap(group => group.userAgents).filter(token => token !== '*'))];
    if (starDisallows.length === 0 || specificTokens.length === 0) return notApplicable('no-specific-group');
    const url = robotsUrl(site);
    const findings: { token: string; rule: RobotsRule; severity: Severity }[] = [];
    let intentionalAllow: string | undefined;
    for (const token of specificTokens) {
      const groups = file.groups.filter(group => group.userAgents.includes(token));
      const merged: RobotsGroup = { userAgents: [token], rules: groups.flatMap(group => group.rules), line: groups[0]!.line };
      const own = groupFile(merged);
      // When * blocks everything, a named group is an allow list by construction.
      if (starDisallows.some(rule => rule.pattern === '/')) {
        intentionalAllow ??= token;
        continue;
      }
      for (const rule of starDisallows) {
        if (!isAllowed(own, [token], samplePath(rule.pattern)).allowed) continue;
        const trap = crawlTrap.test(rule.pattern);
        findings.push({ token, rule, severity: trap && searchEngines.has(token) ? 'medium' : 'low' });
      }
    }
    if (findings.length === 0 && intentionalAllow) {
      const id = evidence.add({ kind: 'robots', url, label: evidenceLabel('group that allows everything while the * group disallows /'), excerpt: `user-agent: ${intentionalAllow}` });
      return failure({ severity: 'info', evidence: [id], reason: 'intentional-allow', params: { token: intentionalAllow } });
    }
    if (findings.length === 0) return passed();
    findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'medium' ? -1 : 1));
    const ids = findings.slice(0, 6).map(entry => evidence.add({ kind: 'robots', url, label: evidenceLabel('* disallow rule that the {token} group does not repeat', { token: entry.token }), excerpt: ruleLine(entry.rule), line: entry.rule.line }));
    const top = findings[0]!.severity;
    return failure({ severity: top, evidence: ids, reason: top === 'medium' ? 'crawl-trap' : 'missing-rules',
      params: { tokens: summarizeList([...new Set(findings.map(entry => entry.token))]), count: findings.length } });
  },
};

const robotsSitemapLines: RuleImplementation = {
  id: 'crawl-robots-sitemap-lines',
  evaluate({ site, evidence }) {
    const file = robotsFile(site);
    const url = robotsUrl(site);
    const lines = file?.sitemaps ?? [];
    const relative = lines.filter(line => !/^https?:\/\//iu.test(line.value));
    const declared = site.sitemaps.filter(entry => entry.source === 'robots' || entry.source === 'link');
    const failing = declared.filter(entry => entry.fetch.status !== 200 || entry.fetch.error !== undefined);
    const ids: string[] = [];
    let severity: Severity | undefined;
    let reason = '';
    if (relative.length > 0) {
      ids.push(...relative.map(line => evidence.add({ kind: 'robots', url, label: evidenceLabel('Sitemap line without an absolute URL'), excerpt: `Sitemap: ${line.value}`, line: line.line })));
      severity = 'medium';
      reason = 'relative-url';
    }
    if (failing.length > 0) {
      ids.push(...failing.slice(0, 5).map(entry => (entry.fetch.status === undefined
        ? evidence.add({ kind: 'sitemap', url: entry.url, label: evidenceLabel('declared sitemap that got no response ({fetchError})', { fetchError: entry.fetch.error?.code ?? 'connection' }) })
        : evidence.add({ kind: 'sitemap', url: entry.url, label: evidenceLabel('declared sitemap fetch outcome'), excerpt: `HTTP ${entry.fetch.status}` }))));
      severity = 'medium';
      reason ||= 'declared-not-200';
    }
    if (severity) return failure({ severity, evidence: ids, reason, params: { count: relative.length + failing.length } });
    if (declared.length > 0 || lines.length > 0) {
      return passed(lines.slice(0, 5).map(line => evidence.add({ kind: 'robots', url, label: evidenceLabel('Sitemap line'), excerpt: `Sitemap: ${line.value}`, line: line.line })));
    }
    const fallback = site.sitemaps.find(entry => entry.source === 'default');
    if (fallback?.document && fallback.document.kind !== 'unknown') return passed([evidence.add({ kind: 'sitemap', url: fallback.url, label: evidenceLabel('sitemap at the default location'), excerpt: `HTTP ${fallback.fetch.status}` })]);
    if (!fallback) return notEvaluated('default-sitemap-not-fetched');
    const id = fallback.fetch.status === undefined
      ? evidence.add({ kind: 'sitemap', url: fallback.url, label: evidenceLabel('default sitemap location, which got no response ({fetchError})', { fetchError: fallback.fetch.error?.code ?? 'connection' }) })
      : evidence.add({ kind: 'sitemap', url: fallback.url, label: evidenceLabel('default sitemap location fetch outcome'), excerpt: `HTTP ${fallback.fetch.status}` });
    return failure({ severity: 'low', evidence: [id], reason: 'no-sitemap', params: { count: 0 } });
  },
};

const noindexBlockedByRobots: RuleImplementation = {
  id: 'crawl-noindex-blocked-by-robots',
  evaluate({ site, page, evidence }) {
    if (!robotsFile(site)) return notApplicable('no-robots-rules');
    const target = page!;
    const sources = [target.raw, target.rendered].filter(doc => doc !== undefined);
    const noindex = effectiveDirectives(target, sources[0]).has('noindex') || sources.some(doc => effectiveDirectives(target, doc).has('noindex'));
    if (!noindex) return notApplicable('no-noindex');
    const decision = robotsDecision(site, target.fetch.finalUrl) ?? robotsDecision(site, target.url);
    if (!decision) return notEvaluated('other-origin');
    if (decision.allowed) return passed();
    const ids = [
      evidence.add({ kind: 'robots', url: robotsUrl(site), label: joinLabels(evidenceLabel('rule that disallows the noindex page for Googlebot'), evidenceLabel('(group {token})', { token: decision.matchedToken ?? '*' })), excerpt: `${decision.rule!.type}: ${decision.rule!.pattern}`, line: decision.rule!.line }),
      evidence.add({ kind: 'html', url: target.fetch.finalUrl, label: evidenceLabel('robots directives that Googlebot cannot read'), excerpt: [...effectiveDirectives(target, sources[0])].join(', ') || 'noindex' }),
    ];
    return failure({ severity: 'high', evidence: ids, params: { url: target.fetch.finalUrl, rule: `${decision.rule!.type}: ${decision.rule!.pattern}` } });
  },
};

function groupForLine(file: RobotsFile, line: number): RobotsGroup | undefined {
  return [...file.groups].filter(group => group.line <= line).sort((a, b) => b.line - a.line)[0];
}

const bingCrawlDelay: RuleImplementation = {
  id: 'crawl-bing-crawl-delay',
  evaluate({ site, evidence }) {
    const file = robotsFile(site);
    if (!file) return notApplicable('no-robots-file');
    const bingToken = file.groups.some(group => group.userAgents.includes('bingbot')) ? 'bingbot' : '*';
    const delays = file.unsupported.filter(entry => entry.key === 'crawl-delay')
      .map(entry => ({ entry, group: groupForLine(file, entry.line) }))
      .filter(item => item.group?.userAgents.includes(bingToken));
    if (delays.length === 0) return passed();
    const value = Number.parseFloat(delays[0]!.entry.value);
    const id = evidence.add({ kind: 'robots', url: robotsUrl(site), label: evidenceLabel('crawl-delay in the group Bingbot follows ({token})', { token: bingToken }), excerpt: `crawl-delay: ${delays[0]!.entry.value}`, line: delays[0]!.entry.line });
    const urls = new Set(sitemapLocs(site).map(entry => normalizeUrl(entry.loc))).size;
    if (Number.isFinite(value) && value >= 10 && urls > 1000) {
      const count = evidence.add({ kind: 'sitemap', url: site.sitemaps[0]?.url ?? site.origin, label: evidenceLabel('distinct URLs listed in the sitemaps: {count}', { count: urls }) });
      return failure({ severity: 'low', evidence: [id, count], reason: 'slow-for-size', params: { delay: delays[0]!.entry.value, urls } });
    }
    return failure({ severity: 'info', evidence: [id], reason: 'present', params: { delay: delays[0]!.entry.value, urls } });
  },
};

export const robotsRules: readonly RuleImplementation[] = [
  robotsFetchStatus, robotsRedirects, robotsFormat, robotsParseErrors, robotsUnsupportedDirectives, robotsBlocksSite, robotsBlocksPage,
  robotsGroupOverride, robotsSitemapLines, noindexBlockedByRobots, bingCrawlDelay,
];

