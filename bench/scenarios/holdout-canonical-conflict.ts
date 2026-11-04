import { insertAfter, page, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'holdout-canonical-conflict',
  summary: 'Two canonicals with different targets, an hreflang link with a media query, a delayed meta refresh, a past unavailable_after with indexifembedded, notranslate and every citation nofollow.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    const path = '/en/open-source/';
    const openSource = page(site, path);
    openSource.robots = 'index, follow, indexifembedded, unavailable_after: 2025-06-30';
    openSource.head = `<meta name="googlebot" content="notranslate">
<meta http-equiv="refresh" content="30; url=/en/open-source/projects/">
<link rel="alternate" hreflang="es" media="only screen and (max-width: 640px)" href="${site.url('/es/codigo-abierto/')}">`;
    openSource.body = `${openSource.body.replaceAll('<a href="https://github.com/', '<a rel="nofollow" href="https://github.com/')}
<section>
<h2>Further reading</h2>
<ul>
<li><a rel="nofollow" href="https://www.postgresql.org/docs/current/explicit-locking.html">PostgreSQL documentation on explicit locking</a></li>
<li><a rel="nofollow" href="https://nodejs.org/en/about/previous-releases">The Node.js release schedule</a></li>
<li><a rel="nofollow" href="https://www.typescriptlang.org/docs/handbook/2/types-from-types.html">Creating types from types in the TypeScript handbook</a></li>
</ul>
</section>`;
    transform(openSource, html => insertAfter(html, `<link rel="canonical" href="${site.url(path)}">`, `\n<link rel="canonical" href="${site.url('/en/projects/')}">`));
    return served(site, path);
  },
  mustFail: [
    { rule: 'crawl-canonical-multiple', severity: 'high', page: '/en/open-source/' },
    { rule: 'intl-hreflang-combined-link-attributes', page: '/en/open-source/' },
    { rule: 'crawl-meta-refresh-js-redirect', severity: 'medium', page: '/en/open-source/' },
    { rule: 'crawl-unavailable-after', severity: 'critical', page: '/en/open-source/' },
    { rule: 'crawl-indexifembedded', severity: 'info', page: '/en/open-source/' },
    { rule: 'intl-notranslate-in-use', severity: 'info', page: '/en/open-source/' },
    { rule: 'content-outbound-citations', severity: 'low' },
  ],
  mustNotFail: [],
});
