import type { Severity } from '../../core/types.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { aiCrawlers, crawlerAccess, isBlocked, samplePaths, type AiCrawler } from './crawlers.ts';
import { accessEvidence, isResult, parsedRobots } from './support.ts';

interface CrawlerRuleSpec {
  readonly id: string;
  /**
   * The crawler whose block is a finding (graded low when inherited, info when its own group blocks it, since naming
   * a crawler is a deliberate choice), or undefined when the rule only reports policies.
   */
  readonly primary?: AiCrawler;
  /** Only `/` decides the primary crawler, as for user-triggered fetchers. */
  readonly rootOnly?: boolean;
  /** Crawlers whose block is reported as info: training opt-outs and fetchers whose robots.txt handling varies. */
  readonly reported?: readonly AiCrawler[];
}

function primaryResult(context: RuleContext, spec: CrawlerRuleSpec, primary: AiCrawler): RuleResult | undefined {
  const robots = parsedRobots(context);
  if (isResult(robots)) return robots;
  const access = crawlerAccess(robots.file, primary, spec.rootOnly ? ['/'] : samplePaths(context.site));
  if (!isBlocked(access, 0.2, spec.rootOnly)) return undefined;
  const named = access.source === 'named';
  const severity: Severity = named ? 'info' : 'low';
  return {
    outcome: 'fail',
    severity,
    reason: named ? 'blocked-by-name' : 'blocked-by-inheritance',
    evidence: accessEvidence(context, robots, access),
    params: { agent: primary.name, blocked: access.blocked.length, sampled: access.sampled.length },
  };
}

function reportedResults(context: RuleContext, crawlers: readonly AiCrawler[]): RuleResult[] {
  const robots = parsedRobots(context);
  if (isResult(robots)) return [];
  const results: RuleResult[] = [];
  for (const entry of crawlers) {
    const access = crawlerAccess(robots.file, entry, ['/']);
    if (access.root.allowed) continue;
    results.push({ outcome: 'fail', severity: 'info', reason: 'disallowed', evidence: accessEvidence(context, robots, access), params: { agent: entry.name } });
  }
  return results;
}

function crawlerRule(spec: CrawlerRuleSpec): RuleImplementation {
  return {
    id: spec.id,
    evaluate(context) {
      const robots = parsedRobots(context);
      if (isResult(robots)) return robots;
      const results: RuleResult[] = [];
      if (spec.primary) {
        const primary = primaryResult(context, spec, spec.primary);
        if (primary) results.push(primary);
      }
      results.push(...reportedResults(context, spec.reported ?? []));
      if (results.length > 0) return results;
      const shown = spec.primary ?? spec.reported?.[0];
      const evidence = shown ? accessEvidence(context, robots, crawlerAccess(robots.file, shown, ['/'])) : [];
      return { outcome: 'pass', evidence };
    },
  };
}

const usageTrainingToken = '__usage_ai-training';

/** Google-Extended, plus the shared training token Google plans to read as a Google-Extended disallow when Google-Extended is not named. */
const googleExtended: RuleImplementation = {
  id: 'ai-robots-google-extended',
  evaluate(context) {
    const robots = parsedRobots(context);
    if (isResult(robots)) return robots;
    const results = reportedResults(context, [aiCrawlers.googleExtended]);
    const usage = robots.file.groups.find(group => group.userAgents.includes(usageTrainingToken));
    const named = robots.file.groups.some(group => group.userAgents.includes(aiCrawlers.googleExtended.token));
    if (usage && !named) {
      const decisive = usage.rules.find(rule => rule.type === 'disallow' && rule.pattern !== '');
      if (decisive) {
        results.push({
          outcome: 'fail', severity: 'info', reason: 'usage-ai-training',
          evidence: [
            context.evidence.add({ kind: 'robots', url: robots.url, label: 'robots.txt group for the shared AI training token', excerpt: (robots.lines[usage.line - 1] ?? '').trim(), line: usage.line }),
            context.evidence.add({ kind: 'robots', url: robots.url, label: 'rule in the shared AI training group', excerpt: (robots.lines[decisive.line - 1] ?? '').trim(), line: decisive.line }),
          ],
        });
      }
    }
    if (results.length > 0) return results;
    return { outcome: 'pass' };
  },
};

export const crawlerRules: readonly RuleImplementation[] = [
  crawlerRule({ id: 'ai-robots-oai-searchbot', primary: aiCrawlers.oaiSearchBot }),
  crawlerRule({ id: 'ai-robots-gptbot', reported: [aiCrawlers.gptbot] }),
  crawlerRule({ id: 'ai-robots-chatgpt-user', reported: [aiCrawlers.chatgptUser] }),
  crawlerRule({ id: 'ai-robots-claude-searchbot', primary: aiCrawlers.claudeSearchBot }),
  crawlerRule({ id: 'ai-robots-claude-user', primary: aiCrawlers.claudeUser, rootOnly: true }),
  crawlerRule({ id: 'ai-robots-claudebot', reported: [aiCrawlers.claudeBot] }),
  crawlerRule({ id: 'ai-robots-perplexitybot', primary: aiCrawlers.perplexityBot }),
  googleExtended,
  crawlerRule({ id: 'ai-robots-applebot', primary: aiCrawlers.applebot, rootOnly: true, reported: [aiCrawlers.applebotExtended] }),
  crawlerRule({ id: 'ai-robots-amazon', primary: aiCrawlers.amznSearchBot, rootOnly: true, reported: [aiCrawlers.amazonbot, aiCrawlers.amznUser] }),
  crawlerRule({
    id: 'ai-robots-meta', primary: aiCrawlers.metaWebIndexer, rootOnly: true,
    reported: [aiCrawlers.metaExternalAgent, aiCrawlers.metaExternalFetcher, aiCrawlers.facebookExternalHit],
  }),
  crawlerRule({ id: 'ai-robots-duckassistbot', primary: aiCrawlers.duckAssistBot, rootOnly: true }),
  crawlerRule({ id: 'ai-robots-mistral', primary: aiCrawlers.mistralIndex, rootOnly: true, reported: [aiCrawlers.mistralUser, aiCrawlers.mistralTraining] }),
  crawlerRule({ id: 'ai-robots-training-only-crawlers', reported: [aiCrawlers.ccBot, aiCrawlers.bytespider] }),
];
