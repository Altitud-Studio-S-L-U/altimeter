import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'ai-crawlers-blocked',
  summary: 'The real problem behind the AI-crawler policy trap: a wildcard group that blocks every AI search crawler while only Googlebot and Bingbot are allowed.',
  hosts: studioHosts,
  build: context => studioSite(context, '/en/', {}, site => {
    site.robots = `User-agent: Googlebot\nAllow: /\n\nUser-agent: Bingbot\nAllow: /\n\nUser-agent: *\nDisallow: /\n\nSitemap: ${site.url('/sitemap-index.xml')}\n`;
  }),
  mustFail: [
    { rule: 'ai-robots-wildcard-disallow-all', severity: 'medium' },
    { rule: 'ai-robots-oai-searchbot', severity: 'low', reason: 'blocked-by-inheritance' },
    { rule: 'ai-robots-claude-searchbot', severity: 'low', reason: 'blocked-by-inheritance' },
    { rule: 'ai-robots-perplexitybot', severity: 'low', reason: 'blocked-by-inheritance' },
    { rule: 'ai-llms-txt', severity: 'info', reason: 'disallowed-links' },
  ],
  mustNotFail: [
    // Googlebot and Bingbot keep their own groups, so Search crawling is untouched.
    'crawl-robots-blocks-site', { rule: 'crawl-robots-blocks-page', page: '/en/' }, 'crawl-robots-parse-errors',
  ],
});
