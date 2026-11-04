import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

export default defineScenario({
  name: 'locale-adaptive',
  summary: 'The real problem behind the Accept-Language trap: the root answers 200 in Spanish or English depending on Accept-Language, at one URL.',
  hosts: studioHosts,
  build: context => studioSite(context, '/', {}, site => {
    const english = site.pages.get('/en/')!;
    const spanish = site.pages.get('/es/')!;
    site.routes.set('/', request => site.respond(/^es\b/iu.test(String(request.headers['accept-language'] ?? '')) ? spanish : english));
  }),
  mustFail: [
    { rule: 'intl-locale-adaptive-same-url', severity: 'high' },
  ],
  mustNotFail: [
    // There is no redirect any more, so the redirect rules have nothing to report.
    'intl-root-locale-redirector', 'intl-auto-redirect-by-language',
  ],
});
