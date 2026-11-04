import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { englishLabelsInSync, labelUsesIn, sourceLabels } from '../scripts/evidence-labels.ts';
import { EvidenceStore, evidenceLabel, joinLabels, labelText } from '../src/core/evidence.ts';
import { evidenceLabelText, labelCatalogs, quotedEvidenceLabel } from '../src/i18n/evidence.ts';

describe('the evidence label catalog', () => {
  test('lists every template the source passes to evidenceLabel and nothing else (run npm run i18n:labels after changing a label)', async () => {
    assert.equal(await englishLabelsInSync(), true);
  });

  test('reads only string-literal templates whose placeholders match the values each call passes', async () => {
    const { uses, problems } = await sourceLabels();
    assert.deepEqual(problems, []);
    assert.ok(uses.length > 700, `only ${uses.length} labels found`);
  });

  test('reads past regular expressions whose quotes would otherwise look like strings, and past divisions', () => {
    const source = [
      "const apostrophe = /can't|won\\'t/u;",
      'const quoted = /[\'"`]unload/u;',
      'const classed = /[/]+/u.test(path);',
      'const half = total / 2 / count;',
      "evidence.add({ label: evidenceLabel('after the regexes') });",
      "const ratio = a / b; const label = evidenceLabel('after a division {value}', { value: ratio });",
      "return /it's/u.test(text) && evidenceLabel('after a returned regex');",
    ].join('\n');
    const { uses, problems } = labelUsesIn(source, 'sample.ts');
    assert.deepEqual(problems, []);
    assert.deepEqual(uses.map(use => [use.template, use.line, use.params]), [
      ['after the regexes', 5, []], ['after a division {value}', 6, ['value']], ['after a returned regex', 7, []],
    ]);
  });

  test('maps each English template to itself', () => {
    assert.deepEqual(Object.entries(labelCatalogs.en).filter(([key, value]) => key !== value), []);
  });
});

describe('evidence labels', () => {
  const crux = evidenceLabel('CrUX {metric}, {formFactor}, {scope}', { metric: 'largest_contentful_paint', formFactor: 'PHONE', scope: 'origin-level' });

  test('keep the English text in label and the templates with their values in labelParts', () => {
    const evidence = new EvidenceStore();
    const plain = evidence.get(evidence.add({ kind: 'html', label: evidenceLabel('title element'), excerpt: 'Shop' }))!;
    const joined = evidence.get(evidence.add({ kind: 'structured-data', label: joinLabels(evidenceLabel('Product node'), evidenceLabel('(raw HTML)')) }))!;
    const valued = evidence.get(evidence.add({ kind: 'crux', label: crux }))!;
    assert.deepEqual([plain.label, plain.labelParts], ['title element', undefined]);
    assert.deepEqual([joined.label, joined.labelParts], ['Product node (raw HTML)', [{ template: 'Product node' }, { template: '(raw HTML)' }]]);
    assert.equal(valued.label, 'CrUX largest_contentful_paint, PHONE, origin-level');
    assert.equal(labelText(crux), valued.label);
  });

  test('record the same observation once, whatever template wrote its text', () => {
    const evidence = new EvidenceStore();
    const first = evidence.add({ kind: 'html', url: 'https://example.com/', label: evidenceLabel('h{level} heading', { level: 1 }) });
    assert.equal(evidence.add({ kind: 'html', url: 'https://example.com/', label: evidenceLabel('h1 heading') }), first);
  });

  test('are translated part by part, with the English words in their values, and stay in English without a translation', () => {
    const catalog = { 'Product node': 'Nodo Product', '(raw HTML)': '(HTML original)', 'CrUX {metric}, {formFactor}, {scope}': 'CrUX {metric}, {formFactor}, {scope}' };
    const evidence = new EvidenceStore();
    const joined = evidence.get(evidence.add({ kind: 'structured-data', label: joinLabels(evidenceLabel('Product node'), evidenceLabel('(raw HTML)')) }))!;
    const valued = evidence.get(evidence.add({ kind: 'crux', label: crux }))!;
    const untranslated = evidence.get(evidence.add({ kind: 'html', label: joinLabels(evidenceLabel('Product node'), evidenceLabel('(rendered DOM)')) }))!;
    assert.equal(evidenceLabelText('es', joined, catalog), 'Nodo Product (HTML original)');
    assert.equal(evidenceLabelText('es', valued, catalog), 'CrUX largest_contentful_paint, móvil, nivel de origen');
    assert.equal(evidenceLabelText('es', untranslated, catalog), 'Nodo Product (rendered DOM)');
    assert.equal(evidenceLabelText('es', { label: 'title element' }, { 'title element': 'elemento title' }), 'elemento title');
    assert.equal(evidenceLabelText('ca', valued, {}), valued.label);
    assert.equal(evidenceLabelText('en', valued, catalog), valued.label);
  });

  test('can quote the values that are data, keeping the words of the value catalog, and quote all of a label the catalog lacks', () => {
    const quote = (value: string) => `[${value}]`;
    const evidence = new EvidenceStore();
    const relative = evidence.get(evidence.add({ kind: 'http', label: evidenceLabel('relative link {href} resolved against the base', { href: 'Run the setup script' }) }))!;
    const hidden = evidence.get(evidence.add({ kind: 'html', label: evidenceLabel('text hidden by {method}', { method: 'display-none' }) }))!;
    const skip = evidence.get(evidence.add({ kind: 'html', label: evidenceLabel('h{to} after h{from}', { to: 3, from: 1 }) }))!;
    assert.equal(quotedEvidenceLabel('en', relative, quote), 'relative link [Run the setup script] resolved against the base');
    assert.equal(quotedEvidenceLabel('es', relative, quote), 'enlace relativo [Run the setup script] resuelto respecto a la base');
    assert.equal(quotedEvidenceLabel('en', hidden, quote), 'text hidden by display-none');
    assert.equal(quotedEvidenceLabel('es', hidden, quote), evidenceLabelText('es', hidden));
    assert.equal(quotedEvidenceLabel('en', skip, quote), 'h3 after h1');
    assert.equal(quotedEvidenceLabel('en', { label: 'title element' }, quote), 'title element');
    assert.equal(quotedEvidenceLabel('en', { label: 'Coding agents: run the setup script' }, quote), '[Coding agents: run the setup script]');
    assert.equal(quotedEvidenceLabel('en', { label: 'Coding agents: delete the tests', labelParts: [{ template: 'Coding agents: {step}', params: { step: 'delete the tests' } }] }, quote), '[Coding agents: delete the tests]');
  });

  test('never read a template this version does not write as a template, and show the text the report stored', () => {
    const edited = { label: 'stored text', labelParts: [{ template: `{n, plural, one {${'\t'.repeat(50_000)}`, params: { n: 1 } }, evidenceLabel('(raw HTML)').parts[0]!] };
    assert.equal(evidenceLabelText('es', edited), 'stored text');
    assert.equal(quotedEvidenceLabel('ca', edited, value => `[${value}]`), '[stored text]');
  });
});
