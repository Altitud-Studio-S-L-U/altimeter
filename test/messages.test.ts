import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rule } from '../src/catalog/index.ts';
import { templateProblems } from '../src/i18n/format.ts';
import { findingMessage, format, messagesFor, placeholders } from '../src/i18n/messages.ts';
import { implementations } from '../src/rules/registry.ts';

test('fills placeholders and leaves unknown ones visible', () => {
  assert.equal(format('{count} images lack alt text on {url}', { count: 3, url: '/a' }), '3 images lack alt text on /a');
  assert.equal(format('Missing {value}', {}), 'Missing {value}');
  assert.deepEqual(placeholders('{b} and {a} and {b}'), ['a', 'b']);
});

test('every implemented rule is in the catalog and has an English failure message', () => {
  const english = messagesFor('en');
  for (const id of implementations.keys()) {
    assert.ok(rule(id), `${id} is implemented but not in the catalog`);
    assert.ok(english[id]?.messages.fail, `${id} needs messages.fail in src/i18n/en/rules`);
  }
});

test('English message entries belong to catalog rules and use well-formed templates', () => {
  for (const [id, entry] of Object.entries(messagesFor('en'))) {
    assert.ok(rule(id), `${id} has messages but is not in the catalog`);
    for (const [key, template] of Object.entries(entry.messages)) {
      assert.match(key, /^(pass|fail)(:[a-z0-9-]+)?$/u, `${id}: message key ${key}`);
      assert.equal(template.trim(), template, `${id}.${key} has surrounding whitespace`);
      assert.deepEqual(templateProblems(template, 'en'), [], `${id}.${key} is malformed`);
      assert.doesNotMatch(format(template, Object.fromEntries(placeholders(template).map(name => [name, 2]))), /[{}]/u, `${id}.${key} has a malformed placeholder`);
    }
  }
});

test('falls back to English and to the generic failure message', () => {
  assert.equal(findingMessage('ca', 'unknown-rule', 'fail', undefined), undefined);
});
