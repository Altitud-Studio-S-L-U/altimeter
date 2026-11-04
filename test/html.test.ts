import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { baseUrl, metaContent, parseHtml } from '../src/parse/html.ts';

describe('parseHtml', () => {
  test('extracts head metadata with positions', () => {
    const source = [
      '<!doctype html>',
      '<html lang="ca">',
      '<head>',
      '<meta charset="utf-8">',
      '<title>Inici | Exemple</title>',
      '<meta name="description" content="Una descripció">',
      '<link rel="canonical" href="https://example.com/ca/">',
      '<link rel="alternate" hreflang="es" href="https://example.com/es/">',
      '</head>',
      '<body><h1>Inici</h1></body></html>',
    ].join('\n');
    const parsed = parseHtml(source);
    assert.equal(parsed.mode, 'no-quirks');
    assert.equal(parsed.doctype, 'html');
    assert.equal(parsed.htmlLang, 'ca');
    assert.deepEqual(parsed.titles.map(title => [title.text, title.line, title.inHead]), [['Inici | Exemple', 5, true]]);
    assert.equal(metaContent(parsed, 'description')[0]?.attrs.content, 'Una descripció');
    const canonical = parsed.links.find(link => link.rel.includes('canonical'));
    assert.equal(canonical?.attrs.href, 'https://example.com/ca/');
    assert.equal(canonical?.inHead, true);
    assert.equal(parsed.headClosure, undefined);
    assert.equal(parsed.charsetByteOffset, Buffer.byteLength(source.slice(0, source.indexOf('<meta charset'))));
  });

  test('detects an element that ends the head early and the metadata it displaces', () => {
    const parsed = parseHtml([
      '<!doctype html><html><head>',
      '<title>Page</title>',
      '<img src="/pixel.gif">',
      '<link rel="canonical" href="https://example.com/page">',
      '<link rel="alternate" hreflang="en" href="https://example.com/en/page">',
      '</head><body><p>Content</p></body></html>',
    ].join('\n'));
    assert.equal(parsed.headClosure?.cause.kind, 'element');
    assert.deepEqual(parsed.headClosure?.cause.kind === 'element' ? [parsed.headClosure.cause.tag, parsed.headClosure.cause.line] : [], ['img', 3]);
    assert.deepEqual(parsed.headClosure?.displaced.map(entry => entry.attrs.rel), ['canonical', 'alternate']);
    assert.equal(parsed.links.find(link => link.rel.includes('canonical'))?.inHead, false);
    assert.equal(parsed.titles[0]?.inHead, true);
  });

  test('detects stray text that ends the head', () => {
    const parsed = parseHtml('<!doctype html><html><head><title>T</title>oops<meta name="robots" content="noindex"></head><body></body></html>');
    assert.deepEqual(parsed.headClosure?.cause, { kind: 'text', text: 'oops', line: 1 });
    assert.equal(parsed.headClosure?.displaced[0]?.attrs.name, 'robots');
  });

  test('does not flag metadata that is legitimately in the body', () => {
    const parsed = parseHtml('<!doctype html><html><head><title>T</title></head><body><div><meta itemprop="name" content="x"></div></body></html>');
    assert.equal(parsed.headClosure, undefined);
  });

  test('reports quirks mode without a doctype', () => {
    assert.equal(parseHtml('<html><head><title>T</title></head></html>').mode, 'quirks');
  });

  test('collects headings, links with image alt text and images', () => {
    const parsed = parseHtml([
      '<!doctype html><html><head><title>T</title></head><body>',
      '<h1>Main  heading</h1><h3>Skipped level</h3>',
      '<a href="/services" rel="nofollow UGC">Our <b>services</b></a>',
      '<a href="/home"><img src="/logo.svg" alt="Home"></a>',
      '<img src="/a.png" alt="">',
      '<script>var hidden = "not text";</script>',
      '</body></html>',
    ].join(''));
    assert.deepEqual(parsed.headings.map(h => [h.level, h.text]), [[1, 'Main heading'], [3, 'Skipped level']]);
    assert.deepEqual(parsed.anchors.map(a => [a.attrs.href, a.text, a.imageAlt, a.rel]),
      [['/services', 'Our services', '', ['nofollow', 'ugc']], ['/home', '', 'Home', []]]);
    assert.deepEqual(parsed.images.map(image => image.attrs.alt), ['Home', '']);
    assert.equal(parsed.bodyText.includes('not text'), false);
    assert.match(parsed.bodyText, /Main heading Skipped level Our services/u);
  });
});

describe('baseUrl', () => {
  const page = 'https://example.com/en/about/team';
  const base = (head: string) => baseUrl(parseHtml(`<!doctype html><html><head>${head}</head><body></body></html>`), page);

  test('resolves the first base element with an href against the document URL', () => {
    assert.equal(base('<base target="_blank"><base href="../blog/"><base href="/other/">'), 'https://example.com/en/blog/');
    assert.equal(base('<base href="https://cdn.example.net/assets/">'), 'https://cdn.example.net/assets/');
  });

  test('falls back to the document URL without a usable http or https base', () => {
    assert.equal(base(''), page);
    assert.equal(base('<base href="javascript:void(0)">'), page);
    assert.equal(base('<base href="http://[bad">'), page);
  });
});
