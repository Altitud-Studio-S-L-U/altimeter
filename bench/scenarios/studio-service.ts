import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/services/custom-software/';

export default defineScenario({
  name: 'studio-service',
  summary: 'A service page: breadcrumb names that repeat the SEO title with the brand suffix, a Service node and an eager hero image.',
  hosts: studioHosts,
  build: context => studioSite(context, page),
  mustFail: [
    { rule: 'schema-breadcrumb', severity: 'low', reason: 'name-with-site-name', page },
  ],
  mustNotFail: [
    { rule: 'content-img-lazy-misuse', page }, { rule: 'content-img-alt-missing', page }, { rule: 'content-img-alt-quality', page },
    { rule: 'schema-service-offercatalog', page }, { rule: 'schema-main-entity-page-fit', page }, { rule: 'schema-url-values', page },
    { rule: 'intl-area-served-format', page }, { rule: 'schema-id-dangling-or-conflicting', page }, { rule: 'schema-domain-range-mismatch', page },
    { rule: 'content-title-width', page }, { rule: 'content-title-branding', page }, { rule: 'content-meta-description-quality', page },
    { rule: 'tech-social-og-image', page }, { rule: 'tech-social-og-url-canonical', page }, { rule: 'crawl-canonical-presence', page },
    { rule: 'intl-hreflang-missing-self-reference', page }, 'intl-hreflang-missing-return-link', 'intl-hreflang-cluster-inconsistent-sets',
  ],
});
