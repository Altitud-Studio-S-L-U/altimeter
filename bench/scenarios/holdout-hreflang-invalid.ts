import { page, replaceOnce, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-hreflang-invalid',
  summary: 'hreflang values a CMS plugin wrote by hand: a three-letter language, a numeric region, an underscore, a root-relative href, de twice in two cases and one URL for two languages; a canonical with a fragment.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    const path = '/en/services/custom-software/';
    const service = page(site, path);
    service.alternates = {};
    const links: (readonly [string, string])[] = [
      ['en', site.url(path)],
      ['es', '/es/servicios/software-a-medida/'],
      ['fil', site.url('/fil/services/custom-software/')],
      ['es-419', site.url('/es-419/servicios/software-a-medida/')],
      ['pt_BR', site.url('/pt-br/servicos/software-sob-medida/')],
      ['de', site.url('/de/leistungen/individualsoftware/')],
      ['DE', site.url('/de/leistungen/software-entwicklung/')],
      ['fr', site.url('/fr/services/logiciel-sur-mesure/')],
      ['ca', site.url('/fr/services/logiciel-sur-mesure/')],
      ['x-default', site.url(path)],
    ];
    service.head = links.map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${href}">`).join('\n');
    transform(service, html => replaceOnce(html, `<link rel="canonical" href="${site.url(path)}">`, `<link rel="canonical" href="${site.url(path)}#overview">`));
    return served(site, path);
  },
  mustFail: [
    { rule: 'intl-hreflang-invalid-language-code', page: '/en/services/custom-software/' },
    { rule: 'intl-hreflang-invalid-region-code', page: '/en/services/custom-software/' },
    { rule: 'intl-hreflang-invalid-script-or-syntax', page: '/en/services/custom-software/' },
    { rule: 'intl-hreflang-relative-url', page: '/en/services/custom-software/' },
    { rule: 'intl-hreflang-duplicate-locale-in-cluster' },
    { rule: 'intl-hreflang-one-url-many-languages', page: '/en/services/custom-software/' },
    { rule: 'crawl-canonical-format', severity: 'medium', page: '/en/services/custom-software/' },
  ],
  mustNotFail: [],
});
