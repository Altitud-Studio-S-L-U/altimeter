/**
 * Crawler identities Altimeter probes with. Sending a crawler's user agent only shows how the site's edge treats
 * that string: real crawlers are recognised by IP, so a site may legitimately block an impostor that uses it.
 */
export type CrawlerPurpose = 'search' | 'training' | 'user-triggered' | 'baseline';

export interface ProbeAgent {
  /** Name used in reports. */
  readonly name: string;
  /** The robots.txt product token. */
  readonly token: string;
  readonly operator: string;
  readonly purpose: CrawlerPurpose;
  readonly userAgent: string;
}

export const browserAgent: ProbeAgent = {
  name: 'Chrome (mobile)',
  token: '*',
  operator: 'browser',
  purpose: 'baseline',
  userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

export const googlebotSmartphone: ProbeAgent = {
  name: 'Googlebot Smartphone',
  token: 'googlebot',
  operator: 'Google',
  purpose: 'search',
  userAgent: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

/** Agents whose access decides visibility in search and AI answers; the home page is probed with each. */
export const probeAgents: readonly ProbeAgent[] = [
  googlebotSmartphone,
  { name: 'Bingbot', token: 'bingbot', operator: 'Microsoft', purpose: 'search',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/141.0.0.0 Safari/537.36' },
  { name: 'OAI-SearchBot', token: 'oai-searchbot', operator: 'OpenAI', purpose: 'search',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot' },
  { name: 'ChatGPT-User', token: 'chatgpt-user', operator: 'OpenAI', purpose: 'user-triggered',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
  { name: 'Claude-SearchBot', token: 'claude-searchbot', operator: 'Anthropic', purpose: 'search',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)' },
  { name: 'Claude-User', token: 'claude-user', operator: 'Anthropic', purpose: 'user-triggered',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://www.anthropic.com)' },
  { name: 'PerplexityBot', token: 'perplexitybot', operator: 'Perplexity', purpose: 'search',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
  { name: 'Applebot', token: 'applebot', operator: 'Apple', purpose: 'search',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)' },
  browserAgent,
];
