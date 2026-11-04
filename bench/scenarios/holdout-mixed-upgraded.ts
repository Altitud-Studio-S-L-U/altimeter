import { htmlDocument, htmlResponse, page, replaceOnce, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

const cards = ['Discovery', 'Prototype', 'Delivery', 'Support', 'Handover', 'Training']
  .map(step => `<article style="flex:0 0 280px"><h3>${step}</h3><p>What happens during the ${step.toLowerCase()} phase of a project, and what you receive at the end of it.</p></article>`).join('\n');

export default defineScenario({
  name: 'holdout-mixed-upgraded',
  summary: 'The same http script and image behind upgrade-insecure-requests, an external http link, a relative canonical, a scrolling carousel, speculation rules, a titled iframe and a form declared as a WebMCP tool.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    const insecure = context.origin('http://vellora.example');
    const path = '/en/services/custom-software/';
    const service = page(site, path);
    service.head = `<script src="${insecure}/assets/widget.js" defer></script>
<script type="speculationrules">${JSON.stringify({ prefetch: [{ source: 'list', urls: ['/en/about/', '/en/open-source/'] }] })}</script>`;
    service.body += `
<section>
<h2>How a project runs</h2>
<div style="overflow-x:auto"><div style="display:flex;gap:1rem;width:1800px">
${cards}
</div></div>
<img src="${insecure}/images/team/founder.png" alt="Marta Ferrer reviewing a release plan" width="640" height="640">
<p>Our 2019 benchmark of hosting costs is still online in the <a href="http://archive.vellora-partners.example/hosting-costs-2019">partners' archive</a>.</p>
<iframe src="/en/embed/case-study/" title="Case study: booking portal for dental clinics" width="100%" height="320"></iframe>
<form method="POST" action="/api/estimate" toolname="request_estimate" tooldescription="Ask Vellora Studio for a project estimate">
<label for="estimate-email">Email</label><input id="estimate-email" name="email" type="email" autocomplete="email" required>
<button type="submit">Request an estimate</button>
</form>
</section>`;
    site.routes.set('/assets/widget.js', site.file('text/javascript; charset=utf-8', "document.documentElement.dataset.widget = 'ready';\n"));
    site.routes.set('/en/embed/case-study/', htmlResponse(htmlDocument({
      lang: 'en', title: 'Case study: booking portal', robots: 'noindex',
      body: '<main><h1>Booking portal for a network of dental clinics</h1><p>Patients book and move appointments online, and each clinic sees its own calendar.</p></main>',
    })));
    transform(service, html => {
      const canonical = replaceOnce(html, `<link rel="canonical" href="${site.url(path)}">`, `<link rel="canonical" href="${path}">`);
      return replaceOnce(canonical, 'content="width=device-width, initial-scale=1"', 'content="width=device-width"');
    });
    return served(site, path);
  },
  mustFail: [
    { rule: 'crawl-canonical-format', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'ai-webmcp-context', severity: 'info', page: '/en/services/custom-software/' },
  ],
  mustNotFail: [
    { rule: 'tech-mixed-content-active', page: '/en/services/custom-software/' },
    { rule: 'tech-mixed-content-passive', page: '/en/services/custom-software/' },
    'tech-internal-links-to-http',
    { rule: 'tech-viewport-meta', page: '/en/services/custom-software/' },
    { rule: 'tech-content-fits-viewport', page: '/en/services/custom-software/' },
    'crawl-js-fragment-routing',
    { rule: 'perf-speculation-rules', page: '/en/services/custom-software/' },
    { rule: 'tech-iframe-main-content', page: '/en/services/custom-software/' },
    { rule: 'ai-hidden-llm-instructions', page: '/en/services/custom-software/' },
  ],
});
