import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Finding } from '../../src/rules/engine.ts';
import { charsetDeclaredEarly, doctypeStandardsMode, duplicateConflictingHeadTags, iframeMainContent, noscriptContent } from '../../src/rules/tech/document.ts';
import { faviconDeclared, faviconFileValid } from '../../src/rules/tech/favicon.ts';
import { imageInfo } from '../../src/rules/tech/image.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';

const home = 'https://example.com/';
const url = 'https://example.com/a';
const doc = (body = '', head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title>${head}</head><body>${body}</body></html>`;

function only(findings: readonly Finding[]): Finding {
  assert.equal(findings.length, 1, JSON.stringify(findings));
  return findings[0]!;
}

function excerpt(result: ReturnType<typeof evaluate>, finding: Finding, index = 0): string | undefined {
  return result.evidence.get(finding.evidence[index]!)?.excerpt;
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function ico(sizes: readonly number[]): Buffer {
  const bytes = Buffer.alloc(6 + sizes.length * 16);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(sizes.length, 4);
  sizes.forEach((size, index) => {
    bytes[6 + index * 16] = size >= 256 ? 0 : size;
    bytes[7 + index * 16] = size >= 256 ? 0 : size;
    bytes.writeUInt32LE(1 << 20, 6 + index * 16 + 12);
  });
  return bytes;
}

const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');

describe('image headers', () => {
  test('reads PNG, ICO, GIF, JPEG and SVG', () => {
    assert.deepEqual(imageInfo(png(96, 96)), { format: 'png', width: 96, height: 96 });
    assert.deepEqual(imageInfo(ico([16, 48, 256])), { format: 'ico', width: 256, height: 256 });
    const gif = Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1');
    assert.deepEqual(imageInfo(gif), { format: 'gif', width: 32, height: 16 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x76, 0x04, 0xb0, 0x03]);
    assert.deepEqual(imageInfo(jpeg), { format: 'jpeg', width: 1200, height: 630 });
    assert.deepEqual(imageInfo(svg), { format: 'svg' });
    assert.deepEqual(imageInfo(Buffer.from('<!doctype html><title>404</title>')), { format: undefined });
  });
});

describe('tech-favicon-declared', () => {
  test('passes a favicon link in the home page head', () => {
    const result = evaluate(faviconDeclared, site({ pages: [page(home, { html: doc('', '<link rel="icon" href="/favicon.png">') })] }));
    const finding = outcomeOn(result.findings, home)!;
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '<link rel="icon" href="/favicon.png">');
  });

  test('fails medium without any favicon link', () => {
    const result = evaluate(faviconDeclared, site({ pages: [page(home, { html: doc() })] }));
    const finding = outcomeOn(result.findings, home)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'medium', 'missing']);
    assert.equal(excerpt(result, finding), '<link rel="icon"> (absent)');
  });

  test('reports an undeclared /favicon.ico as info only', () => {
    const facts = site({ pages: [page(home, { html: doc() })], resources: [{ url: 'https://example.com/favicon.ico', purpose: 'favicon', referencedBy: home, body: ico([32]), headers: { 'content-type': 'image/x-icon' } }] });
    const finding = outcomeOn(evaluate(faviconDeclared, facts).findings, home)!;
    assert.deepEqual([finding.severity, finding.reason], ['info', 'favicon-ico-only']);
  });

  test('is not applicable to pages other than the home page', () => {
    const finding = outcomeOn(evaluate(faviconDeclared, site({ pages: [page('https://example.com/blog/post', { html: doc(), pageType: 'article' })] })).findings, 'https://example.com/blog/post')!;
    assert.deepEqual([finding.outcome, finding.reason], ['not_applicable', 'page-type:article']);
  });
});

describe('tech-favicon-file-valid', () => {
  const declared = (head: string, resources: Parameters<typeof site>[0]['resources'], robots?: string) =>
    site({ pages: [page(home, { html: doc('', head) })], homeUrl: home, resources: resources ?? [], ...(robots === undefined ? {} : { robots }) });
  const resource = (path: string, body: Buffer, type: string, status = 200) => ({ url: `https://example.com${path}`, purpose: 'favicon' as const, referencedBy: home, body, status, headers: { 'content-type': type } });

  test('passes a large square PNG', () => {
    const result = evaluate(faviconFileValid, declared('<link rel="icon" href="/icon.png">', [resource('/icon.png', png(192, 192), 'image/png')]));
    const finding = only(result.findings);
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '200 image/png png 192x192');
  });

  test('passes SVG with a raster fallback and never measures the SVG', () => {
    const facts = declared('<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico">', [
      resource('/icon.svg', svg, 'image/svg+xml'),
      resource('/favicon.ico', ico([16, 32, 96]), 'image/x-icon'),
    ]);
    assert.equal(only(evaluate(faviconFileValid, facts).findings).outcome, 'pass');
  });

  test('fails medium when only SVG is declared', () => {
    const result = evaluate(faviconFileValid, declared('<link rel="icon" href="/icon.svg">', [resource('/icon.svg', svg, 'image/svg+xml')]));
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'medium', 'svg-only']);
    assert.equal(excerpt(result, finding), '200 image/svg+xml svg');
  });

  test('fails medium on a non-square or missing file, and low on a small one', () => {
    assert.equal(only(evaluate(faviconFileValid, declared('<link rel="icon" href="/icon.png">', [resource('/icon.png', png(64, 32), 'image/png')])).findings).reason, 'not-square');
    assert.equal(only(evaluate(faviconFileValid, declared('<link rel="icon" href="/icon.png">', [resource('/icon.png', Buffer.from('<html>'), 'text/html', 404)])).findings).reason, 'not-200');
    const small = only(evaluate(faviconFileValid, declared('<link rel="icon" href="/icon.png">', [resource('/icon.png', png(32, 32), 'image/png')])).findings);
    assert.deepEqual([small.severity, small.reason], ['low', 'small']);
  });

  test('fails when robots.txt blocks Googlebot-Image', () => {
    const facts = declared('<link rel="icon" href="/assets/icon.png">', [resource('/assets/icon.png', png(96, 96), 'image/png')], 'User-agent: Googlebot-Image\nDisallow: /assets/\n');
    assert.equal(only(evaluate(faviconFileValid, facts).findings).reason, 'blocked-for-googlebot-image');
  });

  test('is not applicable when the home page declares no favicon, and not evaluated without resources', () => {
    const facts = declared('', [resource('/favicon.ico', ico([32]), 'image/x-icon')]);
    assert.deepEqual([only(evaluate(faviconFileValid, facts).findings).outcome, only(evaluate(faviconFileValid, facts).findings).reason], ['not_applicable', 'no-declared-favicon']);
    assert.equal(only(evaluate(faviconFileValid, declared('<link rel="icon" href="/i.png">', [])).findings).reason, 'missing-input:resources');
  });
});

describe('tech-duplicate-conflicting-head-tags', () => {
  test('passes identical duplicates and several og:image tags', () => {
    const head = '<meta name="description" content="Same"><meta name="description" content="Same"><meta property="og:image" content="/a.png"><meta property="og:image" content="/b.png">';
    assert.equal(outcomeOn(evaluate(duplicateConflictingHeadTags, site({ pages: [page(url, { html: doc('', head) })] })).findings, url)?.outcome, 'pass');
  });

  test('fails low on two different descriptions', () => {
    const result = evaluate(duplicateConflictingHeadTags, site({ pages: [page(url, { html: doc('', '<meta name="description" content="One"><meta name="description" content="Two">') })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.tags], ['fail', 'low', 'meta description']);
    assert.equal(excerpt(result, finding), '<meta name="description" content="One">');
  });

  test('leaves conflicting canonicals to the crawl rule', () => {
    const head = '<link rel="canonical" href="https://example.com/a"><link rel="canonical" href="https://example.com/b">';
    assert.equal(outcomeOn(evaluate(duplicateConflictingHeadTags, site({ pages: [page(url, { html: doc('', head) })] })).findings, url)?.outcome, 'pass');
  });

  test('is not evaluated without HTML', () => {
    assert.equal(outcomeOn(evaluate(duplicateConflictingHeadTags, site({ pages: [page(url)] })).findings, url)?.outcome, 'not_evaluated');
  });
});

describe('tech-doctype-standards-mode', () => {
  test('passes <!DOCTYPE html>', () => {
    const result = evaluate(doctypeStandardsMode, site({ pages: [page(url, { html: doc() })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '<!doctype html>; mode=no-quirks');
  });

  test('fails low without a doctype or with a legacy one', () => {
    const missing = outcomeOn(evaluate(doctypeStandardsMode, site({ pages: [page(url, { html: '<html><head><title>x</title></head><body></body></html>' })] })).findings, url)!;
    assert.deepEqual([missing.outcome, missing.severity, missing.reason], ['fail', 'low', 'missing']);
    const strict = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html><body></body></html>';
    assert.equal(outcomeOn(evaluate(doctypeStandardsMode, site({ pages: [page(url, { html: strict })] })).findings, url)?.reason, 'legacy-doctype');
  });

  test('is not applicable to XML documents', () => {
    const facts = site({ pages: [page(url, { html: doc(), headers: { 'content-type': 'application/xhtml+xml' } })] });
    assert.equal(outcomeOn(evaluate(doctypeStandardsMode, facts).findings, url)?.reason, 'xml-document');
  });
});

describe('tech-charset-declared-early', () => {
  test('passes a meta charset within 1024 bytes when Content-Type has no charset', () => {
    const facts = site({ pages: [page(url, { html: doc(), headers: { 'content-type': 'text/html' } })] });
    const result = evaluate(charsetDeclaredEarly, facts);
    const finding = outcomeOn(result.findings, url)!;
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding, 1), '<meta charset="utf-8">');
  });

  test('fails medium when the only meta charset comes after 1024 bytes', () => {
    const late = `<!doctype html><html><head><style>${'x'.repeat(1100)}</style><meta charset="utf-8"></head><body></body></html>`;
    const result = evaluate(charsetDeclaredEarly, site({ pages: [page(url, { html: late, headers: { 'content-type': 'text/html' } })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'medium', 'late-meta']);
    assert.equal(excerpt(result, finding), 'Content-Type: text/html');
  });

  test('fails when header and meta disagree', () => {
    const facts = site({ pages: [page(url, { html: doc(), headers: { 'content-type': 'text/html; charset=iso-8859-1' } })] });
    assert.equal(outcomeOn(evaluate(charsetDeclaredEarly, facts).findings, url)?.reason, 'not-utf8');
  });

  test('passes on a UTF-8 BOM and is not applicable to XML', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!doctype html><title>x</title>')]);
    const withBom = page(url, { html: '<!doctype html><title>x</title>', headers: { 'content-type': 'text/html' } });
    const facts = site({ pages: [{ ...withBom, fetch: { ...withBom.fetch, body: bom } }] });
    assert.equal(outcomeOn(evaluate(charsetDeclaredEarly, facts).findings, url)?.outcome, 'pass');
    assert.equal(outcomeOn(evaluate(charsetDeclaredEarly, site({ pages: [page(url, { html: doc(), headers: { 'content-type': 'application/xml' } })] })).findings, url)?.outcome, 'not_applicable');
  });
});

describe('tech-iframe-main-content', () => {
  const words = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ');

  test('passes a titled video embed on a page with its own content', () => {
    const facts = site({ pages: [page(url, { html: doc(`<main><p>${words}</p><iframe src="https://www.youtube.com/embed/x" title="Product video"></iframe></main>`) })] });
    assert.equal(outcomeOn(evaluate(iframeMainContent, facts).findings, url)?.outcome, 'pass');
  });

  test('fails low on an untitled iframe, ignoring hidden tracking frames', () => {
    const html = doc(`<p>${words}</p><iframe src="https://www.google.com/maps/embed?pb=1"></iframe><iframe src="https://tracker.example.net/" width="0" height="0"></iframe>`);
    const result = evaluate(iframeMainContent, site({ pages: [page(url, { html })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason, finding.params?.count], ['fail', 'low', 'missing-title', 1]);
    assert.equal(excerpt(result, finding), '<iframe src="https://www.google.com/maps/embed?pb=1">');
  });

  test('hands a short page framing other content to the analyst', () => {
    const facts = site({ pages: [page(url, { html: doc('<iframe src="https://app.example.net/content" title="Content"></iframe>') })] });
    const finding = outcomeOn(evaluate(iframeMainContent, facts).findings, url)!;
    assert.deepEqual([finding.reason, finding.needsJudgment, finding.severity], ['content-in-iframe', true, 'low']);
  });

  test('is not applicable without iframes', () => {
    assert.equal(outcomeOn(evaluate(iframeMainContent, site({ pages: [page(url, { html: doc('<p>x</p>') })] })).findings, url)?.reason, 'no-iframes');
  });
});

describe('tech-noscript-content', () => {
  const long = Array.from({ length: 60 }, (_, index) => `hidden${index}`).join(' ');

  test('passes a tracking pixel and an enable-JavaScript message', () => {
    const html = doc('<noscript><img src="https://www.facebook.com/tr?id=1" height="1" width="1"></noscript><noscript>Please enable JavaScript.</noscript>');
    assert.equal(outcomeOn(evaluate(noscriptContent, site({ pages: [page(url, { html, rendered: doc('<p>Rendered</p>') })] })).findings, url)?.outcome, 'pass');
  });

  test('hands substantial noscript-only text to the analyst', () => {
    const result = evaluate(noscriptContent, site({ pages: [page(url, { html: doc(`<noscript><p>${long}</p></noscript>`), rendered: doc('<p>Rendered page</p>') })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.needsJudgment], ['fail', 'info', true]);
    assert.match(excerpt(result, finding)!, /^<p>hidden0 hidden1/u);
  });

  test('is not applicable without noscript', () => {
    assert.equal(outcomeOn(evaluate(noscriptContent, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'no-noscript');
  });
});
