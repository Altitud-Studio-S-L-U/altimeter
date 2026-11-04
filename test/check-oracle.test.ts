import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOracle } from '../scripts/check-oracle.ts';
import type { Report, ReportFinding } from '../src/report/model.ts';

const finding = (ruleId: string, extra: Partial<ReportFinding> = {}): ReportFinding => ({
  id: `F-${ruleId}`, ruleId, scope: { kind: 'page', url: 'https://example.com/en/' }, outcome: 'fail', severity: 'low', evidence: [], evidenceSignature: ruleId,
  confidence: 'high', origin: 'deterministic', category: 'crawl', title: ruleId, ...extra,
});

const report = { findings: [
  finding('crawl-sitemap-lastmod', { scope: { kind: 'site', origin: 'https://example.com' }, reason: 'missing' }),
  finding('perf-dom-size', { severity: 'medium' }),
  finding('content-hidden-text', { needsJudgment: true, severity: 'medium' }),
] } as unknown as Report;

test('meets present and absent expectations and checks the severity cap', () => {
  const results = checkOracle(report, [
    { ruleId: 'crawl-sitemap-lastmod', expect: 'present', scope: 'site', reason: 'missing' },
    { ruleId: 'perf-dom-size', expect: 'present', maxSeverity: 'info' },
    { ruleId: 'content-hidden-text', expect: 'absent' },
    { ruleId: 'content-hidden-text', expect: 'absent', includeCandidates: true },
    { ruleId: 'schema-breadcrumb', expect: 'present', scope: '/en/services/' },
    { ruleId: 'schema-breadcrumb', expect: 'capped', maxSeverity: 'low' },
    { ruleId: 'perf-dom-size', expect: 'capped', maxSeverity: 'medium' },
  ]);
  assert.deepEqual(results.map(result => [result.ok, result.detail.split(':')[0]]), [
    [true, 'present'], [false, 'above info'], [true, 'absent'], [false, 'reported'], [false, 'missing'], [true, 'absent'], [true, 'present'],
  ]);
});
