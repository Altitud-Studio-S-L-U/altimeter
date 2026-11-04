import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rules } from '../src/catalog/index.ts';
import { labelCatalogs } from '../src/i18n/evidence.ts';
import { catalogsByCategory, placeholders, type Language } from '../src/i18n/messages.ts';
import { ui } from '../src/i18n/ui.ts';
import { valueCatalogs } from '../src/i18n/values.ts';

const codeSpans = (text: string) => (text.match(/`[^`]+`/gu) ?? []).sort();

/** Differences between an English template catalog and a translation: missing or extra keys and changed placeholders. */
function templateProblems(where: string, english: Readonly<Record<string, string>>, translated: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const [key, template] of Object.entries(english)) {
    const translation = translated[key];
    if (translation === undefined || translation.trim() === '') problems.push(`${where}: "${key}" is not translated`);
    else if (JSON.stringify(placeholders(translation)) !== JSON.stringify(placeholders(template))) problems.push(`${where}: "${key}" has other placeholders`);
    else if (translation.trim() !== translation) problems.push(`${where}: "${key}" has surrounding whitespace`);
  }
  for (const key of Object.keys(translated)) if (!(key in english)) problems.push(`${where}: "${key}" is not an English template`);
  return problems;
}

/** Every string of the report interface, by its path, so a translation can be compared with the English one. */
function uiTexts(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((entry, index) => uiTexts(entry, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => uiTexts(entry, path ? `${path}.${key}` : key));
}

for (const language of ['es', 'ca'] as const satisfies readonly Language[]) {
  describe(`${language} report interface`, () => {
    test('has every string of the English one, with the same placeholders', () => {
      const english = new Map(uiTexts(ui('en')));
      const translated = new Map(uiTexts(ui(language)));
      const problems = [...english].filter(([path, text]) => translated.get(path) === undefined || JSON.stringify(placeholders(translated.get(path)!)) !== JSON.stringify(placeholders(text)))
        .map(([path]) => path);
      assert.deepEqual(problems, []);
    });
  });

  const values = valueCatalogs[language];
  describe(`${language} values that code writes into messages and labels`, { skip: Object.keys(values).length === 0 ? `no ${language} values yet` : false }, () => {
    test('translate every English value of src/i18n/en/values.json with the same placeholders', () => {
      const problems = Object.entries(valueCatalogs.en).flatMap(([section, english]) => templateProblems(`values.${section}`, english, values[section] ?? {}));
      for (const section of Object.keys(values)) if (!(section in valueCatalogs.en)) problems.push(`values.${section} is not an English section`);
      assert.deepEqual(problems, []);
    });
  });

  const labels = labelCatalogs[language];
  describe(`${language} evidence labels`, { skip: Object.keys(labels).length === 0 ? `no ${language} evidence labels yet` : false }, () => {
    test('translate every template of src/i18n/en/evidence.json with the same placeholders', () => {
      assert.deepEqual(templateProblems('evidence', labelCatalogs.en, labels), []);
    });
  });
}

/**
 * A translation must say the same thing in another language: the same message keys, the same placeholders and the
 * same code spans, for every rule that can reach a report. A language is checked once it has any entry, so a new
 * language can be added gradually on its own branch.
 */
for (const language of ['es', 'ca'] as const satisfies readonly Language[]) {
  const translated = Object.values(catalogsByCategory[language]).reduce((sum, catalog) => sum + Object.keys(catalog).length, 0);
  describe(`${language} translations`, { skip: translated === 0 ? `no ${language} translations yet` : false }, () => {
    test('cover the title, why, fix and every message of each rule that can reach a report, in the right file', () => {
      const problems: string[] = [];
      for (const rule of rules.filter(entry => entry.status !== 'planned')) {
        const entry = catalogsByCategory[language][rule.category][rule.id];
        const english = catalogsByCategory.en[rule.category][rule.id];
        if (!entry) {
          problems.push(`${rule.id}: missing in src/i18n/${language}/rules/${rule.category}.json`);
          continue;
        }
        for (const field of ['title', 'why', 'fix'] as const) if (!entry[field]?.trim()) problems.push(`${rule.id}: ${field} is missing`);
        const keys = Object.keys(english?.messages ?? {}).sort();
        if (JSON.stringify(Object.keys(entry.messages).sort()) !== JSON.stringify(keys)) problems.push(`${rule.id}: message keys differ from English`);
      }
      assert.deepEqual(problems, []);
    });

    test('keep the placeholders and code spans of the English text', () => {
      const problems: string[] = [];
      for (const rule of rules.filter(entry => entry.status !== 'planned')) {
        const entry = catalogsByCategory[language][rule.category][rule.id];
        const english = catalogsByCategory.en[rule.category][rule.id];
        if (!entry) continue;
        for (const field of ['title', 'why', 'fix'] as const) {
          if (JSON.stringify(codeSpans(entry[field] ?? '')) !== JSON.stringify(codeSpans(rule[field]))) problems.push(`${rule.id}.${field}: code spans differ`);
        }
        for (const [key, template] of Object.entries(english?.messages ?? {})) {
          const translation = entry.messages[key] ?? '';
          if (JSON.stringify(placeholders(translation)) !== JSON.stringify(placeholders(template))) problems.push(`${rule.id}.${key}: placeholders differ`);
          if (JSON.stringify(codeSpans(translation)) !== JSON.stringify(codeSpans(template))) problems.push(`${rule.id}.${key}: code spans differ`);
          if (translation.trim() !== translation) problems.push(`${rule.id}.${key}: surrounding whitespace`);
        }
      }
      assert.deepEqual(problems, []);
    });

    test('translate only rules of the catalog, under their own category', () => {
      const problems: string[] = [];
      for (const [category, catalog] of Object.entries(catalogsByCategory[language])) {
        for (const id of Object.keys(catalog)) {
          const rule = rules.find(entry => entry.id === id);
          if (!rule) problems.push(`${id}: not in the catalog`);
          else if (rule.category !== category) problems.push(`${id}: belongs in ${rule.category}.json`);
        }
      }
      assert.deepEqual(problems, []);
    });
  });
}
