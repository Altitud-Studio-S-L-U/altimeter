import { dropLine, page, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-noindex-blocked',
  summary: 'A noindex legal notice that robots.txt also disallows, with indexifembedded, noarchive, an older year in its title and no meta description, and well-formed business identifiers.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.robots = `User-agent: *\nDisallow: /en/legal/\n\nSitemap: ${site.url('/sitemap-index.xml')}\n`;
    for (const studioPage of site.pages.values()) {
      Object.assign(studioPage.graph[0]!, { vatID: 'ESB12345678', telephone: '+34 960 123 456', email: 'hola@vellora.example' });
    }
    const legal = page(site, '/en/legal/');
    legal.robots = 'noindex, follow, indexifembedded, noarchive';
    legal.title = 'Legal notice 2024 | Vellora Studio';
    legal.h1 = 'Legal notice, updated in 2026';
    transform(legal, html => dropLine(html, '<meta name="description"'));
    return served(site, '/en/legal/');
  },
  mustFail: [
    { rule: 'crawl-noindex-blocked-by-robots', severity: 'high', page: '/en/legal/' },
  ],
  mustNotFail: [
    { rule: 'crawl-indexifembedded', page: '/en/legal/' },
    { rule: 'content-meta-description-missing', page: '/en/legal/' },
    { rule: 'content-title-obsolete-year', page: '/en/legal/' },
    { rule: 'ai-bing-noarchive-nocache', page: '/en/legal/', outcome: 'not_applicable' },
    'schema-organization-identifiers',
  ],
});
