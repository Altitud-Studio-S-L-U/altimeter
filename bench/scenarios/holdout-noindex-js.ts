import { png } from '../support/assets.ts';
import { dropLine, page, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-noindex-js',
  summary: 'A page whose noindex is removed by JavaScript, which also adds the only canonical, prefixes an unread counter to the title and marks a block data-nosnippet; a noscript pixel.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.routes.set('/analytics/pixel.png', site.file('image/png', png(1, 1)));
    const about = page(site, '/en/about/');
    about.robots = 'noindex, follow';
    about.head = `<script>
document.querySelector('meta[name="robots"]').setAttribute('content', 'index, follow');
document.title = '(3) ' + document.title;
const canonical = document.createElement('link');
canonical.rel = 'canonical';
canonical.href = ${JSON.stringify(site.url('/en/about/'))};
document.head.append(canonical);
document.addEventListener('DOMContentLoaded', () => document.getElementById('estimate-note')?.setAttribute('data-nosnippet', ''));
</script>`;
    about.body += `
<div id="estimate-note"><p>Every estimate is free and comes with a written scope, a schedule and the names of the engineers who would do the work.</p></div>
<noscript><img src="/analytics/pixel.png?nojs=1" width="1" height="1" alt=""></noscript>`;
    transform(about, html => dropLine(html, '<link rel="canonical"'));
    return served(site, '/en/about/');
  },
  mustFail: [
    { rule: 'crawl-noindex-raw-vs-rendered', severity: 'critical', page: '/en/about/' },
    { rule: 'crawl-canonical-js-changed', severity: 'low', page: '/en/about/' },
    { rule: 'content-data-nosnippet-invalid', severity: 'low', page: '/en/about/' },
  ],
  mustNotFail: [
    { rule: 'content-title-raw-rendered-mismatch', page: '/en/about/' },
    { rule: 'tech-noscript-content', page: '/en/about/' },
  ],
});
