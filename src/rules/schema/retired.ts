import { evidenceLabel } from '../../core/evidence.ts';
import { retiredFeatures } from '../../data/google-features.ts';
import type { RuleImplementation } from '../engine.ts';
import { has, type GraphNode, type PageGraph } from './graph.ts';
import { cite, isResult, nodesOfType, pageGraph, report, type Problem } from './support.ts';
import { isA } from './vocabulary.ts';

export const faqPageRetired: RuleImplementation = {
  id: 'schema-faqpage-retired',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const pages = nodesOfType(graph, 'FAQPage');
    if (pages.length === 0) return { outcome: 'not_applicable', reason: 'no-faqpage' };
    return report(pages.map(node => ({ reason: 'present', severity: 'info', subject: 'FAQPage', evidence: cite(context, graph, node, evidenceLabel('FAQPage markup')) })));
  },
};

/** The retired feature a node is markup for, if any. */
function retiredFeatureOf(graph: PageGraph, node: GraphNode): { feature: string; date: string } | undefined {
  for (const [type, retired] of Object.entries(retiredFeatures)) {
    if (!isA(node.types, type)) continue;
    // HowTo steps also appear nested in recipes; only a HowTo that is the page's markup was the how-to feature.
    if (type === 'HowTo' && (node.parent !== undefined || isA(node.types, 'Recipe'))) continue;
    return retired;
  }
  if (isA(node.types, 'LearningResource') && isA(node.types, 'VideoObject')) return { feature: 'Learning video', date: '2025-09-09' };
  if (isA(node.types, 'Course') && has(graph, node, 'hasCourseInstance')) return { feature: 'Course info', date: '2025-09-09' };
  return undefined;
}

export const retiredFeatureMarkup: RuleImplementation = {
  id: 'schema-retired-feature-markup',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const problems: Problem[] = [];
    for (const node of graph.nodes.filter(entry => entry.schemaOrg)) {
      const retired = retiredFeatureOf(graph, node);
      if (!retired) continue;
      problems.push({ reason: 'retired', severity: 'info', subject: `${retired.feature} (${retired.date})`,
        evidence: cite(context, graph, node, evidenceLabel('markup for a retired Google feature: {feature}', { feature: retired.feature })) });
    }
    if (problems.length === 0) return { outcome: 'not_applicable', reason: 'no-retired-feature-markup' };
    return report(problems);
  },
};
