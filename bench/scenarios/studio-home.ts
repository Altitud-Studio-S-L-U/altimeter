import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'studio-home',
  summary: 'The English home of the studio as the tuned site serves it: the traps in their correct form and the expected findings.',
  hosts: studioHosts,
  build: context => studioSite(context, '/en/'),
  mustFail: [
    // Expected findings of the tuned site.
    { rule: 'crawl-host-variant-consolidation', severity: 'low', reason: 'temporary-redirect' },
    { rule: 'crawl-sitemap-lastmod', severity: 'low', reason: 'missing' },
    { rule: 'schema-organization', severity: 'low', reason: 'missing-recommended' },
    { rule: 'tech-security-headers-info', severity: 'info',
      known: 'the inventory shows the CSP, but its thresholds flag only a broken nosniff value, not script-src \'unsafe-inline\'' },
    // Valid FAQPage markup is reported as information that the rich result is gone, never as an error.
    { rule: 'schema-faqpage-retired', severity: 'info', reason: 'present', page: '/en/' },
    { rule: 'ai-cdn-cloudflare-detected', severity: 'info', reason: 'cloudflare' },
  ],
  mustNotFail: [
    // Accept-Language is ignored by design: every language probe of /en/ gets the same page.
    'intl-auto-redirect-by-language', 'intl-locale-adaptive-same-url', 'intl-separate-urls-per-locale', 'intl-root-locale-redirector',
    'intl-localized-urls-unreachable', 'intl-hreflang-x-default-missing', 'intl-hreflang-x-default-inconsistent', 'intl-hreflang-missing-return-link',
    // /sitemap.xml answers 404 by design; the index is declared in robots.txt and in <link rel="sitemap">.
    'crawl-robots-sitemap-lines', 'crawl-sitemap-validity', 'crawl-sitemap-scope', 'crawl-sitemap-url-quality', 'intl-hreflang-sitemap-format',
    // FAQPage that matches the visible FAQ, and a WebSite without the retired SearchAction.
    'schema-visible-content-parity', 'schema-sitelinks-searchbox-obsolete', 'schema-site-name-website', 'schema-duplicate-feature-nodes',
    'schema-jsonld-syntax-error', 'schema-unknown-property', 'schema-feature-opportunity',
    // Decorative images with alt="" next to their text, shown twice, lazy-loaded with srcset.
    'content-img-alt-missing', 'content-img-alt-quality', 'content-img-lazy-misuse', 'content-img-filename', 'content-img-format',
    // Analytics injected only after consent, and a cookie banner whose headings sit outside <main>.
    'tech-consent-mode-ordering', 'tech-cmp-blocks-content', 'tech-intrusive-interstitial', 'content-heading-level-skips',
    // Sections at opacity 0 until scrolled into view by an IntersectionObserver; present in the HTML.
    'content-hidden-text', 'content-hidden-links', 'crawl-js-lazy-content', 'crawl-js-content-dependency', 'ai-js-only-content', 'content-filler-before-mc',
    // text/html without a charset, with <meta charset> first in the head.
    'tech-charset-declared-early',
    // max-age=0, must-revalidate with an ETag at a CDN edge: caching, not its absence.
    'perf-html-no-store', 'crawl-conditional-requests', 'perf-html-cdn',
    // An SVG Organization logo cannot be measured, which is not an invalid format.
    { rule: 'schema-organization-logo', outcome: 'not_evaluated' }, 'tech-favicon-file-valid', 'tech-favicon-declared',
    // robots.txt that allows everything without AI groups or Content-Signal lines, and an informational llms.txt.
    'ai-robots-wildcard-disallow-all', 'ai-robots-oai-searchbot', 'ai-robots-claude-searchbot', 'ai-robots-perplexitybot', 'ai-robots-policy-coherence',
    'ai-cdn-cloudflare-managed-robots', 'ai-content-signal-lines', 'ai-llms-txt', 'crawl-robots-blocks-site', 'crawl-robots-parse-errors',
    // No X-Robots-Tag, Content-Language or Link header.
    'intl-content-language-signal-conflict', 'intl-hreflang-http-header-format', 'crawl-robots-directives-conflict', 'intl-hreflang-source-conflict',
    // One h1 that joins a keyword line and a tagline.
    'content-h1-missing', 'content-h1-empty-or-image', 'content-title-h1-mismatch', 'tech-duplicate-conflicting-head-tags',
    // The shared Open Graph image.
    'tech-social-og-image', 'tech-social-og-image-meta', 'tech-social-og-required', 'content-preferred-image',
    // One hop from every scheme and host variant, HTTPS everywhere.
    'tech-http-to-https-redirect', 'tech-tls-certificate-valid', 'tech-https-final-url', 'tech-https-to-http-downgrade', 'crawl-status-final',
  ],
});
