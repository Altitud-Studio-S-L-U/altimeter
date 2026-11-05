import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import type { TextBlock } from '../../src/render/chrome.ts';
import {
  dataNosnippetInvalid, imagePreviewLarge, metaDescriptionDuplicate, metaDescriptionMissing, metaDescriptionQuality,
} from '../../src/rules/content/descriptions.ts';
import { h1EmptyOrImage, h1Missing, headingLevelSkips, mainLandmark } from '../../src/rules/content/headings.ts';
import type { RuleImplementation } from '../../src/rules/engine.ts';
import { evaluate, outcomeOn, page, site, type SiteSpec } from '../support/facts.ts';

const url = 'https://example.com/garden/tools';
const doc = (head: string, body = '<main><p>Text.</p></main>') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const block = (selector: string, text: string, extra: Partial<TextBlock> = {}): TextBlock => ({ selector, text, fontSize: 16, top: 400, inMain: true, ...extra });
const crawled = { crawled: true, homeUrl: 'https://example.com/' } as const;

function run(rule: RuleImplementation, pages: readonly PageFacts[], extra: Partial<SiteSpec> = {}) {
  const { findings, evidence } = evaluate(rule, site({ pages, ...extra }));
  const excerpts = (finding: (typeof findings)[number] | undefined) => (finding?.evidence ?? []).map(id => evidence.get(id)?.excerpt);
  return { at: (target = url) => outcomeOn(findings, target), siteFindings: findings.filter(entry => entry.scope.kind === 'site'), excerpts };
}

describe('content-meta-description-missing', () => {
  test('passes with a description', () => {
    const { at, excerpts } = run(metaDescriptionMissing, [page(url, { html: doc('<meta name="description" content="Tools for small gardens.">') })]);
    assert.equal(at()?.outcome, 'pass');
    assert.deepEqual(excerpts(at()), ['Tools for small gardens.']);
  });

  test('fails low without one, and cites an empty one', () => {
    assert.deepEqual([run(metaDescriptionMissing, [page(url, { html: doc('') })]).at()?.severity, run(metaDescriptionMissing, [page(url, { html: doc('') })]).at()?.reason], ['low', 'absent']);
    const { at, excerpts } = run(metaDescriptionMissing, [page(url, { html: doc('<meta name="description" content="">') })]);
    assert.deepEqual([at()?.outcome, at()?.reason], ['fail', 'empty']);
    assert.deepEqual(excerpts(at()), ['<meta name="description" content="">']);
  });

  test('does not apply to noindex,follow legal pages', () => {
    const legal = 'https://example.com/privacy';
    const { at } = run(metaDescriptionMissing, [page(legal, { html: doc('<meta name="robots" content="noindex,follow">') })]);
    assert.deepEqual([at(legal)?.outcome, at(legal)?.reason], ['not_applicable', 'not-indexable-noindex']);
  });

  test('is not evaluated without the raw HTML', () => {
    assert.equal(run(metaDescriptionMissing, [page(url)]).at()?.reason, 'missing-input:raw-html');
  });
});

describe('content-meta-description-duplicate', () => {
  const described = (path: string, text: string) => page(`https://example.com${path}`, { html: doc(`<meta name="description" content="${text}">`) });

  test('passes with distinct descriptions and ignores paginated pages', () => {
    const pages = [described('/a', 'Seeds for spring.'), described('/blog', 'All posts.'), described('/blog?page=2', 'All posts.'), described('/blog/page/3/?ref=nav', 'All posts.')];
    assert.equal(run(metaDescriptionDuplicate, pages, crawled).siteFindings[0]?.outcome, 'pass');
  });

  test('fails medium for a shared description', () => {
    const pages = [described('/a', 'The best garden shop.'), described('/b', 'The best garden shop.')];
    const { siteFindings, excerpts } = run(metaDescriptionDuplicate, pages, crawled);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.params?.count], ['medium', 2]);
    assert.deepEqual(excerpts(siteFindings[0]), ['The best garden shop.', 'The best garden shop.']);
  });

  test('is not evaluated without a crawl', () => {
    assert.equal(run(metaDescriptionDuplicate, [described('/a', 'x')]).siteFindings[0]?.outcome, 'not_evaluated');
  });
});

describe('content-meta-description-quality', () => {
  test('passes a summary sentence', () => {
    const html = doc('<title>Tools</title><meta name="description" content="Learn which hand tools a small balcony garden needs, with prices and care tips.">');
    assert.equal(run(metaDescriptionQuality, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails low on a template placeholder without the analyst', () => {
    const { at, excerpts } = run(metaDescriptionQuality, [page(url, { html: doc('<meta name="description" content="Buy {{ product.name }} today at our store online.">') })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.needsJudgment], ['low', 'placeholder', undefined]);
    assert.deepEqual(excerpts(at()), ['Buy {{ product.name }} today at our store online.']);
  });

  test('hands a very short description to the analyst', () => {
    const { at } = run(metaDescriptionQuality, [page(url, { html: doc('<meta name="description" content="Mechanical pencil">') })]);
    assert.deepEqual([at()?.reason, at()?.needsJudgment, at()?.params?.words], ['short', true, 2]);
  });

  test('does not apply without a description', () => {
    assert.equal(run(metaDescriptionQuality, [page(url, { html: doc('') })]).at()?.outcome, 'not_applicable');
  });
});

describe('content-data-nosnippet-invalid', () => {
  const long = 'Garden tools for balconies. '.repeat(20);

  test('passes on supported elements', () => {
    assert.equal(run(dataNosnippetInvalid, [page(url, { html: doc('', `<main><p>${long}</p><span data-nosnippet>Price: 10 EUR</span></main>`) })]).at()?.outcome, 'pass');
  });

  test('fails low on an unsupported element, citing its tag', () => {
    const { at, excerpts } = run(dataNosnippetInvalid, [page(url, { html: doc('', `<main><p data-nosnippet>Secret</p><p>${long}</p></main>`) })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['low', 'unsupported-element']);
    assert.deepEqual(excerpts(at()), ['<p data-nosnippet>']);
  });

  test('reports the attribute added by JavaScript to an existing element', () => {
    const html = doc('', `<main><div id="offer">Offer</div><p>${long}</p></main>`);
    const rendered = doc('', `<main><div id="offer" data-nosnippet>Offer</div><p>${long}</p></main>`);
    assert.equal(run(dataNosnippetInvalid, [page(url, { html, rendered })]).at()?.reason, 'added-by-javascript');
  });

  test('reports covering the main content as info only', () => {
    const { at } = run(dataNosnippetInvalid, [page(url, { html: doc('', `<main><div data-nosnippet>${long}</div></main>`) })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['info', 'covers-main-content']);
  });

  test('does not apply without the attribute', () => {
    assert.equal(run(dataNosnippetInvalid, [page(url, { html: doc('') })]).at()?.reason, 'no-data-nosnippet');
  });
});

describe('content-image-preview-large', () => {
  const article = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Tools"}</script>';

  test('passes with max-image-preview:large', () => {
    assert.equal(run(imagePreviewLarge, [page(url, { html: doc(`${article}<meta name="robots" content="max-image-preview:large">`) })]).at()?.outcome, 'pass');
  });

  test('fails low without the directive on an article', () => {
    const { at } = run(imagePreviewLarge, [page(url, { html: doc(article) })]);
    assert.deepEqual([at()?.outcome, at()?.severity, at()?.reason], ['fail', 'low', 'absent']);
  });

  test('cites a restricting X-Robots-Tag header', () => {
    const { at, excerpts } = run(imagePreviewLarge, [page(url, { html: doc(article), headers: { 'x-robots-tag': 'max-image-preview:none' } })]);
    assert.deepEqual([at()?.reason, at()?.params?.value], ['restricted', 'none']);
    assert.deepEqual(excerpts(at()), ['max-image-preview:none']);
  });

  test('does not apply to pages that are not articles', () => {
    assert.equal(run(imagePreviewLarge, [page(url, { html: doc('') })]).at()?.reason, 'page-type:other');
  });
});

describe('content-h1-missing', () => {
  test('passes with an h1 and allows several', () => {
    const { at, excerpts } = run(h1Missing, [page(url, { html: doc('', '<h1>Tools</h1><h1>Seeds</h1>') })]);
    assert.equal(at()?.outcome, 'pass');
    assert.deepEqual(excerpts(at()), ['Tools']);
  });

  test('fails low without an h1', () => {
    assert.deepEqual([run(h1Missing, [page(url, { html: doc('', '<p>Text</p>') })]).at()?.severity], ['low']);
  });

  test('passes when the render shows a dominant visual title', () => {
    const html = doc('', '<div class="title">Garden tools</div><p>Text</p>');
    const rendered = { html, textBlocks: [block('div.title', 'Garden tools', { fontSize: 40, top: 120 }), block('p', 'Text'), block('p', 'More text')] };
    const { at, excerpts } = run(h1Missing, [page(url, { html, rendered })]);
    assert.equal(at()?.outcome, 'pass');
    assert.deepEqual(excerpts(at()), ['Garden tools']);
  });

  test('is not evaluated without the raw HTML', () => {
    assert.equal(run(h1Missing, [page(url)]).at()?.outcome, 'not_evaluated');
  });
});

describe('content-h1-empty-or-image', () => {
  test('passes an image h1 with alt text', () => {
    assert.equal(run(h1EmptyOrImage, [page(url, { html: doc('', '<h1><img src="/logo.png" alt="Acme garden tools"></h1>') })]).at()?.outcome, 'pass');
  });

  test('fails low on an image h1 without alt', () => {
    const { at, excerpts } = run(h1EmptyOrImage, [page(url, { html: doc('', '<h1><img src="/logo.png"></h1>') })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['low', 'empty']);
    assert.deepEqual(excerpts(at()), ['<h1><img src="/logo.png"></h1>']);
  });

  test('fails when every h1 is display:none in both renders', () => {
    const html = doc('', '<h1 class="seo">Cheap tools</h1>');
    const hidden = { html, textBlocks: [block('h1.seo', 'Cheap tools', { hidden: 'display-none' })] };
    assert.equal(run(h1EmptyOrImage, [page(url, { html, rendered: hidden, userRender: hidden })]).at()?.reason, 'hidden');
  });

  test('does not treat a reveal-on-scroll h1 at opacity 0 or a screen-reader h1 as hidden', () => {
    const html = doc('', '<section data-reveal><h1>Garden tools</h1></section><h1 class="sr-only">Shop</h1>');
    const rendered = { html, textBlocks: [block('section > h1', 'Garden tools', { hidden: 'opacity-zero' }), block('h1.sr-only', 'Shop', { hidden: 'visually-hidden' })] };
    assert.equal(run(h1EmptyOrImage, [page(url, { html, rendered })]).at()?.outcome, 'pass');
  });

  test('does not apply without an h1', () => {
    assert.equal(run(h1EmptyOrImage, [page(url, { html: doc('') })]).at()?.reason, 'no-h1');
  });
});

describe('content-heading-level-skips', () => {
  test('passes a nested outline', () => {
    assert.equal(run(headingLevelSkips, [page(url, { html: doc('', '<main><h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2></main>') })]).at()?.outcome, 'pass');
  });

  test('fails low on a skip and cites the heading', () => {
    const { at, excerpts } = run(headingLevelSkips, [page(url, { html: doc('', '<main><h1>A</h1><h2>B</h2><h4>Details</h4></main>') })]);
    assert.deepEqual([at()?.severity, at()?.params?.from, at()?.params?.to], ['low', 'h2', 'h4']);
    assert.deepEqual(excerpts(at()), ['<h4>Details']);
  });

  test('ignores cookie-banner headings outside main and footer headings', () => {
    const body = '<div id="cookie-banner"><h5>We use cookies</h5></div><main><h1>A</h1><h2>B</h2></main><footer><h5>Contact</h5></footer>';
    assert.equal(run(headingLevelSkips, [page(url, { html: doc('', body) })]).at()?.outcome, 'pass');
  });

  test('does not apply with fewer than two headings', () => {
    assert.equal(run(headingLevelSkips, [page(url, { html: doc('', '<h1>A</h1>') })]).at()?.outcome, 'not_applicable');
  });
});

describe('content-main-landmark', () => {
  test('passes with one main, ignoring hidden ones', () => {
    assert.equal(run(mainLandmark, [page(url, { html: doc('', '<main>A</main><main hidden>B</main>') })]).at()?.outcome, 'pass');
  });

  test('fails low without a main landmark', () => {
    assert.deepEqual([run(mainLandmark, [page(url, { html: doc('', '<div>A</div>') })]).at()?.reason], ['none']);
  });

  test('fails low with two visible main landmarks', () => {
    const { at, excerpts } = run(mainLandmark, [page(url, { html: doc('', '<main id="a">A</main><div role="main">B</div>') })]);
    assert.deepEqual([at()?.reason, at()?.params?.count], ['multiple', 2]);
    assert.deepEqual(excerpts(at()), ['<main id="a">', '<div role="main">']);
  });

  test('is not evaluated without the raw HTML', () => {
    assert.equal(run(mainLandmark, [page(url)]).at()?.outcome, 'not_evaluated');
  });
});
