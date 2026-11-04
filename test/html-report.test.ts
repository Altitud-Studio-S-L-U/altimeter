import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { rules as catalogRules } from '../src/catalog/index.ts';
import type { CollectResult } from '../src/collect/index.ts';
import { evidenceLabel, EvidenceStore } from '../src/core/evidence.ts';
import { runRules, type RuleImplementation } from '../src/rules/engine.ts';
import { renderHtml } from '../src/report/html.ts';
import { buildReport } from '../src/report/model.ts';
import { page, site } from './support/facts.ts';

const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const rule: RuleImplementation = {
  id: 'content-title-missing',
  evaluate: ({ page: current, evidence }) => ({ outcome: 'fail', severity: 'high', evidence: [evidence.add({ kind: 'html', url: current!.url, label: evidenceLabel('title element'), excerpt: hostile })] }),
};
const rules = catalogRules.map(entry => entry.id === rule.id ? { ...entry, inputs: ['raw-html' as const] } : entry);

function report() {
  const facts = site({ pages: [page(`https://example.com/?q=${encodeURIComponent('"><script>x</script>')}`, { html: `<!doctype html><title>${hostile}</title>` })] });
  const evidence = new EvidenceStore();
  const findings = runRules({ rules: rules.filter(entry => entry.id === rule.id), implementations: new Map([[rule.id, rule]]), site: facts, evidence });
  const collected: CollectResult = { site: facts, versions: {}, warnings: [], durationMs: 1 };
  return buildReport({ collected, findings, evidence, implemented: 1, language: 'en', startedAt: new Date('2026-11-04T10:00:00Z'), targetUrl: [...facts.pages.keys()][0]!, options: {}, rules });
}

test('the HTML report escapes everything taken from the site', () => {
  const html = renderHtml(report(), 'en');
  assert.doesNotMatch(html, /<script>alert/u);
  assert.doesNotMatch(html, /<img src=x/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});

test('the HTML report allows only its own script through the CSP and loads nothing external', () => {
  const html = renderHtml(report(), 'es');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(html)?.[1] ?? '';
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)].map(match => match[1]!);
  assert.equal(scripts.length, 1);
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(scripts[0]!).digest('base64')}'`));
  assert.match(csp, /default-src 'none'/u);
  assert.doesNotMatch(html, /<(?:script|img|link|iframe)[^>]+(?:src|href)="https?:/u);
  assert.match(html, /<html lang="es">/u);
});
