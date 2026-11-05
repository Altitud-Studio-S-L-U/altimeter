import type { RuleImplementation } from '../engine.ts';
import { clusterImplementations } from './clusters.ts';
import { languageImplementations } from './language-rules.ts';
import { miscImplementations } from './misc.ts';
import { placementImplementations } from './placement.ts';
import { redirectImplementations } from './redirects.ts';
import { sitemapFormat } from './sitemap.ts';
import { targetImplementations } from './targets.ts';
import { valueImplementations } from './values.ts';

export const implementations: readonly RuleImplementation[] = [
  ...valueImplementations,
  ...placementImplementations,
  ...clusterImplementations,
  sitemapFormat,
  ...targetImplementations,
  ...languageImplementations,
  ...redirectImplementations,
  ...miscImplementations,
];
