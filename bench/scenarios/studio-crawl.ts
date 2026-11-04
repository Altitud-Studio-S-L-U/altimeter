import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const legal = ['/en/legal/', '/en/privacy/', '/es/aviso-legal/', '/es/privacidad/'];

export default defineScenario({
  name: 'studio-crawl',
  summary: 'A crawl of the studio: noindex, follow legal pages in the footer and out of the sitemap, a short About page and one shared OG image.',
  hosts: studioHosts,
  options: { crawl: true, maxPages: 30 },
  build: context => studioSite(context, '/en/'),
  mustFail: [
    { rule: 'schema-breadcrumb', severity: 'low', reason: 'name-with-site-name', page: '/es/servicios/software-a-medida/' },
  ],
  mustNotFail: [
    // Legal pages: noindex, follow on purpose, linked from the footer and left out of the sitemap.
    ...legal.map(page => ({ rule: 'crawl-meta-robots-noindex', page })), 'crawl-sitemap-url-quality', 'crawl-internal-links-broken-redirected',
    ...legal.map(page => ({ rule: 'crawl-page-nofollow', page })), 'intl-hreflang-target-noindex', 'crawl-canonical-signal-consistency',
    // The About page fulfils its purpose with a few hundred words; Google sets no minimum.
    'content-boilerplate-ratio', { rule: 'content-originality', page: '/en/about/' }, 'content-scaled-doorway', 'content-trust-pages',
    // Home, About and Open Source share one Open Graph image, which is not duplicate content.
    { rule: 'tech-social-og-image', page: '/en/about/' }, { rule: 'tech-social-og-image', page: '/en/' }, 'crawl-duplicate-clusters',
    'content-title-duplicate', 'content-meta-description-duplicate', 'content-title-boilerplate',
    // The same decorative images appear on both home pages and in two sections of each.
    'content-img-filename',
    // Two locales that mirror each other, with reciprocal hreflang.
    'intl-hreflang-missing-return-link', 'intl-hreflang-cluster-inconsistent-sets', 'intl-untranslated-variant', 'schema-entity-consistency-sitewide',
    { rule: 'intl-html-lang-vs-content', page: '/es/sobre-nosotros/' }, { rule: 'intl-hreflang-value-vs-content-language', page: '/es/sobre-nosotros/' },
  ],
});
