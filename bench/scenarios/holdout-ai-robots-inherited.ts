import { byUserAgent, page, refuse, served } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

// Case studies a prerendering service adds to the HTML it serves crawlers, on top of everything the browser receives.
const prerendered = `<section class="prerendered-cases">
<h2>Case studies</h2>
<article>
<h3>Route planning for a regional courier</h3>
<p>A courier with forty vans planned every route by hand each morning, copying addresses from three order systems into a spreadsheet. We built a planning tool that reads the orders overnight, groups them by area and delivery window, and proposes routes that drivers can adjust on a tablet before they leave. Planning now takes twenty minutes instead of two hours, and late deliveries fell by a quarter during the first season.</p>
<p>The tool runs on the courier's own servers, keeps a full history of every change a dispatcher makes, and sends the final routes to the drivers' phones. When the connection drops, drivers keep the last version and their updates are synchronised as soon as the van is back in coverage.</p>
</article>
<article>
<h3>Monthly reporting for a group of veterinary clinics</h3>
<p>Six clinics sent their figures to head office as spreadsheets with different columns, and the monthly report took a week to assemble. We designed a small data platform that collects appointments, invoices and stock movements every night, checks them against the clinic's own rules and publishes one report that every manager can filter. The finance team now closes the month on the third working day.</p>
<p>Every number in the report links back to the records it comes from, so managers can see which invoices or visits explain a change. New clinics join the platform by filling in a configuration file instead of waiting for a developer.</p>
</article>
<article>
<h3>Supplier onboarding for a furniture importer</h3>
<p>New suppliers used to send their catalogues by email, and two people retyped thousands of product lines into the warehouse system every quarter. We automated the import with a portal where suppliers upload their files, see the errors in plain language and correct them before anything reaches the warehouse. Retyping has stopped, and catalogue updates now go live in days instead of weeks.</p>
<p>The portal keeps every version of every catalogue, so the purchasing team can compare prices between seasons and answer supplier questions without searching old emails.</p>
</article>
</section>`;

export default defineScenario({
  name: 'holdout-ai-robots-inherited',
  summary: 'A wildcard group that disallows the site while Googlebot and Bingbot keep their own groups, AI agents refused at the edge, and prerendered HTML for Googlebot.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.robots = [
      'User-agent: *', 'Disallow: /', '',
      'User-agent: Googlebot', 'Allow: /', '',
      'User-agent: Bingbot', 'Allow: /', '',
      `Sitemap: ${site.url('/sitemap-index.xml')}`, '',
    ].join('\n');
    const home = page(site, '/en/');
    const forCrawlers = { ...home, body: `${home.body}\n${prerendered}` };
    return served(site, '/en/', apex => byUserAgent(apex, [
      [/OAI-SearchBot/iu, refuse(403, {}, 'Access denied')],
      [/Claude-SearchBot/iu, refuse(402, { 'crawler-price': 'USD 0.01' }, 'Payment required')],
      [/Googlebot/iu, request => (request.pathname === '/en/' ? site.respond(forCrawlers) : undefined)],
    ]));
  },
  mustFail: [
    { rule: 'ai-robots-claude-user', severity: 'low' },
    { rule: 'ai-robots-duckassistbot', severity: 'low' },
    { rule: 'ai-robots-mistral', severity: 'low' },
    { rule: 'ai-robots-meta', severity: 'low' },
    { rule: 'ai-robots-amazon', severity: 'info' },
    { rule: 'ai-robots-chatgpt-user', severity: 'info' },
    { rule: 'crawl-robots-group-override', severity: 'info' },
    { rule: 'ai-edge-ua-block-probe', severity: 'info' },
    { rule: 'ai-pay-per-crawl-402', severity: 'info' },
    { rule: 'crawl-dynamic-rendering', severity: 'low' },
  ],
  mustNotFail: [],
});
