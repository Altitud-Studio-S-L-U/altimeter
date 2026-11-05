import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rules } from '../../src/catalog/index.ts';
import { EvidenceStore } from '../../src/core/evidence.ts';
import { findingMessage } from '../../src/i18n/messages.ts';
import type { BotActivity, BotSummary } from '../../src/owner/bots/activity.ts';
import { runRules, type Finding, type RuleImplementation } from '../../src/rules/engine.ts';
import { implementations } from '../../src/rules/owner/bots.ts';
import { activity, botSummary, tally } from '../support/bots.ts';
import { evaluate, site, type SiteSpec } from '../support/facts.ts';

const origin = 'https://example.com';
const rule = (id: string): RuleImplementation => implementations.find(entry => entry.id === id)!;
const sitemapXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/en/', '/en/about/', '/en/contact/'].map(path => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;
const robotsTxt = 'User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /en/team/\n';

function check(id: string, data: BotActivity, extra: Partial<SiteSpec> = {}) {
  const result = evaluate(rule(id), site({ origin, pages: [], robots: robotsTxt, sitemaps: [{ url: `${origin}/sitemap.xml`, xml: sitemapXml }], owner: { bots: data }, ...extra }));
  const excerpts = (finding: Finding | undefined) => (finding?.evidence ?? []).map(entry => result.evidence.get(entry)?.excerpt ?? '');
  const labels = (finding: Finding | undefined) => (finding?.evidence ?? []).map(entry => result.evidence.get(entry)?.label ?? '');
  return { findings: result.findings, first: result.findings[0], excerpts, labels };
}

/** The finding's English message, which must leave no placeholder unfilled. */
function message(finding: Finding | undefined): string {
  const text = findingMessage('en', finding!.ruleId, 'fail', finding!.reason, finding!.params) ?? '';
  assert.doesNotMatch(text, /\{[a-zA-Z]+\}/u, `${finding!.ruleId}:${finding!.reason ?? ''} leaves a placeholder: ${text}`);
  return text;
}

const verified = (hits: number, statuses: Record<string, number> = { 200: hits }) => tally({ hits, statuses, lastSeen: '2026-11-03T10:00:00.000Z' });
const gptbot = (overrides: Partial<BotSummary> = {}) => botSummary({ id: 'gptbot', name: 'GPTBot', operator: 'OpenAI', purpose: 'training', token: 'gptbot', ...overrides });
const oai = (overrides: Partial<BotSummary> = {}) => botSummary({ id: 'oai-searchbot', name: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search', token: 'oai-searchbot', ...overrides });
const perplexity = (overrides: Partial<BotSummary> = {}) => botSummary({ id: 'perplexitybot', name: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', token: 'perplexitybot', ...overrides });
const googlebot = (overrides: Partial<BotSummary> = {}) => botSummary({ id: 'googlebot', name: 'Googlebot', operator: 'Google', purpose: 'search', token: 'googlebot', ...overrides });
const meta = (overrides: Partial<BotSummary> = {}) => botSummary({ id: 'meta-externalagent', name: 'meta-externalagent', operator: 'Meta', purpose: 'training', token: 'meta-externalagent', verifiable: false, basis: 'claimed', ...overrides });

describe('ai-bots-crawl-activity', () => {
  test('reports verified AI crawlers and keeps unverifiable operators as claims', () => {
    const { first, excerpts, labels } = check('ai-bots-crawl-activity', activity({ bots: [gptbot({ verified: verified(10), robotsTxt: 2 }), meta({ unverified: tally({ hits: 3 }) }), googlebot({ verified: verified(50) })] }));
    assert.deepEqual([first?.outcome, first?.severity, first?.reason, first?.params], ['fail', 'info', 'seen', { verified: 10, crawlers: 'GPTBot', claims: 3 }]);
    assert.equal(message(first), 'Verified AI crawlers fetched the site 10 times in the window (GPTBot); 3 more requests used AI crawler user agents without being verified.');
    assert.match(labels(first)[0]!, /^GPTBot \(OpenAI, training\), from \S+ to \S+: verified requests: 10; unverified: 0; spoofed: 0; last verified: \S+; robots\.txt: 2;/u);
    assert.match(labels(first)[1]!, /^meta-externalagent \(Meta, training\), from \S+ to \S+: claimed requests: 3; the operator publishes no way to verify them$/u);
    assert.match(excerpts(first)[2]!, /Google-Extended \(Google\)\nApplebot-Extended \(Apple\)/u);
    assert.equal(first?.origin, 'owner-data');
  });

  test('says so when no AI crawler claim could be verified, and marks sampled counts', () => {
    const { first } = check('ai-bots-crawl-activity', activity({ sampled: true, bots: [gptbot({ basis: 'claimed', unverified: tally({ hits: 5 }), unverifiedReasons: { 'no-client-ip': 5 } })] }));
    assert.deepEqual([first?.reason, first?.params?.claims, first?.params?.verified], ['claims-only', '~5', '~0']);
    message(first);
  });

  test('passes without AI crawler requests and is not evaluated without user agents', () => {
    assert.equal(check('ai-bots-crawl-activity', activity({ bots: [googlebot({ verified: verified(3) })] })).first?.outcome, 'pass');
    const blind = activity({ sources: [{ kind: 'access-log', file: 'a.log', format: 'common', lines: 1, records: 1, malformed: 0, skipped: {}, fields: { userAgent: false, clientIp: true, referer: false, host: false, bytes: true } }] });
    assert.deepEqual([check('ai-bots-crawl-activity', blind).first?.outcome, check('ai-bots-crawl-activity', blind).first?.reason], ['not_evaluated', 'no-user-agents']);
  });
});

describe('ai-bots-blocked-at-edge', () => {
  const refused = (statuses: Record<string, number>, overrides: Partial<BotSummary> = {}) => {
    const hits = Object.values(statuses).reduce((sum, value) => sum + value, 0);
    return oai({ verified: verified(hits, statuses), onAllowedPaths: verified(hits, statuses), paths: { distinct: 1, capped: false, top: [{ path: '/en/', hits, statuses }] }, ...overrides });
  };

  test('grades refusals of a verified search crawler that robots.txt allows', () => {
    const medium = check('ai-bots-blocked-at-edge', activity({ bots: [refused({ 403: 8, 200: 2 })] })).first;
    assert.deepEqual([medium?.severity, medium?.reason, medium?.params], ['medium', 'refused', { agent: 'OAI-SearchBot', blocked: 8, total: 10, share: 0.8, statuses: '403 x8' }]);
    assert.match(message(medium), /Verified OAI-SearchBot requests were refused 8 of 10 times/u);
    const low = check('ai-bots-blocked-at-edge', activity({ bots: [refused({ 429: 3, 200: 37 })] })).first;
    assert.deepEqual([low?.severity, low?.params?.share], ['low', 0.075]);
    const charged = check('ai-bots-blocked-at-edge', activity({ bots: [refused({ 402: 6, 200: 4 })] })).first;
    assert.deepEqual([charged?.severity, charged?.reason], ['medium', 'payment-required']);
    message(charged);
  });

  test('reports refusals of unverified claims as info and leaves training crawlers out', () => {
    const claimed = check('ai-bots-blocked-at-edge', activity({ bots: [perplexity({ basis: 'claimed', unverified: verified(10, { 403: 10 }), onAllowedPaths: verified(10, { 403: 10 }) })] })).first;
    assert.deepEqual([claimed?.severity, claimed?.reason], ['info', 'unverified-claims']);
    message(claimed);
    const training = check('ai-bots-blocked-at-edge', activity({ bots: [gptbot({ verified: verified(10, { 403: 10 }), onAllowedPaths: verified(10, { 403: 10 }) })] })).first;
    assert.deepEqual([training?.outcome, training?.reason], ['not_applicable', 'no-requests']);
  });

  test('passes below the thresholds and exempts crawlers robots.txt disallows', () => {
    assert.equal(check('ai-bots-blocked-at-edge', activity({ bots: [refused({ 403: 2, 200: 98 })] })).first?.outcome, 'pass');
    const disallowed = check('ai-bots-blocked-at-edge', activity({ bots: [refused({ 403: 10 })] }), { robots: 'User-agent: OAI-SearchBot\nDisallow: /\n' }).first;
    assert.deepEqual([disallowed?.outcome, disallowed?.reason], ['not_applicable', 'no-requests']);
  });

  test('is not evaluated while robots.txt is unreachable', () => {
    const { first } = check('ai-bots-blocked-at-edge', activity({ bots: [refused({ 403: 10 })] }), { robots: 'unreachable' });
    assert.deepEqual([first?.outcome, first?.reason], ['not_evaluated', 'robots-unreachable']);
  });
});

describe('ai-bots-search-not-seen', () => {
  test('passes when one allowed AI search crawler made a verified request', () => {
    assert.equal(check('ai-bots-search-not-seen', activity({ bots: [oai({ verified: verified(1) })] })).first?.outcome, 'pass');
  });

  test('reports no verified visit as low, and only unverified claims as info', () => {
    const none = check('ai-bots-search-not-seen', activity({ bots: [perplexity({ spoofed: tally({ hits: 4 }) }), googlebot({ verified: verified(9) })] })).first;
    assert.deepEqual([none?.severity, none?.reason, none?.params?.days], ['low', 'none-seen', 29]);
    assert.match(message(none), /None of the AI search crawlers robots\.txt allows \(OAI-SearchBot, Claude-SearchBot, PerplexityBot, DuckAssistBot, MistralAI-Index, Amzn-SearchBot\)/u);
    const claims = check('ai-bots-search-not-seen', activity({ bots: [perplexity({ basis: 'claimed', unverified: tally({ hits: 2 }) })] })).first;
    assert.deepEqual([claims?.severity, claims?.reason, claims?.params?.agents], ['info', 'unverified-only', 'PerplexityBot']);
    message(claims);
  });

  test('does not apply when robots.txt disallows them all, and needs two weeks of data', () => {
    const blocked = ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'DuckAssistBot', 'MistralAI-Index', 'Amzn-SearchBot'].map(agent => `User-agent: ${agent}\nDisallow: /`).join('\n\n');
    assert.equal(check('ai-bots-search-not-seen', activity(), { robots: blocked }).first?.reason, 'all-disallowed');
    const short = activity({ window: { start: '2026-10-05T12:00:00.000Z', end: '2026-11-04T12:00:00.000Z', days: 30, firstRecord: '2026-10-30T00:00:00.000Z', lastRecord: '2026-11-04T00:00:00.000Z' } });
    assert.deepEqual([check('ai-bots-search-not-seen', short).first?.outcome, check('ai-bots-search-not-seen', short).first?.reason], ['not_evaluated', 'short-window']);
  });
});

describe('ai-bots-referrals', () => {
  test('reports referred and tagged visits as context', () => {
    const { first, excerpts } = check('ai-bots-referrals', activity({ referrals: { byHost: [{ host: 'chatgpt.com', assistant: 'ChatGPT', visits: 3 }], tagged: 1, total: 4 } }));
    assert.deepEqual([first?.severity, first?.params], ['info', { visits: 4, tagged: 1, assistants: 'ChatGPT 3' }]);
    assert.deepEqual(excerpts(first), ['chatgpt.com (ChatGPT): 3\nutm_source=chatgpt.com: 1']);
    assert.match(message(first), /AI Overviews and AI Mode count as Google Search/u);
  });

  test('passes without referred visits and is not evaluated without referrer data', () => {
    assert.equal(check('ai-bots-referrals', activity()).first?.outcome, 'pass');
    const { referrals: _referrals, ...withoutReferrals } = activity();
    assert.deepEqual([check('ai-bots-referrals', withoutReferrals).first?.outcome, check('ai-bots-referrals', withoutReferrals).first?.reason], ['not_evaluated', 'no-referrer-data']);
  });
});

describe('crawl-bots-blocked-at-edge', () => {
  const engine = (statuses: Record<string, number>, overrides: Partial<BotSummary> = {}) => {
    const hits = Object.values(statuses).reduce((sum, value) => sum + value, 0);
    return googlebot({ verified: verified(hits, statuses), onAllowedPaths: verified(hits, statuses), ...overrides });
  };

  test('grades refusals of verified Googlebot from high to low', () => {
    const high = check('crawl-bots-blocked-at-edge', activity({ bots: [engine({ 403: 15, 200: 5 })] })).first;
    assert.deepEqual([high?.severity, high?.reason, high?.params], ['high', 'refused', { agent: 'Googlebot', count: 15, total: 20, share: 0.75, statuses: '403 x15' }]);
    assert.match(message(high), /Verified Googlebot requests were refused 15 of 20 times/u);
    assert.equal(check('crawl-bots-blocked-at-edge', activity({ bots: [engine({ 403: 5, 200: 40 })] })).first?.severity, 'medium');
    assert.equal(check('crawl-bots-blocked-at-edge', activity({ bots: [engine({ 429: 3, 200: 97 })] })).first?.severity, 'low');
    const errors = check('crawl-bots-blocked-at-edge', activity({ bots: [engine({ 503: 12, 200: 50 })] })).first;
    assert.deepEqual([errors?.severity, errors?.reason, errors?.params?.statuses], ['medium', 'server-errors', '503 x12']);
    message(errors);
  });

  test('passes clean answers, is not evaluated for unverified claims and does not apply without search engine requests', () => {
    assert.equal(check('crawl-bots-blocked-at-edge', activity({ bots: [engine({ 200: 30, 304: 4 })] })).first?.outcome, 'pass');
    const claimed = check('crawl-bots-blocked-at-edge', activity({ bots: [googlebot({ basis: 'claimed', unverified: verified(20, { 403: 20 }) })] })).first;
    assert.deepEqual([claimed?.outcome, claimed?.reason], ['not_evaluated', 'unverified-only']);
    assert.equal(check('crawl-bots-blocked-at-edge', activity({ bots: [oai({ verified: verified(3) })] })).first?.reason, 'no-requests');
    const impostors = check('crawl-bots-blocked-at-edge', activity({ bots: [googlebot({ spoofed: verified(9, { 403: 9 }) })] })).first;
    assert.deepEqual([impostors?.outcome, impostors?.reason], ['not_applicable', 'no-verified-requests'], 'refusing impostors says nothing about the real crawler');
  });
});

describe('crawl-bots-robots-compliance', () => {
  const compliant = (disallowed: number) => gptbot({
    verified: verified(20), compliance: {
      cacheHours: 24, cacheBasis: 'standard', checkedFrom: '2026-09-02T10:00:00.000Z', disallowed, incomplete: false,
      paths: disallowed === 0 ? [] : [{ path: '/en/team/x', hits: disallowed, lastSeen: '2026-10-20T08:00:00.000Z', rule: '/en/team/', line: 5 }],
    },
  });

  test('reports a verified crawler fetching disallowed paths, quoting the rule', () => {
    const { first, excerpts } = check('crawl-bots-robots-compliance', activity({ bots: [compliant(4)] }));
    assert.deepEqual([first?.severity, first?.reason, first?.params], ['low', 'disallowed', { agent: 'GPTBot', count: 4, hours: 24, since: '2026-09-01' }]);
    assert.deepEqual(excerpts(first), ['/en/team/x (4, 2026-10-20)', 'Disallow: /en/team/']);
    message(first);
  });

  test('lowers the finding to info when the date robots.txt took effect is assumed', () => {
    const assumed = activity({ bots: [compliant(4)], site: { origin, sitemapUrls: 4, robots: { url: `${origin}/robots.txt`, effectiveFrom: '2026-10-05T12:00:00.000Z', effectiveFromSource: 'assumed' } } });
    const { first } = check('crawl-bots-robots-compliance', assumed);
    assert.deepEqual([first?.severity, first?.reason], ['info', 'assumed-unchanged']);
    assert.match(message(first), /assuming robots\.txt has not changed since 2026-10-05/u);
  });

  test('passes compliant crawlers and does not apply without rules or verified crawlers', () => {
    assert.equal(check('crawl-bots-robots-compliance', activity({ bots: [compliant(0)] })).first?.outcome, 'pass');
    assert.equal(check('crawl-bots-robots-compliance', activity({ bots: [oai({ verified: verified(2) })] })).first?.reason, 'no-verified-crawlers');
    assert.equal(check('crawl-bots-robots-compliance', activity({ bots: [compliant(4)] }), { robots: { status: 404 } }).first?.reason, 'no-robots-rules');
    const { site: _site, ...withoutSite } = activity({ bots: [compliant(4)] });
    assert.deepEqual([check('crawl-bots-robots-compliance', withoutSite).first?.outcome, check('crawl-bots-robots-compliance', withoutSite).first?.reason], ['not_evaluated', 'robots-not-compared']);
  });
});

describe('crawl-bots-googlebot-sitemap-coverage', () => {
  const covered = (ok: number) => googlebot({ verified: verified(40), coverage: { urls: 4, fetched: ok, ok, missing: [`${origin}/en/contact/`].slice(0, 4 - ok) } });

  test('passes full coverage and grades partial and low coverage', () => {
    assert.equal(check('crawl-bots-googlebot-sitemap-coverage', activity({ bots: [covered(4)] })).first?.outcome, 'pass');
    const partial = check('crawl-bots-googlebot-sitemap-coverage', activity({ bots: [covered(3)] }));
    assert.deepEqual([partial.first?.severity, partial.first?.reason, partial.first?.params], ['info', 'partial-coverage', { days: 29, fetched: 3, urls: 4, share: 0.75 }]);
    assert.deepEqual(partial.excerpts(partial.first)[1], `${origin}/en/contact/`);
    const low = check('crawl-bots-googlebot-sitemap-coverage', activity({ bots: [covered(1)] })).first;
    assert.deepEqual([low?.severity, low?.reason], ['low', 'low-coverage']);
    message(low);
  });

  test('reports Googlebot absent from the data as low', () => {
    const { first } = check('crawl-bots-googlebot-sitemap-coverage', activity({ bots: [oai({ verified: verified(3) })] }));
    assert.deepEqual([first?.severity, first?.reason, first?.params?.urls], ['low', 'not-seen', 4]);
    assert.match(message(first), /No verified Googlebot request appears in 29 days of data/u);
  });

  test('is not evaluated on short or unverifiable data, and does not apply without sitemap URLs', () => {
    const claimed = check('crawl-bots-googlebot-sitemap-coverage', activity({ bots: [googlebot({ basis: 'claimed', unverified: verified(10) })] })).first;
    assert.deepEqual([claimed?.outcome, claimed?.reason], ['not_evaluated', 'unverified-only']);
    const none = activity({ bots: [covered(1)], site: { origin, sitemapUrls: 0 } });
    assert.equal(check('crawl-bots-googlebot-sitemap-coverage', none).first?.reason, 'no-sitemap-urls');
    const missingInput = check('crawl-bots-googlebot-sitemap-coverage', activity({ bots: [covered(1)] }), { sitemaps: [] }).first;
    assert.deepEqual([missingInput?.outcome, missingInput?.reason], ['not_evaluated', 'missing-input:sitemaps']);
  });
});

describe('crawl-bots-spoofed-crawlers', () => {
  test('reports impostors the edge serves as low and impostors it refuses as info', () => {
    const served = check('crawl-bots-spoofed-crawlers', activity({ bots: [googlebot({ verified: verified(50), spoofed: tally({ hits: 30, statuses: { 200: 30 } }) })] })).first;
    assert.deepEqual([served?.severity, served?.reason, served?.params], ['low', 'served', { spoofed: 30, checked: 80, share: 0.375, served: 30, agents: 'Googlebot' }]);
    assert.match(message(served), /30 of 80 checked crawler requests failed their operators' checks/u);
    const refused = check('crawl-bots-spoofed-crawlers', activity({ bots: [googlebot({ verified: verified(50), spoofed: tally({ hits: 30, statuses: { 403: 30 } }) })] })).first;
    assert.deepEqual([refused?.severity, refused?.reason], ['info', 'refused']);
    const few = check('crawl-bots-spoofed-crawlers', activity({ bots: [googlebot({ verified: verified(46), spoofed: tally({ hits: 4, statuses: { 200: 4 } }) })] })).first;
    assert.deepEqual([few?.severity, few?.reason], ['info', 'present']);
    message(few);
  });

  test('passes a low share and needs checkable claims', () => {
    assert.equal(check('crawl-bots-spoofed-crawlers', activity({ bots: [googlebot({ verified: verified(99), spoofed: tally({ hits: 1, statuses: { 200: 1 } }) })] })).first?.outcome, 'pass');
    const unchecked = check('crawl-bots-spoofed-crawlers', activity({ bots: [googlebot({ basis: 'claimed', unverified: verified(20) })] })).first;
    assert.deepEqual([unchecked?.outcome, unchecked?.reason], ['not_evaluated', 'no-client-address']);
    assert.equal(check('crawl-bots-spoofed-crawlers', activity({ bots: [meta({ unverified: tally({ hits: 9 }) })] })).first?.reason, 'no-claims');
  });
});

describe('crawler rules in the engine', () => {
  test('run only with crawler activity, stay out of the score and have messages for every reason they emit', () => {
    const facts = site({ origin, pages: [], robots: robotsTxt, sitemaps: [{ url: `${origin}/sitemap.xml`, xml: sitemapXml }] });
    const map = new Map(implementations.map(entry => [entry.id, entry]));
    assert.deepEqual(runRules({ rules, implementations: map, site: facts, evidence: new EvidenceStore() }), []);
    const withData = runRules({ rules, implementations: map, site: { ...facts, owner: { bots: activity({ bots: [googlebot({ verified: verified(5) })] }) } }, evidence: new EvidenceStore() });
    assert.equal(withData.length, implementations.length);
    assert.ok(withData.every(finding => finding.origin === 'owner-data'));
    for (const entry of rules.filter(meta => implementations.some(implementation => implementation.id === meta.id))) {
      assert.deepEqual([entry.status, entry.scored, entry.method, entry.verifiableBy], ['requires-owner-data', false, 'owner-data', 'owner-data'], entry.id);
      assert.ok(entry.sources.every(source => source.verified === '2026-11-04'), entry.id);
    }
  });
});
