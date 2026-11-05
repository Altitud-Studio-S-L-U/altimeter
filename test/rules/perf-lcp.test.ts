import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TextBlock } from '../../src/render/chrome.ts';
import {
  lcpAntiflicker, lcpBreakdownLab, lcpClientSideRendered, lcpFetchpriority, lcpLazyLoaded, lcpNotDiscoverable,
} from '../../src/rules/perf/lcp.ts';
import { page } from '../support/facts.ts';
import { assertExcerpt, assertFail, assertOutcome, breakdown, check, checklist, crux, html, lab, node } from './perf-fixtures.ts';

const url = 'https://example.com/';
const heroNode = node('<img src="/hero.jpg" alt="Product photo">', 'main > img.hero');
const discovery = (entries: Record<string, boolean>) => ({ 'lcp-discovery-insight': { score: Object.values(entries).every(Boolean) ? 1 : 0, details: checklist(entries, heroNode) } });
const allGood = { priorityHinted: true, requestDiscoverable: true, eagerlyLoaded: true };
const heroRender = { html: '<html><body><img src="/hero.jpg"></body></html>', lcp: { time: 2500, size: 120000, url: 'https://example.com/hero.jpg', tag: 'img', selector: 'main > img.hero' } };

describe('perf-lcp-lazy-loaded', () => {
  test('passes an eagerly loaded LCP image', () => {
    const checked = check(lcpLazyLoaded, page(url, { html: html(''), lighthouse: lab(discovery(allGood)) }));
    assertOutcome(checked, 'pass');
    assertExcerpt(checked, /eagerlyLoaded=true/u);
  });

  test('fails high when Lighthouse sees loading=lazy on the LCP image', () => {
    const checked = check(lcpLazyLoaded, page(url, { html: html(''), lighthouse: lab(discovery({ ...allGood, eagerlyLoaded: false })) }));
    assertFail(checked, 'high', 'loading-lazy');
    assertExcerpt(checked, /eagerlyLoaded=false/u);
    assertExcerpt(checked, /<img src="\/hero\.jpg"/u);
  });

  test('fails high when the LCP URL is only in a data-src attribute', () => {
    const raw = html('', '<main><img src="data:image/gif;base64,R0lGOD" data-src="/hero.jpg" class="lazyload" alt="Product photo"></main>');
    const checked = check(lcpLazyLoaded, page(url, { html: raw, userRender: heroRender, lighthouse: lab(discovery({ ...allGood, requestDiscoverable: false })) }));
    assertFail(checked, 'high', 'script-lazy-load');
    assertExcerpt(checked, /data-src="\/hero\.jpg"/u);
  });

  test('does not apply to a text LCP', () => {
    assertOutcome(check(lcpLazyLoaded, page(url, { html: html(''), lighthouse: lab({}) })), 'not_applicable', 'no-image-lcp');
  });
});

describe('perf-lcp-not-discoverable', () => {
  test('passes an LCP image found in the server HTML', () => {
    assertOutcome(check(lcpNotDiscoverable, page(url, { html: html(''), lighthouse: lab(discovery(allGood)) })), 'pass');
  });

  test('fails high when the LCP image is discovered late', () => {
    const raw = html('<link rel="stylesheet" href="/site.css">', '<main><div class="hero"></div></main>');
    const checked = check(lcpNotDiscoverable, page(url, { html: raw, userRender: heroRender, lighthouse: lab(discovery({ ...allGood, requestDiscoverable: false })) }));
    assertFail(checked, 'high');
    assert.equal(checked.finding.params?.url, 'https://example.com/hero.jpg');
    assertExcerpt(checked, /requestDiscoverable=false/u);
  });

  test('lowers to medium when the server HTML references the URL anyway, matching srcset variants', () => {
    const raw = html('', '<main><img srcset="/hero.jpg?w=400 400w, /hero.jpg?w=800 800w" sizes="100vw" alt="Product photo"></main>');
    const render = { ...heroRender, lcp: { ...heroRender.lcp, url: 'https://example.com/hero.jpg?w=800' } };
    const checked = check(lcpNotDiscoverable, page(url, { html: raw, userRender: render, lighthouse: lab(discovery({ ...allGood, requestDiscoverable: false })) }));
    assertFail(checked, 'medium', 'conflicting-signals');
    assertExcerpt(checked, /srcset="\/hero\.jpg\?w=400 400w/u);
  });

  test('leaves the data-src pattern to perf-lcp-lazy-loaded', () => {
    const raw = html('', '<main><img data-src="/hero.jpg" alt="Product photo"></main>');
    const checked = check(lcpNotDiscoverable, page(url, { html: raw, userRender: heroRender, lighthouse: lab(discovery({ ...allGood, requestDiscoverable: false })) }));
    assertOutcome(checked, 'not_applicable', 'script-lazy-load');
  });

  test('leaves a lazy image that the server HTML names to perf-lcp-lazy-loaded, whatever the discovery check says', () => {
    const raw = html('', '<main><img src="/hero.jpg" loading="lazy" alt="Product photo"></main>');
    for (const requestDiscoverable of [true, false]) {
      const checked = check(lcpNotDiscoverable, page(url, { html: raw, userRender: heroRender, lighthouse: lab(discovery({ ...allGood, eagerlyLoaded: false, requestDiscoverable })) }));
      assert.ok(checked.finding.outcome !== 'fail', JSON.stringify(checked.finding));
    }
  });

  test('still fails high for a lazy image that only a script adds', () => {
    const raw = html('', '<main><div class="hero"></div></main>');
    const checked = check(lcpNotDiscoverable, page(url, { html: raw, userRender: heroRender, lighthouse: lab(discovery({ ...allGood, eagerlyLoaded: false, requestDiscoverable: false })) }));
    assertFail(checked, 'high');
  });

  test('does not apply without an image LCP', () => {
    assertOutcome(check(lcpNotDiscoverable, page(url, { html: html(''), lighthouse: lab({}) })), 'not_applicable', 'no-image-lcp');
  });
});

describe('perf-lcp-fetchpriority', () => {
  test('passes a hinted LCP image', () => {
    assertOutcome(check(lcpFetchpriority, page(url, { html: html(''), lighthouse: lab(discovery(allGood)) })), 'pass');
  });

  test('fails medium without fetchpriority=high on a discoverable LCP image', () => {
    const checked = check(lcpFetchpriority, page(url, { html: html(''), lighthouse: lab(discovery({ ...allGood, priorityHinted: false })) }));
    assertFail(checked, 'medium');
    assertExcerpt(checked, /priorityHinted=false/u);
  });

  test('flags more than two high-priority images as overuse', () => {
    const images = ['a', 'b', 'c'].map(name => `<img src="/${name}.jpg" fetchpriority="high" alt="">`).join('');
    const checked = check(lcpFetchpriority, page(url, { html: html('', `<main>${images}</main>`), lighthouse: lab(discovery(allGood)) }));
    assertFail(checked, 'low', 'overuse');
    assert.equal(checked.finding.params?.count, 3);
    assertExcerpt(checked, /fetchpriority="high"/u);
  });

  test('leaves an undiscoverable LCP image to perf-lcp-not-discoverable', () => {
    const checked = check(lcpFetchpriority, page(url, { html: html(''), lighthouse: lab(discovery({ priorityHinted: false, requestDiscoverable: false, eagerlyLoaded: true })) }));
    assertOutcome(checked, 'not_applicable', 'lcp-not-discoverable');
  });

  test('judges the hint of a lazy image that the server HTML names, whatever the discovery check says', () => {
    const raw = html('', '<main><img src="/hero.jpg" loading="lazy" alt="Product photo"></main>');
    for (const requestDiscoverable of [true, false]) {
      const checked = check(lcpFetchpriority, page(url, { html: raw, userRender: heroRender, lighthouse: lab(discovery({ priorityHinted: false, requestDiscoverable, eagerlyLoaded: false })) }));
      assertFail(checked, 'medium');
    }
  });

  test('does not apply to a text LCP', () => {
    assertOutcome(check(lcpFetchpriority, page(url, { html: html(''), lighthouse: lab({}) })), 'not_applicable', 'no-image-lcp');
  });
});

describe('perf-lcp-breakdown-lab', () => {
  const lcp = (value: number) => ({ 'largest-contentful-paint': { numericValue: value } });

  test('passes balanced subparts', () => {
    const audits = { ...lcp(3200), 'lcp-breakdown-insight': { details: breakdown({ ttfb: 500, loadDelay: 100, loadDuration: 1200, renderDelay: 150 }) } };
    assertOutcome(check(lcpBreakdownLab, page(url, { html: html(''), lighthouse: lab(audits) })), 'pass');
  });

  test('fails medium on a dominant render delay', () => {
    const audits = { ...lcp(4000), 'lcp-breakdown-insight': { details: breakdown({ ttfb: 600, loadDelay: 100, loadDuration: 900, renderDelay: 2000 }) } };
    const checked = check(lcpBreakdownLab, page(url, { html: html(''), lighthouse: lab(audits) }));
    assertFail(checked, 'medium');
    assert.match(String(checked.finding.params?.subparts), /element render delay 56%/u);
    assertExcerpt(checked, /elementRenderDelay=2000 ms/u);
  });

  test('does not apply to a good lab LCP or when field subparts exist', () => {
    assertOutcome(check(lcpBreakdownLab, page(url, { html: html(''), lighthouse: lab(lcp(2000)) })), 'not_applicable', 'lab-lcp-good');
    const field = crux({ url: { PHONE: { metrics: { largest_contentful_paint_image_time_to_first_byte: 900, largest_contentful_paint_image_element_render_delay: 300 } } } });
    assertOutcome(check(lcpBreakdownLab, page(url, { html: html(''), lighthouse: lab(lcp(4000)), crux: field })), 'not_applicable', 'field-subparts-available');
  });

  test('is not evaluated without the breakdown', () => {
    assertOutcome(check(lcpBreakdownLab, page(url, { html: html(''), lighthouse: lab(lcp(4000)) })), 'not_evaluated', 'no-lcp-breakdown');
  });
});

describe('perf-lcp-client-side-rendered', () => {
  const block = (text: string): TextBlock => ({ selector: 'h1.hero', text, fontSize: 40, top: 100, inMain: true });
  const rendered = { html: '<html><body><main><h1 class="hero">Fast audits for real sites</h1></main></body></html>', textBlocks: [block('Fast audits for real sites')],
    lcp: { time: 2800, size: 50000, selector: 'h1.hero', tag: 'h1' } };
  const timing = (lcp: number, fcp: number) => lab({ 'largest-contentful-paint': { numericValue: lcp }, 'first-contentful-paint': { numericValue: fcp } });

  test('passes when the LCP text is in the server HTML', () => {
    const raw = html('', '<main><h1 class="hero">Fast audits for   real sites</h1></main>');
    assertOutcome(check(lcpClientSideRendered, page(url, { html: raw, rendered, lighthouse: timing(3000, 1000) })), 'pass');
  });

  test('fails high on an empty app shell', () => {
    const checked = check(lcpClientSideRendered, page(url, { html: html('<script src="/app.js" defer></script>', '<div id="root"></div>'), rendered, lighthouse: timing(3000, 1000) }));
    assertFail(checked, 'high', 'app-shell');
    assert.equal(checked.finding.params?.gap, '2000 ms');
    assertExcerpt(checked, /Fast audits for real sites/u);
  });

  test('hands other differences to the analyst at medium', () => {
    const checked = check(lcpClientSideRendered, page(url, { html: html('', '<main><p>Loading the catalogue</p></main>'), rendered, lighthouse: timing(3000, 1000) }));
    assertFail(checked, 'medium', 'content-differs');
    assert.equal(checked.finding.needsJudgment, true);
  });

  test('passes when LCP follows FCP closely', () => {
    assertOutcome(check(lcpClientSideRendered, page(url, { html: html('', '<div id="root"></div>'), rendered, lighthouse: timing(1300, 1000) })), 'pass');
  });

  test('is not evaluated without an LCP element', () => {
    assertOutcome(check(lcpClientSideRendered, page(url, { html: html(''), rendered: { html: rendered.html }, lighthouse: timing(3000, 1000) })), 'not_evaluated', 'no-lcp-element');
  });
});

describe('perf-lcp-antiflicker-hiding', () => {
  const delay = (renderDelay: number) => lab({ 'lcp-breakdown-insight': { details: breakdown({ ttfb: 400, renderDelay }) } });

  test('fails medium when a page-hiding snippet coincides with a long render delay', () => {
    const raw = html('<style>.async-hide { opacity: 0 !important }</style><script>(function(a,s,y,n){s.className+=" "+y;})(window,document.documentElement,"async-hide")</script>');
    const checked = check(lcpAntiflicker, page(url, { html: raw, lighthouse: delay(900) }));
    assertFail(checked, 'medium');
    assertExcerpt(checked, /\.async-hide \{ opacity: 0/u);
    assert.equal(checked.finding.params?.delay, '900 ms');
  });

  test('never treats data-reveal sections at opacity 0 as page hiding', () => {
    const raw = html('<style>[data-reveal]{opacity:0;transition:opacity .4s} body [data-reveal].is-visible{opacity:1}</style>', '<main><section data-reveal><h1>Title</h1></section></main>');
    assertOutcome(check(lcpAntiflicker, page(url, { html: raw, lighthouse: delay(900) })), 'pass');
  });

  test('passes a snippet with a short render delay', () => {
    assertOutcome(check(lcpAntiflicker, page(url, { html: html('<style>body{opacity:0}</style>'), lighthouse: delay(200) })), 'pass');
  });

  test('is not evaluated without the LCP breakdown', () => {
    assertOutcome(check(lcpAntiflicker, page(url, { html: html('<style>body{opacity:0}</style>'), lighthouse: lab({}) })), 'not_evaluated', 'no-lcp-breakdown');
  });
});
