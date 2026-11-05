import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analysisCacheDirectory, cacheKey, cacheTtlMs, clearCache, readCache, writeCache, type CacheKeyInput } from '../src/ai/cache.ts';
import type { Schema } from '../src/ai/schema.ts';
import { sandbox } from './support/providers.ts';

const schema: Schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const input: CacheKeyInput = {
  canonicalPrompt: 'prompt with <<<SITE-DATA NONCE BEGIN>>>',
  provider: 'claude',
  cliVersion: '2.0.59',
  schema,
  catalogSlice: 'rules',
  myths: 'myths',
  rubric: 'rubric',
  keyword: [],
  role: 'analyst',
};

describe('cache keys', () => {
  test('change with everything that can change an answer', () => {
    const base = cacheKey(input);
    assert.match(base, /^[0-9a-f]{64}$/u);
    const variants: Partial<CacheKeyInput>[] = [
      { canonicalPrompt: 'another prompt' }, { provider: 'codex' }, { cliVersion: '2.0.60' }, { model: 'opus' }, { effort: 'high' },
      { schema: { ...schema, properties: { answer: { type: 'string', maxLength: 10 } } } }, { catalogSlice: 'other rules' }, { myths: 'other myths' },
      { rubric: 'other rubric' }, { keyword: ['hotel'] }, { role: 'verifier' },
    ];
    const keys = variants.map(change => cacheKey({ ...input, ...change }));
    assert.equal(new Set([base, ...keys]).size, variants.length + 1);
    assert.equal(cacheKey({ ...input, model: 'default' }), base, 'no model and the default model are the same question');
  });

  test('live in the user cache folder', () => {
    assert.equal(analysisCacheDirectory({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'), 'C:\\Users\\u\\AppData\\Local\\altimeter\\ai-cache');
    assert.equal(analysisCacheDirectory({ HOME: '/home/u' }, 'linux'), '/home/u/.cache/altimeter/ai-cache');
  });
});

describe('cache entries', () => {
  test('hit within seven days, miss and disappear afterwards', async t => {
    const directory = join(await sandbox(t), 'cache');
    const key = cacheKey(input);
    await writeCache(key, schema, { value: { answer: 'yes' }, cliVersion: '2.0.59', costUsd: 0.01 }, { directory, now: () => 1000 });
    assert.deepEqual((await readCache(key, schema, { directory, now: () => 1000 + cacheTtlMs - 1 }))?.value, { answer: 'yes' });
    assert.equal(await readCache(key, schema, { directory, now: () => 1000 + cacheTtlMs }), undefined);
    assert.equal(existsSync(join(directory, key.slice(0, 2), `${key}.json`)), false);
  });

  test('are re-validated on read: a tampered key, a changed schema or a future date is a miss', async t => {
    const directory = join(await sandbox(t), 'cache');
    const key = cacheKey(input);
    const file = join(directory, key.slice(0, 2), `${key}.json`);
    await writeCache(key, schema, { value: { answer: 'yes' }, cliVersion: '2.0.59' }, { directory });
    const stricter: Schema = { ...schema, properties: { answer: { type: 'string', enum: ['no'] } } };
    assert.equal(await readCache(key, stricter, { directory }), undefined);
    await writeCache(key, schema, { value: { answer: 'yes' }, cliVersion: '2.0.59' }, { directory });
    const entry = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...entry, key: 'f'.repeat(64) }));
    assert.equal(await readCache(key, schema, { directory }), undefined);
    await writeCache(key, schema, { value: { answer: 'yes' }, cliVersion: '2.0.59' }, { directory, now: () => Date.now() + 60_000 });
    assert.equal(await readCache(key, schema, { directory }), undefined);
    assert.equal(await readCache('../../etc/passwd', schema, { directory }), undefined);
  });

  test('never store an answer that does not match its schema', async t => {
    const directory = join(await sandbox(t), 'cache');
    const key = cacheKey(input);
    await writeCache(key, schema, { value: { answer: 7 }, cliVersion: '2.0.59' }, { directory });
    assert.equal(await readCache(key, schema, { directory }), undefined);
    assert.equal(await clearCache({ directory }), 0);
  });

  test('clearCache removes every entry and says how many there were', async t => {
    const directory = join(await sandbox(t), 'cache');
    for (const role of ['analyst', 'verifier'] as const) await writeCache(cacheKey({ ...input, role }), schema, { value: { answer: role }, cliVersion: '2.0.59' }, { directory });
    assert.equal(await clearCache({ directory }), 2);
    assert.equal(existsSync(directory), false);
    assert.equal(await clearCache({ directory }), 0);
  });
});
