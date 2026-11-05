import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/';

const hidden = `<section class="seo-copy">
<p style="color:#ffffff;background:#ffffff">custom software valencia custom software company valencia best custom software developers valencia cheap custom software valencia</p>
<p style="position:absolute;left:-9999px">software agency valencia software developers valencia software company valencia app developers valencia web developers valencia</p>
</section>`;

export default defineScenario({
  name: 'hidden-text',
  summary: 'The real problem behind the scroll-reveal trap: keyword text hidden with the background colour and pushed off screen, not waiting for a scroll.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    const home = site.pages.get(page)!;
    home.body = `${home.body}\n${hidden}`;
  }),
  mustFail: [
    { rule: 'content-hidden-text', severity: 'medium', page },
  ],
  mustNotFail: [
    // The reveal-on-scroll sections next to it are still not hidden text.
    { rule: 'ai-js-only-content', page },
  ],
});
