import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFacts } from '../src/collect/page.ts';
import { directivesFor, hreflangLinks, robotsDirectives, splitDirectives, summarizeList } from '../src/rules/helpers.ts';
import { headers } from './support/facts.ts';

test('splits robots directives and keeps unavailable_after dates whole', () => {
  assert.deepEqual(splitDirectives('NoIndex, nofollow , max-snippet : 50'), ['noindex', 'nofollow', 'max-snippet:50']);
  assert.deepEqual(splitDirectives('unavailable_after: Friday, 25-Jun-2027 15:00:00 PST, noarchive'),
    ['unavailable_after:friday, 25-jun-2027 15:00:00 pst', 'noarchive']);
});

test('collects robots directives from meta elements and X-Robots-Tag headers, per crawler', () => {
  const doc = documentFacts('<!doctype html><head><title>T</title><meta name="robots" content="max-image-preview:large"><meta name="googlebot" content="noindex"><meta name="bingbot" content="nosnippet"></head>');
  const all = robotsDirectives(headers({ 'X-Robots-Tag': ['none', 'otherbot: noarchive'] }), doc);
  assert.deepEqual(all.map(entry => [entry.source, entry.agent, entry.directives.join(' ')]), [
    ['meta', 'all', 'max-image-preview:large'],
    ['meta', 'googlebot', 'noindex'],
    ['meta', 'bingbot', 'nosnippet'],
    ['header', 'all', 'none'],
    ['header', 'otherbot', 'noarchive'],
  ]);
  const googlebot = directivesFor(all, 'googlebot');
  assert.ok(googlebot.has('noindex') && googlebot.has('nofollow') && googlebot.has('max-image-preview:large'));
  assert.ok(!googlebot.has('nosnippet') && !googlebot.has('noarchive'));
  assert.ok(directivesFor(all, 'bingbot').has('nosnippet'));
});

test('resolves hreflang alternates against the page URL', () => {
  const doc = documentFacts('<!doctype html><head><title>T</title><link rel="alternate" hreflang="ca" href="/ca/"><link rel="alternate" hreflang="x-default" href="https://example.com/en/"><link rel="alternate" href="/feed.xml" type="application/rss+xml"></head>');
  assert.deepEqual(hreflangLinks(doc, 'https://example.com/en/').map(link => [link.hreflang, link.href]), [
    ['ca', 'https://example.com/ca/'],
    ['x-default', 'https://example.com/en/'],
  ]);
});

test('summarizes long lists for messages', () => {
  assert.equal(summarizeList(['a', 'b']), 'a, b');
  assert.equal(summarizeList(['a', 'b', 'c', 'd', 'e'], 2), 'a, b and 3 more');
});
