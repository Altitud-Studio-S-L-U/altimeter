import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cruxAssessment, cruxAvailability, cruxCls, cruxFcp, cruxInp, cruxLcp, cruxNavigationTypes, cruxSoftnav, cruxSubparts, cruxTtfb,
} from '../../src/rules/perf/field.ts';
import { page } from '../support/facts.ts';
import { assertExcerpt, assertFail, assertOutcome, check, crux, goodVitals, html } from './perf-fixtures.ts';

const url = 'https://example.com/';
const withCrux = (spec: Parameters<typeof crux>[0], extra: Parameters<typeof page>[1] = {}) => page(url, { html: html(''), crux: crux(spec), ...extra });

describe('perf-crux-lcp-p75', () => {
  test('passes a good URL-level p75', () => {
    const checked = check(cruxLcp, withCrux({ url: { PHONE: { metrics: goodVitals } } }));
    assertOutcome(checked, 'pass');
    assertExcerpt(checked, /p75=1800 ms/u);
  });

  test('reports phone and desktop separately, never averaged', () => {
    const checked = check(cruxLcp, withCrux({ url: { PHONE: { metrics: { largest_contentful_paint: 4300 } }, DESKTOP: { metrics: { largest_contentful_paint: 2900 } } } }));
    assert.equal(checked.findings.length, 2);
    assertFail(checked, 'high', undefined, checked.findings[0]);
    assert.deepEqual(checked.findings[0]!.params, { formFactor: 'PHONE', scope: 'URL-level', value: '4300 ms', band: 'poor' });
    assertFail(checked, 'medium', undefined, checked.findings[1]);
    assert.equal(checked.findings[1]!.params?.formFactor, 'DESKTOP');
  });

  test('labels origin-level data when the URL has none', () => {
    const checked = check(cruxLcp, withCrux({ origin: { PHONE: { metrics: { largest_contentful_paint: 3100 } } } }));
    assertFail(checked, 'medium', 'origin-level');
    assert.equal(checked.finding.params?.scope, 'origin-level');
  });

  test('is not evaluated when CrUX has no data, which is not a problem', () => {
    assertOutcome(check(cruxLcp, withCrux({})), 'not_evaluated', 'no-field-data');
  });

  test('is not evaluated when CrUX was not queried', () => {
    assertOutcome(check(cruxLcp, page(url, { html: html('') })), 'not_evaluated', 'missing-input:crux');
  });

  test('tells failed queries from missing data', () => {
    assertOutcome(check(cruxLcp, withCrux({ url: { PHONE: 'error', DESKTOP: 'error' }, origin: { PHONE: 'error', DESKTOP: 'error' } })), 'not_evaluated', 'crux-error');
  });
});

describe('perf-crux-inp-p75 and perf-crux-cls-p75', () => {
  test('pass good values', () => {
    assertOutcome(check(cruxInp, withCrux({ url: { PHONE: { metrics: goodVitals } } })), 'pass');
    assertOutcome(check(cruxCls, withCrux({ url: { PHONE: { metrics: goodVitals } } })), 'pass');
  });

  test('fail poor and needs-improvement values with the band', () => {
    const inp = check(cruxInp, withCrux({ url: { PHONE: { metrics: { interaction_to_next_paint: 520 } } } }));
    assertFail(inp, 'high');
    assertExcerpt(inp, /p75=520 ms/u);
    const cls = check(cruxCls, withCrux({ url: { DESKTOP: { metrics: { cumulative_layout_shift: 0.18 } } } }));
    assertFail(cls, 'medium');
    assert.equal(cls.finding.params?.value, 0.18);
  });

  test('are not evaluated without the metric', () => {
    assertOutcome(check(cruxCls, withCrux({ url: { PHONE: { metrics: { largest_contentful_paint: 2000 } } } })), 'not_evaluated', 'no-field-data');
  });

  test('treat missing INP as not evaluated, not as a failure', () => {
    assertOutcome(check(cruxInp, withCrux({ url: { PHONE: { metrics: { largest_contentful_paint: 2000, cumulative_layout_shift: 0.01 } } } })), 'not_evaluated', 'no-inp-data');
  });
});

describe('perf-crux-cwv-assessment', () => {
  test('passes when every available vital is good, with INP missing', () => {
    assertOutcome(check(cruxAssessment, withCrux({ url: { PHONE: { metrics: { largest_contentful_paint: 2000, cumulative_layout_shift: 0.05 } } } })), 'pass');
  });

  test('fails high on phone and medium on desktop with the failing metrics named', () => {
    const checked = check(cruxAssessment, withCrux({ url: {
      PHONE: { metrics: { ...goodVitals, cumulative_layout_shift: 0.3 } },
      DESKTOP: { metrics: { ...goodVitals, largest_contentful_paint: 2600 } },
    } }));
    assertFail(checked, 'high', undefined, checked.findings[0]);
    assert.equal(checked.findings[0]!.params?.metrics, 'CLS 0.30 (poor)');
    assertFail(checked, 'medium', undefined, checked.findings[1]);
    assert.equal(checked.findings[1]!.params?.metrics, 'LCP 2600 ms (needs improvement)');
  });

  test('is not assessable without LCP or CLS data', () => {
    assertOutcome(check(cruxAssessment, withCrux({ url: { PHONE: { metrics: { interaction_to_next_paint: 100 } } } })), 'not_evaluated', 'not-assessable');
  });
});

describe('perf-crux-data-availability', () => {
  test('passes with URL-level data', () => {
    assertOutcome(check(cruxAvailability, withCrux({ url: { PHONE: { metrics: goodVitals } } })), 'pass');
  });

  test('notes origin-only data as info', () => {
    const checked = check(cruxAvailability, withCrux({ origin: { PHONE: { metrics: goodVitals }, DESKTOP: { metrics: goodVitals } } }));
    assertFail(checked, 'info', 'origin-only');
    assert.equal(checked.finding.params?.formFactors, 'PHONE, DESKTOP');
  });

  test('ties missing data to noindex instead of traffic', () => {
    const checked = check(cruxAvailability, page(url, { html: html('<meta name="robots" content="noindex">'), crux: crux({}) }));
    assertFail(checked, 'info', 'not-eligible-noindex');
  });

  test('ties missing data to a non-200 status', () => {
    const checked = check(cruxAvailability, page(url, { html: html(''), status: 404, crux: crux({}) }));
    assertFail(checked, 'info', 'not-eligible-status');
    assertExcerpt(checked, /HTTP 404/u);
  });

  test('is not evaluated when every query failed', () => {
    assertOutcome(check(cruxAvailability, withCrux({ url: { PHONE: 'error', DESKTOP: 'error' }, origin: { PHONE: 'error', DESKTOP: 'error' } })), 'not_evaluated', 'crux-error');
  });
});

describe('perf-crux-fcp-p75 and perf-crux-ttfb-p75', () => {
  test('pass good diagnostics', () => {
    assertOutcome(check(cruxFcp, withCrux({ url: { PHONE: { metrics: { first_contentful_paint: 1500 } } } })), 'pass');
    assertOutcome(check(cruxTtfb, withCrux({ url: { PHONE: { metrics: { experimental_time_to_first_byte: 600 } } } })), 'pass');
  });

  test('keep FCP low and raise TTFB to medium only when LCP is not good', () => {
    assertFail(check(cruxFcp, withCrux({ url: { PHONE: { metrics: { first_contentful_paint: 3500 } } } })), 'low');
    assertFail(check(cruxTtfb, withCrux({ url: { PHONE: { metrics: { experimental_time_to_first_byte: 1200, largest_contentful_paint: 2000 } } } })), 'low');
    const slow = check(cruxTtfb, withCrux({ url: { PHONE: { metrics: { experimental_time_to_first_byte: 1200, largest_contentful_paint: 3000 } } } }));
    assertFail(slow, 'medium');
    assertExcerpt(slow, /p75=1200 ms/u);
  });

  test('cite the round-trip time of the users beside a slow TTFB', () => {
    const checked = check(cruxTtfb, withCrux({ url: { PHONE: { metrics: { experimental_time_to_first_byte: 1900, round_trip_time: 420 } } } }));
    assertFail(checked, 'low');
    assertExcerpt(checked, /^p75=420 ms$/u);
  });

  test('are not evaluated without the metric', () => {
    assertOutcome(check(cruxFcp, withCrux({ url: { PHONE: { metrics: goodVitals } } })), 'not_evaluated', 'no-field-data');
    assertOutcome(check(cruxTtfb, withCrux({ origin: { DESKTOP: { metrics: goodVitals } } })), 'not_evaluated', 'no-field-data');
  });
});

describe('perf-crux-lcp-subparts', () => {
  const subparts = (ttfb: number, delay: number, duration: number, render: number) => ({
    largest_contentful_paint: 4200,
    largest_contentful_paint_image_time_to_first_byte: ttfb,
    largest_contentful_paint_image_resource_load_delay: delay,
    largest_contentful_paint_image_resource_load_duration: duration,
    largest_contentful_paint_image_element_render_delay: render,
  });

  test('passes when shares follow the guideline', () => {
    assertOutcome(check(cruxSubparts, withCrux({ url: { PHONE: { metrics: subparts(1400, 300, 1900, 200) } } })), 'pass');
  });

  test('flags a large load delay with approximate shares', () => {
    const checked = check(cruxSubparts, withCrux({ url: { PHONE: { metrics: subparts(1000, 1500, 1200, 300) } } }));
    assertFail(checked, 'medium');
    assert.match(String(checked.finding.params?.subparts), /resource load delay 38%/u);
    assertExcerpt(checked, /p75=1500 ms/u);
  });

  test('does not apply when LCP is good', () => {
    assertOutcome(check(cruxSubparts, withCrux({ url: { PHONE: { metrics: { ...subparts(1000, 1500, 1200, 300), largest_contentful_paint: 2000 } } } })), 'not_applicable', 'lcp-good');
  });

  test('is not evaluated without subpart data', () => {
    assertOutcome(check(cruxSubparts, withCrux({ url: { PHONE: { metrics: { largest_contentful_paint: 4200 } } } })), 'not_evaluated', 'no-subpart-data');
  });
});

describe('perf-crux-navigation-types', () => {
  test('passes when most history navigations are restored', () => {
    assertOutcome(check(cruxNavigationTypes, withCrux({ url: { PHONE: { navigationTypes: { navigate: 0.8, back_forward: 0.02, back_forward_cache: 0.1 } } } })), 'pass');
  });

  test('flags back/forward navigations that miss the cache', () => {
    const checked = check(cruxNavigationTypes, withCrux({ url: { PHONE: { navigationTypes: { navigate: 0.8, back_forward: 0.09, back_forward_cache: 0.03 } } } }));
    assertFail(checked, 'low');
    assert.equal(checked.finding.params?.backForward, 0.09);
    assertExcerpt(checked, /back_forward=0\.090/u);
  });

  test('ignores a small share of history navigations (5% gate)', () => {
    assertOutcome(check(cruxNavigationTypes, withCrux({ url: { PHONE: { navigationTypes: { navigate: 0.97, back_forward: 0.03, back_forward_cache: 0 } } } })), 'pass');
  });

  test('is not evaluated without navigation types', () => {
    assertOutcome(check(cruxNavigationTypes, withCrux({ url: { PHONE: { metrics: goodVitals } } })), 'not_evaluated', 'no-navigation-types');
  });
});

describe('perf-crux-softnav-experimental', () => {
  test('passes when the experimental metrics stay in the same band', () => {
    assertOutcome(check(cruxSoftnav, withCrux({ url: { PHONE: { metrics: { ...goodVitals, experimental_largest_contentful_paint_with_softnavs: 2100 } } } })), 'pass');
  });

  test('notes a band change as info', () => {
    const checked = check(cruxSoftnav, withCrux({ url: { PHONE: { metrics: { ...goodVitals, experimental_cumulative_layout_shift_with_softnavs: 0.15 } } } }));
    assertFail(checked, 'info');
    assert.match(String(checked.finding.params?.metrics), /CLS 0\.04 vs 0\.15/u);
  });

  test('does not apply without experimental metrics', () => {
    assertOutcome(check(cruxSoftnav, withCrux({ url: { PHONE: { metrics: goodVitals } } })), 'not_applicable', 'no-softnav-data');
  });
});
