import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/';

const googleTag = `<script>
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'G-BENCH00000');
</script>`;

const wall = `<div id="cookie-wall" role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:50;background:#fff;padding:2rem">
<h2>Before you continue</h2>
<p>We use cookies to show this page. Accept the cookies to read the content.</p>
<button type="button">Accept cookies</button>
</div>
<script>if (!document.cookie.includes('studio-consent=')) document.getElementById('content').replaceChildren();</script>`;

export default defineScenario({
  name: 'consent-problems',
  summary: 'The real problems behind the consent-gating traps: a Google tag configured before any consent default, and a cookie wall that withholds the content.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    const home = site.pages.get(page)!;
    home.head = googleTag;
    home.afterMain = wall;
  }),
  mustFail: [
    { rule: 'tech-consent-mode-ordering', severity: 'info', reason: 'no-consent-default' },
    { rule: 'tech-cmp-blocks-content', severity: 'high', reason: 'content-withheld', page },
  ],
  mustNotFail: [
    // A notice the law requires is exempt from the interstitial guidance, even when it covers the screen.
    { rule: 'tech-intrusive-interstitial', page },
  ],
});
