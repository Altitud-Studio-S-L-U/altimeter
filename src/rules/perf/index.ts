import type { RuleImplementation } from '../engine.ts';
import { deliveryImplementations } from './delivery.ts';
import { fieldImplementations } from './field.ts';
import { labImplementations } from './lab.ts';
import { layoutImplementations } from './layout.ts';
import { lcpImplementations } from './lcp.ts';
import { resourceImplementations } from './resources.ts';
import { scriptImplementations } from './script.ts';

export const implementations: readonly RuleImplementation[] = [
  ...fieldImplementations,
  ...labImplementations,
  ...lcpImplementations,
  ...deliveryImplementations,
  ...layoutImplementations,
  ...resourceImplementations,
  ...scriptImplementations,
];
