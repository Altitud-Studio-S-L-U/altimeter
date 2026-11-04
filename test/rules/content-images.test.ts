import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import { imageSize, sniffImage } from '../../src/rules/content/image-bytes.ts';
import {
  imgAltMissing, imgAltQuality, imgCssBackground, imgFilename, imgFormat, imgLazyMisuse, preferredImage,
} from '../../src/rules/content/images.ts';
import type { RuleImplementation } from '../../src/rules/engine.ts';
import { evaluate, outcomeOn, page, site, type SiteSpec } from '../support/facts.ts';

const url = 'https://example.com/guides/pruning';
const doc = (body: string, head = '<title>Pruning</title>') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const article = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Pruning"}</script>';

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function run(rule: RuleImplementation, pages: readonly PageFacts[], extra: Partial<SiteSpec> = {}) {
  const { findings, evidence } = evaluate(rule, site({ pages, ...extra }));
  const excerpts = (finding: (typeof findings)[number] | undefined) => (finding?.evidence ?? []).map(id => evidence.get(id)?.excerpt);
  return { at: (target = url) => outcomeOn(findings, target), siteFindings: findings.filter(entry => entry.scope.kind === 'site'), findings, excerpts };
}

describe('image bytes', () => {
  test('reads PNG, GIF and JPEG sizes and sniffs SVG', () => {
    assert.deepEqual(imageSize(png(1600, 900)), { width: 1600, height: 900 });
    const gif = Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1');
    assert.deepEqual(imageSize(gif), { width: 800, height: 600 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
    assert.deepEqual(imageSize(jpeg), { width: 800, height: 600 });
    assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
  });
});

describe('content-img-alt-missing', () => {
  test('passes described images and decorative images with alt=""', () => {
    const html = doc('<main><img src="/a.jpg" alt="Pruning shears"><img src="/divider.svg" alt=""><img src="/a.jpg" alt="Pruning shears"></main>');
    assert.equal(run(imgAltMissing, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails medium for a content image without alt, and counts alt="" separately', () => {
    const html = doc('<main><img src="/hedge.jpg" width="800" height="600"><img src="/line.png" alt=""></main>');
    const { at, excerpts } = run(imgAltMissing, [page(url, { html })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.params?.count, at()?.params?.emptyAlt], ['medium', 'content-image', 1, 1]);
    assert.deepEqual(excerpts(at()), ['<img src="/hedge.jpg" width="800" height="600">']);
  });

  test('reports other images without alt as low and ignores tracking pixels and aria-hidden images', () => {
    const html = doc('<header><img src="/badge.png"></header><img src="https://www.facebook.com/tr?id=1" width="1" height="1"><img src="/x.png" aria-hidden="true">');
    const { at } = run(imgAltMissing, [page(url, { html })]);
    assert.deepEqual([at()?.severity, at()?.params?.count], ['low', 1]);
  });

  test('does not apply without images', () => {
    assert.equal(run(imgAltMissing, [page(url, { html: doc('<p>x</p>') })]).at()?.reason, 'no-images');
  });
});

describe('content-img-alt-quality', () => {
  test('passes descriptive alt text, including one image used twice', () => {
    const html = doc('<img src="/rose.jpg" alt="Rose bush after winter pruning"><img src="/rose.jpg" alt="Rose bush after winter pruning">');
    assert.equal(run(imgAltQuality, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails low when the alt repeats a camera file name', () => {
    const { at, excerpts } = run(imgAltQuality, [page(url, { html: doc('<img src="/uploads/IMG_4521.jpg" alt="IMG_4521">') })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.needsJudgment], ['low', 'filename', undefined]);
    assert.deepEqual(excerpts(at()), ['<img src="/uploads/IMG_4521.jpg" alt="IMG_4521">']);
  });

  test('hands generic alt text to the analyst', () => {
    const { at } = run(imgAltQuality, [page(url, { html: doc('<img src="/a.jpg" alt="photo">') })]);
    assert.deepEqual([at()?.reason, at()?.needsJudgment], ['generic', true]);
  });

  test('does not apply when no image has alt text', () => {
    assert.equal(run(imgAltQuality, [page(url, { html: doc('<img src="/a.jpg" alt="">') })]).at()?.reason, 'no-alt-text');
  });
});

describe('content-img-filename', () => {
  test('passes descriptive file names', () => {
    const html = doc('<main><img src="/img/rose-pruning.jpg" alt="a"><img src="/img/hedge-trimmer.webp" alt="b"></main>');
    assert.equal(run(imgFilename, [page(url, { html })]).siteFindings[0]?.outcome, 'pass');
  });

  test('fails low when most content images have opaque names', () => {
    const html = doc('<main><img src="/u/IMG_2231.jpg" alt="a"><img src="/u/9f86d081884c7d659a2feaa0c55ad015.png" alt="b"><img src="/u/hedge.jpg" alt="c"></main>');
    const { siteFindings, excerpts } = run(imgFilename, [page(url, { html })]);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.params?.count, siteFindings[0]?.params?.total], ['low', 2, 3]);
    assert.deepEqual(excerpts(siteFindings[0]), ['https://example.com/u/IMG_2231.jpg', 'https://example.com/u/9f86d081884c7d659a2feaa0c55ad015.png']);
  });

  test('does not apply with fewer than two content images', () => {
    assert.equal(run(imgFilename, [page(url, { html: doc('<main><img src="/IMG_1.jpg" alt="a"></main>') })]).siteFindings[0]?.reason, 'fewer-than-two-content-images');
  });
});

describe('content-img-css-background', () => {
  const html = doc('<main><div class="hero"></div></main>');

  test('passes when the largest paint is an img element', () => {
    const rendered = { html, lcp: { time: 900, size: 90000, tag: 'img', url: 'https://example.com/hero.jpg' } };
    assert.equal(run(imgCssBackground, [page(url, { html, rendered })]).at()?.outcome, 'pass');
  });

  test('fails medium when the largest paint is a CSS background with no img', () => {
    const rendered = { html, lcp: { time: 900, size: 90000, tag: 'div', url: 'https://example.com/hero.jpg', selector: 'div.hero' } };
    const { at, excerpts } = run(imgCssBackground, [page(url, { html, rendered })]);
    assert.deepEqual([at()?.severity, at()?.params?.element], ['medium', 'div']);
    assert.deepEqual(excerpts(at()), ['https://example.com/hero.jpg']);
  });

  test('passes a background that also exists as an img', () => {
    const withImg = doc('<main><div class="hero"></div><img src="/hero.jpg" alt="Garden"></main>');
    const rendered = { html: withImg, lcp: { time: 900, size: 90000, tag: 'div', url: 'https://example.com/hero.jpg' } };
    assert.equal(run(imgCssBackground, [page(url, { html: withImg, rendered })]).at()?.outcome, 'pass');
  });

  test('is not evaluated without a largest-paint entry', () => {
    assert.equal(run(imgCssBackground, [page(url, { html, rendered: html })]).at()?.reason, 'no-lcp-element');
  });
});

describe('content-img-format', () => {
  test('passes supported formats, including a picture with a JPEG XL source and JPEG fallback', () => {
    const html = doc('<picture><source type="image/jxl" srcset="/a.jxl"><img src="/a.jpg" alt="a"></picture>');
    assert.equal(run(imgFormat, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails medium on an img whose only source is HEIC', () => {
    const { at, excerpts } = run(imgFormat, [page(url, { html: doc('<img src="/photos/rose.heic" alt="Rose">') })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['medium', 'unsupported-format']);
    assert.deepEqual(excerpts(at()), ['<img src="/photos/rose.heic" alt="Rose">']);
  });

  test('reports an Open Graph image whose extension disagrees with its bytes as low', () => {
    const resources = [{ url: 'https://example.com/og.jpg', purpose: 'og-image' as const, referencedBy: url, body: png(1200, 630), headers: { 'content-type': 'image/png' } }];
    const { at } = run(imgFormat, [page(url, { html: doc('<p>x</p>') })], { resources });
    assert.deepEqual([at()?.severity, at()?.reason, at()?.params?.actual], ['low', 'extension-mismatch', 'png']);
  });

  test('does not apply without images', () => {
    assert.equal(run(imgFormat, [page(url, { html: doc('<p>x</p>') })]).at()?.reason, 'no-images');
  });
});

describe('content-img-lazy-misuse', () => {
  const placeholder = doc('<img src="data:image/gif;base64,R0lGOD" data-src="/rose.jpg" alt="Rose">');
  const swapped = doc('<img src="/rose.jpg" data-src="/rose.jpg" alt="Rose">');

  test('passes lazy images that load in the tall-viewport render', () => {
    assert.equal(run(imgLazyMisuse, [page(url, { html: placeholder, rendered: swapped, userRender: swapped })]).at()?.outcome, 'pass');
  });

  test('fails medium on an image that loads only after scrolling', () => {
    const { at, excerpts } = run(imgLazyMisuse, [page(url, { html: placeholder, rendered: placeholder, userRender: swapped })]);
    assert.deepEqual([at()?.severity, at()?.params?.count], ['medium', 1]);
    assert.deepEqual(excerpts(at()), ['src="data:image/gif;base64,R0lGOD" -> https://example.com/rose.jpg']);
  });

  test('does not apply without deferred images, and is not evaluated without the user render', () => {
    const plain = doc('<img src="/rose.jpg" loading="lazy" alt="Rose">');
    assert.equal(run(imgLazyMisuse, [page(url, { html: plain, rendered: plain, userRender: plain })]).at()?.reason, 'no-deferred-images');
    assert.equal(run(imgLazyMisuse, [page(url, { html: plain, rendered: plain })]).at()?.reason, 'missing-input:user-render');
  });
});

describe('content-preferred-image', () => {
  const og = (src: string) => `<title>Pruning</title>${article}<meta property="og:image" content="${src}">`;
  const resource = (src: string, body: Buffer, status = 200) => ({ url: src, purpose: 'og-image' as const, referencedBy: url, body, status, headers: { 'content-type': 'image/png' } });

  test('passes a large reachable image, shared across pages', () => {
    const src = 'https://example.com/share.png';
    const pages = [page(url, { html: doc('<p>x</p>', og(src)) }), page('https://example.com/guides/mulch', { html: doc('<p>x</p>', og(src)) })];
    const { findings } = run(preferredImage, pages, { resources: [resource(src, png(1600, 900))] });
    assert.deepEqual(findings.map(finding => finding.outcome), ['pass', 'pass']);
  });

  test('fails low on an article without a preferred image', () => {
    const { at, excerpts } = run(preferredImage, [page(url, { html: doc('<p>x</p>', `<title>Pruning</title>${article}`) })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['low', 'missing']);
    assert.deepEqual(excerpts(at()), [undefined]);
  });

  test('reports a logo, an unreachable image and a narrow image', () => {
    const logo = 'https://example.com/brand-logo.png';
    assert.equal(run(preferredImage, [page(url, { html: doc('<p>x</p>', og(logo)) })], { resources: [resource(logo, png(1600, 900))] }).at()?.reason, 'logo');
    const missing = 'https://example.com/gone.png';
    const unreachable = run(preferredImage, [page(url, { html: doc('<p>x</p>', og(missing)) })], { resources: [resource(missing, Buffer.alloc(0), 404)] }).at();
    assert.deepEqual([unreachable?.reason, unreachable?.params?.status], ['unreachable', 404]);
    const small = 'https://example.com/small.png';
    const narrow = run(preferredImage, [page(url, { html: doc('<p>x</p>', og(small)) })], { resources: [resource(small, png(800, 450))] }).at();
    assert.deepEqual([narrow?.severity, narrow?.params?.width], ['info', 800]);
  });

  test('never fails on an SVG size, and does not apply to pages that are not content pages', () => {
    const svg = 'https://example.com/share.svg';
    const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
    assert.equal(run(preferredImage, [page(url, { html: doc('<p>x</p>', og(svg)) })], { resources: [resource(svg, body)] }).at()?.reason, 'svg-size-not-measurable');
    assert.equal(run(preferredImage, [page('https://example.com/contact', { html: doc('<p>x</p>') })]).at('https://example.com/contact')?.reason, 'not-a-content-page');
  });
});
