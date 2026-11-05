import { page, served } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-robots-directives',
  summary: 'robots.txt with noindex and crawl-delay lines, a Googlebot group that drops the crawl-trap rules of *, a blocked analytics script and the Spanish services blocked for Googlebot.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.robots = [
      'User-agent: *', 'Disallow: /search', 'Disallow: /cart/', 'Crawl-delay: 5', 'Noindex: /en/legal/', '',
      'User-agent: Googlebot', 'Allow: /', 'Disallow: /analytics/', 'Disallow: /es/servicios/', '',
      'User-agent: GPTBot', 'User-agent: GPT-Bot', 'Allow: /', '',
      `Sitemap: ${site.url('/sitemap-index.xml')}`, '',
    ].join('\n');
    site.routes.set('/analytics/collect.js', site.file('text/javascript; charset=utf-8', "window.dataLayer = window.dataLayer || [];\nwindow.dataLayer.push({ event: 'page_view' });\n"));
    page(site, '/en/services/custom-software/').head = '<script src="/analytics/collect.js" async></script>';
    return served(site, '/en/services/custom-software/');
  },
  mustFail: [
    { rule: 'crawl-robots-unsupported-directives', severity: 'high' },
    { rule: 'crawl-robots-group-override', severity: 'medium' },
    { rule: 'crawl-bing-crawl-delay', severity: 'info' },
    { rule: 'intl-hreflang-target-blocked-by-robots' },
  ],
  mustNotFail: [
    'ai-robots-legacy-tokens',
    'ai-robots-gptbot',
    'crawl-robots-fetch-status',
    { rule: 'crawl-robots-blocks-render-resources', page: '/en/services/custom-software/' },
  ],
});
