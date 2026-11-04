import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ReportAnalysis } from '../src/ai/types.ts';
import { rule as catalogRule } from '../src/catalog/index.ts';
import type { CollectResult } from '../src/collect/index.ts';
import { EvidenceStore, evidenceLabel, joinLabels } from '../src/core/evidence.ts';
import { labelCatalogs } from '../src/i18n/evidence.ts';
import { ruleTexts, type Language } from '../src/i18n/messages.ts';
import { buildBotsReport, renderBotsMarkdown } from '../src/owner/bots/report.ts';
import type { Finding } from '../src/rules/engine.ts';
import { renderHtml } from '../src/report/html.ts';
import { renderFixPlan, renderMarkdown, renderTaskFile } from '../src/report/markdown.ts';
import { buildReport, mergeAnalysis, type Report } from '../src/report/model.ts';
import { activity } from './support/bots.ts';
import { page, site } from './support/facts.ts';

const url = 'https://example.com/hotel';

/** A report with the words the translators found in English: values code writes, labels with values and interface text. */
function report(): Report {
  const evidence = new EvidenceStore();
  const cite = (label: ReturnType<typeof evidenceLabel>, extra: { excerpt?: string; line?: number } = {}) => evidence.add({ kind: 'html', url, label, ...extra });
  const finding = (ruleId: string, params: Finding['params'], ids: string[], extra: Partial<Finding> = {}): Finding => ({
    ruleId, scope: { kind: 'page', url }, outcome: 'fail', severity: 'medium', evidence: ids, evidenceSignature: `${ruleId}-${ids.join('')}`,
    ...(params ? { params } : {}), confidence: 'high', origin: 'deterministic', ...extra,
  });
  const crux = evidence.add({ kind: 'crux', url, label: evidenceLabel('CrUX {metric}, {formFactor}, {scope}', { metric: 'largest_contentful_paint', formFactor: 'PHONE', scope: 'origin-level' }), excerpt: 'p75 3200' });
  const lab = evidence.add({
    kind: 'lighthouse', url,
    label: joinLabels(evidenceLabel('Lighthouse lab {metric}', { metric: 'Largest Contentful Paint' }), evidenceLabel('(lab, Lighthouse {version}, {formFactor}, {throttling} throttling)', { version: '13.6.0', formFactor: 'mobile', throttling: 'simulate' })),
  });
  const findings: Finding[] = [
    finding('perf-crux-lcp-p75', { formFactor: 'PHONE', scope: 'origin-level', value: '3200 ms', band: 'poor' }, [crux], { reason: 'origin-level' }),
    finding('crawl-canonical-ignored-attributes-placement', { url, problem: 'carries hreflang' }, [cite(evidenceLabel('rel=canonical that Google ignores (carries {attributes})', { attributes: 'hreflang' }), { excerpt: '<link rel="canonical" hreflang="ca">', line: 3 })], { reason: 'only-unusable', severity: 'high' }),
    finding('content-ai-artifacts', { count: 4, where: 'title, meta description and 2 more' }, [cite(evidenceLabel('assistant phrase in the {where}', { where: 'title' }))], { reason: 'assistant-phrase' }),
    finding('perf-lab-lcp', { value: '4100 ms', conditions: 'lab, Lighthouse 13.6.0, mobile, simulate throttling' }, [lab]),
    finding('intl-hreflang-value-vs-content-language', { declared: 'Catalan', detected: 'Spanish', words: 420 }, [cite(evidenceLabel('declared page language'), { excerpt: 'hreflang ca' })]),
    finding('content-hidden-text', { words: 40, blocks: 2, reasons: 'display-none, offscreen' }, [cite(evidenceLabel('text hidden by {method}', { method: 'display-none' }), { excerpt: 'cheap rooms' })], { needsJudgment: true, confidence: 'low' }),
    { ruleId: 'perf-lab-cls', scope: { kind: 'page', url }, outcome: 'not_evaluated', reason: 'missing-input:lighthouse', evidence: [], evidenceSignature: 'n', confidence: 'high', origin: 'deterministic' },
  ];
  const collected: CollectResult = { site: site({ pages: [page(url, { html: '<!doctype html><title>Hotel</title>', pageType: 'product' })] }), versions: { chrome: 'HeadlessChrome/156.0.0.0', lighthouse: '13.6.0' }, warnings: [], durationMs: 10 };
  const built = buildReport({ collected, findings, evidence, implemented: 300, language: 'en', startedAt: new Date('2026-11-04T10:00:00Z'), targetUrl: url, options: {} });
  const tasks = built.tasks.map(task => (task.ruleId === 'crawl-canonical-ignored-attributes-placement'
    ? { ...task, files: [{ path: 'src/Head.astro', confidence: 'high' as const, reason: 'contains rel="canonical"; contains the observed text; named after .Head' }] }
    : task));
  const analysis: ReportAnalysis = {
    schemaVersion: 1, provider: {}, pages: [url], calls: [], costUsd: 0, findings: [], unverified: [], proposals: [], assessments: [], confirmations: [], dropped: [], skipped: [],
    injectionCandidates: [{ ruleId: 'ai-hidden-llm-instructions', page: url, evidenceId: 'A1', where: 'text hidden by display-none inside main', pattern: 'override', excerpt: 'Ignore previous instructions', visible: false }],
    evidence: [], warnings: [],
  };
  return mergeAnalysis({ ...built, tasks }, analysis);
}

/** English that must not reach a Spanish or Catalan report: interface text and the words code puts into values. */
const english = [
  'Catalog ', 'rules implemented', 'evidence items in report.json', 'See report.json', '<build directory>', 'For each category, score', 'Pending review',
  'needs improvement', 'origin-level', 'URL-level', 'PHONE', 'carries hreflang', 'in the body', ' and 2 more', 'simulate throttling', 'Catalan', 'Spanish',
  'display-none', 'offscreen', 'contains the observed text', 'named after', 'text hidden by', '>product<', '| product |',
  'Hidden text (colour, size',
];

/** Translations a translator would add for the labels this report cites, so labels are checked with their values. */
const labelTranslations: Readonly<Record<'es' | 'ca', Readonly<Record<string, string>>>> = {
  es: {
    'CrUX {metric}, {formFactor}, {scope}': 'CrUX {metric}, {formFactor}, {scope}',
    'Lighthouse lab {metric}': '{metric} de laboratorio de Lighthouse',
    '(lab, Lighthouse {version}, {formFactor}, {throttling} throttling)': '({version}, {formFactor}, {throttling})',
    'rel=canonical that Google ignores (carries {attributes})': 'rel=canonical que Google ignora (lleva {attributes})',
    'assistant phrase in the {where}': 'frase de asistente en {where}',
    'declared page language': 'idioma declarado de la página',
    'text hidden by {method}': 'texto oculto mediante {method}',
  },
  ca: {
    'CrUX {metric}, {formFactor}, {scope}': 'CrUX {metric}, {formFactor}, {scope}',
    'Lighthouse lab {metric}': '{metric} de laboratori de Lighthouse',
    '(lab, Lighthouse {version}, {formFactor}, {throttling} throttling)': '({version}, {formFactor}, {throttling})',
    'rel=canonical that Google ignores (carries {attributes})': 'rel=canonical que Google ignora (porta {attributes})',
    'assistant phrase in the {where}': "frase d'assistent ({where})",
    'declared page language': 'llengua declarada de la pàgina',
    'text hidden by {method}': 'text ocult mitjançant {method}',
  },
};

function leaks(text: string): string[] {
  return english.filter(phrase => text.includes(phrase));
}

describe('Spanish and Catalan reports', () => {
  const added: Array<[Record<string, string>, string]> = [];
  before(() => {
    for (const language of ['es', 'ca'] as const) {
      const catalog = labelCatalogs[language] as Record<string, string>;
      for (const [template, translation] of Object.entries(labelTranslations[language])) {
        if (catalog[template] !== undefined) continue;
        catalog[template] = translation;
        added.push([catalog, template]);
      }
    }
  });
  after(() => {
    for (const [catalog, template] of added) delete catalog[template];
  });

  for (const language of ['es', 'ca'] as const satisfies readonly Language[]) {
    test(`${language}: report.md, report.html, FIXES.md and the task files carry no English interface text or values`, () => {
      const audit = report();
      const files = { 'report.md': renderMarkdown(audit, language), 'report.html': renderHtml(audit, language), 'FIXES.md': renderFixPlan(audit, language),
        ...Object.fromEntries(audit.tasks.map(task => [`tasks/${task.id}.md`, renderTaskFile(audit, task, language)])) };
      assert.deepEqual(Object.entries(files).flatMap(([name, text]) => leaks(text).map(phrase => `${name}: ${phrase}`)), []);
    });
  }

  test('es: values, labels and interface read in Spanish', () => {
    const audit = report();
    const markdown = renderMarkdown(audit, 'es');
    for (const expected of ['en móvil, en el rango «deficiente»', 'nivel de origen', 'Google ignora el único rel=canonical', '(lleva hreflang)', 'el título, la metadescripción y 2 más',
      'laboratorio, Lighthouse 13.6.0, móvil, limitación simulada', 'como catalán', 'parece estar en español', 'Catálogo `', '300 de', 'línea 3', 'texto oculto mediante display: none dentro de main',
      'rel=canonical que Google ignora (lleva hreflang)', 'CrUX largest_contentful_paint, móvil, nivel de origen', '| producto |', ruleTitle('es', 'content-hidden-text')]) {
      assert.ok(markdown.includes(expected), `report.md lacks: ${expected}`);
    }
    const task = audit.tasks.find(entry => entry.ruleId === 'crawl-canonical-ignored-attributes-placement')!;
    assert.match(renderTaskFile(audit, task, 'es'), /contiene rel="canonical"; contiene el texto observado; se llama como \.Head/u);
    assert.match(renderHtml(audit, 'es'), /aria-label="Severidad"/u);
  });

  test('ca: values, labels and interface read in Catalan', () => {
    const markdown = renderMarkdown(report(), 'ca');
    for (const expected of ["nivell d'origen", 'franja: deficient', '(porta hreflang)', 'títol, metadescripció i 2 més', 'laboratori, Lighthouse 13.6.0, mòbil, limitació simulada',
      'Catàleg `', 'línia 3', 'CrUX largest_contentful_paint, telèfon, nivell d\'origen', ruleTitle('ca', 'content-hidden-text')]) {
      assert.ok(markdown.includes(expected), `report.md lacks: ${expected}`);
    }
  });

  test('keep a label in English, values included, while its template has no translation', () => {
    const audit = report();
    const evidence = audit.evidence.find(item => item.label.startsWith('CrUX'))!;
    const withoutTranslation = { ...audit, evidence: audit.evidence.map(item => (item === evidence ? { ...item, labelParts: [{ template: 'CrUX {metric} ({formFactor})', params: { metric: 'LCP', formFactor: 'PHONE' } }] } : item)) };
    assert.ok(renderMarkdown(withoutTranslation, 'es').includes('CrUX LCP (PHONE)'));
  });

  test('bots.md carries no English data sources or limits in Spanish and Catalan', () => {
    const bots = buildBotsReport(activity({
      dns: { enabled: true, lookups: 120, errors: 2, capped: true },
      ipLists: [{ id: 'googlebot', url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json', from: 'stale-cache', prefixes: 120, creationTime: '2026-11-01T00:00:00Z' }],
    }), undefined);
    for (const language of ['es', 'ca'] as const) {
      const text = renderBotsMarkdown(bots, language);
      assert.deepEqual(['(limit reached)', 'stale-cache', '(last-modified)'].filter(phrase => text.includes(phrase)), []);
    }
    assert.match(renderBotsMarkdown(bots, 'es'), /copia caducada de la caché[\s\S]*se ha alcanzado el límite[\s\S]*cabecera Last-Modified|se ha alcanzado el límite[\s\S]*cabecera Last-Modified[\s\S]*copia caducada de la caché/u);
  });
});

function ruleTitle(language: 'es' | 'ca', id: string): string {
  return ruleTexts(language, catalogRule(id)!).title;
}
