import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import {
  bfcacheEligibility, documentRedirects, htmlCdn, htmlNoStore, httpProtocol, renderBlocking, serverResponseTime, speculationRulesCheck, staticCacheTtl,
  textCompression, unloadHandlers,
} from '../../src/rules/perf/delivery.ts';
import { evaluate, headers, page, site } from '../support/facts.ts';
import { assertExcerpt, assertFail, assertOutcome, check, html, lab, requests, table } from './perf-fixtures.ts';

const url = 'https://example.com/';
const longText = `<main><h1>Guide</h1><p>${'Plain words about the topic. '.repeat(80)}</p></main>`;
const withoutStatus = (facts: PageFacts): PageFacts => ({ ...facts, fetch: { ...facts.fetch, status: undefined } });

describe('perf-render-blocking', () => {
  test('passes deferred, async and module scripts and ignores inline data', () => {
    const head = '<script src="/app.js" defer></script><script async src="/a.js"></script><script type="module" src="/m.js"></script><script type="application/ld+json">{}</script>';
    assertOutcome(check(renderBlocking, page(url, { html: html(head) })), 'pass');
  });

  test('fails medium on a parser-blocking script in the head', () => {
    const checked = check(renderBlocking, page(url, { html: html('<script src="/vendor.js"></script>') }));
    assertFail(checked, 'medium', 'parser-blocking-script');
    assertExcerpt(checked, /^<script src="\/vendor\.js">$/u);
  });

  test('reports a synchronous consent script with the caveat, at low', () => {
    const checked = check(renderBlocking, page(url, { html: html('<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="0000"></script>') }));
    assertFail(checked, 'low', 'consent-script');
  });

  test('uses the insight only when Lighthouse estimates a saving', () => {
    const insight = (numericValue: number) => lab({ 'render-blocking-insight': { score: 0, numericValue, details: table([{ url: 'https://example.com/site.css', totalBytes: 9000, wastedMs: numericValue ? 300 : 0 }]) } });
    const checked = check(renderBlocking, page(url, { html: html('<link rel="stylesheet" href="/site.css">'), lighthouse: insight(450) }));
    assertFail(checked, 'low', 'render-blocking-requests');
    assertExcerpt(checked, /site\.css: 300 ms/u);
    assertOutcome(check(renderBlocking, page(url, { html: html('<link rel="stylesheet" href="/site.css">'), lighthouse: insight(0) })), 'pass');
  });

  test('is not evaluated without the server HTML', () => {
    assertOutcome(check(renderBlocking, page(url)), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('perf-document-redirects', () => {
  test('passes a URL that answers directly', () => {
    assertOutcome(check(documentRedirects, page(url, { html: html('') })), 'pass');
  });

  test('fails medium on a redirect to another path, citing the hop', () => {
    const checked = check(documentRedirects, page('https://example.com/old', { html: html(''), redirects: [[301, '/new']] }));
    assertFail(checked, 'medium');
    assert.deepEqual(checked.finding.params, { hops: 1, from: 'https://example.com/old', to: 'https://example.com/new' });
    assertExcerpt(checked, /^301 https:\/\/example\.com\/old -> https:\/\/example\.com\/new$/u);
  });

  test('accepts a root locale redirect when every locale answers and hreflang covers them', () => {
    const cluster = '<link rel="alternate" hreflang="en" href="https://example.com/en/"><link rel="alternate" hreflang="es" href="https://example.com/es/"><link rel="alternate" hreflang="x-default" href="https://example.com/">';
    const root = page(url, { html: html(cluster), redirects: [[302, '/en/']], headers: { vary: 'Cookie', 'cache-control': 'private, no-store' } });
    const spanish = page('https://example.com/es/', { html: html(cluster) });
    const { findings } = evaluate(documentRedirects, site({ pages: [root, spanish] }));
    assert.equal(findings.find(finding => finding.scope.kind === 'page' && finding.scope.url === url)?.outcome, 'pass');
  });

  test('fails the locale redirect when a locale URL itself redirects', () => {
    const cluster = '<link rel="alternate" hreflang="en" href="https://example.com/en/"><link rel="alternate" hreflang="es" href="https://example.com/es/">';
    const root = page(url, { html: html(cluster), redirects: [[302, '/en/']] });
    const spanish = page('https://example.com/es/', { html: html(cluster), redirects: [[302, '/']] });
    const { findings } = evaluate(documentRedirects, site({ pages: [root, spanish] }));
    assert.equal(findings.find(finding => finding.scope.kind === 'page' && finding.scope.url === url)?.outcome, 'fail');
  });

  test('accepts an https hop for a typed URL, but not when internal links use it', () => {
    const typed = page('http://example.com/', { html: html(''), redirects: [[301, 'https://example.com/']] });
    assertOutcome(check(documentRedirects, typed), 'pass');
    const linking = page('https://example.com/about', { html: html('', '<a href="http://example.com/">Home</a>') });
    const { findings } = evaluate(documentRedirects, site({ pages: [typed, linking] }));
    assert.equal(findings.find(finding => finding.scope.kind === 'page' && finding.scope.url === 'http://example.com/')?.outcome, 'fail');
  });

  test('is not evaluated without a response', () => {
    assertOutcome(check(documentRedirects, withoutStatus(page(url, { html: html('') }))), 'not_evaluated', 'missing-input:redirects');
  });
});

describe('perf-server-response-time', () => {
  const lighthouse = (numericValue: number) => lab({ 'server-response-time': { numericValue, numericUnit: 'millisecond', score: numericValue > 600 ? 0 : 1 } });

  test('passes a fast lab response', () => {
    assertOutcome(check(serverResponseTime, page(url, { html: html(''), lighthouse: lighthouse(180) })), 'pass');
  });

  test('fails low on one slow lab sample and medium when the collector agrees', () => {
    assertFail(check(serverResponseTime, page(url, { html: html(''), lighthouse: lighthouse(900), ttfbMs: 120 })), 'low');
    const checked = check(serverResponseTime, page(url, { html: html(''), lighthouse: lighthouse(900), ttfbMs: 950 }));
    assertFail(checked, 'medium');
    assertExcerpt(checked, /^950 ms$/u);
    assertExcerpt(checked, /numericValue=900 millisecond/u);
  });

  test('is not evaluated without the lab value', () => {
    assertOutcome(check(serverResponseTime, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-lab-value');
  });
});

describe('perf-text-compression', () => {
  test('passes compressed HTML and small uncompressed HTML', () => {
    assertOutcome(check(textCompression, page(url, { html: html('', longText), headers: { 'content-encoding': 'br' } })), 'pass');
    assertOutcome(check(textCompression, page(url, { html: html('') })), 'pass');
  });

  test('fails medium on uncompressed HTML', () => {
    const checked = check(textCompression, page(url, { html: html('', longText) }));
    assertFail(checked, 'medium', 'document');
    assertExcerpt(checked, /^content-encoding: \(absent\)$/u);
  });

  test('fails low on uncompressed first-party text assets and ignores images', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0h10v10H0z"/>'.repeat(80)}</svg>`;
    const lighthouse = lab({ 'network-requests': requests([
      { url: 'https://example.com/app.js', resourceType: 'Script', mimeType: 'application/javascript', transferSize: 6200, resourceSize: 6000 },
      { url: 'https://example.com/photo.jpg', resourceType: 'Image', mimeType: 'image/jpeg', transferSize: 90000, resourceSize: 90000 },
      { url: 'https://cdn.other.net/lib.js', resourceType: 'Script', mimeType: 'application/javascript', transferSize: 9000, resourceSize: 8800 },
    ]) });
    const checked = check(textCompression, page(url, { html: html(''), headers: { 'content-encoding': 'gzip' }, lighthouse }), {
      resources: [{ url: 'https://example.com/icon.svg', purpose: 'favicon', referencedBy: url, body: svg, headers: { 'content-type': 'image/svg+xml' } }],
    });
    assertFail(checked, 'low', 'assets');
    assert.equal(checked.finding.params?.count, 2);
    assertExcerpt(checked, /transferSize=6200 bytes/u);
  });

  test('is not evaluated without a response', () => {
    assertOutcome(check(textCompression, withoutStatus(page(url, { html: html('') }))), 'not_evaluated', 'missing-input:http');
  });
});

describe('perf-http-protocol', () => {
  const statics = (origin: string, protocol: string) => Array.from({ length: 6 }, (_, index) => ({ url: `${origin}/asset-${index}.js`, resourceType: 'Script', protocol }));

  test('passes HTTP/2 origins', () => {
    assertOutcome(check(httpProtocol, page(url, { html: html(''), lighthouse: lab({ 'network-requests': requests(statics('https://example.com', 'h2')) }) })), 'pass');
  });

  test('fails medium for a first-party origin on HTTP/1.1', () => {
    const checked = check(httpProtocol, page(url, { html: html(''), lighthouse: lab({ 'network-requests': requests(statics('https://static.example.com', 'http/1.1')) }) }));
    assertFail(checked, 'medium');
    assertExcerpt(checked, /6 static requests; protocols http\/1\.1/u);
  });

  test('reports third-party origins separately at low', () => {
    const checked = check(httpProtocol, page(url, { html: html(''), lighthouse: lab({ 'network-requests': requests(statics('https://widgets.vendor.net', 'http/1.1')) }) }));
    assertFail(checked, 'low', 'third-party');
  });

  test('is not evaluated without network requests', () => {
    assertOutcome(check(httpProtocol, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-network-requests');
  });
});

describe('perf-static-cache-ttl', () => {
  const cache = (items: Record<string, unknown>[]) => lab({ 'cache-insight': { score: items.length ? 0 : 1, details: table(items) } });

  test('passes when only third-party assets have short lifetimes', () => {
    assertOutcome(check(staticCacheTtl, page(url, { html: html(''), lighthouse: cache([{ url: 'https://www.googletagmanager.com/gtag/js', cacheLifetimeMs: 900000, totalBytes: 90000 }]) })), 'pass');
  });

  test('fails low and names fingerprinted files', () => {
    const checked = check(staticCacheTtl, page(url, { html: html(''), lighthouse: cache([{ url: 'https://example.com/assets/app.3f9a1c2e.js', cacheLifetimeMs: 3600000, totalBytes: 40000 }]) }));
    assertFail(checked, 'low', 'fingerprinted');
    assertExcerpt(checked, /app\.3f9a1c2e\.js: TTL 1 h/u);
  });

  test('fails low on an unhashed first-party image', () => {
    const checked = check(staticCacheTtl, page(url, { html: html(''), lighthouse: cache([{ url: 'https://example.com/img/photo.jpg', cacheLifetimeMs: 0, totalBytes: 40000 }]) }));
    assertFail(checked, 'low');
    assertExcerpt(checked, /no TTL/u);
  });

  test('is not evaluated without the insight', () => {
    assertOutcome(check(staticCacheTtl, page(url, { html: html(''), lighthouse: lab({}) })), 'not_evaluated', 'no-cache-insight');
  });
});

describe('perf-html-no-store', () => {
  test('treats max-age=0 with an ETag on edge-cached HTML as revalidation', () => {
    const checked = check(htmlNoStore, page(url, { html: html(''), headers: { 'cache-control': 'public, max-age=0, must-revalidate', etag: '"abc"', age: '12' } }));
    assertOutcome(checked, 'pass');
  });

  test('ignores Vary: Cookie on a private, no-store redirect hop', () => {
    const facts = page(url, { html: html(''), redirects: [[302, '/en/']], headers: { 'cache-control': 'public, max-age=300' } });
    const firstHop = { ...facts.fetch.hops[0]!, headers: headers({ location: '/en/', vary: 'Cookie', 'cache-control': 'private, no-store' }) };
    assertOutcome(check(htmlNoStore, { ...facts, fetch: { ...facts.fetch, hops: [firstHop, facts.fetch.hops[1]!] } }), 'pass');
  });

  test('fails low on public HTML served with no-store', () => {
    const checked = check(htmlNoStore, page(url, { html: html(''), headers: { 'cache-control': 'no-store' } }));
    assertFail(checked, 'low');
    assertExcerpt(checked, /^cache-control: no-store$/u);
  });

  test('passes private or login pages and hands cookie-setting pages to the analyst', () => {
    assertOutcome(check(htmlNoStore, page(url, { html: html(''), headers: { 'cache-control': 'private, no-store' } })), 'pass');
    assertOutcome(check(htmlNoStore, page(url, { html: html('', '<form><input type="password" name="p"></form>'), headers: { 'cache-control': 'no-store' } })), 'pass');
    const cookie = check(htmlNoStore, page(url, { html: html(''), headers: { 'cache-control': 'no-store', 'set-cookie': 'session=abc; HttpOnly' } }));
    assertFail(cookie, 'low', 'sets-cookie');
    assert.equal(cookie.finding.needsJudgment, true);
    assertExcerpt(cookie, /^set-cookie: session$/u);
  });

  test('does not apply to error or noindex pages', () => {
    assertOutcome(check(htmlNoStore, page(url, { html: html(''), status: 404, headers: { 'cache-control': 'no-store' } })), 'not_applicable', 'not-200');
    assertOutcome(check(htmlNoStore, page(url, { html: html('<meta name="robots" content="noindex, follow">'), headers: { 'cache-control': 'no-store' } })), 'not_applicable', 'noindex');
  });
});

describe('perf-bfcache-eligibility', () => {
  const bfcache = (score: number | null, items: Record<string, unknown>[] = [], mode = 'binary') => lab({ 'bf-cache': { score, scoreDisplayMode: mode, details: table(items) } });

  test('passes a restorable page', () => {
    assertOutcome(check(bfcacheEligibility, page(url, { html: html(''), lighthouse: bfcache(1) })), 'pass');
  });

  test('fails medium on an actionable reason', () => {
    const checked = check(bfcacheEligibility, page(url, { html: html(''), lighthouse: bfcache(0, [{ reason: 'Pages with WebSocket cannot enter back/forward cache.', failureType: 'Actionable', protocolReason: 'WebSocket' }]) }));
    assertFail(checked, 'medium');
    assertExcerpt(checked, /\(WebSocket\)$/u);
  });

  test('ignores reasons from the automated run or the browser', () => {
    const items = [
      { reason: 'Back/forward cache is disabled by flags.', failureType: 'Actionable', protocolReason: 'BackForwardCacheDisabledByCommandLine' },
      { reason: 'Internal error.', failureType: 'Not actionable', protocolReason: 'InternalError' },
    ];
    assertOutcome(check(bfcacheEligibility, page(url, { html: html(''), lighthouse: bfcache(0, items) })), 'pass');
  });

  test('is not evaluated when the test could not run', () => {
    assertOutcome(check(bfcacheEligibility, page(url, { html: html(''), lighthouse: bfcache(null, [], 'notApplicable') })), 'not_evaluated', 'bfcache-not-tested');
  });
});

describe('perf-unload-handlers', () => {
  test('passes beforeunload and pagehide listeners', () => {
    const body = '<script>window.addEventListener("beforeunload", save); window.onbeforeunload = null; addEventListener("pagehide", flush);</script>';
    assertOutcome(check(unloadHandlers, page(url, { html: html('', body) })), 'pass');
  });

  test('fails low on an unload listener, citing it', () => {
    const checked = check(unloadHandlers, page(url, { html: html('', '<script>window.addEventListener(\'unload\', sendBeacon);</script>') }));
    assertFail(checked, 'low');
    assertExcerpt(checked, /addEventListener\('unload'/u);
  });

  test('finds listeners added by scripts in the rendered page', () => {
    const rendered = '<html><body><script>window.onunload = function () {}</script></body></html>';
    assertFail(check(unloadHandlers, page(url, { html: html(''), rendered })), 'low');
  });

  test('is not evaluated without the server HTML', () => {
    assertOutcome(check(unloadHandlers, page(url)), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('perf-speculation-rules', () => {
  const rules = (json: string) => `<script type="speculationrules">${json}</script>`;
  const links = '<main><a href="/pricing">Pricing</a><a href="/account/logout">Log out</a></main>';

  test('does not apply without speculation rules, which are optional', () => {
    assertOutcome(check(speculationRulesCheck, page(url, { html: html('') })), 'not_applicable', 'no-speculation-rules');
  });

  test('passes rules that exclude state-changing links', () => {
    const json = '{"prerender":[{"source":"document","where":{"and":[{"href_matches":"/*"},{"not":{"href_matches":"/account/logout"}}]},"eagerness":"moderate"}]}';
    assertOutcome(check(speculationRulesCheck, page(url, { html: html(rules(json), links) })), 'pass');
  });

  test('notes rules that match a logout link as info', () => {
    const checked = check(speculationRulesCheck, page(url, { html: html(rules('{"prefetch":[{"where":{"href_matches":"/*"}}]}'), links) }));
    assertFail(checked, 'info', 'state-changing-urls');
    assert.equal(checked.finding.params?.urls, 'https://example.com/account/logout');
    assertExcerpt(checked, /href_matches/u);
  });

  test('notes invalid JSON as info', () => {
    assertFail(check(speculationRulesCheck, page(url, { html: html(rules('{"prerender": [')) })), 'info', 'invalid-json');
  });

  test('is not evaluated without the server HTML', () => {
    assertOutcome(check(speculationRulesCheck, page(url)), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('perf-html-cdn', () => {
  const siteFinding = (pages: PageFacts[]) => {
    const { findings, evidence } = evaluate(htmlCdn, site({ origin: 'https://example.com', pages }));
    return { finding: findings[0]!, evidence };
  };

  test('passes when an HTML response carries CDN markers', () => {
    const { finding, evidence } = siteFinding([page(url, { html: html(''), headers: { 'cf-cache-status': 'HIT', 'cache-control': 'max-age=0', etag: '"v1"' } })]);
    assert.equal(finding.outcome, 'pass');
    assert.match(evidence.get(finding.evidence[0]!)?.excerpt ?? '', /cf-cache-status: HIT/u);
  });

  test('notes missing markers as info, never as no CDN', () => {
    const { finding, evidence } = siteFinding([page(url, { html: html(''), headers: { server: 'nginx' } })]);
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.count], ['fail', 'info', 1]);
    assert.match(evidence.get(finding.evidence[0]!)?.excerpt ?? '', /content-type, server/u);
  });

  test('is not evaluated without any response', () => {
    const { finding } = siteFinding([]);
    assert.deepEqual([finding.outcome, finding.reason], ['not_evaluated', 'missing-input:http']);
  });
});
