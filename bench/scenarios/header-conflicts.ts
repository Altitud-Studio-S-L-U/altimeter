import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/about/';

export default defineScenario({
  name: 'header-conflicts',
  summary: 'The real problems behind the missing-headers trap: headers that are present and wrong, a Spanish Content-Language, a Link hreflang without the page and an X-Robots-Tag noindex.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    site.pages.get(page)!.headers = {
      'content-language': 'es',
      link: `<${site.url('/es/sobre-nosotros/')}>; rel="alternate"; hreflang="es"`,
      'x-robots-tag': 'noindex',
    };
  }),
  mustFail: [
    { rule: 'intl-content-language-signal-conflict', severity: 'low', reason: 'conflicts-with-lang', page },
    { rule: 'intl-hreflang-http-header-format', severity: 'low', reason: 'missing-self', page },
    { rule: 'crawl-meta-robots-noindex', severity: 'critical', page },
  ],
  mustNotFail: [
    // The meta robots tag of the page is fine; the header is the problem.
    { rule: 'crawl-robots-directive-validity', page },
  ],
});
