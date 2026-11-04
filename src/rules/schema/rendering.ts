import type { PageFacts } from '../../core/facts.ts';
import type { RuleImplementation } from '../engine.ts';
import { flatten, sameSet } from './compare.ts';
import { buildGraph, text, topLevel, type GraphNode, type PageGraph } from './graph.ts';
import { cite, report, type Problem } from './support.ts';
import { isA } from './vocabulary.ts';

function bothGraphs(page: PageFacts): { raw: PageGraph; rendered: PageGraph } {
  return { raw: buildGraph(page.raw!, page.fetch.finalUrl, 'raw'), rendered: buildGraph(page.rendered!, page.fetch.finalUrl, 'rendered') };
}

function identity(graph: PageGraph, node: GraphNode): string {
  return `${[...node.types].sort().join('+')}|${node.id ?? text(graph, node, 'name') ?? text(graph, node, 'url') ?? ''}`;
}

const commerce = (node: GraphNode) => isA(node.types, 'Product') || isA(node.types, 'Offer') || isA(node.types, 'ProductGroup');

export const jsOnlyMarkup: RuleImplementation = {
  id: 'schema-js-only-markup',
  evaluate(context) {
    const { raw, rendered } = bothGraphs(context.page!);
    const rawTop = topLevel(raw).filter(node => node.types.length > 0);
    const renderedTop = topLevel(rendered).filter(node => node.types.length > 0);
    if (rawTop.length === 0 && renderedTop.length === 0) return { outcome: 'not_applicable', reason: 'no-structured-data' };
    const present = new Set(rawTop.map(node => identity(raw, node)));
    const problems: Problem[] = renderedTop.filter(node => !present.has(identity(rendered, node))).map(node => {
      const product = commerce(node) || rendered.nodes.some(child => child.path.startsWith(`${node.path}.`) && commerce(child));
      return {
        reason: product ? 'product-rendered-only' : 'rendered-only',
        severity: product ? 'medium' : 'low',
        subject: node.types.join('+'),
        evidence: cite(context, rendered, node, 'item present in the rendered DOM but not in the raw HTML'),
      };
    });
    return report(problems);
  },
};

const comparedProperties = new Set(['price', 'priceCurrency', 'availability', 'name', 'ratingValue', 'reviewCount', 'datePublished', 'dateModified', 'startDate', 'url']);

function counterpart(raw: PageGraph, rendered: PageGraph, node: GraphNode, candidates: readonly GraphNode[]): GraphNode | undefined {
  const name = text(rendered, node, 'name');
  const url = text(rendered, node, 'url');
  const matches = candidates.filter(candidate => (node.id !== undefined && candidate.id === node.id)
    || (candidate.types.join('+') === node.types.join('+')
      && ((name !== undefined && text(raw, candidate, 'name') === name) || (url !== undefined && text(raw, candidate, 'url') === url))));
  return matches.length === 1 ? matches[0] : undefined;
}

export const rawRenderedConflict: RuleImplementation = {
  id: 'schema-raw-rendered-conflict',
  evaluate(context) {
    const { raw, rendered } = bothGraphs(context.page!);
    const rawTop = topLevel(raw).filter(node => node.types.length > 0);
    const renderedTop = topLevel(rendered).filter(node => node.types.length > 0);
    if (rawTop.length === 0 || renderedTop.length === 0) return { outcome: 'not_applicable', reason: 'markup-in-one-version-only' };
    const problems: Problem[] = [];
    for (const node of renderedTop) {
      const original = counterpart(raw, rendered, node, rawTop);
      if (!original) continue;
      const before = flatten(raw, original, comparedProperties);
      for (const [path, values] of flatten(rendered, node, comparedProperties)) {
        const previous = before.get(path);
        if (!previous || sameSet(previous.normal, values.normal)) continue;
        const property = path.includes('.') ? undefined : path;
        problems.push({
          reason: 'value-differs', severity: 'medium', subject: `${node.types.join('+')} ${path}`,
          evidence: cite(context, rendered, node, `${path} in the rendered DOM`, property, `${path}: ${[...values.written].join(' | ')}`),
          also: [cite(context, raw, original, `${path} in the raw HTML`, property, `${path}: ${[...previous.written].join(' | ')}`)],
        });
      }
    }
    return report(problems);
  },
};
