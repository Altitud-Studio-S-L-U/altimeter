import { png } from '../support/assets.ts';
import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/';

export default defineScenario({
  name: 'media-problems',
  summary: 'The real problems behind the SVG-logo and shared-OG-image traps: an Organization logo that answers 404 and an og:image smaller than its declared size.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    for (const entry of site.pages.values()) {
      const organization = entry.graph.find(node => node['@type'] === 'Organization')!;
      organization.logo = `${site.origin}/images/logo-2019.png`;
    }
    site.pages.get(page)!.ogImage = '/images/og-small.png';
    site.routes.set('/images/og-small.png', site.file('image/png', png(600, 315)));
  }),
  mustFail: [
    { rule: 'schema-organization-logo', severity: 'medium', reason: 'not-200' },
    { rule: 'tech-social-og-image-meta', severity: 'low', reason: 'dimension-mismatch', page },
    { rule: 'tech-social-og-image', severity: 'info', reason: 'below-recommended', page },
  ],
  mustNotFail: [
    { rule: 'tech-social-og-required', page },
  ],
});
