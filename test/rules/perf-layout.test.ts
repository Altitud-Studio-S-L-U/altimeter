import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clsCulprits, consentLabBias, embedReservedSpace, nonCompositedAnimations, unsizedImages } from '../../src/rules/perf/layout.ts';
import { page } from '../support/facts.ts';
import { assertExcerpt, assertFail, assertOutcome, breakdown, check, html, lab, list, node, table } from './perf-fixtures.ts';

const url = 'https://example.com/';

describe('perf-unsized-images', () => {
  const audit = (items: Record<string, unknown>[]) => lab({ 'unsized-images': { score: items.length ? 0 : 1, scoreDisplayMode: 'metricSavings', details: table(items) } });

  test('passes when every image is sized', () => {
    assertOutcome(check(unsizedImages, page(url, { html: html(''), lighthouse: audit([]) })), 'pass');
  });

  test('fails medium for an unsized image in the first viewport', () => {
    const checked = check(unsizedImages, page(url, { html: html(''), lighthouse: audit([{ url: 'https://example.com/team.jpg', node: node('<img src="/team.jpg" alt="Team">', 'main > img', 300) }]) }));
    assertFail(checked, 'medium');
    assert.deepEqual(checked.finding.params, { count: 1, aboveFold: 1 });
    assertExcerpt(checked, /<img src="\/team\.jpg"/u);
  });

  test('fails low when unsized images are only below the fold', () => {
    assertFail(check(unsizedImages, page(url, { html: html(''), lighthouse: audit([{ url: 'https://example.com/map.png', node: node('<img src="/map.png">', 'footer img', 2400) }]) })), 'low', 'below-fold');
  });

  test('is not evaluated without the audit', () => {
    assertOutcome(check(unsizedImages, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-unsized-images-audit');
  });
});

const cluster = (score: number, causes: Array<{ cause: string; value: string }> = []) => table([
  { node: { type: 'text', value: 'Total' }, score },
  { node: node('<section class="pricing">', 'main > section.pricing'), score, ...(causes.length ? { subItems: { type: 'subitems', items: causes.map(entry => ({ cause: entry.cause, extra: { type: 'url', value: entry.value } })) } } : {}) },
]);

describe('perf-cls-culprits', () => {
  const audit = (...tables: Record<string, unknown>[]) => lab({ 'cls-culprits-insight': { score: 0, scoreDisplayMode: 'metricSavings', details: list(...tables) }, 'cumulative-layout-shift': { numericValue: 0.02 } });

  test('passes small clusters', () => {
    assertOutcome(check(clsCulprits, page(url, { html: html(''), lighthouse: audit(cluster(0.03)) })), 'pass');
  });

  test('fails medium with the root cause Lighthouse attributed', () => {
    const checked = check(clsCulprits, page(url, { html: html(''), lighthouse: audit(cluster(0.18, [{ cause: 'Web font', value: 'https://example.com/brand.woff2' }])) }));
    assertFail(checked, 'medium');
    assertExcerpt(checked, /^cluster score=0\.180$/u);
    assertExcerpt(checked, /^Web font: https:\/\/example\.com\/brand\.woff2$/u);
  });

  test('hands a cluster without a root cause to the analyst', () => {
    const checked = check(clsCulprits, page(url, { html: html(''), lighthouse: audit(cluster(0.07)) }));
    assertFail(checked, 'low', 'no-root-cause');
    assert.equal(checked.finding.needsJudgment, true);
  });

  test('is not evaluated without the insight', () => {
    assertOutcome(check(clsCulprits, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-cls-culprits');
  });
});

describe('perf-embed-reserved-space', () => {
  const video = (attrs: string) => html('', `<main><iframe src="https://www.youtube-nocookie.com/embed/abc123" ${attrs} title="Demo"></iframe></main>`);

  test('does not apply without embeds', () => {
    assertOutcome(check(embedReservedSpace, page(url, { html: html('', '<main><iframe src="/form.html"></iframe></main>') })), 'not_applicable', 'no-embeds');
  });

  test('passes embeds with dimensions or an inline aspect ratio', () => {
    assertOutcome(check(embedReservedSpace, page(url, { html: video('width="560" height="315"') })), 'pass');
    assertOutcome(check(embedReservedSpace, page(url, { html: video('style="width:100%;aspect-ratio:16/9"') })), 'pass');
  });

  test('fails medium when Lighthouse attributes a shift to the injected iframe', () => {
    const lighthouse = lab({ 'cls-culprits-insight': { score: 0, details: list(cluster(0.12, [{ cause: 'Injected iframe', value: 'https://www.youtube-nocookie.com/embed/abc123' }])) } });
    const checked = check(embedReservedSpace, page(url, { html: video(''), lighthouse }));
    assertFail(checked, 'medium', 'attributed-shift');
    assertExcerpt(checked, /youtube-nocookie\.com\/embed\/abc123/u);
  });

  test('hands an unsized embed without attributed shift to the analyst at low', () => {
    const checked = check(embedReservedSpace, page(url, { html: video('') }));
    assertFail(checked, 'low', 'unsized-embed');
    assert.equal(checked.finding.needsJudgment, true);
  });

  test('is not evaluated without the server HTML', () => {
    assertOutcome(check(embedReservedSpace, page(url)), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('perf-non-composited-animations', () => {
  test('passes without non-composited animations', () => {
    assertOutcome(check(nonCompositedAnimations, page(url, { html: html(''), lighthouse: lab({ 'non-composited-animations': { score: 1, details: table([]) } }) })), 'pass');
  });

  test('fails low with the failure reasons', () => {
    const items = [{ node: node('<div class="ticker">', 'div.ticker'), subItems: { type: 'subitems', items: [{ failureReason: 'Unsupported CSS Property: margin-left', animation: 'slide' }] } }];
    const checked = check(nonCompositedAnimations, page(url, { html: html(''), lighthouse: lab({ 'non-composited-animations': { score: 0, details: table(items) } }) }));
    assertFail(checked, 'low');
    assert.equal(checked.finding.params?.reasons, 'Unsupported CSS Property: margin-left');
    assertExcerpt(checked, /<div class="ticker">: Unsupported CSS Property: margin-left/u);
  });

  test('is not evaluated without the audit', () => {
    assertOutcome(check(nonCompositedAnimations, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-animations-audit');
  });
});

describe('perf-consent-lab-bias', () => {
  const banner = '<html><body><main><h1>Title</h1></main><div id="onetrust-banner-sdk"><h2>We use cookies</h2><p id="onetrust-policy-text">We and our partners use cookies.</p></div></body></html>';
  const lcpAt = (selector: string) => lab({ 'lcp-breakdown-insight': { details: breakdown({ ttfb: 300, renderDelay: 400 }, node(`<p id="${selector}">`, selector)) } });

  test('does not apply without a consent dialog', () => {
    assertOutcome(check(consentLabBias, page(url, { html: html(''), rendered: '<html><body><main><h1>Title</h1></main></body></html>', lighthouse: lcpAt('main > h1') })), 'not_applicable', 'no-consent-ui');
  });

  test('passes when the LCP element is page content, with headings of the banner outside main', () => {
    assertOutcome(check(consentLabBias, page(url, { html: html(''), rendered: banner, lighthouse: lcpAt('main > h1') })), 'pass');
  });

  test('annotates a lab LCP inside the consent dialog as info', () => {
    const checked = check(consentLabBias, page(url, { html: html(''), rendered: banner, lighthouse: lcpAt('div#onetrust-banner-sdk > p#onetrust-policy-text') }));
    assertFail(checked, 'info');
    assertExcerpt(checked, /<div id="onetrust-banner-sdk">/u);
  });

  test('is not evaluated without the rendered page', () => {
    assertOutcome(check(consentLabBias, page(url, { html: html(''), lighthouse: lcpAt('main > h1') })), 'not_evaluated', 'missing-input:rendered-dom');
  });
});
