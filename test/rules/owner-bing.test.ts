import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rule as catalogRule, rules } from '../../src/catalog/index.ts';
import { EvidenceStore } from '../../src/core/evidence.ts';
import { findingMessage, messagesFor } from '../../src/i18n/messages.ts';
import { crawlIssueTypes, lowCtrPages } from '../../src/owner/bing-analyses.ts';
import type { BingCrawlIssue, BingData, BingTrafficRow, BingUrlInfo } from '../../src/owner/bing.ts';
import { runRules, type Finding, type RuleImplementation } from '../../src/rules/engine.ts';
import { implementations } from '../../src/rules/owner/bing.ts';
import { searchQueriesPath } from '../../src/rules/owner/search-console.ts';
import { evaluate, page, site, type PageSpec, type SiteSpec } from '../support/facts.ts';

const origin = 'https://example.com';
const url = `${origin}/en/services/`;
const html = (head = '') => `<!doctype html><html lang="en"><head><title>Services | Example</title>${head}</head><body><main><h1>Services</h1></main></body></html>`;
const rule = (id: string): RuleImplementation => implementations.find(entry => entry.id === id)!;

const bing = (overrides: Partial<BingData> = {}): BingData => ({
  fetchedAt: '2026-11-04T09:00:00.000Z', site: `${origin}/`, crawlIssues: [], pageStats: [], pageQueries: [], urlInfo: [], unavailable: [], ...overrides,
});
const issue = (target: string, issues: number, httpCode?: number, inLinks = 0): BingCrawlIssue => ({ url: target, issues, ...(httpCode === undefined ? {} : { httpCode }), inLinks });
const crawled = (target: string, overrides: Partial<BingUrlInfo> = {}): BingUrlInfo => ({ url: target, httpStatus: 200, lastCrawled: '2026-10-20T08:00:00.000Z', discovered: '2025-03-01T00:00:00.000Z', ...overrides });
const row = (key: string, date: string, impressions: number, clicks: number, position?: number): BingTrafficRow => ({ key, date, impressions, clicks, ...(position === undefined ? {} : { position }) });
const flags = { Code301: 1, Code302: 2, Code4xx: 4, Code5xx: 8, BlockedByRobotsTxt: 16, ContainsMalware: 32, ImportantUrlBlockedByRobotsTxt: 64, DnsErrors: 128, TimeOutErrors: 256 };

function check(id: string, data: BingData, spec: PageSpec = {}, extra: Partial<SiteSpec> = {}) {
  const result = evaluate(rule(id), site({ pages: [page(url, { html: html(), ...spec })], owner: { bing: data }, ...extra }));
  const excerpts = (finding: Finding | undefined) => (finding?.evidence ?? []).map(entry => result.evidence.get(entry)?.excerpt);
  return { findings: result.findings, first: result.findings[0], excerpts, evidence: result.evidence };
}

/** Every failure must render a complete English message: a reason without a template, or a missing value, fails. */
function message(finding: Finding | undefined): string {
  assert.ok(finding?.outcome === 'fail', 'a failing finding');
  if (finding.reason) assert.ok(messagesFor('en')[finding.ruleId]?.messages[`fail:${finding.reason}`], `${finding.ruleId} has a message for ${finding.reason}`);
  const text = findingMessage('en', finding.ruleId, 'fail', finding.reason, finding.params);
  assert.ok(text, `${finding.ruleId} has a message`);
  assert.doesNotMatch(text, /\{[a-zA-Z]+\}/u, `${finding.ruleId}:${finding.reason ?? ''} leaves a placeholder: ${text}`);
  return text;
}

describe('crawl-bing-crawl-issues', () => {
  test('passes when Bing lists no crawl issues', () => {
    const { first, excerpts } = check('crawl-bing-crawl-issues', bing());
    assert.equal(first?.outcome, 'pass');
    assert.deepEqual(excerpts(first), ['0 URLs']);
  });

  test('reports each issue type Bing lists, graded by what it stops Bing from doing', () => {
    const data = bing({ crawlIssues: [
      issue(`${origin}/infected/`, flags.ContainsMalware, 200),
      issue(`${origin}/a`, flags.Code5xx, 503, 2),
      issue(`${origin}/b`, flags.Code5xx | flags.TimeOutErrors, 504, 9),
      issue(`${origin}/gone`, flags.Code4xx, 404),
      issue(`${origin}/linked`, flags.Code4xx, 404, 3),
      issue(`${origin}/admin/`, flags.BlockedByRobotsTxt),
      issue(`${origin}/old`, flags.Code301, 301),
    ] });
    const { findings } = check('crawl-bing-crawl-issues', data);
    const by = (reason: string) => findings.find(finding => finding.reason === reason);
    assert.deepEqual(findings.map(finding => [finding.reason, finding.severity, finding.params?.count]), [
      ['malware', 'critical', 1], ['server-error', 'high', 2], ['timeout', 'medium', 1], ['client-error', 'medium', 2], ['blocked-by-robots', 'info', 1], ['permanent-redirect', 'info', 1],
    ]);
    assert.equal(by('server-error')?.params?.examples, `${origin}/b, ${origin}/a`, 'most linked first');
    assert.equal(by('client-error')?.params?.linked, 1);
    for (const finding of findings) message(finding);
    assert.match(message(by('client-error')), /^Bing got 4xx errors for 2 URL\(s\), 1 of them with inbound links/u);
    assert.ok(findings.every(finding => finding.origin === 'owner-data'));
  });

  test('grades 4xx URLs that nothing links to as low', () => {
    const { first } = check('crawl-bing-crawl-issues', bing({ crawlIssues: [issue(`${origin}/gone`, flags.Code4xx, 404)] }));
    assert.deepEqual([first?.reason, first?.severity], ['client-error', 'low']);
  });

  test('cites the URLs with their issues, status and inbound links', () => {
    const { first, excerpts } = check('crawl-bing-crawl-issues', bing({ crawlIssues: [issue(`${origin}/b`, flags.Code5xx | flags.TimeOutErrors, 504, 9)] }));
    assert.deepEqual(excerpts(first), [`${origin}/b (Code5xx, TimeOutErrors; HTTP 504; 9 inbound links)`]);
  });

  test('keeps a URL someone linked to from turning into a Markdown link in the message', () => {
    const { first } = check('crawl-bing-crawl-issues', bing({ crawlIssues: [issue(`${origin}/[click](https://evil.example/)`, flags.Code4xx, 404)] }));
    const examples = String(first?.params?.examples);
    assert.doesNotMatch(examples, /[[\]()]/u);
    assert.equal(examples, `${origin}/%5Bclick%5D%28https://evil.example/%29`);
  });

  test('is not evaluated when the crawl issue list could not be read', () => {
    const { crawlIssues: _unread, ...data } = bing();
    assert.deepEqual([check('crawl-bing-crawl-issues', data).first?.outcome, check('crawl-bing-crawl-issues', data).first?.reason], ['not_evaluated', 'crawl-issues-not-read']);
  });
});

describe('crawl-bing-page-issues', () => {
  test('passes an audited page Bing crawled without problems', () => {
    const { first, excerpts } = check('crawl-bing-page-issues', bing({ urlInfo: [crawled(url)] }));
    assert.equal(first?.outcome, 'pass');
    assert.deepEqual(excerpts(first), ['httpStatus=200; lastCrawled=2026-10-20; discovered=2025-03-01']);
  });

  test('reports a server error Bing got that this audit also gets as high', () => {
    const { first } = check('crawl-bing-page-issues', bing({ crawlIssues: [issue(url, flags.Code5xx, 503)], urlInfo: [crawled(url, { httpStatus: 503 })] }), { status: 503 });
    assert.deepEqual([first?.severity, first?.reason, first?.params?.status, first?.params?.live], ['high', 'server-error', 503, 'HTTP 503']);
    assert.match(message(first), /^Bing got a server error for https:\/\/example\.com\/en\/services\/ \(HTTP status 503; Code5xx\), and this audit got HTTP 503\.$/u);
  });

  test('reports an HTTP problem this audit cannot reproduce as medium, citing the status the audit got', () => {
    const { first, excerpts } = check('crawl-bing-page-issues', bing({ crawlIssues: [issue(url, flags.Code5xx | flags.TimeOutErrors, 500)] }));
    assert.deepEqual([first?.severity, first?.reason, first?.params?.issues], ['medium', 'not-reproduced', 'Code5xx, TimeOutErrors']);
    assert.ok(excerpts(first).includes('HTTP 200'));
    assert.match(message(first), /reaches only Bingbot/u);
  });

  test('reads an error status in the index details when the crawl issue list does not name the page', () => {
    const { first } = check('crawl-bing-page-issues', bing({ urlInfo: [crawled(url, { httpStatus: 404 })] }), { status: 404 });
    assert.deepEqual([first?.severity, first?.reason, first?.params?.issues], ['medium', 'client-error', 'HTTP 404 in its index details']);
    message(first);
  });

  test('reports a robots.txt block, and lowers it when the robots.txt read by this audit allows Bingbot', () => {
    const data = bing({ crawlIssues: [issue(url, flags.BlockedByRobotsTxt)] });
    const blocked = check('crawl-bing-page-issues', data, {}, { robots: 'User-agent: bingbot\nDisallow: /en/\n' });
    assert.deepEqual([blocked.first?.severity, blocked.first?.reason], ['medium', 'blocked-by-robots']);
    assert.ok(blocked.excerpts(blocked.first).includes('disallow: /en/ (group bingbot)'));
    const fixed = check('crawl-bing-page-issues', data, {}, { robots: 'User-agent: *\nDisallow: /private/\n' });
    assert.deepEqual([fixed.first?.severity, fixed.first?.reason], ['low', 'robots-allows-now']);
    message(blocked.first);
    message(fixed.first);
  });

  test('matches the URL the audit requested when it redirects', () => {
    const moved = `${origin}/services`;
    const result = evaluate(rule('crawl-bing-page-issues'), site({
      pages: [page(moved, { html: html(), redirects: [[301, url]] })],
      owner: { bing: bing({ crawlIssues: [issue(moved, flags.Code301, 301)], urlInfo: [crawled(url)] }) },
    }));
    const first = result.findings[0];
    assert.deepEqual([first?.severity, first?.reason, first?.params?.live], ['info', 'permanent-redirect', 'HTTP 301']);
    message(first);
  });

  test('does not apply to a page kept out of Bing on purpose, except for malware', () => {
    const data = bing({ crawlIssues: [issue(url, flags.Code4xx, 404)] });
    assert.equal(check('crawl-bing-page-issues', data, { html: html('<meta name="bingbot" content="noindex">') }).first?.reason, 'kept-out-of-index');
    assert.equal(check('crawl-bing-page-issues', data, { html: html(`<link rel="canonical" href="${origin}/en/">`) }).first?.reason, 'kept-out-of-index');
    const infected = check('crawl-bing-page-issues', bing({ crawlIssues: [issue(url, flags.ContainsMalware | flags.Code4xx, 200)] }), { html: html('<meta name="robots" content="noindex">') });
    assert.deepEqual([infected.first?.severity, infected.first?.reason], ['critical', 'malware']);
    message(infected.first);
  });

  test('does not apply to a utility page that robots.txt blocks on purpose', () => {
    const data = bing({ crawlIssues: [issue(url, flags.BlockedByRobotsTxt)] });
    assert.equal(check('crawl-bing-page-issues', data, { pageType: 'utility' }).first?.reason, 'utility-page');
    const failing = check('crawl-bing-page-issues', bing({ crawlIssues: [issue(url, flags.Code5xx, 500)] }), { pageType: 'utility', status: 500 }).first;
    assert.deepEqual([failing?.severity, failing?.reason], ['high', 'server-error'], 'other problems of a utility page are reported');
  });

  test('does not apply without index details, without a crawl date, or off the Bing site', () => {
    assert.equal(check('crawl-bing-page-issues', bing()).first?.reason, 'no-index-details');
    assert.equal(check('crawl-bing-page-issues', bing({ urlInfo: [{ url }] })).first?.reason, 'not-crawled-by-bing');
    assert.equal(check('crawl-bing-page-issues', bing({ urlInfo: [{ url, error: 'NotFound' }] })).first?.reason, 'no-index-details');
    assert.equal(check('crawl-bing-page-issues', bing({ site: 'https://www.example.com/' })).first?.reason, 'outside-bing-site');
    const { crawlIssues: _unread, ...data } = bing({ urlInfo: [crawled(url)] });
    assert.deepEqual([check('crawl-bing-page-issues', data).first?.outcome, check('crawl-bing-page-issues', data).first?.reason], ['not_evaluated', 'crawl-issues-not-read'],
      'clean index details alone do not make a pass');
    const failing = check('crawl-bing-page-issues', { ...data, urlInfo: [crawled(url, { httpStatus: 500 })] }, { status: 500 }).first;
    assert.deepEqual([failing?.severity, failing?.reason], ['high', 'server-error'], 'a problem in the index details is reported without the issue list');
  });
});

describe('content-bing-low-ctr', () => {
  const weeks = ['2026-10-17', '2026-10-24', '2026-10-31'];
  const pageStats = [
    ...weeks.map(date => row(`${origin}/a`, date, 400, 40, 2.0)),
    ...weeks.map(date => row(`${origin}/b`, date, 300, 2, 2.2)),
    row(`${origin}/c`, '2026-10-31', 150, 15, 1.8),
    // Outside the twelve weeks: had it counted, /b would look healthy.
    row(`${origin}/b`, '2026-06-01', 5000, 2500, 2.0),
  ];
  const pageQueries = [{ page: `${origin}/b`, rows: [
    row('custom software andorra', '2026-10-24', 250, 1, 2.1), row('custom software andorra', '2026-10-31', 250, 1, 2.1),
    row('erp integration', '2026-10-31', 200, 0, 2.4), row('old query', '2026-05-01', 9000, 0, 3),
  ] }];

  test('names the page against the CTR of the site\'s other pages, and keeps its queries in a redactable excerpt', () => {
    const { findings, first, evidence } = check('content-bing-low-ctr', bing({ pageStats, pageQueries }));
    assert.equal(findings.length, 1);
    assert.deepEqual([first?.severity, first?.params?.page, first?.params?.ctr, first?.params?.expected, first?.params?.position, first?.params?.start, first?.params?.end],
      ['low', `${origin}/b`, '0.7%', '10.0%', '2.2', '2026-10-17', '2026-10-31']);
    const queries = first!.evidence.map(id => evidence.get(id)!).find(item => item.path === searchQueriesPath);
    assert.equal(queries?.excerpt, 'custom software andorra (500 impressions, position 2.1)\nerp integration (200 impressions, position 2.4)');
    assert.match(message(first), /^https:\/\/example\.com\/b got 900 Bing impressions at position 2\.2 with a 0\.7% CTR, against 10\.0% for the site's other pages/u);
  });

  test('writes numbered labels instead of queries when the owner asks for a shareable report', () => {
    const result = evaluate(rule('content-bing-low-ctr'), site({ pages: [page(url, { html: html() })], owner: { bing: bing({ pageStats, pageQueries }), redactQueries: true } }));
    const excerpts = result.findings.flatMap(finding => finding.evidence.map(id => result.evidence.get(id)?.excerpt ?? '')).join('\n');
    assert.doesNotMatch(excerpts, /custom software|erp integration/u);
    assert.match(excerpts, /^query 1 \(500 impressions, position 2\.1\)$/mu);
  });

  test('leaves each page out of the norm it is compared with', () => {
    // Counted in its own norm, /a would set the bar at 2.5% and pass at 2%; the site's other pages get 10%.
    const rows = [row(`${origin}/a`, '2026-10-31', 5000, 100, 2), row(`${origin}/b`, '2026-10-31', 300, 30, 2)];
    const analysis = lowCtrPages(rows);
    assert.deepEqual(analysis.pages.map(entry => [entry.page, entry.ctr, entry.expectedCtr]), [[`${origin}/a`, 0.02, 0.1]]);
    assert.equal(analysis.compared, 2);
    assert.equal(lowCtrPages([row(`${origin}/a`, '2026-10-31', 5000, 100, 2), row(`${origin}/b`, '2026-10-31', 300, 30, 7)]).compared, 0, 'pages in different bands are not compared');
  });

  test('passes when every page is near the site norm', () => {
    const even = weeks.flatMap(date => [row(`${origin}/a`, date, 400, 40, 2.0), row(`${origin}/b`, date, 300, 25, 2.2)]);
    assert.equal(check('content-bing-low-ctr', bing({ pageStats: even })).first?.outcome, 'pass');
  });

  test('does not apply without search data or with too little of it, and is not evaluated when the traffic could not be read', () => {
    assert.equal(check('content-bing-low-ctr', bing()).first?.reason, 'no-search-data');
    assert.equal(check('content-bing-low-ctr', bing({ pageStats: [row(`${origin}/a`, '2026-10-31', 400, 1, 2)] })).first?.reason, 'too-little-data');
    const { pageStats: _unread, ...data } = bing();
    assert.deepEqual([check('content-bing-low-ctr', data).first?.outcome, check('content-bing-low-ctr', data).first?.reason], ['not_evaluated', 'page-traffic-not-read']);
  });
});

describe('content-bing-ai-performance', () => {
  // Context only: it has no passing state, and without Bing data the engine does not run it.
  test('points to the AI Performance report whenever Bing data was read', () => {
    const { first, excerpts } = check('content-bing-ai-performance', bing());
    assert.deepEqual([first?.outcome, first?.severity, first?.params?.site], ['fail', 'info', `${origin}/`]);
    assert.deepEqual(excerpts(first), [`${origin}/`]);
    assert.match(message(first), /AI Performance report of Bing Webmaster Tools \(https:\/\/www\.bing\.com\/webmasters\); the Bing Webmaster API has no method for it/u);
  });
});

describe('Bing rules in the engine', () => {
  test('run only when the owner provided Bing data, and stay out of the score', () => {
    const map = new Map(implementations.map(entry => [entry.id, entry]));
    const facts = site({ pages: [page(url, { html: html() })] });
    assert.deepEqual(runRules({ rules, implementations: map, site: facts, evidence: new EvidenceStore() }), []);
    const withData = runRules({ rules, implementations: map, site: { ...facts, owner: { bing: bing({ urlInfo: [crawled(url)] }) } }, evidence: new EvidenceStore() });
    assert.deepEqual([...new Set(withData.map(finding => finding.ruleId))].sort(), implementations.map(entry => entry.id).sort());
    assert.ok(withData.every(finding => finding.origin === 'owner-data'));
    for (const entry of implementations) {
      const meta = catalogRule(entry.id)!;
      assert.deepEqual([meta.status, meta.scored, meta.method, meta.inputs.includes('bing')], ['requires-owner-data', false, 'owner-data', true], entry.id);
      assert.ok(meta.sources.every(source => source.verified === '2026-11-04'), entry.id);
    }
  });

  test('have a message for every issue type Bing documents, on the site and on an audited page', () => {
    const siteReasons = check('crawl-bing-crawl-issues', bing({ crawlIssues: crawlIssueTypes.map(type => issue(`${origin}/${type.name}`, type.flag, 500)) })).findings;
    assert.equal(siteReasons.length, crawlIssueTypes.length);
    for (const finding of siteReasons) message(finding);
    const pageReasons = new Set<string>();
    for (const type of crawlIssueTypes) {
      // A live status other than 200 keeps each HTTP issue from being reported as not reproduced.
      const status = type.name === 'Code4xx' ? 404 : ['Code5xx', 'DnsErrors', 'TimeOutErrors'].includes(type.name) ? 503 : 200;
      const finding = check('crawl-bing-page-issues', bing({ crawlIssues: [issue(url, type.flag, status)] }), { status }).first;
      pageReasons.add(finding?.reason ?? '');
      message(finding);
    }
    assert.equal(pageReasons.size, crawlIssueTypes.length);
  });
});
