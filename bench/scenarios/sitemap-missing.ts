import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'sitemap-missing',
  summary: 'The real problem behind the /sitemap.xml trap: no sitemap declared in robots.txt or the HTML, and nothing at the default location.',
  hosts: studioHosts,
  build: context => studioSite(context, '/en/', {}, site => {
    site.robots = 'User-agent: *\nAllow: /\n';
    for (const page of site.pages.values()) page.transform = html => html.replace('<link rel="sitemap" href="/sitemap-index.xml">\n', '');
  }),
  mustFail: [
    { rule: 'crawl-robots-sitemap-lines', severity: 'low', reason: 'no-sitemap' },
  ],
  mustNotFail: [
    'crawl-robots-parse-errors', 'crawl-robots-blocks-site',
  ],
});
