import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rules } from '../src/catalog/index.ts';
import { passDefinitions, passSchema, type PassPlan } from '../src/ai/passes.ts';
import { assertStrictSchema, implementedKeywords, keywordsOf, SchemaError, validateSchema, type Schema } from '../src/ai/schema.ts';
import type { PageInfo } from '../src/ai/site.ts';
import { verificationSchema } from '../src/ai/verify.ts';

const page: PageInfo = { key: 'https://example.com/', label: 'P1', url: 'https://example.com/', finalUrl: 'https://example.com/', pageType: 'home', pageTypeReason: 'fixture', role: 'audited' };

function planFor(pass: PassPlan['pass']): PassPlan {
  const category = passDefinitions.find(entry => entry.id === pass)!.category;
  const inScope = rules.filter(rule => rule.category === category && (rule.method === 'hybrid' || rule.method === 'ai-judgment'));
  return { pass, page, sitePage: true, rules: pass === 'serp' ? [] : inScope, candidates: [], facts: [], contextPages: [] };
}

/** Every schema the analysis can send to a provider. */
function sentSchemas(): Schema[] {
  return [...passDefinitions.map(definition => passSchema(planFor(definition.id))), verificationSchema(['V1', 'V2', 'V3'])];
}

describe('strict schema subset', () => {
  test('meta-test: every schema sent to a provider uses only keywords the validator implements', () => {
    for (const schema of sentSchemas()) {
      assertStrictSchema(schema);
      for (const keyword of keywordsOf(schema)) assert.ok(implementedKeywords.includes(keyword), `the validator does not implement ${keyword}`);
    }
  });

  test('rejects any keyword the validator does not implement', () => {
    for (const keyword of ['minimum', 'maximum', 'format', 'oneOf', 'anyOf', 'allOf', '$ref', 'const', 'default', 'uniqueItems', 'patternProperties', 'not']) {
      const schema = { type: 'string', [keyword]: 1 } as unknown as Schema;
      assert.throws(() => assertStrictSchema(schema), SchemaError, keyword);
    }
  });

  test('requires the shape Codex strict output needs at every level', () => {
    const open = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } as unknown as Schema;
    assert.throws(() => assertStrictSchema(open), /additionalProperties/u);
    const optional: Schema = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] };
    assert.throws(() => assertStrictSchema(optional), /every property/u);
    const nested: Schema = { type: 'object', additionalProperties: false, required: ['list'], properties: { list: { type: 'array', items: { type: 'object', properties: {}, required: [] } as unknown as Schema } } };
    assert.throws(() => assertStrictSchema(nested), /additionalProperties/u);
    assert.throws(() => assertStrictSchema({ type: ['string', 'number'] } as unknown as Schema), /one type and null/u);
    assert.throws(() => assertStrictSchema({ type: 'number', enum: ['1'] } as unknown as Schema), /string type/u);
    assert.throws(() => assertStrictSchema({ type: 'array' } as unknown as Schema), /items/u);
    assert.throws(() => assertStrictSchema({ type: 'string', minLength: 5, maxLength: 2 }), /exceeds/u);
  });
});

describe('validateSchema', () => {
  const schema: Schema = {
    type: 'object',
    additionalProperties: false,
    required: ['count', 'ratio', 'flag', 'tags', 'note', 'kind'],
    properties: {
      count: { type: 'integer' },
      ratio: { type: 'number' },
      flag: { type: 'boolean' },
      tags: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[a-z]+$' } },
      note: { type: ['string', 'null'], maxLength: 5 },
      kind: { type: 'string', enum: ['a', 'b'] },
    },
  };
  const valid = { count: 3, ratio: 0.5, flag: false, tags: ['x'], note: null, kind: 'a' };

  test('accepts integers, numbers, booleans and null unions', () => {
    assert.deepEqual(validateSchema(valid, schema), []);
    assert.deepEqual(validateSchema({ ...valid, ratio: 2, note: 'short' }, schema), []);
  });

  test('enforces minItems even when maxItems is absent', () => {
    assert.match(validateSchema({ ...valid, tags: [] }, schema)[0]!, /fewer than 1/u);
    assert.deepEqual(validateSchema({ ...valid, tags: Array.from({ length: 50 }, () => 'x') }, schema), []);
  });

  test('rejects wrong types, extra or missing properties, enum, pattern and length violations', () => {
    assert.match(validateSchema({ ...valid, count: 1.5 }, schema)[0]!, /integer/u);
    assert.match(validateSchema({ ...valid, ratio: Number.NaN }, schema)[0]!, /number/u);
    assert.match(validateSchema({ ...valid, flag: 'false' }, schema)[0]!, /boolean/u);
    assert.match(validateSchema({ ...valid, extra: 1 }, schema)[0]!, /unexpected property/u);
    const { kind: _kind, ...missing } = valid;
    assert.match(validateSchema(missing, schema)[0]!, /missing kind/u);
    assert.match(validateSchema({ ...valid, kind: 'c' }, schema)[0]!, /allowed values/u);
    assert.match(validateSchema({ ...valid, tags: ['X1'] }, schema)[0]!, /pattern/u);
    assert.match(validateSchema({ ...valid, note: 'too long' }, schema)[0]!, /longer than 5/u);
    assert.match(validateSchema({ ...valid, tags: [`a${String.fromCharCode(0)}`] }, schema).join(' '), /NUL/u);
    assert.match(validateSchema([], schema)[0]!, /expected object/u);
  });
});
