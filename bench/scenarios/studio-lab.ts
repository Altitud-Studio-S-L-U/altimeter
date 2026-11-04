import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/services/custom-software/';

export default defineScenario({
  name: 'studio-lab',
  summary: 'The service page under Lighthouse: an eager hero image with fetchpriority=high, sized lazy images further down, the counterpart of lcp-lazy.',
  hosts: studioHosts,
  options: { lighthouse: true },
  build: context => studioSite(context, page),
  mustFail: [],
  mustNotFail: [
    { rule: 'perf-lcp-lazy-loaded', page }, { rule: 'perf-lcp-fetchpriority', page }, { rule: 'perf-lcp-not-discoverable', page },
    { rule: 'perf-unsized-images', page }, { rule: 'perf-lab-cls', page }, { rule: 'perf-cls-culprits', page },
  ],
});
