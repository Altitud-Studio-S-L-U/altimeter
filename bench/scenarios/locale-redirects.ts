import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const prefersSpanish = (header: string | string[] | undefined) => /^es\b/iu.test(String(header ?? ''));

export default defineScenario({
  name: 'locale-redirects',
  summary: 'The real problem behind the root-redirect trap: a cacheable 301 root chosen by Accept-Language without Vary, and /en/ sending Spanish speakers away.',
  hosts: studioHosts,
  build: context => studioSite(context, '/en/', {}, site => {
    const english = site.pages.get('/en/')!;
    site.routes.set('/', request => ({
      status: 301, headers: { location: prefersSpanish(request.headers['accept-language']) ? '/es/' : '/en/', 'cache-control': 'public, max-age=86400' }, body: '',
    }));
    site.routes.set('/en/', request => (prefersSpanish(request.headers['accept-language'])
      ? { status: 302, headers: { location: '/es/', 'cache-control': 'private, no-store' }, body: '' }
      : site.respond(english)));
  }),
  mustFail: [
    { rule: 'intl-root-locale-redirector', severity: 'low', reason: 'permanent-redirect' },
    { rule: 'intl-root-locale-redirector', severity: 'low', reason: 'missing-vary' },
    { rule: 'intl-auto-redirect-by-language', severity: 'high' },
  ],
  mustNotFail: [
    // Requests without Accept-Language or cookies still reach every locale.
    'intl-localized-urls-unreachable',
  ],
});
