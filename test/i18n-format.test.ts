import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { argumentSignature, format, formatNumber, placeholders, templateProblems } from '../src/i18n/format.ts';

const lines = '{count, plural, =0 {no line} one {# line} other {# lines}} in {file}';

describe('the template engine', () => {
  test('picks the plural branch for the count in the report language, with # as the count', () => {
    assert.deepEqual([0, 1, 2, 12345].map(count => format(lines, { count, file: 'a.log' })), ['no line in a.log', '1 line in a.log', '2 lines in a.log', '12,345 lines in a.log']);
    const spanish = '{count, plural, one {# línea} other {# líneas}}';
    assert.deepEqual([1, 2, 12345, 1000000].map(count => format(spanish, { count }, 'es')), ['1 línea', '2 líneas', '12.345 líneas', '1.000.000 líneas']);
    assert.equal(format(spanish, { count: '1' }, 'es'), '1 línea', 'a count that code wrote as digits still picks its form');
    assert.equal(format('{count, plural, one {# fitxer} other {# fitxers}} de {total}', { count: 1, total: 4 }, 'ca'), '1 fitxer de 4');
  });

  test('writes numbers as each language does, with no group separator in four digits', () => {
    const template = '{share, number, percent} of {total}; CTR {ctr, number, ::percent .0}; confidence {confidence, number, ::.00}; zoom {zoom, number, ::.#}x';
    const params = { share: 0.2, total: 2048, ctr: 0.08, confidence: 1, zoom: 1.5 };
    assert.equal(format(template, params), '20% of 2048; CTR 8.0%; confidence 1.00; zoom 1.5x');
    assert.equal(format(template, params, 'es'), '20\u00a0% of 2048; CTR 8,0\u00a0%; confidence 1,00; zoom 1,5x');
    assert.equal(format(template, params, 'ca'), '20\u00a0% of 2048; CTR 8,0\u00a0%; confidence 1,00; zoom 1,5x');
    assert.deepEqual([format('{n}', { n: 12345.5 }), format('{n}', { n: 12345.5 }, 'ca'), format('{n}', { n: 0.31 }, 'es')], ['12,345.5', '12.345,5', '0,31']);
    assert.deepEqual([formatNumber(1000, 'ca'), formatNumber(0.081, 'es', '::percent .0'), formatNumber(3, 'en', '::.00')], ['1000', '8,1\u00a0%', '3.00']);
    assert.equal(format('{share, number, percent}', { share: '20%' }, 'es'), '20%', 'a value given as text is written as it is');
  });

  test('leaves a missing value and plain braces visible', () => {
    assert.equal(format(lines, { file: 'a.log' }), '{count, plural, =0 {no line} one {# line} other {# lines}} in a.log');
    assert.equal(format('{} and {"a": 1} and # stay', {}), '{} and {"a": 1} and # stay');
  });

  test('lists the values a template fills in, inside plural branches too, with the style of each number', () => {
    const template = '{count, plural, one {# page of {site}} other {# pages of {site}}} ({share, number, ::percent .0})';
    assert.deepEqual(placeholders(template), ['count', 'share', 'site']);
    assert.deepEqual(argumentSignature(template), ['count', 'share:percent .0', 'site']);
    assert.deepEqual(argumentSignature('Pages of {site}: {count} ({share, number, ::percent .0})'), argumentSignature(template));
    assert.notDeepEqual(argumentSignature('{share}'), argumentSignature('{share, number, percent}'));
  });

  test('reports malformed arguments and plural forms the language does not have', () => {
    assert.deepEqual(templateProblems(lines, 'en'), []);
    assert.deepEqual(templateProblems('{count, plural, one {# line}}'), ['{count, plural, ...} has no other branch']);
    assert.deepEqual(templateProblems('{count, plural, one {# line} other {# lines}'), ['{count, plural, ...} has a malformed branch']);
    assert.deepEqual(templateProblems('{count, plural, one {# line} one {# lines} other {}}'), ['{count, plural, ...} repeats its one branch']);
    assert.deepEqual(templateProblems('{count, plurals, one {a} other {b}}'), ['{count, plurals} is not a known argument type']);
    assert.deepEqual(templateProblems('{share, number, percentage}'), ['{share, number, ...} has an unknown style']);
    assert.deepEqual(templateProblems('{count, plural, one {a} few {b} other {c}}', 'es'), ['{count, plural, ...} has a few branch, which es does not use']);
    assert.deepEqual(templateProblems('{count, plural, one {a} many {b} other {c}}', 'ca'), []);
  });
});
