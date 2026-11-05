import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'studio-root',
  summary: 'The bare root: a 302 locale entry point (private, no-store, Vary: Cookie) that ignores Accept-Language, with x-default on /en/.',
  hosts: studioHosts,
  build: context => studioSite(context, '/'),
  mustFail: [],
  mustNotFail: [
    // An intentional, uncached locale entry point is not a homepage redirect problem.
    'intl-root-locale-redirector', 'intl-auto-redirect-by-language', 'intl-localized-urls-unreachable', 'intl-locale-adaptive-same-url',
    { rule: 'crawl-redirect-type', page: '/' }, { rule: 'perf-document-redirects', page: '/' }, { rule: 'crawl-status-final', page: '/' },
    { rule: 'crawl-redirect-chain', page: '/' }, 'content-sneaky-redirects', 'crawl-redirect-to-home',
    // x-default points to /en/ rather than the root, and Organization.url and WebSite.url name the redirecting root.
    'intl-hreflang-x-default-missing', 'intl-hreflang-x-default-inconsistent', 'intl-hreflang-target-not-200',
    'schema-site-name-website', { rule: 'schema-url-values', page: '/' }, 'schema-entity-consistency-sitewide',
    { rule: 'tech-social-og-url-canonical', page: '/' }, { rule: 'crawl-canonical-presence', page: '/' }, { rule: 'crawl-canonical-target-health', page: '/' },
    // The redirect is private and no-store, so Vary: Cookie without a country header cannot poison a shared cache.
    { rule: 'perf-html-no-store', page: '/' }, 'crawl-internal-links-broken-redirected', 'tech-http-to-https-redirect',
  ],
});
