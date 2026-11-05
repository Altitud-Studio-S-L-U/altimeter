import { png } from '../support/assets.ts';
import { insertAfter, page, replaceOnce, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

const related = Array.from({ length: 10 }, () => '<li><a href="/en/services/custom-software/">custom software in Valencia</a></li>').join('\n');

export default defineScenario({
  name: 'holdout-head-pixel',
  summary: 'A tracking pixel in the head before the canonical and hreflang, a 10px theme, a 900px table, zoom capped at 3x, an icon-only link and one anchor repeated ten times.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.routes.set('/images/px.png', site.file('image/png', png(1, 1)));
    const openSource = page(site, '/en/open-source/');
    openSource.head = '<style>body, body * {font-size:10px !important}</style>';
    openSource.body += `
<section>
<h2>Release history</h2>
<table style="width:900px"><thead><tr><th>Project</th><th>Version</th><th>Released</th><th>Licence</th><th>Downloads per month</th></tr></thead>
<tbody><tr><td>sheet-import</td><td>2.4.0</td><td>September 2026</td><td>MIT</td><td>18,000</td></tr>
<tr><td>queue-lite</td><td>1.9.2</td><td>August 2026</td><td>Apache 2.0</td><td>6,500</td></tr>
<tr><td>fixture-kit</td><td>0.8.1</td><td>July 2026</td><td>MIT</td><td>2,300</td></tr></tbody></table>
<p>Questions about a release? <a href="/en/about/" class="icon-link"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M2 8h12M9 3l5 5-5 5" stroke="currentColor" fill="none"/></svg></a></p>
</section>
<section>
<h2>Related services</h2>
<ul>
${related}
</ul>
</section>`;
    transform(openSource, html => {
      const pixel = insertAfter(html, '<meta name="robots" content="index, follow">', '\n<img src="/images/px.png" alt="" width="1" height="1">');
      return replaceOnce(pixel, 'content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, maximum-scale=3"');
    });
    return served(site, '/en/open-source/');
  },
  mustFail: [
    { rule: 'crawl-head-invalid-element', severity: 'high', page: '/en/open-source/' },
    { rule: 'intl-hreflang-outside-head', page: '/en/open-source/' },
    { rule: 'tech-viewport-zoom-allowed', severity: 'info', page: '/en/open-source/' },
    { rule: 'tech-content-fits-viewport', page: '/en/open-source/' },
    { rule: 'tech-legible-font-size', severity: 'low', page: '/en/open-source/' },
    { rule: 'content-anchor-text-empty', severity: 'medium', page: '/en/open-source/' },
    { rule: 'content-anchor-text-quality', severity: 'low', page: '/en/open-source/' },
  ],
  mustNotFail: [
    { rule: 'crawl-canonical-ignored-attributes-placement', page: '/en/open-source/' },
    { rule: 'content-title-missing', page: '/en/open-source/' },
    'content-outbound-citations',
  ],
});
