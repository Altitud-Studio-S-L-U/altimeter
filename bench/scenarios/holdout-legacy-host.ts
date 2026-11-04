import { htmlDocument, htmlResponse, page, replaceOnce, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

const staging = 'staging.vellora-studio.example';
const xhtml = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';
const hsts = 'max-age=86400; preload';

export default defineScenario({
  name: 'holdout-legacy-host',
  summary: 'An older host: robots.txt answers 503, an XHTML doctype, a fixed 1024-pixel viewport without zoom, HSTS preload with a one-day max-age, framing limited by a meta CSP only, and a canonical to staging.',
  hosts: [...studioHosts, staging],
  build: context => {
    const site = studio(context);
    site.routes.set('/robots.txt', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3600' }, body: 'Service temporarily unavailable\n' });
    site.pageHeaders['strict-transport-security'] = hsts;
    delete site.pageHeaders['x-frame-options'];
    const root = site.routes.get('/');
    if (typeof root !== 'function') throw new Error('holdout: the studio root is not a handler');
    site.routes.set('/', request => {
      const answer = root(request);
      const headers: Record<string, string | readonly string[]> = { ...answer.headers, 'strict-transport-security': hsts };
      delete headers['x-frame-options'];
      return { ...answer, headers };
    });
    const home = page(site, '/en/');
    home.head = '<meta http-equiv="Content-Security-Policy" content="frame-ancestors \'none\'">';
    const stagingUrl = `${context.origin(`https://${staging}`)}/en/`;
    transform(home, html => {
      const doctype = replaceOnce(html, '<!doctype html>', xhtml);
      const viewport = replaceOnce(doctype, 'content="width=device-width, initial-scale=1"', 'content="width=1024, user-scalable=no"');
      return replaceOnce(viewport, `<link rel="canonical" href="${site.url('/en/')}">`, `<link rel="canonical" href="${stagingUrl}">`);
    });
    const preview = htmlResponse(htmlDocument({ lang: 'en', title: 'Vellora Studio (staging)', robots: 'noindex, nofollow', body: '<main><h1>Staging copy</h1><p>This host previews changes before they go live.</p></main>' }));
    return served(site, '/en/', undefined, { [`https://${staging}`]: preview });
  },
  mustFail: [
    { rule: 'crawl-robots-fetch-status', severity: 'critical' },
    { rule: 'tech-doctype-standards-mode', severity: 'low', page: '/en/' },
    { rule: 'tech-viewport-meta', severity: 'high', page: '/en/' },
    { rule: 'tech-viewport-zoom-allowed', severity: 'low', page: '/en/' },
    { rule: 'tech-hsts-preload-eligibility', severity: 'info' },
    { rule: 'tech-framing-protection', severity: 'info' },
    { rule: 'crawl-canonical-cross-domain', severity: 'high', page: '/en/' },
  ],
  mustNotFail: [
    'tech-maintenance-503',
    { rule: 'tech-legible-font-size', page: '/en/', outcome: 'not_applicable' },
  ],
});
