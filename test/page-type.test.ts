import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPage, type PageTypeInput } from '../src/analyze/page-type.ts';
import { parseHtml } from '../src/parse/html.ts';
import { extractStructuredData } from '../src/parse/structured-data.ts';

const base: PageTypeInput = { url: 'https://example.com/', status: 200, title: undefined, h1: undefined, ogType: undefined, data: undefined };

function type(input: Partial<PageTypeInput>): string {
  return classifyPage({ ...base, ...input }).type;
}

test('recognizes home pages and locale roots', () => {
  for (const url of ['https://example.com/', 'https://example.com/en/', 'https://example.com/ca', 'https://example.com/pt-br/']) {
    assert.equal(type({ url }), 'home', url);
  }
  assert.equal(type({ url: 'https://example.com/landing', isHome: true }), 'home');
});

test('recognizes legal, contact, about, utility and error pages in several languages', () => {
  assert.equal(type({ url: 'https://example.com/es/privacidad/' }), 'legal');
  assert.equal(type({ url: 'https://example.com/ca/avis-legal/' }), 'legal');
  assert.equal(type({ url: 'https://example.com/en/cookies/' }), 'legal');
  assert.equal(type({ url: 'https://example.com/es/contacto/' }), 'contact');
  assert.equal(type({ url: 'https://example.com/es/sobre-altitud/' }), 'about');
  assert.equal(type({ url: 'https://example.com/ca/qui-som/' }), 'about');
  assert.equal(type({ url: 'https://example.com/search?q=shoes' }), 'utility');
  assert.equal(type({ url: 'https://example.com/cart' }), 'utility');
  assert.equal(type({ url: 'https://example.com/missing', status: 404 }), 'error');
  assert.equal(type({ url: 'https://example.com/old', title: 'Page not found' }), 'error');
});

test('uses structured data and Open Graph types for content pages', () => {
  const article = extractStructuredData(parseHtml('<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"H"}</script>'));
  assert.equal(type({ url: 'https://example.com/posts/hello', data: article }), 'article');
  assert.equal(type({ url: 'https://example.com/item/42', ogType: 'product' }), 'product');
  assert.equal(type({ url: 'https://example.com/blog' }), 'listing');
  assert.equal(type({ url: 'https://example.com/en/services/custom-software/' }), 'service');
  assert.equal(type({ url: 'https://example.com/en/open-source/' }), 'other');
});

test('reads the main entity of a page node and treats recipes as articles', () => {
  const data = (html: string) => extractStructuredData(parseHtml(html));
  const jsonLd = (value: unknown) => data(`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...value as object })}</script>`);
  const lamp = { '@type': 'Product', name: 'Lamp', offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' } };
  assert.equal(type({ url: 'https://example.com/receptes/pa-amb-tomaquet', data: jsonLd({ '@type': 'Recipe', name: 'Pa amb tomaquet' }) }), 'article');
  assert.equal(type({ url: 'https://example.com/item/lamp', data: jsonLd({ '@type': 'ItemPage', mainEntity: lamp }) }), 'product');
  assert.equal(type({ url: 'https://example.com/item/lamp', data: jsonLd({ '@graph': [{ '@type': 'ItemPage', mainEntity: [lamp] }] }) }), 'product');
  const microdata = '<div itemscope itemtype="https://schema.org/ItemPage"><div itemprop="mainEntity" itemscope itemtype="https://schema.org/Product"><span itemprop="name">Lamp</span></div></div>';
  assert.equal(type({ url: 'https://example.com/item/lamp', data: data(microdata) }), 'product');
  assert.equal(type({ url: 'https://example.com/posts/lamp-review', data: jsonLd({ '@type': 'BlogPosting', headline: 'H', review: { '@type': 'Review', itemReviewed: lamp } }) }), 'article');
});
