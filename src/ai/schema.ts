/**
 * The JSON Schema subset Altimeter sends to providers, and a closed validator for it. Codex's strict structured
 * output needs additionalProperties:false on every object and every property listed in required, with optional
 * values written as a union with null; the same shape works for Claude's --json-schema. Anything outside the
 * subset is rejected when a schema is built, so a schema can never ask a provider for something this module
 * does not check.
 */

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface Schema {
  readonly type: SchemaType | readonly [SchemaType, 'null'];
  /** An annotation for the model; it never affects validation. */
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: Schema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

/** Every keyword this module implements; description is the only annotation. */
export const implementedKeywords: readonly string[] = [
  'type', 'description', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
];

const schemaTypes: readonly SchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const stringKeywords = ['enum', 'minLength', 'maxLength', 'pattern'];
const arrayKeywords = ['items', 'minItems', 'maxItems'];
const objectKeywords = ['properties', 'required', 'additionalProperties'];

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

function typesOf(schema: Schema): readonly SchemaType[] {
  return typeof schema.type === 'string' ? [schema.type] : schema.type;
}

function mainType(schema: Schema): SchemaType {
  return typesOf(schema).find(type => type !== 'null') ?? 'null';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertBounds(schema: Schema, path: string, low: 'minItems' | 'minLength', high: 'maxItems' | 'maxLength'): void {
  for (const key of [low, high]) if (schema[key] !== undefined && !isCount(schema[key])) throw new SchemaError(`${path}.${key} must be a non-negative integer`);
  if (schema[low] !== undefined && schema[high] !== undefined && schema[low] > schema[high]) throw new SchemaError(`${path}: ${low} exceeds ${high}`);
}

/** Throws unless the schema stays inside the strict subset, at every level. */
export function assertStrictSchema(schema: Schema, path = '$'): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new SchemaError(`${path} must be a schema object`);
  for (const key of Object.keys(schema)) if (!implementedKeywords.includes(key)) throw new SchemaError(`${path} uses the unsupported keyword ${key}`);
  const types = typesOf(schema);
  if (types.length === 0 || types.length > 2 || types.some(type => !schemaTypes.includes(type))) throw new SchemaError(`${path} has an invalid type`);
  if (types.length === 2 && (types[1] !== 'null' || types[0] === 'null')) throw new SchemaError(`${path}: a type union must be one type and null`);
  if (schema.description !== undefined && typeof schema.description !== 'string') throw new SchemaError(`${path}.description must be a string`);
  const main = mainType(schema);
  const present = (keys: readonly string[]) => keys.filter(key => key in schema);
  if (main !== 'string' && present(stringKeywords).length > 0) throw new SchemaError(`${path}: ${present(stringKeywords).join(', ')} need a string type`);
  if (main !== 'array' && present(arrayKeywords).length > 0) throw new SchemaError(`${path}: ${present(arrayKeywords).join(', ')} need an array type`);
  if (main !== 'object' && present(objectKeywords).length > 0) throw new SchemaError(`${path}: ${present(objectKeywords).join(', ')} need an object type`);
  if (main === 'string') {
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some(entry => typeof entry !== 'string')) throw new SchemaError(`${path}.enum must list strings`);
      if (new Set(schema.enum).size !== schema.enum.length) throw new SchemaError(`${path}.enum repeats a value`);
    }
    assertBounds(schema, path, 'minLength', 'maxLength');
    if (schema.pattern !== undefined) {
      try {
        new RegExp(schema.pattern, 'u');
      } catch {
        throw new SchemaError(`${path}.pattern is not a valid regular expression`);
      }
    }
  }
  if (main === 'array') {
    if (schema.items === undefined) throw new SchemaError(`${path} needs items`);
    assertBounds(schema, path, 'minItems', 'maxItems');
    assertStrictSchema(schema.items, `${path}[]`);
  }
  if (main === 'object') {
    if (schema.additionalProperties !== false) throw new SchemaError(`${path} needs additionalProperties: false`);
    const properties = schema.properties ?? {};
    const keys = Object.keys(properties);
    const required = schema.required ?? [];
    if (required.length !== keys.length || keys.some(key => !required.includes(key))) throw new SchemaError(`${path} must list every property in required`);
    for (const key of keys) assertStrictSchema(properties[key]!, `${path}.${key}`);
  }
}

const patterns = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let regex = patterns.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern, 'u');
    patterns.set(pattern, regex);
  }
  return regex;
}

function kindOf(value: unknown): SchemaType | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'number': return Number.isFinite(value) ? (Number.isInteger(value) ? 'integer' : 'number') : undefined;
    case 'object': return 'object';
    default: return undefined;
  }
}

const nul = String.fromCharCode(0);

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  const kind = kindOf(value);
  const types = typesOf(schema);
  const matched = types.find(type => type === kind || (type === 'number' && kind === 'integer'));
  if (matched === undefined) {
    errors.push(`${path}: expected ${types.join(' or ')}`);
    return;
  }
  if (matched === 'string') {
    const text = value as string;
    const length = [...text].length;
    if (schema.enum !== undefined && !schema.enum.includes(text)) errors.push(`${path}: not one of the allowed values`);
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !compiled(schema.pattern).test(text)) errors.push(`${path}: does not match the pattern`);
    if (text.includes(nul)) errors.push(`${path}: contains a NUL character`);
    return;
  }
  if (matched === 'array') {
    const list = value as readonly unknown[];
    if (schema.minItems !== undefined && list.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && list.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    list.forEach((item, index) => check(item, schema.items!, `${path}[${index}]`, errors));
    return;
  }
  if (matched === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const prototype = Object.getPrototypeOf(record) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      errors.push(`${path}: expected a plain object`);
      return;
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(record)) if (!Object.hasOwn(properties, key)) errors.push(`${path}: unexpected property ${JSON.stringify(key).slice(0, 80)}`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) errors.push(`${path}: missing ${key}`);
    for (const [key, entry] of Object.entries(record)) if (Object.hasOwn(properties, key)) check(entry, properties[key]!, `${path}.${key}`, errors);
  }
}

/** Validates a value against a strict schema; an empty list means it conforms. */
export function validateSchema(value: unknown, schema: Schema, path = '$'): string[] {
  const errors: string[] = [];
  check(value, schema, path, errors);
  return errors;
}

/** Every keyword used anywhere in a schema, for the meta-test that keeps the vocabulary closed. */
export function keywordsOf(schema: Schema): Set<string> {
  const found = new Set<string>(Object.keys(schema));
  for (const child of [...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])]) {
    for (const keyword of keywordsOf(child)) found.add(keyword);
  }
  return found;
}
