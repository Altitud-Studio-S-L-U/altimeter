import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rulesDocInSync } from '../scripts/rules-doc.ts';

test('docs/rules.md matches the catalog (run npm run docs:rules after changing it)', async () => {
  assert.equal(await rulesDocInSync(), true);
});
