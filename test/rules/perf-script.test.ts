import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  domSize, forcedReflow, legacyDuplicatedJs, longTasks, minification, thirdPartyCost, thirdPartyFacades, totalByteWeight, unusedCode,
} from '../../src/rules/perf/script.ts';
import { page } from '../support/facts.ts';
import { assertExcerpt, assertFail, assertLabel, assertOutcome, check, html, lab, list, opportunity, requests, table } from './perf-fixtures.ts';

const url = 'https://example.com/';
const kib = 1024;

describe('perf-long-tasks', () => {
  const tasks = (durations: number[]) => ({ 'long-tasks': { scoreDisplayMode: 'informative', details: table(durations.map((duration, index) => ({ url: 'https://example.com/app.js', duration, startTime: index * 500 }))) } });

  test('passes moderate main-thread blocking', () => {
    assertOutcome(check(longTasks, page(url, { html: html(''), lighthouse: lab(tasks([120, 90])) })), 'pass');
  });

  test('fails medium and names the busiest scripts with their party', () => {
    const bootup = { 'bootup-time': { details: table([{ url: 'https://example.com/app.js', total: 900 }, { url: 'https://www.googletagmanager.com/gtm.js', total: 400 }]) } };
    const checked = check(longTasks, page(url, { html: html(''), lighthouse: lab({ ...tasks([400, 300, 200]), ...bootup }) }));
    assertFail(checked, 'medium');
    assert.equal(checked.finding.params?.blocking, '750 ms');
    assert.equal(checked.finding.params?.scripts, 'https://example.com/app.js (first party, 900 ms); https://www.googletagmanager.com/gtm.js (third party, 400 ms)');
    assertLabel(checked, /^first-party script with 900 ms of lab execution time /u);
    assertLabel(checked, /^third-party script with 400 ms of lab execution time /u);
    assertExcerpt(checked, /^https:\/\/www\.googletagmanager\.com\/gtm\.js$/u);
  });

  test('is not evaluated without the audit', () => {
    assertOutcome(check(longTasks, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-long-tasks-audit');
  });
});

describe('perf-forced-reflow', () => {
  test('passes without forced reflows', () => {
    assertOutcome(check(forcedReflow, page(url, { html: html(''), lighthouse: lab({ 'forced-reflow-insight': { score: 1, details: list(table([])) } }) })), 'pass');
  });

  test('fails low and lists the call sites', () => {
    const details = list(table([{ source: { type: 'source-location', url: 'https://example.com/menu.js', line: 10, column: 4 }, reflowTime: 42 }]));
    const checked = check(forcedReflow, page(url, { html: html(''), lighthouse: lab({ 'forced-reflow-insight': { score: 0, details } }) }));
    assertFail(checked, 'low');
    assertExcerpt(checked, /^https:\/\/example\.com\/menu\.js$/u);
  });

  test('is not evaluated when the insight did not score', () => {
    assertOutcome(check(forcedReflow, page(url, { html: html(''), lighthouse: lab({ 'forced-reflow-insight': { score: null, scoreDisplayMode: 'notApplicable' } }) })), 'not_evaluated', 'no-forced-reflow-insight');
  });
});

describe('perf-dom-size', () => {
  const dom = (count: number) => `<html><body>${'<div></div>'.repeat(count)}</body></html>`;

  test('passes a small DOM', () => {
    const checked = check(domSize, page(url, { html: html(''), rendered: dom(100) }));
    assertOutcome(checked, 'pass');
    assertLabel(checked, /^elements in the rendered DOM: 103$/u);
  });

  test('fails low above 1400 elements and notes 800 as info', () => {
    const large = check(domSize, page(url, { html: html(''), rendered: dom(1500) }));
    assertFail(large, 'low');
    assert.equal(large.finding.params?.count, 1503);
    assertFail(check(domSize, page(url, { html: html(''), rendered: dom(900) })), 'info', 'warn');
  });

  test('reports costly rendering on a smaller DOM as info, as Lighthouse does not fail it', () => {
    const lighthouse = lab({ 'dom-size-insight': { score: null, scoreDisplayMode: 'informative', numericValue: 700, numericUnit: 'element' } });
    assertFail(check(domSize, page(url, { html: html(''), rendered: dom(500), lighthouse })), 'info', 'costly-rendering');
  });

  test('is not evaluated without the rendered page', () => {
    assertOutcome(check(domSize, page(url, { html: html('') })), 'not_evaluated', 'missing-input:rendered-dom');
  });
});

describe('perf-third-party-cost', () => {
  const insight = (rows: Record<string, unknown>[]) => lab({ 'third-parties-insight': { score: rows.length ? 0 : 1, details: table(rows, { isEntityGrouped: true }) } });

  test('passes light third parties, such as analytics injected only after consent', () => {
    assertOutcome(check(thirdPartyCost, page(url, { html: html(''), lighthouse: insight([{ entity: 'Cookiebot', mainThreadTime: 60, transferSize: 30 * kib }]) })), 'pass');
  });

  test('fails medium on main-thread cost and low on bytes only', () => {
    const busy = check(thirdPartyCost, page(url, { html: html(''), lighthouse: insight([{ entity: 'Google Tag Manager', mainThreadTime: 400, transferSize: 120 * kib }]) }));
    assertFail(busy, 'medium');
    assertExcerpt(busy, /^Google Tag Manager: main thread 400 ms, transfer 120 KiB$/u);
    assertFail(check(thirdPartyCost, page(url, { html: html(''), lighthouse: insight([{ entity: 'YouTube', mainThreadTime: 80, transferSize: 300 * kib }]) })), 'low', 'bytes');
  });

  test('reports a heavy consent manager as optimisation, not removal', () => {
    assertFail(check(thirdPartyCost, page(url, { html: html(''), lighthouse: insight([{ entity: 'OneTrust', mainThreadTime: 300, transferSize: 90 * kib }]) })), 'low', 'consent-manager');
  });

  test('does not apply without third parties and is not evaluated without the insight', () => {
    assertOutcome(check(thirdPartyCost, page(url, { html: html(''), lighthouse: insight([]) })), 'not_applicable', 'no-third-parties');
    assertOutcome(check(thirdPartyCost, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-third-parties-insight');
  });
});

describe('perf-third-party-facades', () => {
  const youtube = (bytes: number) => requests([
    { url: 'https://www.youtube.com/embed/abc', resourceType: 'Document', transferSize: bytes / 2 },
    { url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg', resourceType: 'Image', transferSize: bytes / 2 },
  ]);

  test('does not apply without video or chat embeds', () => {
    assertOutcome(check(thirdPartyFacades, page(url, { html: html(''), lighthouse: lab({ 'network-requests': requests([{ url: 'https://example.com/app.js' }]) }) })), 'not_applicable', 'no-embeds');
  });

  test('passes a light embed', () => {
    assertOutcome(check(thirdPartyFacades, page(url, { html: html(''), lighthouse: lab({ 'network-requests': youtube(40 * kib) }) })), 'pass');
  });

  test('fails low on an embed costing more than 100 KiB before interaction', () => {
    const checked = check(thirdPartyFacades, page(url, { html: html(''), lighthouse: lab({ 'network-requests': youtube(600 * kib) }) }));
    assertFail(checked, 'low');
    assertLabel(checked, /^YouTube player embed loaded before any interaction in the lab load: 2 requests, 600 KiB, 0 ms of main thread /u);
  });

  test('is not evaluated without Lighthouse', () => {
    assertOutcome(check(thirdPartyFacades, page(url, { html: html('') })), 'not_evaluated', 'missing-input:lighthouse');
  });
});

describe('perf-unused-code', () => {
  test('passes small amounts of unused code', () => {
    const lighthouse = lab({ 'unused-javascript': { details: opportunity([], 20 * kib) }, 'unused-css-rules': { details: opportunity([], 10 * kib) } });
    assertOutcome(check(unusedCode, page(url, { html: html(''), lighthouse })), 'pass');
  });

  test('fails low on large unused JavaScript', () => {
    const lighthouse = lab({ 'unused-javascript': { details: opportunity([{ url: 'https://example.com/vendor.js', wastedBytes: 180 * kib }], 200 * kib) } });
    const checked = check(unusedCode, page(url, { html: html(''), lighthouse }));
    assertFail(checked, 'low', 'javascript');
    assertExcerpt(checked, /overallSavingsBytes=204800; https:\/\/example\.com\/vendor\.js \(180 KiB\)/u);
  });

  test('is not evaluated without coverage audits', () => {
    assertOutcome(check(unusedCode, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-coverage-audits');
  });
});

describe('perf-legacy-duplicated-js', () => {
  test('passes modern bundles', () => {
    const lighthouse = lab({ 'legacy-javascript-insight': { score: 1 }, 'duplicated-javascript-insight': { score: 1 } });
    assertOutcome(check(legacyDuplicatedJs, page(url, { html: html(''), lighthouse })), 'pass');
  });

  test('fails low on legacy JavaScript', () => {
    const lighthouse = lab({ 'legacy-javascript-insight': { score: 0, numericValue: 30 * kib, numericUnit: 'byte', details: table([{ url: 'https://example.com/main.js', wastedBytes: 30 * kib }]) } });
    const checked = check(legacyDuplicatedJs, page(url, { html: html(''), lighthouse }));
    assertFail(checked, 'low', 'legacy');
    assert.equal(checked.finding.params?.files, 'https://example.com/main.js');
    assertExcerpt(checked, /numericValue=30720 byte/u);
  });

  test('is not evaluated without the insights', () => {
    assertOutcome(check(legacyDuplicatedJs, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-javascript-insights');
  });
});

describe('perf-minification', () => {
  test('passes small savings', () => {
    assertOutcome(check(minification, page(url, { html: html(''), lighthouse: lab({ 'unminified-css': { details: opportunity([], 2 * kib) } }) })), 'pass');
  });

  test('fails low from 10 KiB', () => {
    const lighthouse = lab({ 'unminified-css': { details: opportunity([], 4 * kib) }, 'unminified-javascript': { details: opportunity([], 11 * kib) } });
    const checked = check(minification, page(url, { html: html(''), lighthouse }));
    assertFail(checked, 'low');
    assert.equal(checked.finding.params?.size, '15 KiB');
    assertExcerpt(checked, /overallSavingsBytes=11264/u);
  });

  test('is not evaluated without the audits', () => {
    assertOutcome(check(minification, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-minification-audits');
  });
});

describe('perf-total-byte-weight', () => {
  const weight = (bytes: number) => lab({ 'total-byte-weight': { numericValue: bytes, numericUnit: 'byte' }, 'network-requests': requests([{ url }, { url: `${url}app.js` }]) });

  test('passes a light page', () => {
    assertOutcome(check(totalByteWeight, page(url, { html: html(''), lighthouse: weight(1000 * kib) })), 'pass');
  });

  test('fails low above 4000 KiB and notes 2667 KiB as info', () => {
    const heavy = check(totalByteWeight, page(url, { html: html(''), lighthouse: weight(5000 * kib) }));
    assertFail(heavy, 'low');
    assert.deepEqual(heavy.finding.params, { size: '5000 KiB', requests: 2 });
    assertExcerpt(heavy, /numericValue=5120000 byte/u);
    assertFail(check(totalByteWeight, page(url, { html: html(''), lighthouse: weight(3000 * kib) })), 'info', 'note');
  });

  test('is not evaluated without the audit', () => {
    assertOutcome(check(totalByteWeight, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-lab-value');
  });
});
