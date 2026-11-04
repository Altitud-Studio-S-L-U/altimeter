import { isAllowed } from '../../fetch/robots.ts';
import { summarizeList } from '../helpers.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { allAiCrawlers, answerCrawlers, crawlerAccess, hasGroup, operatorPairs } from './crawlers.ts';
import { accessEvidence, isResult, parsedRobots, robotsLineEvidence } from './support.ts';

// Hosts that are private previews by convention, where a global disallow is the intended state.
const stagingHost = /^(?:staging|stage|preview|dev|development|test|testing|qa|uat|sandbox)[.-]/iu;

const wildcardDisallowAll: RuleImplementation = {
  id: 'ai-robots-wildcard-disallow-all',
  evaluate(context) {
    const robots = parsedRobots(context);
    if (isResult(robots)) return robots;
    const { file } = robots;
    const wildcard = isAllowed(file, [], '/');
    if (wildcard.matchedToken !== '*' || wildcard.allowed) return { outcome: 'pass' };
    if (stagingHost.test(new URL(context.site.origin).hostname)) return { outcome: 'not_applicable', reason: 'staging-host' };
    const inheriting = answerCrawlers.map(entry => crawlerAccess(file, entry, ['/'])).filter(access => access.source === 'wildcard' && !access.root.allowed);
    if (inheriting.length === 0) return { outcome: 'pass' };
    const searchEngines = ['googlebot', 'bingbot'].map(token => ({ token, decision: isAllowed(file, [token], '/') }))
      .filter(entry => entry.decision.matchedToken === entry.token && entry.decision.allowed);
    // With Googlebot and Bingbot blocked too, the whole site is closed and crawl-robots-blocks-site owns the finding.
    if (searchEngines.length === 0) return { outcome: 'not_applicable', reason: 'whole-site-blocked' };
    const evidence = accessEvidence(context, robots, inheriting[0]!);
    for (const engine of searchEngines) {
      const group = file.groups.find(entry => entry.userAgents.includes(engine.token));
      if (group) evidence.push(robotsLineEvidence(context, robots, group.line, `robots.txt group that names ${engine.token}`));
    }
    return {
      outcome: 'fail', severity: 'medium', reason: 'ai-search-inherits-block', evidence,
      params: { agents: summarizeList(inheriting.map(access => access.crawler.name), 4), count: inheriting.length },
    };
  },
};

const policyCoherence: RuleImplementation = {
  id: 'ai-robots-policy-coherence',
  evaluate(context) {
    const robots = parsedRobots(context);
    if (isResult(robots)) return robots;
    const inversions = operatorPairs.map(pair => ({
      pair,
      search: crawlerAccess(robots.file, pair.search, ['/']),
      training: crawlerAccess(robots.file, pair.training, ['/']),
    })).filter(entry => !entry.search.root.allowed && entry.training.root.allowed);
    if (inversions.length === 0) return { outcome: 'pass' };
    // Naming both crawlers is an explicit choice; an inversion that comes from inheritance is more likely an accident.
    const explicit = inversions.every(entry => entry.search.source === 'named' && entry.training.source === 'named');
    const evidence = inversions.flatMap(entry => [...accessEvidence(context, robots, entry.search), ...accessEvidence(context, robots, entry.training)]);
    return {
      outcome: 'fail', severity: explicit ? 'info' : 'low', reason: 'search-blocked-training-allowed', evidence,
      params: { operators: summarizeList(inversions.map(entry => `${entry.pair.operator} (${entry.pair.search.name} blocked, ${entry.pair.training.name} allowed)`), 3) },
    };
  },
};

/** Tokens no operator documents any more, mapped to the current token that replaced them. */
const legacyTokens: Readonly<Record<string, string>> = {
  'anthropic-ai': 'claudebot',
  'claude-web': 'claudebot',
  chatgpt: 'chatgpt-user',
  openai: 'gptbot',
  perplexity: 'perplexitybot',
  facebookbot: 'meta-externalagent',
  'google-notebooklm': 'google-gemininotebook',
};

const currentNames = new Map<string, string>([
  ...allAiCrawlers.map(entry => [entry.token, entry.name] as const),
  ['google-gemininotebook', 'Google-GeminiNotebook'],
]);

/** Crawler tokens that are not AI tokens but sit close to one, so they are never read as a misspelling. */
const otherKnownTokens = new Set([
  'googlebot', 'googlebot-image', 'googlebot-news', 'googlebot-video', 'googleother', 'google-inspectiontool', 'storebot-google',
  'adsbot-google', 'mediapartners-google', 'bingbot', 'msnbot', 'adidxbot', 'duckduckbot', 'yandex', 'yandexbot', 'baiduspider',
  'slurp', 'facebot', 'twitterbot', 'linkedinbot', 'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot', 'petalbot', 'seznambot',
  'rogerbot', 'ia_archiver', 'archive.org_bot', 'qwantify', 'naverbot', 'yeti', 'sogou', 'exabot',
]);

const normalize = (token: string) => token.toLowerCase().replace(/[^a-z0-9]/gu, '');

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/** The current token a user-agent value most likely meant, when it is a spelling variant of one. */
function nearMiss(value: string, product: string): string | undefined {
  const lower = value.toLowerCase();
  const plain = normalize(value);
  // "Applebot Extended" parses as the Applebot token, so a spacing variant matters even when its first word is valid.
  for (const token of currentNames.keys()) if (plain === normalize(token) && lower !== token) return token;
  if (currentNames.has(product) || otherKnownTokens.has(product) || product === '*' || lower.startsWith('*')) return undefined;
  const candidate = normalize(product);
  for (const token of currentNames.keys()) {
    const target = normalize(token);
    // Short tokens sit within two edits of unrelated crawler names (DotBot and GPTBot), so the margin grows with length.
    const allowed = target.length >= 11 ? 2 : target.length >= 7 ? 1 : 0;
    if (allowed > 0 && distance(candidate, target) <= allowed) return token;
  }
  return undefined;
}

const legacyTokenRule: RuleImplementation = {
  id: 'ai-robots-legacy-tokens',
  evaluate(context) {
    const robots = parsedRobots(context);
    if (isResult(robots)) return robots;
    const results: RuleResult[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of robots.lines.entries()) {
      const match = /^\s*user[- ]?agent\s*:\s*([^#]*)/iu.exec(raw);
      const value = match?.[1]?.trim();
      if (!value || seen.has(value.toLowerCase())) continue;
      const product = /^[a-z_-]+/u.exec(value.toLowerCase())?.[0] ?? value.toLowerCase();
      const legacy = legacyTokens[product];
      const current = legacy ?? nearMiss(value, product);
      if (!current || hasGroup(robots.file, current)) continue;
      seen.add(value.toLowerCase());
      results.push({
        outcome: 'fail', severity: 'low', reason: legacy ? 'legacy-token' : 'near-miss-token',
        evidence: [robotsLineEvidence(context, robots, index + 1, 'user-agent line naming a token that no current crawler documentation lists')],
        params: { token: value, current: currentNames.get(current) ?? current },
      });
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

export const policyRules: readonly RuleImplementation[] = [wildcardDisallowAll, policyCoherence, legacyTokenRule];
