import type { Scenario } from '../support/scenario.ts';
import studioCrawl from './studio-crawl.ts';
import studioEs from './studio-es.ts';
import studioHome from './studio-home.ts';
import studioPolished from './studio-polished.ts';
import studioRoot from './studio-root.ts';
import studioService from './studio-service.ts';

/** Every scenario, in the order the benchmark runs them. */
export const scenarios: readonly Scenario[] = [
  studioHome, studioRoot, studioService, studioEs, studioCrawl, studioPolished,
];
