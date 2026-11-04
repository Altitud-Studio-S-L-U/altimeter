/** Small builders for international fixtures: pages with hreflang sets and text in a given language. */
import assert from 'node:assert/strict';
import type { EvidenceStore } from '../../src/core/evidence.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { samples } from './intl-language-samples.ts';

export const origin = 'https://example.com';
export const url = (path: string) => new URL(path, origin).href;

/** About 280 words of running text in `language`, from the labelled samples. */
export function prose(language: string): string {
  const texts = samples.filter(sample => sample.language === language).map(sample => sample.text);
  return [...texts, ...texts].map(text => `<p>${text}</p>`).join('\n');
}

export interface DocSpec {
  readonly lang?: string;
  readonly head?: string;
  readonly body?: string;
  readonly title?: string;
}

export function html(spec: DocSpec = {}): string {
  const lang = spec.lang === undefined ? '' : ` lang="${spec.lang}"`;
  return `<!doctype html><html${lang}><head><meta charset="utf-8"><title>${spec.title ?? 'Page'}</title>\n${spec.head ?? ''}\n</head><body><main>${spec.body ?? ''}</main></body></html>`;
}

export function links(entries: ReadonlyArray<readonly [string, string]>): string {
  return entries.map(([value, href]) => `<link rel="alternate" hreflang="${value}" href="${href}">`).join('\n');
}

/** A complete reciprocal set over the given versions, as each member would declare it. */
export function cluster(versions: Readonly<Record<string, string>>, xDefault?: string): string {
  return links([...Object.entries(versions), ...(xDefault ? [['x-default', xDefault] as const] : [])]);
}

export function only(findings: readonly Finding[]): Finding {
  assert.equal(findings.length, 1, `expected one finding, got ${findings.map(entry => `${entry.outcome}:${entry.reason ?? ''}`).join(', ')}`);
  return findings[0]!;
}

export function excerpts(finding: Finding, evidence: EvidenceStore): string[] {
  return finding.evidence.map(id => evidence.get(id)?.excerpt ?? '');
}

export function assertFail(finding: Finding | undefined, severity: string, reason?: string): void {
  assert.ok(finding, 'expected a finding');
  assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', severity, reason], `got ${finding.outcome} ${finding.severity} ${finding.reason}`);
}

export function assertOutcome(finding: Finding | undefined, outcome: string, reason?: string): void {
  assert.ok(finding, 'expected a finding');
  assert.deepEqual([finding.outcome, finding.reason], [outcome, reason], `got ${finding.outcome} ${finding.severity ?? ''} ${finding.reason ?? ''}`);
}

export function sitemap(entries: ReadonlyArray<{ readonly loc: string; readonly alternates?: ReadonlyArray<readonly [string, string]> }>): string {
  const body = entries.map(entry => `<url><loc>${entry.loc}</loc>${(entry.alternates ?? []).map(([value, href]) => `<xhtml:link rel="alternate" hreflang="${value}" href="${href}"/>`).join('')}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${body}\n</urlset>`;
}
