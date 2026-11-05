import snapshot from '../../data/schema-org-vocabulary.json' with { type: 'json' };
import { bareTerm } from './graph.ts';

interface VocabularyFile {
  readonly release: string;
  readonly source: string;
  readonly types: Readonly<Record<string, readonly string[]>>;
  readonly dataTypes: readonly string[];
  readonly properties: Readonly<Record<string, readonly [readonly string[], readonly string[]]>>;
  readonly enumerations: Readonly<Record<string, readonly string[]>>;
  readonly values: readonly string[];
  readonly superseded: Readonly<Record<string, string>>;
  readonly pending: readonly string[];
  readonly attic: readonly string[];
}

const file = snapshot as unknown as VocabularyFile;
const types = new Map(Object.entries(file.types));
const properties = new Map(Object.entries(file.properties));
const dataTypes = new Set(file.dataTypes);
const pending = new Set(file.pending);
const attic = new Set(file.attic);
const memberOf = new Map<string, string[]>();
for (const [enumeration, members] of Object.entries(file.enumerations)) {
  for (const member of members) memberOf.set(member, [...(memberOf.get(member) ?? []), enumeration]);
}
const valueTerms = new Set(file.values);
const ancestorCache = new Map<string, ReadonlySet<string>>();

export const vocabularyRelease = file.release;

export function isType(name: string): boolean {
  return types.has(name);
}

export function isProperty(name: string): boolean {
  return properties.has(name);
}

/** Any term the release defines: a type, a property, an enumeration member or a value such as True. */
export function isTerm(name: string): boolean {
  return types.has(name) || properties.has(name) || memberOf.has(name) || valueTerms.has(name);
}

export function isAtticTerm(name: string): boolean {
  return attic.has(name);
}

export function isPendingTerm(name: string): boolean {
  return pending.has(name);
}

export function supersededBy(name: string): string | undefined {
  return file.superseded[name];
}

/** The type and every type it inherits from. */
export function ancestors(type: string): ReadonlySet<string> {
  const cached = ancestorCache.get(type);
  if (cached) return cached;
  const seen = new Set<string>([type]);
  const queue = [type];
  while (queue.length > 0) {
    for (const parent of types.get(queue.shift()!) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  ancestorCache.set(type, seen);
  return seen;
}

export function isSubtypeOf(type: string, ancestor: string): boolean {
  return ancestors(type).has(ancestor);
}

/** Whether any of the types is the given type or one of its subtypes. */
export function isA(typesOfNode: readonly string[], ancestor: string): boolean {
  return typesOfNode.some(type => isSubtypeOf(type, ancestor));
}

export function isDataType(name: string): boolean {
  return dataTypes.has(name);
}

export function domainsOf(property: string): readonly string[] {
  return properties.get(property)?.[0] ?? [];
}

export function rangesOf(property: string): readonly string[] {
  return properties.get(property)?.[1] ?? [];
}

export function isEnumeration(type: string): boolean {
  return isSubtypeOf(type, 'Enumeration') && type !== 'Enumeration';
}

export function membersOf(enumeration: string): readonly string[] {
  return file.enumerations[enumeration] ?? [];
}

/** Enumerations a value such as `https://schema.org/InStock` belongs to. */
export function enumerationsOfValue(value: string): readonly string[] {
  return memberOf.get(bareTerm(value)) ?? [];
}

export function allTypeNames(): IterableIterator<string> {
  return types.keys();
}

export function allPropertyNames(): IterableIterator<string> {
  return properties.keys();
}

function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** The closest defined term: a case-insensitive match first, then an edit distance of at most two. */
export function suggestion(name: string, candidates: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === lower) return candidate;
    if (name.length < 4) continue;
    const value = distance(lower, candidate.toLowerCase(), 2);
    if (value < bestDistance) {
      best = candidate;
      bestDistance = value;
    }
  }
  return best;
}
