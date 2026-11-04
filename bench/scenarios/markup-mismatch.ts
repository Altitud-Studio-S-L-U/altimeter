import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/services/custom-software/';

export default defineScenario({
  name: 'markup-mismatch',
  summary: 'The real problems behind the FAQPage and SearchAction traps: a marked-up price the page never shows, and the retired SearchAction.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    for (const entry of site.pages.values()) {
      const website = entry.graph.find(node => node['@type'] === 'WebSite')!;
      website.potentialAction = { '@type': 'SearchAction', target: `${site.origin}/search?q={search_term_string}`, 'query-input': 'required name=search_term_string' };
    }
    const service = site.pages.get(page)!.graph.find(node => node['@type'] === 'Service')!;
    service.offers = { '@type': 'Offer', price: '4900', priceCurrency: 'EUR' };
  }),
  mustFail: [
    { rule: 'schema-visible-content-parity', severity: 'medium', reason: 'value-not-on-page', page },
    { rule: 'schema-sitelinks-searchbox-obsolete', severity: 'info', reason: 'present' },
  ],
  mustNotFail: [
    // The markup is still valid JSON-LD with known schema.org terms.
    { rule: 'schema-jsonld-syntax-error', page }, { rule: 'schema-unknown-property', page },
  ],
});
