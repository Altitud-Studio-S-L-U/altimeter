import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'locale-unreachable',
  summary: 'What the root-redirect trap must not hide: Spanish URLs that send every visitor without the language cookie, Googlebot included, to /en/.',
  hosts: studioHosts,
  build: context => studioSite(context, '/en/', {}, site => {
    for (const page of [...site.pages.values()].filter(entry => entry.locale === 'es')) {
      site.routes.set(page.path, request => (/(?:^|;\s*)studio-language=es\b/u.test(String(request.headers.cookie ?? ''))
        ? site.respond(page)
        : { status: 302, headers: { location: '/en/', 'cache-control': 'private, no-store', vary: 'Cookie' }, body: '' }));
    }
  }),
  mustFail: [
    { rule: 'intl-localized-urls-unreachable', severity: 'critical', reason: 'redirected-away' },
  ],
  mustNotFail: [
    // The root itself is unchanged: one temporary, uncached target.
    'intl-root-locale-redirector',
  ],
});
