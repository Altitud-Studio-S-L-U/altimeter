import { byUserAgent, page, refuse, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-ai-robots-named',
  summary: 'Named robots.txt groups that keep AI crawlers out of training, a legacy token, AI search agents refused at the edge and a dateModified stamped per request.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.robots = [
      'User-agent: *', 'Allow: /', '',
      'User-agent: GPTBot', 'Disallow: /', '',
      'User-agent: ClaudeBot', 'Disallow: /', '',
      'User-agent: Claude-User', 'Disallow: /', '',
      'User-agent: Google-Extended', 'Disallow: /', '',
      'User-agent: CCBot', 'User-agent: Bytespider', 'Disallow: /', '',
      'User-agent: Applebot-Extended', 'Disallow: /', '',
      'User-agent: Amazonbot', 'Disallow: /', '',
      'User-agent: meta-externalagent', 'Disallow: /', '',
      'User-agent: MistralAI-Training', 'Disallow: /', '',
      'User-agent: Perplexity', 'Disallow: /', '',
      `Sitemap: ${site.url('/sitemap-index.xml')}`, '',
    ].join('\n');
    const home = page(site, '/en/');
    Object.assign(home.graph[3]!, { dateModified: '__NOW__' });
    let last = 0;
    transform(home, html => html.replace('"__NOW__"', () => {
      last = Math.max(Date.now(), last + 1);
      return JSON.stringify(new Date(last).toISOString());
    }));
    return served(site, '/en/', apex => byUserAgent(apex, [
      [/OAI-SearchBot/iu, refuse(403, {}, 'Access denied')],
      [/Claude-SearchBot/iu, refuse(402, { 'crawler-price': 'USD 0.01' }, 'Payment required')],
    ]));
  },
  mustFail: [
    { rule: 'ai-robots-gptbot', severity: 'info' },
    { rule: 'ai-robots-claudebot', severity: 'info' },
    { rule: 'ai-robots-claude-user', severity: 'info' },
    { rule: 'ai-robots-meta', severity: 'info' },
    { rule: 'ai-robots-mistral', severity: 'info' },
    { rule: 'ai-robots-legacy-tokens', severity: 'low' },
    { rule: 'ai-edge-ua-block-probe', severity: 'low' },
    { rule: 'ai-pay-per-crawl-402', severity: 'medium' },
    { rule: 'content-date-manipulation', severity: 'medium' },
  ],
  mustNotFail: [
    'ai-robots-duckassistbot',
    'crawl-dynamic-rendering',
  ],
});
