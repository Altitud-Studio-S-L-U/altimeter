import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

const page = '/en/';

export default defineScenario({
  name: 'crux-no-data',
  summary: 'The expected finding of a low-traffic site: the Chrome UX Report has no field data, which is reported as information and not as a failing Core Web Vital.',
  hosts: [...studioHosts, 'crux.example'],
  build: context => {
    const site = studio(context);
    const notFound = { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } }) };
    return { origins: { ...site.origins(), 'https://crux.example': () => notFound }, url: site.url(page), cruxEndpoint: context.origin('https://crux.example') };
  },
  mustFail: [
    { rule: 'perf-crux-data-availability', severity: 'info', reason: 'no-field-data', page },
  ],
  mustNotFail: [
    ...['perf-crux-lcp-p75', 'perf-crux-inp-p75', 'perf-crux-cls-p75', 'perf-crux-cwv-assessment'].map(rule => ({ rule, page, outcome: 'not_evaluated' as const })),
  ],
});
