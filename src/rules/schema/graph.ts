import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { StructuredData, StructuredNode } from '../../parse/structured-data.ts';
import { pageDocument } from '../helpers.ts';

/** One property value, with nested objects resolved to nodes and `{"@id"}` objects kept as references. */
export type Value =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'node'; readonly node: GraphNode }
  | { readonly kind: 'ref'; readonly id: string }
  | { readonly kind: 'null' };

export interface GraphNode {
  readonly syntax: 'json-ld' | 'microdata';
  /** schema.org type names without prefix; terms of other vocabularies keep their prefix or IRI. */
  readonly types: readonly string[];
  readonly id: string | undefined;
  /** Same convention as the parser: `jsonld[0].@graph[1].offers[0]`, `microdata[0].offers`. */
  readonly path: string;
  readonly line: number;
  readonly schemaOrg: boolean;
  /** Set for nodes that are the value of another node's property. */
  readonly parent: { readonly node: GraphNode; readonly property: string } | undefined;
  /** Property values keyed by schema.org name; keys of other vocabularies keep their prefix or IRI. */
  readonly properties: ReadonlyMap<string, readonly Value[]>;
  /** Terms the node's JSON-LD context defines itself; they are not schema.org terms. */
  readonly customTerms: ReadonlySet<string>;
  /** The object as written, for evidence. */
  readonly raw: unknown;
  /** The JSON-LD block text, for checks on literals JSON.parse normalizes away. */
  readonly blockText: string | undefined;
}

export interface PageGraph {
  readonly nodes: readonly GraphNode[];
  readonly byId: ReadonlyMap<string, readonly GraphNode[]>;
  readonly data: StructuredData;
  readonly doc: DocumentFacts;
  readonly source: 'raw' | 'rendered';
  /** The page URL that relative values resolve against. */
  readonly base: string;
}

const schemaIri = /^(?:https?:\/\/schema\.org\/|schema:)/iu;
// The schema.org context document itself is also accepted as a context IRI.
const schemaContext = /^https?:\/\/schema\.org(?:\/|\/docs\/jsonldcontext\.jsonld?)?$/iu;

export function bareTerm(term: string): string {
  return term.trim().replace(schemaIri, '');
}

/** A term of another vocabulary: a prefixed name or an IRI that is not schema.org. */
export function isExternalTerm(term: string): boolean {
  return term.includes(':') || term.includes('/');
}

function contextIsSchemaOrg(context: unknown): boolean {
  if (typeof context === 'string') return schemaContext.test(context.trim());
  if (Array.isArray(context)) return context.some(contextIsSchemaOrg);
  if (context && typeof context === 'object') {
    const vocab = (context as Record<string, unknown>)['@vocab'];
    return typeof vocab === 'string' && schemaContext.test(vocab.trim());
  }
  return false;
}

function contextTerms(context: unknown, into: Set<string>): void {
  if (Array.isArray(context)) for (const entry of context) contextTerms(entry, into);
  else if (context && typeof context === 'object') for (const key of Object.keys(context)) if (!key.startsWith('@')) into.add(key);
}

interface Scope {
  readonly schemaOrg: boolean;
  readonly terms: ReadonlySet<string>;
  readonly line: number;
  readonly blockText: string;
}

function scopeWith(scope: Scope, record: Record<string, unknown>): Scope {
  if (!('@context' in record)) return scope;
  const terms = new Set(scope.terms);
  contextTerms(record['@context'], terms);
  return { ...scope, schemaOrg: contextIsSchemaOrg(record['@context']), terms };
}

function typesOf(value: unknown): string[] {
  return [value].flat().filter((entry): entry is string => typeof entry === 'string').map(bareTerm).filter(Boolean);
}

function isNodeObject(record: Record<string, unknown>): boolean {
  return Object.keys(record).some(key => key === '@type' || !key.startsWith('@'));
}

class Builder {
  readonly nodes: GraphNode[] = [];

  jsonLd(value: unknown, path: string, scope: Scope, parent: GraphNode['parent']): Value[] {
    if (Array.isArray(value)) return value.flatMap((entry, index) => this.jsonLd(entry, `${path}[${index}]`, scope, parent));
    if (value === null) return [{ kind: 'null' }];
    if (typeof value === 'string') return [{ kind: 'text', value }];
    if (typeof value === 'number') return [{ kind: 'number', value }];
    if (typeof value === 'boolean') return [{ kind: 'boolean', value }];
    if (typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    if ('@value' in record) return this.jsonLd(record['@value'], path, scope, parent);
    if ('@list' in record) return this.jsonLd(record['@list'], path, scope, parent);
    if ('@set' in record) return this.jsonLd(record['@set'], path, scope, parent);
    const inner = scopeWith(scope, record);
    const graph = record['@graph'];
    if (Array.isArray(graph)) graph.forEach((entry, index) => this.jsonLd(entry, `${path}.@graph[${index}]`, inner, undefined));
    else if (graph && typeof graph === 'object') this.jsonLd(graph, `${path}.@graph`, inner, undefined);
    if (!isNodeObject(record)) {
      return typeof record['@id'] === 'string' ? [{ kind: 'ref', id: record['@id'] }] : [];
    }
    const properties = new Map<string, Value[]>();
    const node: GraphNode = {
      syntax: 'json-ld',
      types: typesOf(record['@type']),
      id: typeof record['@id'] === 'string' ? record['@id'] : undefined,
      path,
      line: inner.line,
      schemaOrg: inner.schemaOrg,
      parent,
      properties,
      customTerms: inner.terms,
      raw: record,
      blockText: inner.blockText,
    };
    this.nodes.push(node);
    for (const [key, entry] of Object.entries(record)) {
      if (key.startsWith('@')) continue;
      const name = bareTerm(key);
      const values = this.jsonLd(entry, `${path}.${key}`, inner, { node, property: name });
      properties.set(name, [...(properties.get(name) ?? []), ...values]);
    }
    return [{ kind: 'node', node }];
  }

  microdata(nodes: readonly StructuredNode[]): void {
    const made = new Map<string, GraphNode>();
    const pending: Array<[StructuredNode, Map<string, Value[]>]> = [];
    for (const source of nodes.filter(entry => entry.syntax === 'microdata')) {
      const properties = new Map<string, Value[]>();
      const node: GraphNode = {
        syntax: 'microdata', types: source.types, id: source.id, path: source.path, line: source.line, schemaOrg: source.schemaOrg,
        parent: undefined, properties, customTerms: new Set(), raw: source.properties, blockText: undefined,
      };
      made.set(source.path, node);
      pending.push([source, properties]);
      this.nodes.push(node);
    }
    for (const [source, properties] of pending) {
      for (const [key, entries] of Object.entries(source.properties)) {
        const name = bareTerm(key);
        const values: Value[] = [];
        for (const entry of entries as unknown[]) {
          const childPath = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['@node'] : undefined;
          const child = typeof childPath === 'string' ? made.get(childPath) : undefined;
          if (child) {
            (child as { parent: GraphNode['parent'] }).parent = { node: made.get(source.path)!, property: name };
            values.push({ kind: 'node', node: child });
          } else if (typeof entry === 'string') values.push({ kind: 'text', value: entry });
        }
        properties.set(name, [...(properties.get(name) ?? []), ...values]);
      }
    }
  }
}

/** Builds the page's structured data graph from one document. */
export function buildGraph(doc: DocumentFacts, base: string, source: 'raw' | 'rendered'): PageGraph {
  const builder = new Builder();
  for (const block of doc.data.jsonLd) {
    if (block.value === undefined) continue;
    builder.jsonLd(block.value, `jsonld[${block.index}]`, { schemaOrg: false, terms: new Set(), line: block.line, blockText: block.raw }, undefined);
  }
  builder.microdata(doc.data.nodes);
  const byId = new Map<string, GraphNode[]>();
  for (const node of builder.nodes) if (node.id !== undefined) byId.set(node.id, [...(byId.get(node.id) ?? []), node]);
  return { nodes: builder.nodes, byId, data: doc.data, doc, source, base };
}

const graphs = new WeakMap<DocumentFacts, PageGraph>();

/** The graph of the document rules read: the rendered DOM when it exists, else the raw HTML. */
export function graphOf(page: PageFacts, prefer: 'raw' | 'rendered' = 'rendered'): PageGraph | undefined {
  const doc = pageDocument(page, prefer);
  if (!doc) return undefined;
  const cached = graphs.get(doc);
  if (cached) return cached;
  const graph = buildGraph(doc, page.fetch.finalUrl, doc === page.raw ? 'raw' : 'rendered');
  graphs.set(doc, graph);
  return graph;
}

/** Values of a property, merged across every node on the page that shares this node's @id. */
export function values(graph: PageGraph, node: GraphNode, property: string): Value[] {
  const peers = node.id === undefined ? [node] : graph.byId.get(node.id) ?? [node];
  return peers.flatMap(peer => [...(peer.properties.get(property) ?? [])]);
}

export function has(graph: PageGraph, node: GraphNode, property: string): boolean {
  return values(graph, node, property).some(value => value.kind !== 'null' && !(value.kind === 'text' && value.value.trim() === ''));
}

/** Resolves a value to the node it denotes: a nested node, or the node defined on the page under a referenced @id. */
export function resolve(graph: PageGraph, value: Value): GraphNode | undefined {
  if (value.kind === 'node') return value.node;
  if (value.kind === 'ref') return graph.byId.get(value.id)?.[0];
  return undefined;
}

export function nodesAt(graph: PageGraph, node: GraphNode, property: string): GraphNode[] {
  return values(graph, node, property).map(value => resolve(graph, value)).filter((entry): entry is GraphNode => entry !== undefined);
}

/** Scalar values as text; numbers keep their JSON form. */
export function texts(graph: PageGraph, node: GraphNode, property: string): string[] {
  return values(graph, node, property).flatMap(value => {
    if (value.kind === 'text') return [value.value];
    if (value.kind === 'number' || value.kind === 'boolean') return [String(value.value)];
    if (value.kind === 'ref') return [value.id];
    return [];
  });
}

export function text(graph: PageGraph, node: GraphNode, property: string): string | undefined {
  return texts(graph, node, property).map(entry => entry.trim()).find(Boolean);
}

/**
 * Whether a dotted path such as `offers.price` has a value. Alternatives separated by `|` are tried in turn;
 * a step through a property holding several nodes succeeds when any of them has the rest of the path.
 */
export function hasPath(graph: PageGraph, node: GraphNode, path: string): boolean {
  return path.split('|').some(alternative => {
    const [head, ...rest] = alternative.split('.');
    if (rest.length === 0) return has(graph, node, head!);
    return nodesAt(graph, node, head!).some(child => hasPath(graph, child, rest.join('.')));
  });
}

/** The top-level nodes: not the value of another property. */
export function topLevel(graph: PageGraph): GraphNode[] {
  return graph.nodes.filter(node => node.parent === undefined);
}

/** A short excerpt of what the site wrote for a node or one of its properties. */
export function excerptOf(node: GraphNode, property?: string): string {
  if (property === undefined) return JSON.stringify(node.raw);
  const raw = node.raw as Record<string, unknown>;
  if (node.syntax === 'microdata') return JSON.stringify(raw[property] ?? raw[Object.keys(raw).find(key => bareTerm(key) === property) ?? ''] ?? null);
  const key = Object.keys(raw).find(entry => bareTerm(entry) === property);
  const value = key === undefined ? undefined : raw[key];
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

export function propertyPath(node: GraphNode, property: string): string {
  if (node.syntax === 'microdata') return `${node.path}.${property}`;
  const key = Object.keys(node.raw as Record<string, unknown>).find(entry => bareTerm(entry) === property) ?? property;
  return `${node.path}.${key}`;
}
