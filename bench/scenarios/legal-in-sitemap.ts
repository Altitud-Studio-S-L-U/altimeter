import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'legal-in-sitemap',
  summary: 'The real problems behind the noindex legal-page trap: noindex legal pages listed in the sitemap, and an About page left noindex by mistake.',
  hosts: studioHosts,
  options: { crawl: true, maxPages: 30 },
  build: context => studioSite(context, '/en/', {}, site => {
    for (const page of site.pages.values()) if (page.kind === 'legal' || page.kind === 'privacy') page.inSitemap = true;
    site.pages.get('/en/about/')!.robots = 'noindex, follow';
  }),
  mustFail: [
    { rule: 'crawl-sitemap-url-quality' },
    { rule: 'crawl-meta-robots-noindex', severity: 'critical', reason: 'conflict-sitemap', page: '/en/about/' },
  ],
  mustNotFail: [
    // A legal page stays a legal page: its noindex is still intended, the sitemap entry is the mistake.
    { rule: 'crawl-meta-robots-noindex', page: '/en/legal/' }, { rule: 'crawl-meta-robots-noindex', page: '/es/privacidad/' },
  ],
});
