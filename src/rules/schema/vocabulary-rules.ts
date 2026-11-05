import { evidenceLabel } from '../../core/evidence.ts';
import { documentedProperties } from '../../data/google-features.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { bareTerm, isExternalTerm, type GraphNode, type PageGraph, type Value } from './graph.ts';
import { featureTypes, requiredBy } from './features.ts';
import { cite, isResult, pageGraph, report, type Problem } from './support.ts';
import {
  allPropertyNames, allTypeNames, domainsOf, enumerationsOfValue, isA, isAtticTerm, isDataType, isEnumeration, isPendingTerm, isProperty, isType,
  membersOf, rangesOf, suggestion, supersededBy, vocabularyRelease,
} from './vocabulary.ts';

/** Runs `check` over the page's schema.org nodes, or reports that the page has none. */
function overSchemaNodes(context: RuleContext, check: (graph: PageGraph, node: GraphNode) => Problem[]): RuleResult[] | RuleResult {
  const graph = pageGraph(context);
  if (isResult(graph)) return graph;
  const nodes = graph.nodes.filter(node => node.schemaOrg);
  if (nodes.length === 0) return { outcome: 'not_applicable', reason: 'no-schema-org-markup' };
  return report(nodes.flatMap(node => check(graph, node)));
}

function ownProperties(node: GraphNode): string[] {
  return [...node.properties.keys()].filter(key => !isExternalTerm(key) && !node.customTerms.has(key));
}

const isFeatureIntent = (type: string) => [...featureTypes].some(feature => isA([type], feature));

export const unknownType: RuleImplementation = {
  id: 'schema-unknown-type',
  evaluate: context => overSchemaNodes(context, (graph, node) => node.types
    .filter(type => !isExternalTerm(type) && !isType(type) && !isAtticTerm(type))
    .map(type => {
      const intended = suggestion(type, allTypeNames());
      return {
        reason: 'unknown-type',
        severity: intended && isFeatureIntent(intended) ? 'high' : 'medium',
        subject: intended ? `${type} (${intended}?)` : type,
        evidence: cite(context, graph, node, evidenceLabel('@type not defined in schema.org {release}', { release: vocabularyRelease }), undefined, type),
      };
    })),
};

/** schema.org's -input and -output annotations of an Action property, such as query-input on a SearchAction (schema.org/docs/actions.html). */
function actionAnnotation(node: GraphNode, key: string): boolean {
  const property = /^(.+)-(?:input|output)$/u.exec(key)?.[1];
  return property !== undefined && isProperty(property) && isA(node.types, 'Action');
}

export const unknownProperty: RuleImplementation = {
  id: 'schema-unknown-property',
  evaluate: context => overSchemaNodes(context, (graph, node) => ownProperties(node)
    .filter(key => !isProperty(key) && !isAtticTerm(key) && !actionAnnotation(node, key))
    .map(key => {
      const intended = suggestion(key, allPropertyNames());
      return {
        reason: 'unknown-property',
        severity: intended && requiredBy(node.types, intended) ? 'medium' : 'low',
        subject: intended ? `${key} (${intended}?)` : key,
        evidence: cite(context, graph, node, evidenceLabel('property not defined in schema.org {release}', { release: vocabularyRelease }), key, key),
      };
    })),
};

const knownTypes = (types: readonly string[]) => types.length > 0 && types.every(isType);

export const domainRangeMismatch: RuleImplementation = {
  id: 'schema-domain-range-mismatch',
  evaluate: context => overSchemaNodes(context, (graph, node) => {
    // A Role node stands in for the value it qualifies and carries that value's property.
    if (!knownTypes(node.types) || isA(node.types, 'Role')) return [];
    const problems: Problem[] = [];
    for (const key of ownProperties(node).filter(isProperty)) {
      const domains = domainsOf(key);
      if (domains.length > 0 && !domains.some(domain => isA(node.types, domain))) {
        problems.push({ reason: 'domain', severity: 'low', subject: `${node.types.join('+')}.${key}`,
          evidence: cite(context, graph, node, evidenceLabel('property used on a type outside its schema.org domain ({types})', { types: domains.join(', ') }), key) });
      }
      const ranges = rangesOf(key);
      if (ranges.length === 0 || ranges.includes('Thing')) continue;
      for (const value of node.properties.get(key) ?? []) {
        if (value.kind !== 'node' || !knownTypes(value.node.types) || isA(value.node.types, 'Role')) continue;
        if (ranges.some(range => isA(value.node.types, range))) continue;
        problems.push({ reason: 'range', severity: 'low', subject: `${key}: ${value.node.types.join('+')}`,
          evidence: cite(context, graph, node, evidenceLabel("value type outside the property's schema.org range ({types})", { types: ranges.join(', ') }), key) });
      }
    }
    return problems;
  }),
};

/** A text value that names a schema.org term, as enumeration values do. */
function termValue(value: Value): string | undefined {
  const raw = value.kind === 'text' ? value.value : value.kind === 'ref' ? value.id : undefined;
  if (raw === undefined) return undefined;
  const bare = bareTerm(raw);
  return bare === raw.trim() && !/^[A-Z][A-Za-z0-9]+$/u.test(bare) ? undefined : bare;
}

/** Labels for a term schema.org superseded, moved to the attic or keeps pending, by the kind of term. */
const termLabels = {
  type: {
    superseded: evidenceLabel('type superseded in schema.org {release}', { release: vocabularyRelease }),
    retired: evidenceLabel('type retired to the schema.org attic'),
    pending: evidenceLabel("type in schema.org's pending section"),
  },
  property: {
    superseded: evidenceLabel('property superseded in schema.org {release}', { release: vocabularyRelease }),
    retired: evidenceLabel('property retired to the schema.org attic'),
    pending: evidenceLabel("property in schema.org's pending section"),
  },
  'enumeration value': {
    superseded: evidenceLabel('enumeration value superseded in schema.org {release}', { release: vocabularyRelease }),
    retired: evidenceLabel('enumeration value retired to the schema.org attic'),
    pending: evidenceLabel("enumeration value in schema.org's pending section"),
  },
} as const;

export const supersededPendingTerm: RuleImplementation = {
  id: 'schema-superseded-pending-term',
  evaluate: context => overSchemaNodes(context, (graph, node) => {
    const problems: Problem[] = [];
    const examine = (term: string, property: string | undefined, kind: keyof typeof termLabels) => {
      const replacement = supersededBy(term);
      if (replacement) {
        problems.push({ reason: 'superseded', severity: 'low', subject: `${term} -> ${replacement}`,
          evidence: cite(context, graph, node, termLabels[kind].superseded, property, term) });
      } else if (isAtticTerm(term)) {
        problems.push({ reason: 'retired', severity: 'low', subject: term,
          evidence: cite(context, graph, node, termLabels[kind].retired, property, term) });
      } else if (isPendingTerm(term) && !documentedProperties.has(term) && !featureTypes.has(term)) {
        problems.push({ reason: 'pending', severity: 'info', subject: term,
          evidence: cite(context, graph, node, termLabels[kind].pending, property, term) });
      }
    };
    for (const type of node.types.filter(entry => !isExternalTerm(entry))) examine(type, undefined, 'type');
    for (const key of ownProperties(node)) {
      examine(key, key, 'property');
      if (!rangesOf(key).some(isEnumeration)) continue;
      for (const value of node.properties.get(key) ?? []) {
        const term = termValue(value);
        if (term) examine(term, key, 'enumeration value');
      }
    }
    return problems;
  }),
};

/** Properties Google documents with a closed list of schema.org enumeration members. */
const googleEnumerations = new Set(['availability', 'itemCondition', 'eventStatus', 'dayOfWeek', 'returnPolicyCategory', 'returnFees', 'returnMethod']);
/** Properties whose values Google lists as plain text. */
const googleTextValues: Readonly<Record<string, readonly string[]>> = {
  employmentType: ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER'],
  unitText: ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'],
};
const singleValued = new Set(['availability', 'itemCondition']);

function rawValue(value: Value): string | undefined {
  if (value.kind === 'text') return value.value.trim();
  if (value.kind === 'ref') return value.id.trim();
  return undefined;
}

function underBaseSalary(node: GraphNode): boolean {
  for (let current: GraphNode | undefined = node; current; current = current.parent?.node) {
    if (current.parent?.property === 'baseSalary') return true;
  }
  return false;
}

export const enumerationValues: RuleImplementation = {
  id: 'schema-enumeration-values',
  evaluate: context => overSchemaNodes(context, (graph, node) => {
    const problems: Problem[] = [];
    for (const key of ownProperties(node).filter(isProperty)) {
      const ranges = rangesOf(key);
      const enumerations = ranges.filter(range => isEnumeration(range));
      const textList = googleTextValues[key];
      const listed = textList && (key !== 'unitText' || underBaseSalary(node)) && (key !== 'employmentType' || isA(node.types, 'JobPosting'));
      // Outside Google's lists, only a range made of enumerations alone rules out free text.
      const closed = enumerations.length > 0 && ranges.every(range => isEnumeration(range) && !isDataType(range));
      if (!listed && !googleEnumerations.has(key) && !closed) continue;
      if (!listed && enumerations.length === 0) continue;
      const written = (node.properties.get(key) ?? []).map(rawValue).filter((entry): entry is string => entry !== undefined && entry !== '');
      const allowed = listed ? textList! : enumerations.flatMap(entry => membersOf(entry));
      const lowerAllowed = new Set(allowed.map(entry => entry.toLowerCase()));
      for (const value of written) {
        const bare = bareTerm(value);
        const member = lowerAllowed.has(bare.toLowerCase()) || (!listed && enumerationsOfValue(bare).some(entry => enumerations.includes(entry)));
        if (member) continue;
        problems.push({
          reason: 'not-a-member', severity: googleEnumerations.has(key) || listed ? 'high' : 'medium', subject: `${key}: ${value}`,
          evidence: cite(context, graph, node, evidenceLabel('value outside the allowed list for {property}', { property: key }), key, value),
        });
      }
      if (singleValued.has(key) && new Set(written.map(entry => bareTerm(entry).toLowerCase())).size > 1) {
        problems.push({ reason: 'multiple-values', severity: 'high', subject: key,
          evidence: cite(context, graph, node, evidenceLabel('several values given for {property}', { property: key }), key) });
      }
    }
    return problems;
  }),
};
