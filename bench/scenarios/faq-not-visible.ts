import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'faq-not-visible',
  summary: 'The real problem behind the FAQPage trap: FAQPage markup for questions the page no longer shows.',
  hosts: studioHosts,
  build: context => studioSite(context, '/en/', {}, site => {
    const home = site.pages.get('/en/')!;
    home.body = home.body.replace(/<section class="faq"[\s\S]*?<\/section>\n/u, '');
  }),
  mustFail: [
    { rule: 'schema-visible-content-parity', reason: 'question-not-on-page', page: '/en/' },
    // Still information, never an error.
    { rule: 'schema-faqpage-retired', severity: 'info', page: '/en/' },
  ],
  mustNotFail: [
    { rule: 'schema-jsonld-syntax-error', page: '/en/' },
  ],
});
