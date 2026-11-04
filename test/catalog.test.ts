import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catalogHash, myths, rules, rulesByCategory } from '../src/catalog/index.ts';
import { catalogProblems, mythProblems, ruleProblems } from '../src/catalog/validate.ts';
import type { RuleMeta } from '../src/core/types.ts';

describe('rule catalog', () => {
  test('every rule and myth is valid and ids are unique', () => {
    assert.deepEqual(catalogProblems(rules, myths), []);
  });

  test('each rule is stored in the file of its category', () => {
    for (const [category, entries] of Object.entries(rulesByCategory)) {
      for (const entry of entries) assert.equal(entry.category, category, `${entry.id} is stored under ${category}`);
    }
  });

  test('the catalog hash is a SHA-256 hex digest', () => {
    assert.match(catalogHash, /^[0-9a-f]{64}$/u);
  });
});

describe('catalog validation', () => {
  const valid: RuleMeta = {
    id: 'crawl-example-rule',
    category: 'crawl',
    title: 'Example rule',
    why: 'Explains why the behavior matters.',
    fix: 'Explains what to change.',
    maxSeverity: 'medium',
    method: 'deterministic',
    scope: 'page',
    inputs: ['raw-html'],
    appliesTo: 'all',
    exemptWhen: [],
    fpRisk: 'low',
    scored: true,
    evidenceLevel: 'official-google',
    thresholds: 'Fails when the example condition holds.',
    sources: [{ url: 'https://developers.google.com/search/docs', verified: '2026-11-03' }],
    status: 'v1',
  };

  test('accepts a complete rule', () => {
    assert.deepEqual(ruleProblems(valid), []);
  });

  test('rejects an id outside its category prefix', () => {
    assert.match(ruleProblems({ ...valid, id: 'content-example-rule' }).join('\n'), /id must be <category>-<kebab-slug>/u);
  });

  test('rejects unknown fields and inputs', () => {
    const problems = ruleProblems({ ...valid, weight: 3, inputs: ['html'] }).join('\n');
    assert.match(problems, /unknown field weight/u);
    assert.match(problems, /known input ids/u);
  });

  test('requires https sources with a verification date', () => {
    const problems = ruleProblems({ ...valid, sources: [{ url: 'http://example.com', verified: 'last week' }] }).join('\n');
    assert.match(problems, /https URL/u);
    assert.match(problems, /YYYY-MM-DD verified date/u);
    assert.match(ruleProblems({ ...valid, sources: [] }).join('\n'), /at least one source/u);
  });

  test('keeps model judgments and info rules out of the score', () => {
    assert.match(ruleProblems({ ...valid, method: 'ai-judgment' }).join('\n'), /ai-judgment rules cannot be scored/u);
    assert.match(ruleProblems({ ...valid, maxSeverity: 'info' }).join('\n'), /info rules cannot be scored/u);
  });

  test('flags owner-data rules marked as v1', () => {
    assert.match(ruleProblems({ ...valid, method: 'owner-data', inputs: ['gsc'] }).join('\n'), /requires-owner-data/u);
  });

  test('reports duplicate ids and dangling related rules', () => {
    const problems = catalogProblems([valid, { ...valid, related: ['crawl-missing-rule'] }], []).join('\n');
    assert.match(problems, /duplicate rule id/u);
    assert.match(problems, /related rule crawl-missing-rule does not exist/u);
  });

  test('validates myths', () => {
    const myth = { id: 'meta-keywords', claim: 'Meta keywords help ranking.', reality: 'Google does not use them.',
      sources: [{ url: 'https://developers.google.com/search/blog', verified: '2026-11-03' }], patterns: ['meta keywords'] };
    assert.deepEqual(mythProblems(myth), []);
    assert.match(mythProblems({ ...myth, patterns: ['Meta Keywords'] }).join('\n'), /lowercase phrases/u);
  });
});
