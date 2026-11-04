import { page, served, siteNodes, webPage } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-hreflang-regional',
  summary: 'An English home declared as EN, en-GB and en-US, the Spanish home, x-default, and a page for US clients declared with the country code us.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    const home = page(site, '/en/');
    const title = 'Vellora Studio | Software engineering for US teams';
    site.pages.set('/us/', {
      ...home, path: '/us/', title,
      description: 'Engineering studio in Valencia working with US companies across time zones on custom software, data platforms and automation.',
      h1: 'Custom software and data for US companies',
      lead: 'We work with product and operations teams in the United States, with overlapping hours every afternoon and contracts in US dollars.',
      graph: [...siteNodes(site), webPage(site, '/us/', title)],
    });
    const links = [['EN', '/en/'], ['en-GB', '/en/'], ['en-US', '/en/'], ['es', '/es/'], ['us', '/us/'], ['x-default', '/en/']]
      .map(([lang, target]) => `<link rel="alternate" hreflang="${lang}" href="${site.url(target!)}">`).join('\n');
    for (const path of ['/en/', '/es/', '/us/']) {
      const target = page(site, path);
      target.alternates = {};
      target.head = links;
    }
    return served(site, '/en/');
  },
  mustFail: [
    { rule: 'intl-hreflang-region-only-value', page: '/en/' },
  ],
  mustNotFail: [
    { rule: 'intl-hreflang-invalid-language-code', page: '/en/' },
    { rule: 'intl-hreflang-invalid-region-code', page: '/en/' },
    { rule: 'intl-hreflang-invalid-script-or-syntax', page: '/en/' },
    { rule: 'intl-hreflang-one-url-many-languages', page: '/en/' },
    'intl-hreflang-duplicate-locale-in-cluster',
    'intl-hreflang-no-language-catchall',
  ],
});
