import type { DefaultTreeAdapterTypes } from 'parse5';
import { attribute, isElement, textOf, walk, type ParsedHtml } from './html.ts';

type Element = DefaultTreeAdapterTypes.Element;

export type StructuredSyntax = 'json-ld' | 'microdata';

export interface JsonLdBlock {
  readonly index: number;
  readonly line: number;
  readonly inHead: boolean;
  readonly raw: string;
  readonly value?: unknown;
  /** The JSON syntax error, when the block does not parse. */
  readonly error?: string;
}

export interface StructuredNode {
  readonly syntax: StructuredSyntax;
  /** Types with any schema.org prefix removed. */
  readonly types: readonly string[];
  readonly id: string | undefined;
  /** Where the node sits, e.g. `jsonld[0].@graph[1].author`. */
  readonly path: string;
  /** Property values as written; nested nodes keep their own entry in `nodes`. */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly line: number;
  /** JSON-LD only: whether the effective @context is schema.org. Microdata nodes report whether itemtype is a schema.org URL. */
  readonly schemaOrg: boolean;
  /** True for a node nested inside another node's property. */
  readonly nested: boolean;
}

export interface StructuredData {
  readonly jsonLd: readonly JsonLdBlock[];
  readonly nodes: readonly StructuredNode[];
  /** RDFa attributes found (typeof, vocab, or property outside meta elements). Detected, not extracted. */
  readonly rdfa: boolean;
}

const schemaPrefixes = [/^https?:\/\/schema\.org\//iu, /^schema:/iu];

function bareType(type: string): string {
  let bare = type.trim();
  for (const prefix of schemaPrefixes) bare = bare.replace(prefix, '');
  return bare;
}

function isSchemaOrgContext(context: unknown): boolean {
  if (typeof context === 'string') return /^https?:\/\/schema\.org\/?$/iu.test(context.trim());
  if (Array.isArray(context)) return context.some(isSchemaOrgContext);
  if (context && typeof context === 'object') {
    const vocab = (context as Record<string, unknown>)['@vocab'];
    return typeof vocab === 'string' && /^https?:\/\/schema\.org\/?$/iu.test(vocab.trim());
  }
  return false;
}

function typesOf(value: unknown): string[] {
  if (typeof value === 'string') return [bareType(value)];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string').map(bareType);
  return [];
}

function collectJsonLd(value: unknown, path: string, context: unknown, line: number, nested: boolean, out: StructuredNode[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectJsonLd(entry, `${path}[${index}]`, context, line, nested, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const effectiveContext = record['@context'] ?? context;
  const graph = record['@graph'];
  const types = typesOf(record['@type']);
  if (types.length > 0) {
    const properties: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) if (!key.startsWith('@')) properties[key] = entry;
    out.push({
      syntax: 'json-ld',
      types,
      id: typeof record['@id'] === 'string' ? record['@id'] : undefined,
      path,
      properties,
      line,
      schemaOrg: isSchemaOrgContext(effectiveContext),
      nested,
    });
  }
  if (Array.isArray(graph)) graph.forEach((entry, index) => collectJsonLd(entry, `${path}.@graph[${index}]`, effectiveContext, line, false, out));
  for (const [key, entry] of Object.entries(record)) {
    if (key.startsWith('@')) continue;
    if (entry && typeof entry === 'object') collectJsonLd(entry, `${path}.${key}`, effectiveContext, line, types.length > 0 || nested, out);
  }
}

/** The value a microdata property takes from its element, per the HTML standard. */
function microdataValue(element: Element): string {
  const tag = element.tagName;
  if (tag === 'meta') return attribute(element, 'content') ?? '';
  if (['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video'].includes(tag)) return attribute(element, 'src') ?? '';
  if (['a', 'area', 'link'].includes(tag)) return attribute(element, 'href') ?? '';
  if (tag === 'object') return attribute(element, 'data') ?? '';
  if (tag === 'data' || tag === 'meter') return attribute(element, 'value') ?? '';
  if (tag === 'time') return attribute(element, 'datetime') ?? textOf(element);
  return textOf(element);
}

function microdataNode(element: Element, path: string, nested: boolean, out: StructuredNode[]): void {
  const itemtype = attribute(element, 'itemtype') ?? '';
  const properties: Record<string, unknown[]> = {};
  const node: StructuredNode = {
    syntax: 'microdata',
    types: itemtype.split(/\s+/u).filter(Boolean).map(bareType),
    id: attribute(element, 'itemid'),
    path,
    properties,
    line: element.sourceCodeLocation?.startLine ?? 0,
    schemaOrg: itemtype.split(/\s+/u).filter(Boolean).every(type => /^https?:\/\/schema\.org\//iu.test(type)) && itemtype.trim() !== '',
    nested,
  };
  out.push(node);
  walk(element, child => {
    if (!isElement(child)) return;
    const names = (attribute(child, 'itemprop') ?? '').split(/\s+/u).filter(Boolean);
    const scoped = attribute(child, 'itemscope') !== undefined;
    for (const name of names) {
      if (scoped) {
        const childPath = `${path}.${name}`;
        properties[name] = [...(properties[name] ?? []), { '@node': childPath }];
        microdataNode(child, childPath, true, out);
      } else {
        properties[name] = [...(properties[name] ?? []), microdataValue(child)];
      }
    }
    // A nested item owns the properties inside it.
    return !scoped;
  });
}

export function extractStructuredData(parsed: ParsedHtml): StructuredData {
  const jsonLd: JsonLdBlock[] = [];
  const nodes: StructuredNode[] = [];
  parsed.scripts
    .filter(script => (script.attrs.type ?? '').split(';')[0]!.trim().toLowerCase() === 'application/ld+json')
    .forEach((script, index) => {
      const raw = script.text;
      try {
        const value: unknown = JSON.parse(raw);
        jsonLd.push({ index, line: script.line, inHead: script.inHead, raw, value });
        collectJsonLd(value, `jsonld[${index}]`, undefined, script.line, false, nodes);
      } catch (error) {
        jsonLd.push({ index, line: script.line, inHead: script.inHead, raw, error: error instanceof Error ? error.message : 'Invalid JSON' });
      }
    });

  let rdfa = false;
  let microdataIndex = 0;
  walk(parsed.document, node => {
    if (!isElement(node)) return;
    if (attribute(node, 'typeof') !== undefined || attribute(node, 'vocab') !== undefined
      || (attribute(node, 'property') !== undefined && node.tagName !== 'meta')) rdfa = true;
    if (attribute(node, 'itemscope') !== undefined && attribute(node, 'itemprop') === undefined) {
      microdataNode(node, `microdata[${microdataIndex++}]`, false, nodes);
      return false;
    }
  });
  return { jsonLd, nodes, rdfa };
}

/** Nodes whose types include `type`, across syntaxes. */
export function nodesOfType(data: StructuredData, type: string): StructuredNode[] {
  return data.nodes.filter(node => node.types.includes(type));
}
