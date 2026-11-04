import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inputIds, notEvaluatedReasons } from '../src/core/types.ts';
import { languages } from '../src/i18n/messages.ts';
import { ui } from '../src/i18n/ui.ts';
import { inputText, notEvaluatedText } from '../src/report/markdown.ts';

const rulesDirectory = fileURLToPath(new URL('../src/rules', import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

describe('the reasons why a check was not evaluated', () => {
  test('are registered wherever a rule returns one, so each has a label (the types also enforce it)', () => {
    const returned = new Set<string>();
    for (const text of sources(rulesDirectory)) {
      for (const match of text.matchAll(/notEvaluated\(\s*([^)]*)\)|outcome: 'not_evaluated', reason: ('[^']*')|missingFieldReason\([^)]*?('[^']*')\)|metricRule\([^)]*?('no-[a-z-]+')/gu)) {
        for (const literal of (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').matchAll(/'([a-z0-9-]+)'/gu)) returned.add(literal[1]!);
      }
    }
    assert.ok(returned.size > 80, `only ${returned.size} reasons found`);
    assert.deepEqual([...returned].filter(reason => !(notEvaluatedReasons as readonly string[]).includes(reason)), []);
  });

  test('have a label in every language, as do the inputs and the reasons the engine adds', () => {
    for (const language of languages) {
      const t = ui(language);
      assert.deepEqual(notEvaluatedReasons.filter(reason => !t.notEvaluatedReasons[reason]?.trim()), [], language);
      assert.deepEqual(inputIds.filter(input => !t.inputs[input]?.trim()), [], language);
    }
  });

  test('read as labels in the reports, with the inputs, the page and the error the engine names', () => {
    assert.equal(notEvaluatedText('no-site-name', 'es'), 'El sitio no declara ningún nombre');
    assert.equal(notEvaluatedText('missing-input:lighthouse,crux', 'en'), 'Inputs that were not available: Lighthouse lab run, Chrome UX Report field data');
    assert.equal(notEvaluatedText('missing-input:rendered-dom', 'ca'), "Dades d'entrada que no estaven disponibles: DOM renderitzat");
    assert.equal(notEvaluatedText('page-not-auditable:fetch-timeout', 'es'), 'No se ha podido auditar la página: la solicitud ha fallado (tiempo de espera agotado)');
    assert.equal(notEvaluatedText('page-not-auditable:challenge-challenge', 'en'), 'The page could not be audited: the CDN answered with a challenge (challenge)');
    assert.equal(notEvaluatedText('page-not-auditable:authentication-required', 'ca'), "No s'ha pogut auditar la pàgina: demana autenticació (HTTP 401)");
    assert.equal(notEvaluatedText('rule-error:Cannot read properties of undefined', 'en'), 'The check stopped on an error: Cannot read properties of undefined');
    assert.equal(notEvaluatedText('a-reason-from-another-version', 'es'), undefined);
    assert.equal(inputText('too-little-text', 'en'), undefined);
    assert.equal(inputText('bot-activity', 'es'), 'actividad de rastreadores');
  });
});
