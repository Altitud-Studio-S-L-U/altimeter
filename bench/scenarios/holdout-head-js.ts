import { dropLine, page, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-head-js',
  summary: 'A head manager script that sets the title, changes the canonical and adds hreflang and a BreadcrumbList, with the stylesheet blocked for Googlebot, geo meta tags, an unload listener and a font preload without crossorigin.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.robots = `User-agent: *\nDisallow: /assets/\n\nSitemap: ${site.url('/sitemap-index.xml')}\n`;
    site.routes.set('/fonts/inter-var.woff2', site.file('font/woff2', Buffer.from('d09GMgABAAAAAA', 'base64'), 'public, max-age=31536000, immutable'));
    const path = '/en/services/custom-software/';
    const service = page(site, path);
    const breadcrumb = service.graph.find(node => node['@type'] === 'BreadcrumbList')!;
    service.graph = service.graph.filter(node => node !== breadcrumb);
    delete service.graph.find(node => node['@type'] === 'WebPage')!.breadcrumb;
    service.alternates = {};
    const alternates = [['en', path], ['es', '/es/servicios/software-a-medida/'], ['x-default', path]];
    service.head = `<meta name="geo.region" content="ES-V">
<meta name="geo.placename" content="Valencia">
<link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2">
<script>
document.title = 'Custom software development in Valencia | Vellora Studio';
document.querySelector('link[rel="canonical"]').href = ${JSON.stringify(site.url('/en/custom-software/'))};
for (const [lang, href] of ${JSON.stringify(alternates.map(([lang, target]) => [lang, site.url(target!)]))}) {
  const link = document.createElement('link');
  link.rel = 'alternate';
  link.hreflang = lang;
  link.href = href;
  document.head.append(link);
}
const crumbs = document.createElement('script');
crumbs.type = 'application/ld+json';
crumbs.textContent = ${JSON.stringify(JSON.stringify({ '@context': 'https://schema.org', ...breadcrumb }))};
document.head.append(crumbs);
window.addEventListener('unload', () => sessionStorage.setItem('left', String(Date.now())));
</script>`;
    service.afterMain = '<main hidden><h2>Previous layout</h2><p>Kept for the comparison view.</p></main>';
    transform(service, html => dropLine(html, '<title>'));
    return served(site, path);
  },
  mustFail: [
    { rule: 'content-title-raw-rendered-mismatch', severity: 'medium', page: '/en/services/custom-software/' },
    { rule: 'crawl-canonical-js-changed', severity: 'high', page: '/en/services/custom-software/' },
    { rule: 'intl-hreflang-rendered-only', page: '/en/services/custom-software/' },
    { rule: 'schema-js-only-markup', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'crawl-robots-blocks-render-resources', severity: 'high', page: '/en/services/custom-software/' },
    { rule: 'intl-geo-meta-tags-ignored', severity: 'info', page: '/en/services/custom-software/' },
    { rule: 'perf-unload-handlers', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'perf-font-preload-crossorigin', severity: 'low', page: '/en/services/custom-software/' },
  ],
  mustNotFail: [
    { rule: 'content-title-missing', page: '/en/services/custom-software/' },
    { rule: 'crawl-canonical-multiple', page: '/en/services/custom-software/' },
    { rule: 'content-main-landmark', page: '/en/services/custom-software/' },
  ],
});
