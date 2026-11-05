import { htmlDocument, htmlResponse, page, replaceOnce, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-mixed-content',
  summary: 'An HTTPS page without upgrade-insecure-requests that loads a script and an image over http, links, canonicalises and declares hreflang to http URLs, and frames a case study without a title.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    const insecure = context.origin('http://vellora.example');
    const path = '/en/services/custom-software/';
    const service = page(site, path);
    service.headers = { 'content-security-policy': site.pageHeaders['content-security-policy']!.replace('; upgrade-insecure-requests', '') };
    service.alternates = {};
    service.head = `<link rel="preconnect dns-prefetch" href="${site.origin}">
<script src="${insecure}/assets/widget.js" defer></script>
<link rel="alternate" hreflang="en" href="${site.url(path)}">
<link rel="alternate" hreflang="es" href="${insecure}/es/servicios/software-a-medida/">
<link rel="alternate" hreflang="x-default" href="${site.url(path)}">`;
    service.body += `
<section>
<h2>A recent project</h2>
<img src="${insecure}/images/team/founder.png" alt="Marta Ferrer reviewing a release plan" width="640" height="640">
<p>Read the case study below, or learn more <a href="${insecure}/en/about/">about the studio</a>.</p>
<iframe src="/en/embed/case-study/" width="100%" height="320"></iframe>
</section>`;
    site.routes.set('/assets/widget.js', site.file('text/javascript; charset=utf-8', "document.documentElement.dataset.widget = 'ready';\n"));
    site.routes.set('/en/embed/case-study/', htmlResponse(htmlDocument({
      lang: 'en', title: 'Case study: booking portal', robots: 'noindex',
      body: '<main><h1>Booking portal for a network of dental clinics</h1><p>Patients book and move appointments online, and each clinic sees its own calendar.</p></main>',
    })));
    transform(service, html => replaceOnce(html, `<link rel="canonical" href="${site.url(path)}">`, `<link rel="canonical" href="${insecure}${path}">`));
    return served(site, path);
  },
  mustFail: [
    { rule: 'tech-mixed-content-active', severity: 'high', page: '/en/services/custom-software/' },
    { rule: 'tech-mixed-content-passive', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'tech-internal-links-to-http', severity: 'medium' },
    { rule: 'crawl-canonical-protocol-host', severity: 'high' },
    { rule: 'intl-hreflang-mixed-protocol-or-host' },
    { rule: 'perf-preconnect-hints', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'tech-iframe-main-content', severity: 'low', page: '/en/services/custom-software/' },
  ],
  mustNotFail: [
    { rule: 'ai-webmcp-context', page: '/en/services/custom-software/', outcome: 'not_applicable' },
  ],
});
