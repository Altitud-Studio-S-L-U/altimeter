import { png } from '../support/assets.ts';
import { day, page, served } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

const crux = 'crux.vellora.example';
const tools = ['typescript', 'node', 'python', 'postgres', 'docker', 'linux', 'git', 'grafana'];

// Chart helpers nobody calls any more, shipped unminified and uncompressed.
const charts = Array.from({ length: 700 }, (_, index) => `/**
 * Draws chart ${index} of the old reporting dashboard.
 * Kept for the reports that still use the previous layout.
 */
function drawChart${index}(canvas, rows) {
  const context = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  rows.forEach((row, position) => {
    const barHeight = (row.value / 100) * height;
    context.fillRect(position * 12, height - barHeight, 10, barHeight);
  });
  return rows.length;
}
`).join('\n');

function metric(bounds: readonly [number | string, number | string], densities: readonly [number, number, number], p75: number | string): Record<string, unknown> {
  const start = typeof bounds[0] === 'string' ? '0.00' : 0;
  return {
    histogram: [{ start, end: bounds[0], density: densities[0] }, { start: bounds[0], end: bounds[1], density: densities[1] }, { start: bounds[1], density: densities[2] }],
    percentiles: { p75 },
  };
}

function cruxRecord(url: string): string {
  const date = (offset: number) => {
    const value = new Date(Date.now() - offset * day);
    return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
  };
  return JSON.stringify({
    record: {
      key: { formFactor: 'PHONE', url },
      metrics: {
        largest_contentful_paint: metric([2500, 4000], [0.55, 0.3, 0.15], 3400),
        interaction_to_next_paint: metric([200, 500], [0.82, 0.13, 0.05], 150),
        cumulative_layout_shift: metric(['0.10', '0.25'], [0.9, 0.06, 0.04], '0.03'),
        first_contentful_paint: metric([1800, 3000], [0.4, 0.3, 0.3], 3200),
        experimental_time_to_first_byte: metric([800, 1800], [0.5, 0.35, 0.15], 1300),
        navigation_types: { fractions: { navigate: 0.78, navigate_cache: 0.04, reload: 0.03, restore: 0.01, back_forward: 0.06, back_forward_cache: 0.02, prerender: 0.06 } },
        largest_contentful_paint_resource_type: { fractions: { image: 0.85, text: 0.15 } },
        largest_contentful_paint_image_time_to_first_byte: { percentiles: { p75: 700 } },
        largest_contentful_paint_image_resource_load_delay: { percentiles: { p75: 1100 } },
        largest_contentful_paint_image_resource_load_duration: { percentiles: { p75: 500 } },
        largest_contentful_paint_image_element_render_delay: { percentiles: { p75: 300 } },
      },
      collectionPeriod: { firstDate: date(30), lastDate: date(3) },
    },
  });
}

export default defineScenario({
  name: 'holdout-lab-field',
  summary: 'The service page under Lighthouse with field data: a 1.5-second script at load, an unnamed icon button, 300 KB of unused unminified JavaScript, a stylesheet cached for an hour; CrUX with good INP and slow FCP, TTFB and LCP.',
  hosts: [...studioHosts, crux],
  options: { lighthouse: true },
  build: context => {
    const site = studio(context);
    const path = '/en/services/custom-software/';
    for (const tool of tools) site.routes.set(`/images/tools/${tool}.png`, site.file('image/png', png(64, 64, [40, 60 + tools.indexOf(tool) * 20, 120])));
    site.routes.set('/styles/theme.css', site.file('text/css; charset=utf-8', '.tools{display:flex;flex-wrap:wrap;gap:1rem;list-style:none;padding:0}\n.tools img{width:64px;height:64px}\n.share{width:44px;height:44px}\n', 'public, max-age=3600'));
    site.routes.set('/assets/charts.3c1d9e7a.js', { ...site.file('text/javascript; charset=utf-8', charts, 'public, max-age=31536000, immutable'), compress: false });
    const service = page(site, path);
    service.head = '<link rel="stylesheet" href="/styles/theme.css">\n<script src="/assets/charts.3c1d9e7a.js" defer></script>';
    service.body += `
<section>
<h2>Tools we use</h2>
<ul class="tools">${tools.map(tool => `<li><img src="/images/tools/${tool}.png" alt="${tool}" width="64" height="64"></li>`).join('')}</ul>
<button type="button" class="share"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 12h16M12 4v16" stroke="currentColor"/></svg></button>
</section>
<script>{ const end = performance.now() + 1500; while (performance.now() < end) { /* builds the pricing table */ } }</script>`;
    const pageUrl = site.url(path);
    const built = served(site, path, undefined, { [`https://${crux}`]: { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: cruxRecord(pageUrl) } });
    return { ...built, cruxEndpoint: `${context.origin(`https://${crux}`)}/v1/records:queryRecord` };
  },
  mustFail: [
    { rule: 'perf-crux-fcp-p75', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'perf-crux-ttfb-p75', severity: 'medium', page: '/en/services/custom-software/' },
    { rule: 'perf-crux-navigation-types', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'perf-crux-lcp-subparts', severity: 'medium', page: '/en/services/custom-software/' },
    { rule: 'perf-lab-tbt-inp-proxy', severity: 'info', page: '/en/services/custom-software/' },
    { rule: 'perf-long-tasks', severity: 'medium', page: '/en/services/custom-software/' },
    { rule: 'perf-lab-run-protocol', severity: 'info', page: '/en/services/custom-software/' },
    { rule: 'perf-lab-performance-score', severity: 'info', page: '/en/services/custom-software/' },
    { rule: 'perf-http-protocol', severity: 'medium', page: '/en/services/custom-software/' },
    { rule: 'perf-static-cache-ttl', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'ai-agent-readiness', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'tech-lighthouse-a11y-overlap', page: '/en/services/custom-software/' },
    { rule: 'perf-unused-code', severity: 'low', page: '/en/services/custom-software/' },
    { rule: 'perf-minification', severity: 'low', page: '/en/services/custom-software/' },
  ],
  mustNotFail: [
    { rule: 'perf-crux-softnav-experimental', page: '/en/services/custom-software/', outcome: 'not_applicable' },
    { rule: 'perf-server-response-time', page: '/en/services/custom-software/' },
  ],
});
