import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { labCls, labLcp, labPerformanceScore, labRunProtocol, labTbt } from '../../src/rules/perf/lab.ts';
import { page } from '../support/facts.ts';
import { assertExcerpt, assertFail, assertOutcome, check, crux, failedLab, goodVitals, html, lab } from './perf-fixtures.ts';

const url = 'https://example.com/';
const labPage = (audits: Parameters<typeof lab>[0], spec: Parameters<typeof lab>[1] = {}, extra: Parameters<typeof page>[1] = {}) =>
  page(url, { html: html(''), lighthouse: lab(audits, spec), ...extra });

describe('perf-lab-run-protocol', () => {
  test('passes with five valid runs and no warnings', () => {
    const checked = check(labRunProtocol, labPage({}));
    assertOutcome(checked, 'pass');
    assertExcerpt(checked, /validRuns=5/u);
  });

  test('notes fewer runs and run warnings as info', () => {
    const checked = check(labRunProtocol, labPage({}, { runs: 3, validRuns: 3, runWarnings: ['The page loaded too slowly to finish within the time limit.'] }));
    assertFail(checked, 'info', 'few-runs', checked.findings[0]);
    assert.deepEqual(checked.findings[0]!.params, { validRuns: 3, runs: 3, recommended: 5 });
    assertFail(checked, 'info', 'run-warnings', checked.findings[1]);
    assertExcerpt(checked, /too slowly/u, checked.findings[1]);
  });

  test('is not evaluated when Lighthouse failed', () => {
    assertOutcome(check(labRunProtocol, page(url, { html: html(''), lighthouse: failedLab })), 'not_evaluated', 'missing-input:lighthouse');
  });
});

describe('perf-lab-performance-score', () => {
  test('passes from 90', () => {
    assertOutcome(check(labPerformanceScore, labPage({}, { performance: 0.92 })), 'pass');
  });

  test('reports the band as info only', () => {
    const checked = check(labPerformanceScore, labPage({}, { performance: 0.41 }));
    assertFail(checked, 'info', 'poor');
    assertExcerpt(checked, /score=41/u);
    assertFail(check(labPerformanceScore, labPage({}, { performance: 0.7 })), 'info', 'needs-improvement');
  });

  test('is not evaluated without a score', () => {
    assertOutcome(check(labPerformanceScore, labPage({}, { performance: null })), 'not_evaluated', 'no-performance-score');
  });
});

describe('perf-lab-lcp', () => {
  test('passes a good lab LCP', () => {
    assertOutcome(check(labLcp, labPage({ 'largest-contentful-paint': { numericValue: 2100, score: 0.9 } })), 'pass');
  });

  test('grades the lab value and labels it as lab', () => {
    const poor = check(labLcp, labPage({ 'largest-contentful-paint': { numericValue: 5200, score: 0.2 } }));
    assertFail(poor, 'medium');
    assert.match(String(poor.finding.params?.conditions), /^lab, Lighthouse 13\.6\.0, mobile, simulate throttling$/u);
    assertExcerpt(poor, /numericValue=5200/u);
    assertFail(check(labLcp, labPage({ 'largest-contentful-paint': { numericValue: 3000 } })), 'low');
  });

  test('defers to field data, keeping the lab value as an info diagnostic', () => {
    const checked = check(labLcp, labPage({ 'largest-contentful-paint': { numericValue: 5200 } }, {}, { crux: crux({ url: { PHONE: { metrics: goodVitals } } }) }));
    assertFail(checked, 'info', 'field-precedence');
  });

  test('is not evaluated without the audit', () => {
    assertOutcome(check(labLcp, labPage({})), 'not_evaluated', 'no-lab-value');
  });
});

describe('perf-lab-tbt-inp-proxy', () => {
  test('passes moderate blocking on mobile', () => {
    assertOutcome(check(labTbt, labPage({ 'total-blocking-time': { numericValue: 450 } })), 'pass');
  });

  test('uses the desktop control point on desktop runs', () => {
    const checked = check(labTbt, labPage({ 'total-blocking-time': { numericValue: 450 } }, { formFactor: 'desktop' }));
    assertFail(checked, 'medium');
    assert.match(String(checked.finding.params?.conditions), /desktop/u);
    assertFail(check(labTbt, labPage({ 'total-blocking-time': { numericValue: 900 } })), 'medium');
  });

  test('defers to field INP when CrUX has it', () => {
    const checked = check(labTbt, labPage({ 'total-blocking-time': { numericValue: 900 } }, {}, { crux: crux({ origin: { PHONE: { metrics: goodVitals } } }) }));
    assertFail(checked, 'info', 'field-precedence');
  });

  test('is not evaluated without the audit', () => {
    assertOutcome(check(labTbt, labPage({})), 'not_evaluated', 'no-lab-value');
  });
});

describe('perf-lab-cls', () => {
  test('passes a small lab CLS', () => {
    assertOutcome(check(labCls, labPage({ 'cumulative-layout-shift': { numericValue: 0.02 } })), 'pass');
  });

  test('grades the lab CLS', () => {
    const checked = check(labCls, labPage({ 'cumulative-layout-shift': { numericValue: 0.31 } }));
    assertFail(checked, 'medium');
    assert.equal(checked.finding.params?.value, 0.31);
    assertFail(check(labCls, labPage({ 'cumulative-layout-shift': { numericValue: 0.15 } })), 'low');
  });

  test('field data for the other form factor does not take precedence', () => {
    const checked = check(labCls, labPage({ 'cumulative-layout-shift': { numericValue: 0.31 } }, {}, { crux: crux({ url: { DESKTOP: { metrics: goodVitals } } }) }));
    assertFail(checked, 'medium');
  });

  test('is not evaluated without Lighthouse', () => {
    assertOutcome(check(labCls, page(url, { html: html('') })), 'not_evaluated', 'missing-input:lighthouse');
  });
});
