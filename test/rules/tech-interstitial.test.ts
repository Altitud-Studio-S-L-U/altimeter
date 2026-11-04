import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Overlay } from '../../src/render/chrome.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { intrusiveInterstitial } from '../../src/rules/tech/interstitial.ts';
import { evaluate, page, site } from '../support/facts.ts';

const url = 'https://example.com/guide/';
const html = '<!doctype html><html lang="en"><head><title>Guide</title></head><body><main><h1>Guide</h1><p>Steps.</p></main></body></html>';

const overlay = (selector: string, coverage: number, text: string, extra: Partial<Overlay> = {}): Overlay => ({
  selector, position: 'fixed', box: { x: 0, y: 0, width: 412, height: Math.round(823 * coverage) }, zIndex: 1000, coverage, text, dialog: false, ...extra,
});

function run(overlays: readonly Overlay[] | undefined, scrollLocked = false) {
  const userRender = overlays === undefined ? { html } : { html, overlays, scrollLocked };
  const result = evaluate(intrusiveInterstitial, site({ pages: [page(url, { html, userRender })] }));
  const finding = result.findings[0] as Finding;
  return { finding, excerpts: finding.evidence.map(id => result.evidence.get(id)?.excerpt), labels: finding.evidence.map(id => result.evidence.get(id)?.label) };
}

describe('tech-intrusive-interstitial', () => {
  test('passes small banners, sticky headers and pages without overlays', () => {
    assert.equal(run([]).finding.outcome, 'pass');
    assert.equal(run([overlay('div#cookies', 0.15, 'We use cookies Accept'), overlay('header', 0.4, 'Menu', { position: 'sticky' })]).finding.outcome, 'pass');
  });

  test('exempts a full-screen consent or age notice, as Google does', () => {
    const consent = run([overlay('div#onetrust-banner-sdk', 1, 'Manage your privacy choices Accept all Reject all')], true);
    assert.equal(consent.finding.outcome, 'pass');
    assert.equal(consent.excerpts[0], 'Manage your privacy choices Accept all Reject all');
    assert.match(String(consent.labels[0]), / \(covering 100% of the screen, z-index \w+\)$/u);
    assert.equal(run([overlay('div.gate', 1, 'Please verify your age to enter')]).finding.outcome, 'pass');
  });

  test('fails medium on a promotional overlay over most of the screen and cites the scroll lock', () => {
    const { finding, excerpts, labels } = run([overlay('div#promo', 1, 'Subscribe to our newsletter and get 10% off', { dialog: true })], true);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason, finding.needsJudgment, finding.params?.coverage], ['fail', 'medium', 'promotion', undefined, 1]);
    assert.deepEqual(excerpts, ['Subscribe to our newsletter and get 10% off', undefined]);
    assert.deepEqual(labels, ['promotional overlay over most of the first screen at load (a dialog covering 100% of the screen, z-index 1000)', 'page scrolling locked at load (overflow hidden on html or body)']);
  });

  test('hands login dialogs and unclassified overlays to the analyst', () => {
    const login = run([overlay('div.modal', 0.6, 'Log in to continue reading')]).finding;
    assert.deepEqual([login.reason, login.needsJudgment], ['access-dialog', true]);
    const unknown = run([overlay('div.splash', 0.4, '')]).finding;
    assert.deepEqual([unknown.reason, unknown.needsJudgment, unknown.params?.coverage], ['overlay', true, 0.4]);
    const partial = run([overlay('div.bar', 0.35, 'Download our app')]).finding;
    assert.deepEqual([partial.reason, partial.needsJudgment], ['promotion', true]);
  });

  test('is not evaluated without overlay data or without the user render', () => {
    assert.deepEqual([run(undefined).finding.outcome, run(undefined).finding.reason], ['not_evaluated', 'no-overlay-data']);
    const missing = evaluate(intrusiveInterstitial, site({ pages: [page(url, { html })] })).findings[0];
    assert.equal(missing?.reason, 'missing-input:user-render');
  });
});
