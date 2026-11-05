import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseHtml } from '../src/parse/html.ts';
import { extractStructuredData, nodesOfType } from '../src/parse/structured-data.ts';

function extract(body: string, head = '') {
  return extractStructuredData(parseHtml(`<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`));
}

describe('JSON-LD', () => {
  test('flattens @graph and nested nodes with their paths', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', '@id': 'https://example.com/#org', name: 'Example', logo: { '@type': 'ImageObject', url: 'https://example.com/logo.png' } },
        { '@type': ['WebSite'], '@id': 'https://example.com/#website', publisher: { '@id': 'https://example.com/#org' } },
      ],
    };
    const data = extract('', `<script type="application/ld+json">${JSON.stringify(graph)}</script>`);
    assert.equal(data.jsonLd.length, 1);
    assert.equal(data.jsonLd[0]?.inHead, true);
    assert.deepEqual(data.nodes.map(node => [node.types.join(), node.path, node.nested]), [
      ['Organization', 'jsonld[0].@graph[0]', false],
      ['ImageObject', 'jsonld[0].@graph[0].logo', true],
      ['WebSite', 'jsonld[0].@graph[1]', false],
    ]);
    assert.equal(nodesOfType(data, 'Organization')[0]?.id, 'https://example.com/#org');
    assert.ok(data.nodes.every(node => node.schemaOrg));
  });

  test('accepts prefixed types and schema.org contexts in several forms', () => {
    const blocks = [
      { '@context': 'http://schema.org/', '@type': 'http://schema.org/Article', headline: 'A' },
      { '@context': { '@vocab': 'https://schema.org/' }, '@type': 'schema:Person', name: 'B' },
      { '@context': ['https://schema.org', { ex: 'https://example.com/' }], '@type': 'Event', name: 'C' },
    ];
    const data = extract(blocks.map(block => `<script type="application/ld+json">${JSON.stringify(block)}</script>`).join(''));
    assert.deepEqual(data.nodes.map(node => [node.types[0], node.schemaOrg]), [['Article', true], ['Person', true], ['Event', true]]);
  });

  test('flags a missing or foreign context', () => {
    const data = extract('<script type="application/ld+json">{"@type":"Product","name":"X"}</script>'
      + '<script type="application/ld+json">{"@context":"https://example.org/vocab","@type":"Thing"}</script>');
    assert.deepEqual(data.nodes.map(node => node.schemaOrg), [false, false]);
  });

  test('reports blocks that are not valid JSON', () => {
    const data = extract('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization",}</script>');
    assert.equal(data.nodes.length, 0);
    assert.match(data.jsonLd[0]?.error ?? '', /JSON/u);
  });

  test('ignores scripts of other types', () => {
    const data = extract('<script type="application/json">{"@type":"Organization"}</script><script>var x = {"@type": "Thing"}</script>');
    assert.equal(data.jsonLd.length, 0);
  });
});

describe('microdata', () => {
  test('extracts items, nested items and property values', () => {
    const data = extract([
      '<div itemscope itemtype="https://schema.org/Product">',
      '<span itemprop="name">Lamp</span>',
      '<img itemprop="image" src="/lamp.jpg" alt="Lamp">',
      '<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">',
      '<meta itemprop="price" content="25.00"><link itemprop="availability" href="https://schema.org/InStock">',
      '</div>',
      '</div>',
    ].join(''));
    assert.deepEqual(data.nodes.map(node => [node.types[0], node.path, node.nested]),
      [['Product', 'microdata[0]', false], ['Offer', 'microdata[0].offers', true]]);
    const [product, offer] = data.nodes;
    assert.deepEqual(product?.properties.name, ['Lamp']);
    assert.deepEqual(product?.properties.image, ['/lamp.jpg']);
    assert.deepEqual(product?.properties.offers, [{ '@node': 'microdata[0].offers' }]);
    assert.equal(product?.properties.price, undefined);
    assert.deepEqual(offer?.properties.price, ['25.00']);
    assert.deepEqual(offer?.properties.availability, ['https://schema.org/InStock']);
  });
});

describe('RDFa', () => {
  test('detects RDFa attributes but not Open Graph meta properties', () => {
    assert.equal(extract('', '<meta property="og:title" content="T">').rdfa, false);
    assert.equal(extract('<div vocab="https://schema.org/" typeof="Person"><span property="name">A</span></div>').rdfa, true);
  });
});
