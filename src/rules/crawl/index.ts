import type { RuleImplementation } from '../engine.ts';
import { canonicalRules } from './canonical.ts';
import { directiveRules } from './directives.ts';
import { javascriptRules } from './javascript.ts';
import { robotsRules } from './robots.ts';
import { sitemapRules } from './sitemaps.ts';
import { statusRules } from './status.ts';

export const implementations: readonly RuleImplementation[] = [
  ...robotsRules, ...directiveRules, ...canonicalRules, ...statusRules, ...sitemapRules, ...javascriptRules,
];
