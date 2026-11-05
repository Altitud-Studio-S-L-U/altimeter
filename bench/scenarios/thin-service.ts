import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const stub = '/en/services/data-platforms/';

export default defineScenario({
  name: 'thin-service',
  summary: 'The real problem behind the short About page trap: a service page with a two-line stub of its own text inside the full template.',
  hosts: studioHosts,
  options: { crawl: true, maxPages: 30 },
  build: context => studioSite(context, '/en/', {}, site => {
    const template = site.pages.get('/en/services/custom-software/')!;
    site.pages.set(stub, {
      ...template,
      path: stub,
      title: 'Data platforms in Valencia | Vellora Studio',
      description: 'Data platforms built by Vellora Studio in Valencia.',
      label: 'Data platforms',
      h1: 'Data platforms',
      lead: 'We build data platforms. Contact us to learn more.',
      hero: '',
      body: '',
      alternates: {},
      graph: template.graph.filter(node => ['Organization', 'Person', 'WebSite'].includes(String(node['@type']))),
    });
    const home = site.pages.get('/en/')!;
    home.body = home.body.replace('<h3>Data platforms</h3>', `<h3><a href="${stub}">Data platforms</a></h3>`);
  }),
  mustFail: [
    { rule: 'content-boilerplate-ratio', severity: 'medium' },
  ],
  mustNotFail: [
    { rule: 'crawl-meta-robots-noindex', page: stub },
  ],
});
