import type { BotPurpose } from './activity.ts';

/** Published address lists, each read from the operator's own URL. */
export type IpListId =
  | 'google-common'
  | 'google-user-triggered-agents'
  | 'google-user-triggered-fetchers-google'
  | 'bingbot'
  | 'openai-gptbot'
  | 'openai-searchbot'
  | 'openai-chatgpt-user'
  | 'anthropic'
  | 'perplexity-bot'
  | 'perplexity-user'
  | 'applebot'
  | 'amazon-amazonbot'
  | 'amazon-searchbot'
  | 'amazon-user'
  | 'duckassistbot'
  | 'mistral-index'
  | 'mistral-user'
  | 'ccbot'
  | 'cloudflare-v4'
  | 'cloudflare-v6';

export interface IpListDefinition {
  readonly id: IpListId;
  readonly url: string;
  /**
   * `bot`: one crawler's addresses. `operator`: every crawler of the operator, so a match proves the operator only.
   * `proxy`: a CDN's own addresses, which are never a crawler's, so a log that records them records the proxy.
   */
  readonly scope: 'bot' | 'operator' | 'proxy';
  /** The page that documents the list. */
  readonly documentation: string;
}

const googleRanges = 'https://developers.google.com/static/crawling/ipranges';
const googleVerify = 'https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot';
const amazonDocs = 'https://developer.amazon.com/amazonbot';

export const ipListDefinitions: Readonly<Record<IpListId, IpListDefinition>> = {
  'google-common': { id: 'google-common', url: `${googleRanges}/common-crawlers.json`, scope: 'bot', documentation: googleVerify },
  'google-user-triggered-agents': { id: 'google-user-triggered-agents', url: `${googleRanges}/user-triggered-agents.json`, scope: 'bot', documentation: googleVerify },
  'google-user-triggered-fetchers-google': {
    id: 'google-user-triggered-fetchers-google', url: `${googleRanges}/user-triggered-fetchers-google.json`, scope: 'operator', documentation: googleVerify,
  },
  bingbot: { id: 'bingbot', url: 'https://www.bing.com/toolbox/bingbot.json', scope: 'bot', documentation: 'https://blogs.bing.com/webmaster/2012/08/31/how-to-verify-that-bingbot-is-bingbot' },
  'openai-gptbot': { id: 'openai-gptbot', url: 'https://openai.com/gptbot.json', scope: 'bot', documentation: 'https://developers.openai.com/api/docs/bots' },
  'openai-searchbot': { id: 'openai-searchbot', url: 'https://openai.com/searchbot.json', scope: 'bot', documentation: 'https://developers.openai.com/api/docs/bots' },
  'openai-chatgpt-user': { id: 'openai-chatgpt-user', url: 'https://openai.com/chatgpt-user.json', scope: 'bot', documentation: 'https://developers.openai.com/api/docs/bots' },
  anthropic: {
    id: 'anthropic', url: 'https://claude.com/crawling/bots.json', scope: 'operator',
    documentation: 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler',
  },
  'perplexity-bot': { id: 'perplexity-bot', url: 'https://www.perplexity.ai/perplexitybot.json', scope: 'bot', documentation: 'https://docs.perplexity.ai/guides/bots' },
  'perplexity-user': { id: 'perplexity-user', url: 'https://www.perplexity.ai/perplexity-user.json', scope: 'bot', documentation: 'https://docs.perplexity.ai/guides/bots' },
  applebot: { id: 'applebot', url: 'https://search.developer.apple.com/applebot.json', scope: 'bot', documentation: 'https://support.apple.com/en-us/119829' },
  'amazon-amazonbot': { id: 'amazon-amazonbot', url: 'https://developer.amazon.com/amazonbot/ip-addresses/', scope: 'bot', documentation: amazonDocs },
  'amazon-searchbot': { id: 'amazon-searchbot', url: 'https://developer.amazon.com/amazonbot/searchbot-ip-addresses/', scope: 'bot', documentation: amazonDocs },
  'amazon-user': { id: 'amazon-user', url: 'https://developer.amazon.com/amazonbot/live-ip-addresses/', scope: 'bot', documentation: amazonDocs },
  duckassistbot: { id: 'duckassistbot', url: 'https://duckduckgo.com/duckassistbot.json', scope: 'bot', documentation: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot' },
  'mistral-index': { id: 'mistral-index', url: 'https://mistral.ai/mistralai-index-ips.json', scope: 'bot', documentation: 'https://docs.mistral.ai/robots' },
  'mistral-user': { id: 'mistral-user', url: 'https://mistral.ai/mistralai-user-ips.json', scope: 'bot', documentation: 'https://docs.mistral.ai/robots' },
  ccbot: { id: 'ccbot', url: 'https://index.commoncrawl.org/ccbot.json', scope: 'bot', documentation: 'https://commoncrawl.org/ccbot' },
  'cloudflare-v4': { id: 'cloudflare-v4', url: 'https://www.cloudflare.com/ips-v4/', scope: 'proxy', documentation: 'https://www.cloudflare.com/ips/' },
  'cloudflare-v6': { id: 'cloudflare-v6', url: 'https://www.cloudflare.com/ips-v6/', scope: 'proxy', documentation: 'https://www.cloudflare.com/ips/' },
};

export const proxyListIds: readonly IpListId[] = ['cloudflare-v4', 'cloudflare-v6'];

export interface BotChecks {
  /** Address lists the operator publishes for the crawler. */
  readonly lists: readonly IpListId[];
  /** Host name suffixes the operator documents for reverse DNS, always checked with a forward lookup. */
  readonly dnsSuffixes: readonly string[];
  /** Address families reverse DNS covers when the operator limits it. */
  readonly dnsFamilies?: readonly (4 | 6)[];
  /**
   * The operator says its lists are not exhaustive, or also identifies the crawler by signed requests (Web Bot Auth)
   * that access logs do not record: an address outside the lists then leaves the request unverified, not spoofed.
   */
  readonly listsInconclusive?: boolean;
  /**
   * The operator also documents host names in space other customers share (Google App Engine), which Altimeter does
   * not accept: reverse DNS can then verify a request but never refute it, and a request no check verifies stays unverified.
   */
  readonly dnsInconclusive?: boolean;
}

export interface BotDefinition {
  readonly id: string;
  readonly name: string;
  readonly operator: string;
  readonly purpose: BotPurpose;
  /**
   * `search-engine`: Googlebot and Bingbot, owned by the crawl rules. `ai`: AI operators' crawlers and fetchers.
   * `preview`: link preview fetchers, counted but left out of both rule sets.
   */
  readonly family: 'search-engine' | 'ai' | 'preview';
  /** Lowercase robots.txt product token. */
  readonly token: string;
  /** Tokens robots.txt groups are chosen by, most specific first; the `*` group is the last resort. */
  readonly robotsTokens: readonly string[];
  /** Amazon: without a group of its own, the crawler follows the groups written for other search bots. */
  readonly robotsFallback?: 'search-bots';
  /** Product tokens in the user agent, matched without case on token boundaries; the first is the current one. */
  readonly userAgentTokens: readonly string[];
  readonly checks: BotChecks;
  /** Whether the operator documents that the crawler follows robots.txt; fetches a user asks for generally do not. */
  readonly followsRobots: boolean;
  /** Hours the operator says it may use a cached robots.txt; RFC 9309's 24 hours when it does not say. */
  readonly robotsCacheHours?: number;
  readonly documentation?: string;
}

const none: BotChecks = { lists: [], dnsSuffixes: [] };

const bot = (definition: Omit<BotDefinition, 'robotsTokens'> & { readonly robotsTokens?: readonly string[] }): BotDefinition =>
  ({ ...definition, robotsTokens: definition.robotsTokens ?? [definition.token] });

const google = 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers';
const googleFetchers = 'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers';
const googlebotChecks: BotChecks = { lists: ['google-common'], dnsSuffixes: ['googlebot.com'], listsInconclusive: true };
// Google's fetchers also run from Google App Engine space (gae.googleusercontent.com), which any App Engine customer
// shares, so only the Google-controlled list and host names verify them and other addresses stay unverified.
const googleFetcherChecks: BotChecks = { lists: ['google-user-triggered-fetchers-google'], dnsSuffixes: ['google.com'], listsInconclusive: true, dnsInconclusive: true };
const openai = 'https://developers.openai.com/api/docs/bots';
const anthropic = ipListDefinitions.anthropic.documentation;
const perplexity = 'https://docs.perplexity.ai/guides/bots';
const meta = 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/';
const mistral = 'https://docs.mistral.ai/robots';

/**
 * Crawlers Altimeter counts, with the purpose and verification each operator documents. Requests from crawlers not
 * listed here are not counted. Sources were read on 2026-11-04.
 */
export const botDefinitions: readonly BotDefinition[] = [
  bot({ id: 'googlebot', name: 'Googlebot', operator: 'Google', purpose: 'search', family: 'search-engine', token: 'googlebot', userAgentTokens: ['Googlebot'],
    checks: googlebotChecks, followsRobots: true, robotsCacheHours: 24, documentation: google }),
  bot({ id: 'googlebot-image', name: 'Googlebot-Image', operator: 'Google', purpose: 'search', family: 'search-engine', token: 'googlebot-image',
    robotsTokens: ['googlebot-image', 'googlebot'], userAgentTokens: ['Googlebot-Image'], checks: googlebotChecks, followsRobots: true, robotsCacheHours: 24, documentation: google }),
  bot({ id: 'googlebot-video', name: 'Googlebot-Video', operator: 'Google', purpose: 'search', family: 'search-engine', token: 'googlebot-video',
    robotsTokens: ['googlebot-video', 'googlebot'], userAgentTokens: ['Googlebot-Video'], checks: googlebotChecks, followsRobots: true, robotsCacheHours: 24, documentation: google }),
  bot({ id: 'google-agent', name: 'Google-Agent', operator: 'Google', purpose: 'user-triggered', family: 'ai', token: 'google-agent', userAgentTokens: ['Google-Agent'],
    checks: { lists: ['google-user-triggered-agents'], dnsSuffixes: [], listsInconclusive: true }, followsRobots: false, documentation: googleFetchers }),
  bot({ id: 'google-gemininotebook', name: 'Google-GeminiNotebook', operator: 'Google', purpose: 'user-triggered', family: 'ai', token: 'google-gemininotebook',
    userAgentTokens: ['Google-GeminiNotebook', 'Google-NotebookLM'], checks: googleFetcherChecks, followsRobots: false, documentation: googleFetchers }),
  bot({ id: 'bingbot', name: 'Bingbot', operator: 'Microsoft', purpose: 'search', family: 'search-engine', token: 'bingbot', userAgentTokens: ['bingbot'],
    checks: { lists: ['bingbot'], dnsSuffixes: ['search.msn.com'], listsInconclusive: true }, followsRobots: true,
    documentation: ipListDefinitions.bingbot.documentation }),
  bot({ id: 'gptbot', name: 'GPTBot', operator: 'OpenAI', purpose: 'training', family: 'ai', token: 'gptbot', userAgentTokens: ['GPTBot'],
    checks: { lists: ['openai-gptbot'], dnsSuffixes: [] }, followsRobots: true, documentation: openai }),
  bot({ id: 'oai-searchbot', name: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search', family: 'ai', token: 'oai-searchbot', userAgentTokens: ['OAI-SearchBot'],
    checks: { lists: ['openai-searchbot'], dnsSuffixes: [] }, followsRobots: true, robotsCacheHours: 24, documentation: openai }),
  bot({ id: 'chatgpt-user', name: 'ChatGPT-User', operator: 'OpenAI', purpose: 'user-triggered', family: 'ai', token: 'chatgpt-user', userAgentTokens: ['ChatGPT-User'],
    checks: { lists: ['openai-chatgpt-user'], dnsSuffixes: [] }, followsRobots: false, documentation: openai }),
  bot({ id: 'claudebot', name: 'ClaudeBot', operator: 'Anthropic', purpose: 'training', family: 'ai', token: 'claudebot', userAgentTokens: ['ClaudeBot'],
    checks: { lists: ['anthropic'], dnsSuffixes: [] }, followsRobots: true, documentation: anthropic }),
  bot({ id: 'claude-searchbot', name: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search', family: 'ai', token: 'claude-searchbot', userAgentTokens: ['Claude-SearchBot'],
    checks: { lists: ['anthropic'], dnsSuffixes: [] }, followsRobots: true, documentation: anthropic }),
  bot({ id: 'claude-user', name: 'Claude-User', operator: 'Anthropic', purpose: 'user-triggered', family: 'ai', token: 'claude-user', userAgentTokens: ['Claude-User'],
    checks: { lists: ['anthropic'], dnsSuffixes: [] }, followsRobots: false, documentation: anthropic }),
  bot({ id: 'perplexitybot', name: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', family: 'ai', token: 'perplexitybot', userAgentTokens: ['PerplexityBot'],
    checks: { lists: ['perplexity-bot'], dnsSuffixes: [] }, followsRobots: true, robotsCacheHours: 24, documentation: perplexity }),
  bot({ id: 'perplexity-user', name: 'Perplexity-User', operator: 'Perplexity', purpose: 'user-triggered', family: 'ai', token: 'perplexity-user', userAgentTokens: ['Perplexity-User'],
    checks: { lists: ['perplexity-user'], dnsSuffixes: [] }, followsRobots: false, documentation: perplexity }),
  bot({ id: 'applebot', name: 'Applebot', operator: 'Apple', purpose: 'search', family: 'ai', token: 'applebot', robotsTokens: ['applebot', 'googlebot'], userAgentTokens: ['Applebot'],
    checks: { lists: ['applebot'], dnsSuffixes: ['applebot.apple.com'], listsInconclusive: true }, followsRobots: true, documentation: 'https://support.apple.com/en-us/119829' }),
  bot({ id: 'amazonbot', name: 'Amazonbot', operator: 'Amazon', purpose: 'training', family: 'ai', token: 'amazonbot', userAgentTokens: ['Amazonbot'],
    checks: { lists: ['amazon-amazonbot'], dnsSuffixes: [] }, followsRobots: true, robotsCacheHours: 720, documentation: amazonDocs }),
  bot({ id: 'amzn-searchbot', name: 'Amzn-SearchBot', operator: 'Amazon', purpose: 'search', family: 'ai', token: 'amzn-searchbot', robotsFallback: 'search-bots',
    userAgentTokens: ['Amzn-SearchBot'], checks: { lists: ['amazon-searchbot'], dnsSuffixes: [] }, followsRobots: true, robotsCacheHours: 720, documentation: amazonDocs }),
  bot({ id: 'amzn-user', name: 'Amzn-User', operator: 'Amazon', purpose: 'user-triggered', family: 'ai', token: 'amzn-user', userAgentTokens: ['Amzn-User'],
    checks: { lists: ['amazon-user'], dnsSuffixes: [] }, followsRobots: false, documentation: amazonDocs }),
  bot({ id: 'meta-externalagent', name: 'meta-externalagent', operator: 'Meta', purpose: 'training', family: 'ai', token: 'meta-externalagent',
    userAgentTokens: ['meta-externalagent'], checks: none, followsRobots: true, robotsCacheHours: 24, documentation: meta }),
  bot({ id: 'meta-webindexer', name: 'meta-webindexer', operator: 'Meta', purpose: 'search', family: 'ai', token: 'meta-webindexer',
    userAgentTokens: ['meta-webindexer'], checks: none, followsRobots: true, robotsCacheHours: 24, documentation: meta }),
  bot({ id: 'meta-externalfetcher', name: 'meta-externalfetcher', operator: 'Meta', purpose: 'user-triggered', family: 'ai', token: 'meta-externalfetcher',
    userAgentTokens: ['meta-externalfetcher'], checks: none, followsRobots: false, documentation: meta }),
  bot({ id: 'facebookexternalhit', name: 'facebookexternalhit', operator: 'Meta', purpose: 'user-triggered', family: 'preview', token: 'facebookexternalhit',
    userAgentTokens: ['facebookexternalhit'], checks: none, followsRobots: false, documentation: meta }),
  bot({ id: 'duckassistbot', name: 'DuckAssistBot', operator: 'DuckDuckGo', purpose: 'search', family: 'ai', token: 'duckassistbot', userAgentTokens: ['DuckAssistBot'],
    checks: { lists: ['duckassistbot'], dnsSuffixes: [] }, followsRobots: true, robotsCacheHours: 72, documentation: ipListDefinitions.duckassistbot.documentation }),
  bot({ id: 'mistralai-index', name: 'MistralAI-Index', operator: 'Mistral', purpose: 'search', family: 'ai', token: 'mistralai-index', userAgentTokens: ['MistralAI-Index'],
    checks: { lists: ['mistral-index'], dnsSuffixes: [] }, followsRobots: true, documentation: mistral }),
  bot({ id: 'mistralai-user', name: 'MistralAI-User', operator: 'Mistral', purpose: 'user-triggered', family: 'ai', token: 'mistralai-user', userAgentTokens: ['MistralAI-User'],
    checks: { lists: ['mistral-user'], dnsSuffixes: [] }, followsRobots: false, documentation: mistral }),
  bot({ id: 'mistralai-training', name: 'MistralAI-Training', operator: 'Mistral', purpose: 'training', family: 'ai', token: 'mistralai-training',
    userAgentTokens: ['MistralAI-Training'], checks: none, followsRobots: true, documentation: mistral }),
  bot({ id: 'ccbot', name: 'CCBot', operator: 'Common Crawl', purpose: 'training', family: 'ai', token: 'ccbot', userAgentTokens: ['CCBot'],
    checks: { lists: ['ccbot'], dnsSuffixes: ['crawl.commoncrawl.org'], dnsFamilies: [4] }, followsRobots: true, documentation: 'https://commoncrawl.org/ccbot' }),
  bot({ id: 'bytespider', name: 'Bytespider', operator: 'ByteDance', purpose: 'training', family: 'ai', token: 'bytespider', userAgentTokens: ['Bytespider'],
    checks: none, followsRobots: true }),
];

/** Whether the operator documents any check; requests of other crawlers are claims only. */
export function isVerifiable(definition: BotDefinition): boolean {
  return definition.checks.lists.length > 0 || definition.checks.dnsSuffixes.length > 0;
}

/** robots.txt tokens that no request carries: they only say how content fetched by other crawlers may be used. */
export const robotsOnlyTokens: readonly { readonly name: string; readonly token: string; readonly operator: string; readonly documentation: string }[] = [
  { name: 'Google-Extended', token: 'google-extended', operator: 'Google', documentation: google },
  { name: 'Applebot-Extended', token: 'applebot-extended', operator: 'Apple', documentation: 'https://support.apple.com/en-us/119829' },
];

const byId = new Map(botDefinitions.map(definition => [definition.id, definition]));

export function botById(id: string): BotDefinition | undefined {
  return byId.get(id);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const tokenOwners = new Map(botDefinitions.flatMap(definition => definition.userAgentTokens.map(token => [token.toLowerCase(), definition] as const)));
const tokenPattern = new RegExp(
  `(?<![A-Za-z0-9_-])(${[...tokenOwners.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![A-Za-z0-9_-])`, 'iu',
);

/**
 * The crawler a user agent names, matched on token boundaries without case: `GPTBot/1.4` matches, `NotGPTBotX` and
 * `Googlebot-Image` (for Googlebot) do not. The leftmost token wins when a user agent names several.
 */
export function matchBot(userAgent: string | undefined): BotDefinition | undefined {
  if (!userAgent) return undefined;
  const match = tokenPattern.exec(userAgent);
  return match ? tokenOwners.get(match[1]!.toLowerCase()) : undefined;
}

/** Assistants whose links send visitors, by the host of the Referer they send. */
export const assistantReferrers: readonly { readonly host: string; readonly assistant: string }[] = [
  { host: 'chatgpt.com', assistant: 'ChatGPT' },
  { host: 'chat.openai.com', assistant: 'ChatGPT' },
  { host: 'perplexity.ai', assistant: 'Perplexity' },
  { host: 'copilot.microsoft.com', assistant: 'Microsoft Copilot' },
  { host: 'gemini.google.com', assistant: 'Gemini' },
  { host: 'claude.ai', assistant: 'Claude' },
];

const referrerHosts = new Map(assistantReferrers.map(entry => [entry.host, entry]));

/** The assistant a Referer value points to: its host must equal a listed host, optionally after `www.`. */
export function assistantFor(referer: string | undefined): { readonly host: string; readonly assistant: string } | undefined {
  if (!referer || referer === '-') return undefined;
  let host: string;
  try {
    host = new URL(referer.includes('://') ? referer : `https://${referer}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return referrerHosts.get(host.startsWith('www.') ? host.slice(4) : host);
}

/** Whether a query string carries utm_source=chatgpt.com, which a link can set and anyone can type. */
export function taggedByChatGpt(pathAndQuery: string): boolean {
  const index = pathAndQuery.indexOf('?');
  if (index === -1) return false;
  try {
    return new URLSearchParams(pathAndQuery.slice(index + 1)).getAll('utm_source').some(value => value.trim().toLowerCase() === 'chatgpt.com');
  } catch {
    return false;
  }
}
