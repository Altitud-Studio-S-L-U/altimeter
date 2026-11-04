import type { SiteFacts } from '../../core/facts.ts';
import { isAllowed, type RobotsDecision, type RobotsFile, type RobotsGroup } from '../../fetch/robots.ts';

export type AiPurpose = 'search' | 'training' | 'user-triggered';

export interface AiCrawler {
  /** Lowercase robots.txt product token. */
  readonly token: string;
  readonly name: string;
  readonly operator: string;
  readonly purpose: AiPurpose;
  /**
   * How the crawler picks a group when none names it. `chain`: the first listed token with a group, then `*`
   * (Applebot follows Googlebot's group). `search-bots`: the rules written for other search bots, which Amazon does
   * not specify further, so the crawler counts as blocked only when every candidate group blocks it.
   */
  readonly fallback?: { readonly mode: 'chain' | 'search-bots'; readonly tokens: readonly string[] };
}

const crawler = (token: string, name: string, operator: string, purpose: AiPurpose, fallback?: AiCrawler['fallback']): AiCrawler =>
  ({ token, name, operator, purpose, ...(fallback ? { fallback } : {}) });

/** AI crawler tokens documented by their operators, with the purpose each operator states for it. */
export const aiCrawlers = {
  gptbot: crawler('gptbot', 'GPTBot', 'OpenAI', 'training'),
  oaiSearchBot: crawler('oai-searchbot', 'OAI-SearchBot', 'OpenAI', 'search'),
  chatgptUser: crawler('chatgpt-user', 'ChatGPT-User', 'OpenAI', 'user-triggered'),
  claudeBot: crawler('claudebot', 'ClaudeBot', 'Anthropic', 'training'),
  claudeSearchBot: crawler('claude-searchbot', 'Claude-SearchBot', 'Anthropic', 'search'),
  claudeUser: crawler('claude-user', 'Claude-User', 'Anthropic', 'user-triggered'),
  perplexityBot: crawler('perplexitybot', 'PerplexityBot', 'Perplexity', 'search'),
  perplexityUser: crawler('perplexity-user', 'Perplexity-User', 'Perplexity', 'user-triggered'),
  googleExtended: crawler('google-extended', 'Google-Extended', 'Google', 'training'),
  applebot: crawler('applebot', 'Applebot', 'Apple', 'search', { mode: 'chain', tokens: ['googlebot'] }),
  applebotExtended: crawler('applebot-extended', 'Applebot-Extended', 'Apple', 'training'),
  amznSearchBot: crawler('amzn-searchbot', 'Amzn-SearchBot', 'Amazon', 'search', { mode: 'search-bots', tokens: ['googlebot', 'bingbot'] }),
  amazonbot: crawler('amazonbot', 'Amazonbot', 'Amazon', 'training'),
  amznUser: crawler('amzn-user', 'Amzn-User', 'Amazon', 'user-triggered'),
  metaWebIndexer: crawler('meta-webindexer', 'meta-webindexer', 'Meta', 'search'),
  metaExternalAgent: crawler('meta-externalagent', 'meta-externalagent', 'Meta', 'training'),
  metaExternalFetcher: crawler('meta-externalfetcher', 'meta-externalfetcher', 'Meta', 'user-triggered'),
  facebookExternalHit: crawler('facebookexternalhit', 'facebookexternalhit', 'Meta', 'user-triggered'),
  duckAssistBot: crawler('duckassistbot', 'DuckAssistBot', 'DuckDuckGo', 'search'),
  mistralIndex: crawler('mistralai-index', 'MistralAI-Index', 'Mistral', 'search'),
  mistralUser: crawler('mistralai-user', 'MistralAI-User', 'Mistral', 'user-triggered'),
  mistralTraining: crawler('mistralai-training', 'MistralAI-Training', 'Mistral', 'training'),
  ccBot: crawler('ccbot', 'CCBot', 'Common Crawl', 'training'),
  bytespider: crawler('bytespider', 'Bytespider', 'ByteDance', 'training'),
} as const satisfies Readonly<Record<string, AiCrawler>>;

export const allAiCrawlers: readonly AiCrawler[] = Object.values(aiCrawlers);

/** Search and answer crawlers that inherit a `*` group when robots.txt does not name them. */
export const answerCrawlers: readonly AiCrawler[] = [
  aiCrawlers.oaiSearchBot, aiCrawlers.claudeSearchBot, aiCrawlers.claudeUser, aiCrawlers.perplexityBot, aiCrawlers.applebot,
  aiCrawlers.amznSearchBot, aiCrawlers.duckAssistBot, aiCrawlers.mistralIndex, aiCrawlers.metaWebIndexer,
];

/** Operators that run a separate search crawler and training crawler, so their two policies can contradict. */
export const operatorPairs: readonly { readonly operator: string; readonly search: AiCrawler; readonly training: AiCrawler }[] = [
  { operator: 'OpenAI', search: aiCrawlers.oaiSearchBot, training: aiCrawlers.gptbot },
  { operator: 'Anthropic', search: aiCrawlers.claudeSearchBot, training: aiCrawlers.claudeBot },
  { operator: 'Amazon', search: aiCrawlers.amznSearchBot, training: aiCrawlers.amazonbot },
  { operator: 'Meta', search: aiCrawlers.metaWebIndexer, training: aiCrawlers.metaExternalAgent },
  { operator: 'Mistral', search: aiCrawlers.mistralIndex, training: aiCrawlers.mistralTraining },
];

export function hasGroup(file: RobotsFile, token: string): boolean {
  return file.groups.some(group => group.userAgents.includes(token));
}

export function groupOfRule(file: RobotsFile, line: number): RobotsGroup | undefined {
  return file.groups.find(group => group.rules.some(rule => rule.line === line));
}

export interface CrawlerAccess {
  readonly crawler: AiCrawler;
  /** named: a group names the crawler; fallback: it follows another crawler's group; wildcard: the `*` group; none: no group applies. */
  readonly source: 'named' | 'fallback' | 'wildcard' | 'none';
  /** The decision for `/`, from the group that decides it. */
  readonly root: RobotsDecision;
  readonly sampled: readonly string[];
  readonly blocked: readonly string[];
}

/** Paths a crawler is checked against: `/`, then the audited pages and sitemap URLs of the origin, up to 20. */
export function samplePaths(site: SiteFacts, limit = 20): string[] {
  const paths = new Set<string>(['/']);
  const add = (url: string) => {
    if (paths.size >= limit) return;
    try {
      const parsed = new URL(url);
      if (parsed.origin === site.origin) paths.add(`${parsed.pathname}${parsed.search}`);
    } catch {
      // A malformed URL in a sitemap is reported by the sitemap rules.
    }
  };
  for (const page of site.pages.values()) if (page.fetch.status === 200) add(page.fetch.finalUrl);
  for (const sitemap of site.sitemaps) for (const entry of sitemap.document?.urls ?? []) add(entry.loc);
  return [...paths];
}

function decide(file: RobotsFile, entry: AiCrawler, path: string): { decision: RobotsDecision; source: CrawlerAccess['source'] } {
  const own = isAllowed(file, [entry.token], path);
  if (own.matchedToken === entry.token || !entry.fallback) return { decision: own, source: sourceOf(own, entry) };
  if (entry.fallback.mode === 'chain') {
    const chained = isAllowed(file, [entry.token, ...entry.fallback.tokens], path);
    return { decision: chained, source: sourceOf(chained, entry) };
  }
  const candidates = [...entry.fallback.tokens.filter(token => hasGroup(file, token)).map(token => isAllowed(file, [token], path)), own];
  const allow = candidates.find(candidate => candidate.allowed);
  const decision = allow ?? candidates.at(-1)!;
  return { decision, source: candidates.length > 1 ? 'fallback' : sourceOf(own, entry) };
}

function sourceOf(decision: RobotsDecision, entry: AiCrawler): CrawlerAccess['source'] {
  if (decision.matchedToken === entry.token) return 'named';
  if (decision.matchedToken === '*') return 'wildcard';
  return decision.matchedToken === undefined ? 'none' : 'fallback';
}

/** Resolves how robots.txt treats a crawler on `/` and on the sampled paths. */
export function crawlerAccess(file: RobotsFile, entry: AiCrawler, paths: readonly string[]): CrawlerAccess {
  const root = decide(file, entry, '/');
  const blocked = paths.filter(path => !decide(file, entry, path).decision.allowed);
  return { crawler: entry, source: root.source, root: root.decision, sampled: paths, blocked };
}

/** Blocked when `/` is disallowed or more than the given share of the sampled paths is. */
export function isBlocked(access: CrawlerAccess, share = 0.2, rootOnly = false): boolean {
  if (!access.root.allowed) return true;
  if (rootOnly || access.sampled.length === 0) return false;
  return access.blocked.length / access.sampled.length > share;
}
