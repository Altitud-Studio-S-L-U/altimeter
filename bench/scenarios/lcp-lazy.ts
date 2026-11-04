import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/services/custom-software/';

export default defineScenario({
  name: 'lcp-lazy',
  summary: 'The real problem behind the lazy-loaded duplicate images trap: the hero image that is the LCP element loads lazily and without a priority hint (Lighthouse).',
  hosts: studioHosts,
  options: { lighthouse: true },
  build: context => studioSite(context, page, {}, site => {
    const service = site.pages.get(page)!;
    service.hero = service.hero.replace('fetchpriority="high"', 'loading="lazy"');
  }),
  mustFail: [
    { rule: 'perf-lcp-lazy-loaded', severity: 'high', reason: 'loading-lazy', page },
    { rule: 'perf-lcp-fetchpriority', severity: 'medium', page },
  ],
  mustNotFail: [
    // The URL is in the server HTML, so the preload scanner can still find it.
    { rule: 'perf-lcp-not-discoverable', page },
  ],
});
