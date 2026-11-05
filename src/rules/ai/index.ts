import type { RuleImplementation } from '../engine.ts';
import { edgeRules } from './edge.ts';
import { hiddenInstructionRules } from './hidden-instructions.ts';
import { llmsTxtRules } from './llms-txt.ts';
import { pageSignalRules } from './page-signals.ts';
import { renderingRules } from './rendering.ts';
import { crawlerRules } from './robots-crawlers.ts';
import { policyRules } from './robots-policy.ts';
import { signalRules } from './robots-signals.ts';

export const implementations: readonly RuleImplementation[] = [
  ...crawlerRules,
  ...policyRules,
  ...signalRules,
  ...edgeRules,
  ...renderingRules,
  ...hiddenInstructionRules,
  ...pageSignalRules,
  ...llmsTxtRules,
];
