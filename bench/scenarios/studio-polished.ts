import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/services/custom-software/';

export default defineScenario({
  name: 'studio-polished',
  summary: 'The studio with its expected findings fixed: 301 normalisation, lastmod, Organization.sameAs, short breadcrumb names and a hashed CSP.',
  hosts: studioHosts,
  build: context => studioSite(context, page, { slashRedirect: 301, lastmod: true, sameAs: true, breadcrumbNames: 'label', hashedCsp: true, twitterSite: true }),
  mustFail: [],
  mustNotFail: [
    'crawl-host-variant-consolidation', 'crawl-sitemap-lastmod', 'schema-organization', { rule: 'schema-breadcrumb', page },
    'tech-security-headers-info', { rule: 'crawl-redirect-type', page },
    // The hashed script-src still lets the one inline script run.
    { rule: 'tech-console-errors', page }, { rule: 'tech-failed-render-requests', page },
  ],
});
