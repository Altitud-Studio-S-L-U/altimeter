import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/';

const newsletter = `<div class="newsletter-modal" role="dialog" aria-modal="true" style="position:fixed;inset:6% 4%;z-index:30;background:#fff;border:1px solid #d9e2ec;padding:2rem">
<h2>Subscribe to our newsletter</h2>
<p>Sign up and get a 10% discount on your first project.</p>
<button type="button">Sign up</button>
</div>`;

export default defineScenario({
  name: 'page-structure',
  summary: 'The real problems behind the banner-heading and combined-h1 traps: a newsletter modal over the first screen, skipped heading levels and an h1 that is an image without alt.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    const home = site.pages.get(page)!;
    home.h1 = '<img src="/logo.svg" width="240" height="64">';
    home.body = home.body.replaceAll('<h3>', '<h4>').replaceAll('</h3>', '</h4>');
    home.afterMain = newsletter;
  }),
  mustFail: [
    { rule: 'tech-intrusive-interstitial', severity: 'medium', reason: 'promotion', page },
    { rule: 'content-heading-level-skips', severity: 'low', page },
    { rule: 'content-h1-empty-or-image', severity: 'low', reason: 'empty', page },
  ],
  mustNotFail: [
    // The h1 is still there, and the consent banner stays exempt next to the modal.
    { rule: 'content-h1-missing', page },
  ],
});
