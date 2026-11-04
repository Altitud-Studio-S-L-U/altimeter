import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { criticalRequestChains, fontDisplay, fontFormat, fontPreloadCrossorigin, imageDelivery, preconnectHints } from '../../src/rules/perf/resources.ts';
import { page } from '../support/facts.ts';
import { assertExcerpt, assertFail, assertOutcome, check, html, lab, list, requests, table } from './perf-fixtures.ts';

const url = 'https://example.com/';

describe('perf-font-display', () => {
  const insight = (score: number, items: Record<string, unknown>[]) => lab({ 'font-display-insight': { score, scoreDisplayMode: 'metricSavings', details: table(items) } });

  test('passes fonts that swap', () => {
    assertOutcome(check(fontDisplay, page(url, { html: html(''), lighthouse: insight(1, []) })), 'pass');
  });

  test('fails low on a font that blocks text', () => {
    const checked = check(fontDisplay, page(url, { html: html(''), lighthouse: insight(0, [{ url: 'https://example.com/brand.woff2', wastedMs: 120 }]) }));
    assertFail(checked, 'low');
    assertExcerpt(checked, /brand\.woff2: 120 ms/u);
  });

  test('is not evaluated without the insight', () => {
    assertOutcome(check(fontDisplay, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-font-display-insight');
  });
});

describe('perf-font-preload-crossorigin', () => {
  test('does not apply without font hints', () => {
    assertOutcome(check(fontPreloadCrossorigin, page(url, { html: html('<link rel="preload" as="image" href="/hero.jpg">') })), 'not_applicable', 'no-font-hints');
  });

  test('passes CORS hints, including a preconnect pair', () => {
    const head = '<link rel="preload" as="font" type="font/woff2" href="/brand.woff2" crossorigin><link rel="preconnect" href="https://fonts.gstatic.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
    assertOutcome(check(fontPreloadCrossorigin, page(url, { html: html(head) })), 'pass');
  });

  test('fails low on a font preload or font-file preconnect without crossorigin', () => {
    const head = '<link rel="preload" as="font" type="font/woff2" href="/brand.woff2"><link rel="preconnect" href="https://fonts.gstatic.com">';
    const checked = check(fontPreloadCrossorigin, page(url, { html: html(head) }));
    assertFail(checked, 'low');
    assert.equal(checked.finding.params?.count, 2);
    assertExcerpt(checked, /^<link rel="preload" as="font" type="font\/woff2" href="\/brand\.woff2">$/u);
  });

  test('is not evaluated without the server HTML', () => {
    assertOutcome(check(fontPreloadCrossorigin, page(url)), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('perf-font-format', () => {
  const fonts = (entries: Array<[string, string]>) => lab({ 'network-requests': requests(entries.map(([path, mimeType]) => ({ url: `https://example.com/${path}`, resourceType: 'Font', mimeType, transferSize: 20000 }))) });

  test('does not apply without web fonts', () => {
    assertOutcome(check(fontFormat, page(url, { html: html(''), lighthouse: lab({ 'network-requests': requests([]) }) })), 'not_applicable', 'no-web-fonts');
  });

  test('passes WOFF2 fonts', () => {
    assertOutcome(check(fontFormat, page(url, { html: html(''), lighthouse: fonts([['a.woff2', 'font/woff2'], ['b.woff2', 'application/octet-stream']]) })), 'pass');
  });

  test('fails low on legacy formats and on many files', () => {
    const checked = check(fontFormat, page(url, { html: html(''), lighthouse: fonts([['old.ttf', 'font/ttf']]) }));
    assertFail(checked, 'low', 'not-woff2');
    assertExcerpt(checked, /old\.ttf \(font\/ttf, 20000 bytes\)/u);
    const many = check(fontFormat, page(url, { html: html(''), lighthouse: fonts(Array.from({ length: 7 }, (_, index): [string, string] => [`f${index}.woff2`, 'font/woff2'])) }));
    assertFail(many, 'low', 'many-files');
    assert.equal(many.finding.params?.count, 7);
  });

  test('is not evaluated without Lighthouse', () => {
    assertOutcome(check(fontFormat, page(url, { html: html('') })), 'not_evaluated', 'missing-input:lighthouse');
  });
});

describe('perf-preconnect-hints', () => {
  const used = lab({ 'network-requests': requests([{ url: 'https://cdn.example.net/app.js', resourceType: 'Script', networkRequestTime: 300 }]) });

  test('does not apply without preconnects or candidates', () => {
    assertOutcome(check(preconnectHints, page(url, { html: html('') })), 'not_applicable', 'no-preconnect');
  });

  test('passes a used preconnect', () => {
    assertOutcome(check(preconnectHints, page(url, { html: html('<link rel="preconnect" href="https://cdn.example.net">'), lighthouse: used })), 'pass');
  });

  test('flags too many, combined and unused preconnects at low', () => {
    const head = ['a', 'b', 'c', 'd'].map(name => `<link rel="preconnect" href="https://${name}.example.org">`).join('') + '<link rel="preconnect dns-prefetch" href="https://cdn.example.net">';
    const checked = check(preconnectHints, page(url, { html: html(head), lighthouse: used }));
    const reasons = checked.findings.map(finding => finding.reason);
    assert.deepEqual(reasons, ['too-many', 'combined-rel', 'unused']);
    for (const finding of checked.findings) assertFail(checked, 'low', finding.reason, finding);
    assertExcerpt(checked, /^<link rel="preconnect dns-prefetch" href="https:\/\/cdn\.example\.net">$/u, checked.findings[1]);
  });

  test('reports an origin Lighthouse would preconnect', () => {
    const tree = list({ type: 'list-section', value: { type: 'network-tree', chains: {}, longestChain: { duration: 900 } } },
      { type: 'list-section', title: 'Preconnect candidates', value: table([{ origin: 'https://images.example.org', wastedMs: 180 }]) });
    const checked = check(preconnectHints, page(url, { html: html(''), lighthouse: lab({ 'network-requests': requests([]), 'network-dependency-tree-insight': { score: 0, details: tree } }) }));
    assertFail(checked, 'low', 'missing');
    assertExcerpt(checked, /images\.example\.org: 180 ms/u);
  });

  test('is not evaluated without the server HTML', () => {
    assertOutcome(check(preconnectHints, page(url)), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('perf-critical-request-chains', () => {
  const chain = (urls: string[]): Record<string, unknown> => {
    const [first, ...rest] = urls;
    return first === undefined ? {} : { [first]: { url: first, navStartToEndTime: 100, transferSize: 1000, children: chain(rest) } };
  };
  const tree = (urls: string[]) => lab({ 'network-dependency-tree-insight': { score: 0, scoreDisplayMode: 'numeric', details: list({ type: 'list-section', value: { type: 'network-tree', chains: chain(urls), longestChain: { duration: 1400 } } }) } });

  test('passes a short chain even though the insight fails on any chain', () => {
    assertOutcome(check(criticalRequestChains, page(url, { html: html(''), lighthouse: tree([url, `${url}site.css`, `${url}brand.woff2`]) })), 'pass');
  });

  test('fails low on a chain deeper than three requests', () => {
    const checked = check(criticalRequestChains, page(url, { html: html(''), lighthouse: tree([url, `${url}a.js`, `${url}b.js`, `${url}c.js`, `${url}d.json`]) }));
    assertFail(checked, 'low');
    assert.deepEqual(checked.finding.params, { depth: 4, duration: '1400 ms' });
    assertExcerpt(checked, /c\.js -> https:\/\/example\.com\/d\.json; longest chain 1400 ms$/u);
  });

  test('is not evaluated without the insight', () => {
    assertOutcome(check(criticalRequestChains, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-dependency-tree');
  });
});

describe('perf-image-delivery', () => {
  const insight = (items: Record<string, unknown>[]) => lab({ 'image-delivery-insight': { score: items.length ? 0 : 1, scoreDisplayMode: 'metricSavings', details: table(items) } });
  const image = (path: string, wastedBytes: number) => ({ url: `https://example.com/${path}`, totalBytes: wastedBytes * 2, wastedBytes, subItems: { type: 'subitems', items: [{ reason: 'Using a modern image format could improve the download size.', wastedBytes }] } });
  const userRender = { html: '<html><body></body></html>', lcp: { time: 2400, size: 90000, url: 'https://example.com/hero.jpg', tag: 'img' } };

  test('passes when nothing can be saved', () => {
    assertOutcome(check(imageDelivery, page(url, { html: html(''), lighthouse: insight([]) })), 'pass');
  });

  test('fails medium for the LCP image and low for the rest', () => {
    const checked = check(imageDelivery, page(url, { html: html(''), userRender, lighthouse: insight([image('hero.jpg', 40000), image('a.png', 60000), image('b.png', 50000)]) }));
    assertFail(checked, 'medium', 'lcp-image', checked.findings[0]);
    assertExcerpt(checked, /hero\.jpg: estimated savings 39 KiB \(Using a modern image format/u, checked.findings[0]);
    assertFail(checked, 'low', 'images', checked.findings[1]);
    assert.equal(checked.findings[1]!.params?.savings, '107 KiB');
  });

  test('passes small savings', () => {
    assertOutcome(check(imageDelivery, page(url, { html: html(''), userRender, lighthouse: insight([image('hero.jpg', 4000), image('a.png', 9000)]) })), 'pass');
  });

  test('is not evaluated without the insight', () => {
    assertOutcome(check(imageDelivery, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-image-delivery-insight');
  });
});
