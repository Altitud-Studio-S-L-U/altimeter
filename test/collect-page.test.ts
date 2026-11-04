import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeHtml, isHtmlResponse } from '../src/collect/page.ts';
import { notFoundProbeUrl, urlVariants } from '../src/collect/probes.ts';

test('recognizes HTML by content type, and by content when the type is missing', () => {
  assert.equal(isHtmlResponse({ 'content-type': ['text/html; charset=utf-8'] }, Buffer.from('x')), true);
  assert.equal(isHtmlResponse({ 'content-type': ['application/json'] }, Buffer.from('<html>')), false);
  assert.equal(isHtmlResponse({}, Buffer.from('  <!DOCTYPE html><title>x</title>')), true);
  assert.equal(isHtmlResponse({}, Buffer.from('plain text')), false);
});

test('decodes with the declared charset', () => {
  const latin1 = Buffer.from('<html><head><meta charset="iso-8859-1"><title>Caf\xe9</title>', 'latin1');
  assert.match(decodeHtml({ 'content-type': ['text/html'] }, latin1), /Café/u);
  const header = Buffer.from('<title>Caf\xe9</title>', 'latin1');
  assert.match(decodeHtml({ 'content-type': ['text/html; charset=windows-1252'] }, header), /Café/u);
  assert.match(decodeHtml({}, Buffer.from('﻿<title>Ação</title>', 'utf8')), /^<title>Ação/u);
});

test('builds the URL variants that should consolidate to the audited URL', () => {
  const variants = urlVariants('https://example.com/en/about/');
  assert.deepEqual(variants.map(variant => [variant.label, variant.url]), [
    ['trailing-slash', 'https://example.com/en/about'],
    ['index-file', 'https://example.com/en/about/index.html'],
    ['uppercase', 'https://example.com/EN/ABOUT/'],
    ['tracking-parameter', 'https://example.com/en/about/?utm_source=altimeter'],
    ['double-slash', 'https://example.com//en/about/'],
    ['http', 'http://example.com/en/about/'],
    ['www', 'https://www.example.com/en/about/'],
  ]);
  assert.deepEqual(urlVariants('https://www.example.com/').map(variant => variant.label), ['index-file', 'tracking-parameter', 'http', 'www']);
  assert.equal(urlVariants('https://www.example.com/').find(variant => variant.label === 'www')?.url, 'https://example.com/');
  assert.equal(urlVariants('https://example.com/file.pdf').some(variant => variant.label === 'trailing-slash'), false);
});

test('probes a random path on the same origin', () => {
  const probe = new URL(notFoundProbeUrl('https://example.com'));
  assert.equal(probe.origin, 'https://example.com');
  assert.match(probe.pathname, /^\/altimeter-probe-[0-9a-f]{12}\/$/u);
  assert.notEqual(notFoundProbeUrl('https://example.com'), notFoundProbeUrl('https://example.com'));
});
