import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/';

export default defineScenario({
  name: 'delivery-problems',
  summary: 'The real problems behind the charset and caching traps: the charset declared after the first 1024 bytes, HTML marked no-store and sent uncompressed.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    const home = site.pages.get(page)!;
    home.headers = { 'cache-control': 'no-store', etag: '' };
    home.compress = false;
    home.transform = html => html.replace('<meta charset="UTF-8">\n', '').replace('</head>', '<meta charset="UTF-8">\n</head>');
  }),
  mustFail: [
    { rule: 'tech-charset-declared-early', severity: 'medium', reason: 'late-meta', page },
    { rule: 'perf-html-no-store', severity: 'low', page },
    { rule: 'perf-text-compression', severity: 'medium', reason: 'document', page },
  ],
  mustNotFail: [],
});
