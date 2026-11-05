import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/services/custom-software/';

export default defineScenario({
  name: 'js-only-content',
  summary: 'The real problem behind the "visible without JavaScript" trap: a service page whose heading and text exist only after a script runs.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    const service = site.pages.get(page)!;
    const markup = `<section class="hero"><h1>${service.h1}</h1><p class="lead">${service.lead}</p>${service.hero}</section>\n${service.body}`;
    service.head = `<script type="module">document.getElementById('content').innerHTML = ${JSON.stringify(markup)};</script>`;
    service.h1 = '';
    service.lead = '';
    service.hero = '';
    service.body = '';
  }),
  mustFail: [
    { rule: 'ai-js-only-content', severity: 'high', page },
    { rule: 'crawl-js-content-dependency', page },
  ],
  mustNotFail: [
    // The rendered page has its heading, so Google sees one.
    { rule: 'content-h1-missing', page },
  ],
});
