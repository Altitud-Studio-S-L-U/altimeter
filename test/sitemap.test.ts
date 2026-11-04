import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeSitemapBody, isW3cDatetime, parseSitemap, sitemapLimits } from '../src/fetch/sitemap.ts';

const urlset = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://example.com/en/</loc>
    <lastmod>2026-10-30</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/"/>
    <xhtml:link rel="alternate" hreflang="ca" href="https://example.com/ca/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/en/"/>
    <image:image><image:loc>https://example.com/hero.webp</image:loc></image:image>
  </url>
  <url><loc>https://example.com/ca/?a=1&amp;b=2</loc></url>
</urlset>`;

describe('parseSitemap', () => {
  test('reads URLs with lastmod, ignored tags, hreflang alternates and images', () => {
    const doc = parseSitemap(urlset);
    assert.equal(doc.kind, 'urlset');
    assert.equal(doc.namespace, 'http://www.sitemaps.org/schemas/sitemap/0.9');
    assert.deepEqual(doc.errors, []);
    assert.equal(doc.urls.length, 2);
    const [first, second] = doc.urls;
    assert.equal(first?.lastmod, '2026-10-30');
    assert.equal(first?.changefreq, 'weekly');
    assert.equal(first?.priority, '0.8');
    assert.deepEqual(first?.alternates.map(alternate => alternate.hreflang), ['en', 'ca', 'x-default']);
    assert.equal(first?.images, 1);
    assert.equal(second?.loc, 'https://example.com/ca/?a=1&b=2');
    assert.equal(second?.lastmod, undefined);
  });

  test('reads sitemap indexes', () => {
    const doc = parseSitemap(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-0.xml</loc><lastmod>2026-11-01T10:00:00+01:00</lastmod></sitemap>
    </sitemapindex>`);
    assert.equal(doc.kind, 'sitemapindex');
    assert.deepEqual(doc.sitemaps.map(entry => [entry.loc, entry.lastmod]), [['https://example.com/sitemap-0.xml', '2026-11-01T10:00:00+01:00']]);
  });

  test('reports a wrong namespace, entries without loc and malformed XML', () => {
    const wrong = parseSitemap('<urlset xmlns="http://example.com/other"><url><loc>https://example.com/</loc></url></urlset>');
    assert.equal(wrong.namespace, 'http://example.com/other');
    assert.equal(wrong.urls.length, 0);
    const missing = parseSitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><lastmod>2026-01-01</lastmod></url></urlset>');
    assert.match(missing.errors[0]?.message ?? '', /without <loc>/u);
    const broken = parseSitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</url>');
    assert.ok(broken.errors.length > 0);
  });

  test('never expands entities declared in a document type', () => {
    const doc = parseSitemap('<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY x "https://evil.example/">]><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>&x;</loc></url></urlset>');
    assert.ok(doc.errors.some(error => /Document type declarations/u.test(error.message)));
    assert.ok(doc.urls.every(url => !url.loc.includes('evil')));
  });

  test('decompresses gzip by content and enforces the size limit', () => {
    const doc = parseSitemap(gzipSync(urlset));
    assert.equal(doc.gzipped, true);
    assert.equal(doc.urls.length, 2);
    const bomb = gzipSync(Buffer.alloc(sitemapLimits.bytes + 10, 0x20));
    assert.match(decodeSitemapBody(bomb).error ?? '', /exceeds 50 MiB/u);
  });
});

describe('isW3cDatetime', () => {
  test('accepts the W3C Datetime profile and rejects other formats', () => {
    for (const value of ['2026', '2026-11', '2026-11-04', '2026-11-04T10:30Z', '2026-11-04T10:30:15+01:00', '2026-11-04T10:30:15.25Z']) {
      assert.equal(isW3cDatetime(value), true, value);
    }
    for (const value of ['04/11/2026', '2026-11-04 10:30', '2026-11-04T10:30', '2026-13-01', 'yesterday']) {
      assert.equal(isW3cDatetime(value), false, value);
    }
  });
});
