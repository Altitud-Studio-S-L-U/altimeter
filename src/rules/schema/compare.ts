import { absoluteUrl } from '../helpers.ts';
import { bareTerm, resolve, texts, type GraphNode, type PageGraph } from './graph.ts';
import { parseIsoDate, plainNumber } from './support.ts';

/** Normalizes a value so that equal facts written differently (19.9 and "19.90", InStock and its IRI) compare equal. */
export function normalized(property: string, value: string, base: string): string {
  const trimmed = value.trim();
  const number = plainNumber(trimmed);
  if (number !== undefined) return String(number);
  if (property === 'availability') return bareTerm(trimmed).toLowerCase();
  if (property === 'url') return (absoluteUrl(trimmed, base) ?? trimmed).replace(/\/$/u, '');
  const date = property === 'name' ? undefined : parseIsoDate(trimmed);
  if (date) return String(date.time);
  return trimmed.replace(/\s+/gu, ' ');
}

export interface Flat {
  readonly normal: Set<string>;
  readonly written: Set<string>;
}

/** Compared values of a node and the nodes nested in it, keyed by property path without indexes. */
export function flatten(graph: PageGraph, node: GraphNode, properties: ReadonlySet<string>, prefix = '', depth = 0, out = new Map<string, Flat>()): Map<string, Flat> {
  if (depth > 3) return out;
  for (const property of node.properties.keys()) {
    const path = prefix ? `${prefix}.${property}` : property;
    const written = properties.has(property) ? texts(graph, node, property) : [];
    if (written.length > 0) {
      const entry = out.get(path) ?? { normal: new Set<string>(), written: new Set<string>() };
      for (const value of written) {
        entry.normal.add(normalized(property, value, graph.base));
        entry.written.add(value);
      }
      out.set(path, entry);
    }
    for (const value of node.properties.get(property) ?? []) {
      const child = value.kind === 'node' ? resolve(graph, value) : undefined;
      if (child) flatten(graph, child, properties, path, depth + 1, out);
    }
  }
  return out;
}

export const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(entry => b.has(entry));

