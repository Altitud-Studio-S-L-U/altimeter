import type { RuleImplementation } from '../engine.ts';
import { absoluteUrl } from '../helpers.ts';
import { flatten, sameSet } from './compare.ts';
import { isExternalTerm, text, texts, topLevel, type GraphNode, type PageGraph } from './graph.ts';
import { cite, isResult, normalizeName, pageGraph, report, type Problem } from './support.ts';
import { isA, isSubtypeOf, isType } from './vocabulary.ts';

const withoutFragment = (url: string) => url.replace(/#.*$/u, '');

/** Whether an @id names a fragment of the page itself, so its definition is expected on this page. */
function fragmentOfPage(id: string, base: string): boolean {
  if (id.startsWith('#')) return true;
  const resolved = absoluteUrl(id, base);
  return resolved !== undefined && resolved.includes('#') && withoutFragment(resolved) === withoutFragment(base);
}

function compatible(a: readonly string[], b: readonly string[]): boolean {
  const known = (types: readonly string[]) => types.filter(type => !isExternalTerm(type) && isType(type));
  const left = known(a);
  const right = known(b);
  if (left.length === 0 || right.length === 0) return true;
  return left.some(x => right.some(y => isSubtypeOf(x, y) || isSubtypeOf(y, x)));
}

const scalarKeys = ['name', 'url', 'logo'] as const;

export const idDanglingOrConflicting: RuleImplementation = {
  id: 'schema-id-dangling-or-conflicting',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const references = graph.nodes.flatMap(node => [...node.properties].flatMap(([property, list]) => list
      .filter(value => value.kind === 'ref').map(value => ({ node, property, id: (value as { id: string }).id }))));
    if (graph.byId.size === 0 && references.length === 0) return { outcome: 'not_applicable', reason: 'no-ids' };
    const problems: Problem[] = [];
    for (const reference of references) {
      if (graph.byId.has(reference.id) || !fragmentOfPage(reference.id, graph.base)) continue;
      problems.push({ reason: 'dangling-reference', severity: 'low', subject: reference.id,
        evidence: cite(context, graph, reference.node, '@id reference with no definition on the page', reference.property, reference.id) });
    }
    for (const [id, nodes] of graph.byId) {
      if (/\s|[<>"{}|\\^`]/u.test(id)) {
        problems.push({ reason: 'invalid-id', severity: 'low', subject: id, evidence: cite(context, graph, nodes[0]!, '@id that is not a valid IRI', undefined, id) });
      }
      if (nodes.length < 2) continue;
      for (let i = 1; i < nodes.length; i++) {
        const first = nodes[0]!;
        const other = nodes[i]!;
        if (!compatible(first.types, other.types)) {
          problems.push({ reason: 'conflicting-types', severity: 'medium', subject: `${id}: ${first.types.join('+')} / ${other.types.join('+')}`,
            evidence: cite(context, graph, first, 'definition of an @id', undefined, `${id}: ${first.types.join(', ')}`),
            also: [cite(context, graph, other, 'another definition of the same @id with an unrelated type', undefined, `${id}: ${other.types.join(', ')}`)] });
        }
        for (const key of scalarKeys) {
          const own = (node: GraphNode) => new Set(ownValues(graph, node, key));
          const a = own(first);
          const b = own(other);
          if (a.size === 0 || b.size === 0 || [...a].some(value => b.has(value))) continue;
          problems.push({ reason: 'conflicting-values', severity: 'medium', subject: `${id} ${key}`,
            evidence: cite(context, graph, first, `${key} of an @id`, key), also: [cite(context, graph, other, `different ${key} for the same @id`, key)] });
        }
      }
    }
    return report(problems);
  },
};

/** Values written on this node only (not merged by @id), with URLs resolved and names normalized. */
function ownValues(graph: PageGraph, node: GraphNode, key: string): string[] {
  const values: string[] = [];
  for (const value of node.properties.get(key) ?? []) {
    if (value.kind === 'text') values.push(key === 'name' ? normalizeName(value.value) : absoluteUrl(value.value, graph.base) ?? value.value);
    else if (value.kind === 'node') {
      const url = text(graph, value.node, 'url') ?? text(graph, value.node, 'contentUrl');
      if (url) values.push(absoluteUrl(url, graph.base) ?? url);
    }
  }
  return values;
}

/** Feature types checked for duplicates, most specific first so that a LocalBusiness is not grouped with an Organization. */
const families = ['ProductGroup', 'Product', 'LocalBusiness', 'Organization', 'Article', 'Event', 'Recipe', 'VideoObject', 'JobPosting', 'Course',
  'SoftwareApplication', 'Dataset', 'QAPage'];
const identityKeys = ['url', 'sku', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'name'];
const conflictKeys = new Set(['price', 'priceCurrency', 'availability', 'ratingValue', 'reviewCount', 'logo', 'url', 'name', 'datePublished',
  'dateModified', 'headline', 'startDate', 'sku']);

function familyOf(node: GraphNode): string | undefined {
  return families.find(family => isA(node.types, family));
}

function identities(graph: PageGraph, node: GraphNode): Set<string> {
  return new Set(identityKeys.flatMap(key => texts(graph, node, key).map(value => `${key}:${key === 'url' ? (absoluteUrl(value, graph.base) ?? value).replace(/\/$/u, '') : normalizeName(value)}`)));
}

/** Two nodes that share a name but carry different SKUs, GTINs or URLs describe different things, such as variants. */
function distinctIdentifiers(graph: PageGraph, a: GraphNode, b: GraphNode): boolean {
  return ['sku', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'url'].some(key => {
    const left = identities(graph, a);
    const right = identities(graph, b);
    const of = (set: Set<string>) => [...set].filter(entry => entry.startsWith(`${key}:`));
    const x = of(left);
    const y = of(right);
    return x.length > 0 && y.length > 0 && !x.some(entry => y.includes(entry));
  });
}

export const duplicateFeatureNodes: RuleImplementation = {
  id: 'schema-duplicate-feature-nodes',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const candidates = topLevel(graph).filter(node => node.schemaOrg && familyOf(node) !== undefined);
    if (candidates.length === 0) return { outcome: 'not_applicable', reason: 'no-feature-nodes' };
    const problems: Problem[] = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        if (familyOf(a) !== familyOf(b) || (a.id !== undefined && a.id === b.id)) continue;
        const shared = [...identities(graph, a)].filter(key => identities(graph, b).has(key));
        if (shared.length === 0 || distinctIdentifiers(graph, a, b)) continue;
        const left = flatten(graph, a, conflictKeys);
        const right = flatten(graph, b, conflictKeys);
        const differing = [...left].filter(([path, values]) => right.has(path) && !sameSet(values.normal, right.get(path)!.normal)).map(([path]) => path);
        problems.push({
          reason: differing.length > 0 ? 'conflicting-duplicate' : 'exact-duplicate',
          severity: differing.length > 0 ? 'medium' : 'low',
          subject: `${familyOf(a)} ${shared[0]}${differing.length > 0 ? ` (${differing.join(', ')})` : ''}`,
          evidence: cite(context, graph, a, `${familyOf(a)} node`),
          also: [cite(context, graph, b, `another ${familyOf(a)} node for the same ${shared[0]!.split(':')[0]}`)],
        });
      }
    }
    return report(problems);
  },
};
