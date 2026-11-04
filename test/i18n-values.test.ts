import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findingMessage, format } from '../src/i18n/messages.ts';
import { ui } from '../src/i18n/ui.ts';
import { languageParams, listParams, localizeParams, localizeValue, splitList, valueCatalogs } from '../src/i18n/values.ts';
import { summarizeList } from '../src/rules/helpers.ts';

const rulesDirectory = fileURLToPath(new URL('../src/rules', import.meta.url));
const sourceDirectory = fileURLToPath(new URL('../src', import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

describe('translating the values of messages and labels', () => {
  test('translates fixed English words and keeps data as it is', () => {
    const params = { band: 'needs improvement', scope: 'origin-level', formFactor: 'PHONE', value: '3200 ms', url: 'https://example.com/poor', title: 'Poor and 3 more', count: 3 };
    assert.deepEqual(localizeParams('es', params), { ...params, band: '«necesita mejorar»', scope: 'nivel de origen', formFactor: 'móvil' });
    assert.deepEqual(localizeParams('ca', params), { ...params, band: 'cal millorar', scope: "nivell d'origen", formFactor: 'telèfon' });
    assert.deepEqual(localizeParams('en', params), params);
  });

  test('translates each item of a list and the ending summarizeList writes', () => {
    assert.equal(localizeValue('es', 'where', 'title, meta description and 2 more'), 'el título, la metadescripción y 2 más');
    assert.equal(localizeValue('ca', 'urls', 'https://a.example/, https://b.example/ and 4 more'), 'https://a.example/, https://b.example/ i 4 més');
    assert.equal(localizeValue('es', 'reasons', 'display-none, offscreen'), 'display: none, fuera de la pantalla');
  });

  test('fills patterns whose parts are translated by their own names, without matching across list items', () => {
    assert.equal(localizeValue('es', 'conditions', 'lab, Lighthouse 13.6.0, mobile, simulate throttling'), 'laboratorio, Lighthouse 13.6.0, móvil, limitación simulada');
    assert.equal(localizeValue('ca', 'metrics', 'LCP 3200 ms (needs improvement), CLS 0.31 (poor)'), 'LCP 3200 ms (cal millorar), CLS 0,31 (deficient)');
    assert.equal(localizeValue('es', 'entities', 'Tag Manager: main thread 120 ms, transfer 45 KiB; Widget: main thread 80 ms, transfer 30 KiB'),
      'Tag Manager: hilo principal 120 ms, transferencia 45 KiB; Widget: hilo principal 80 ms, transferencia 30 KiB');
    assert.equal(localizeValue('ca', 'operators', 'OpenAI (OAI-SearchBot blocked, GPTBot allowed) and 1 more'), 'OpenAI (OAI-SearchBot bloquejat, GPTBot permès) i 1 més');
    assert.equal(localizeValue('es', 'aiItem', 'text hidden by display-none inside main'), 'texto oculto mediante display: none dentro de main');
  });

  test('names languages with Intl.DisplayNames and leaves codes alone', () => {
    assert.equal(localizeValue('es', 'detected', 'Catalan'), 'catalán');
    assert.equal(localizeValue('ca', 'declared', 'Spanish, English and 1 more'), 'castellà, anglès i 1 més');
    assert.equal(localizeValue('es', 'language', 'pt-BR'), 'pt-BR');
  });

  test('reads a section of one rule before the section of the parameter', () => {
    assert.equal(localizeValue('es', 'problem', 'svg', 'tech-favicon-file-valid'), 'es un SVG');
    assert.equal(localizeValue('es', 'problem', 'svg'), 'svg');
  });

  test('names what ended the head early for the hreflang rule, and leaves the site text the head rule quotes alone', () => {
    const message = (language: 'es' | 'ca', cause: string) => findingMessage(language, 'intl-hreflang-outside-head', 'fail', 'raw-body', { count: 2, line: 7, cause });
    assert.match(message('es', '<div> element')!, /línea 7 \(elemento <div>\)/u);
    assert.match(message('ca', 'text content')!, /línia 7 \(contingut de text\)/u);
    assert.match(message('es', 'not determined')!, /\(sin determinar\)/u);
    assert.equal(localizeValue('es', 'cause', 'text content', 'crawl-head-invalid-element'), 'text content');
  });

  test('gives a translated message translated values and the English message the English ones', () => {
    const params = { formFactor: 'PHONE', scope: 'origin-level', value: '3200 ms', band: 'poor' };
    assert.match(findingMessage('es', 'perf-crux-lcp-p75', 'fail', undefined, params)!, /en móvil \(datos de CrUX: nivel de origen\), en el rango «deficiente»/u);
    assert.match(findingMessage('en', 'perf-crux-lcp-p75', 'fail', undefined, params)!, /on PHONE \(origin-level CrUX data\), in the poor range/u);
  });

  test('splits lists only outside parentheses and quotes', () => {
    assert.deepEqual(splitList('a (b, c), "d, e", f'), ['a (b, c)', '"d, e"', 'f']);
    assert.deepEqual(splitList('a; b, c', '; '), ['a', 'b, c']);
  });

  test('translates warnings as whole sentences, with a prefix before them', () => {
    const proxy = 'access.log: 85% of its requests come from one or two addresses, which looks like a proxy or load balancer, so its addresses were not used to verify crawlers. Log the client address and pass --ip-source.';
    assert.match(localizeValue('es', 'warning', `Crawler activity: ${proxy}`), /^Actividad de rastreadores: access\.log: el 85\u00a0% de sus solicitudes vienen de una o dos direcciones, lo que parece un proxy/u);
    assert.equal(localizeValue('ca', 'warning', 'analyst call C3 (content) failed: no answer'), 'Crida C3 (analista, content) fallida: sense resposta');
    assert.equal(localizeValue('es', 'warning', 'Lighthouse did not complete: Target closed, retry'), 'Lighthouse no ha terminado: Target closed, retry');
    assert.equal(localizeValue('es', 'warning', 'A warning nobody translated yet.'), 'A warning nobody translated yet.');
  });

  test('reads the list ending that summarizeList writes', () => {
    const list = summarizeList(['a', 'b', 'c', 'd'], 2);
    assert.equal(list, format(ui('en').moreItems, { items: 'a, b', count: 2 }));
    assert.equal(localizeValue('es', 'urls', list), format(ui('es').moreItems, { items: 'a, b', count: 2 }));
  });
});

describe('the value catalogs', () => {
  test('map each English value to itself in English, without surrounding whitespace', () => {
    const problems = Object.entries(valueCatalogs.en).flatMap(([section, values]) => Object.entries(values)
      .filter(([key, value]) => key !== value || key.trim() !== key || key === '')
      .map(([key]) => `${section}: ${key}`));
    assert.deepEqual(problems, []);
  });

  test('give every pattern fixed text, so its parts cannot take the whole value', () => {
    const problems = Object.entries(valueCatalogs.en).flatMap(([section, values]) => Object.keys(values)
      .filter(key => key.includes('{') && key.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/gu, '').trim() === '')
      .map(key => `${section}: ${key}`));
    assert.deepEqual(problems, []);
  });

  test('know every parameter that rules fill from summarizeList, so its ending is translated', () => {
    const names = new Set<string>();
    for (const text of sources(rulesDirectory)) {
      for (const match of text.matchAll(/\b([A-Za-z]+): (?:[^,{}]*\? )?(?:summarizeList|summarizeUrls|list|names)\(/gu)) names.add(match[1]!);
    }
    names.delete('excerpt');
    const missing = [...names].filter(name => !listParams.has(name) && ![...listParams].some(entry => entry.endsWith(`/${name}`)));
    assert.deepEqual(missing, []);
  });

  test('know every warning that code writes with a fixed sentence', () => {
    const normalize = (template: string) => template.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/gu, '{}');
    const known = new Set(Object.keys(valueCatalogs.en.warning ?? {}).map(normalize));
    // Warnings whose wording code picks from a few fixed variants; the catalog lists each variant.
    for (const variants of ['{} could not be read: {}', '{} later request{} not sent after Bing Webmaster Tools throttled the requests.', '{} records no user agent{}, so crawlers cannot be identified in it.', '{} analysis call{} left out to stay within the call limit.', 'Cloudflare keeps {} day{} of this data for the zone, so the window starts on {}.', 'Cloudflare allows {} hour{} per query and Altimeter makes at most {} queries per run, so only the data from {} was read.']) known.add(variants);
    const pushed = /(?:warnings\.push|unavailable\.push)\(\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\s*\)|\.\.\.collected\.warnings, (?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\]/gu;
    const missing: string[] = [];
    let checked = 0;
    for (const text of sources(sourceDirectory)) {
      for (const match of text.matchAll(pushed)) {
        const literal = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
        const template = literal.replace(/\\'/gu, '\'').replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/gu, '{}');
        checked += 1;
        if (!known.has(template)) missing.push(template);
      }
    }
    assert.ok(checked >= 20, `only ${checked} warnings found`);
    assert.deepEqual(missing, []);
  });

  test('know every parameter that holds a language name', () => {
    const names = new Set<string>();
    for (const text of sources(rulesDirectory)) for (const match of text.matchAll(/\b([A-Za-z]+): (?:list\()?(?:[a-z.]+\.map\()?languageLabel\b/gu)) names.add(match[1]!);
    assert.ok(names.size >= 6, [...names].join(', '));
    assert.deepEqual([...names].filter(name => !languageParams.has(name)), []);
  });
});
