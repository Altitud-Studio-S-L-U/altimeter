import { insertAfter, isoDate, page, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-robots-redirected',
  summary: 'robots.txt redirected to the HTML home, a base href that sends relative links to 404, a second canonical in the body, noarchive and an unavailable_after date ten days away.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.routes.set('/robots.txt', { status: 301, headers: { location: site.url('/en/'), 'content-type': 'text/html' }, body: '' });
    const about = page(site, '/en/about/');
    about.headers = { 'content-security-policy': site.pageHeaders['content-security-policy']!.replace("base-uri 'none'", "base-uri 'self'") };
    about.robots = `index, follow, noarchive, unavailable_after: ${isoDate(10)}`;
    about.body += `
<section>
<h2>Working with us</h2>
<p>Read how we <a href="team/">organise the team</a> and what <a href="services/custom-software/">a custom software project</a> looks like before we meet.</p>
<p>Our name, <span translate="no" class="notranslate">Vellora</span>, comes from the street where the first office was. Day rates <span data-nosnippet>start at 640 euros</span> and are reviewed every January.</p>
</section>`;
    transform(about, html => {
      const withBase = insertAfter(html, '<meta charset="UTF-8">', `\n<base href="${site.url('/en/blog/')}">`);
      return insertAfter(withBase, '<main id="content">', `\n<link rel="canonical" href="${site.url('/en/about/')}">`);
    });
    return served(site, '/en/about/');
  },
  mustFail: [
    { rule: 'crawl-robots-format', severity: 'medium' },
    { rule: 'crawl-base-href', severity: 'high', page: '/en/about/' },
    { rule: 'crawl-canonical-ignored-attributes-placement', severity: 'low', page: '/en/about/' },
    { rule: 'crawl-unavailable-after', severity: 'medium', page: '/en/about/' },
    { rule: 'ai-bing-noarchive-nocache', page: '/en/about/' },
  ],
  mustNotFail: [
    'crawl-robots-redirects',
    'crawl-robots-fetch-status',
    { rule: 'intl-notranslate-in-use', page: '/en/about/' },
    { rule: 'content-data-nosnippet-invalid', page: '/en/about/' },
  ],
});
