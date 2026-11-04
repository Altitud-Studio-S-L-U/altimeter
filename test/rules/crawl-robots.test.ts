import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SiteFacts } from '../../src/core/facts.ts';
import type { Severity } from '../../src/core/types.ts';
import type { FetchResult, Hop } from '../../src/fetch/http.ts';
import { robotsAvailability } from '../../src/fetch/robots.ts';
import { findingMessage } from '../../src/i18n/messages.ts';
import { implementations } from '../../src/rules/crawl/index.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { evaluate, headers, page, response, site, type ResponseSpec, type SiteSpec } from '../support/facts.ts';

function run(id: string, facts: SiteFacts | SiteSpec, url?: string) {
  const implementation = implementations.find(entry => entry.id === id);
  assert.ok(implementation, `${id} is implemented`);
  const { findings, evidence } = evaluate(implementation, 'pages' in facts && !(facts.pages instanceof Map) ? site(facts as SiteSpec) : facts as SiteFacts);
  const picked = url ? findings.filter(entry => entry.scope.kind === 'page' && entry.scope.url === url) : findings;
  return { finding: picked[0]!, findings: picked, excerpts: (finding: Finding = picked[0]!) => finding.evidence.map(ref => evidence.get(ref)?.excerpt ?? '') };
}

function assertFail(finding: Finding, severity: Severity, reason?: string) {
  assert.equal(finding.outcome, 'fail', JSON.stringify(finding));
  assert.equal(finding.severity, severity);
  assert.equal(finding.reason, reason);
  const message = findingMessage('en', finding.ruleId, 'fail', finding.reason, finding.params);
  assert.ok(message !== undefined && !/\{[a-zA-Z]+\}/u.test(message), message);
}

function assertOutcome(finding: Finding, outcome: Finding['outcome'], reason?: string) {
  assert.equal(finding.outcome, outcome, JSON.stringify(finding));
  if (reason !== undefined) assert.equal(finding.reason, reason);
}

const origin = 'https://example.com';
const home = () => page(`${origin}/`, { html: '<!doctype html><title>Home</title><h1>Home</h1>' });
const urlset = (locs: readonly string[]) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map(loc => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`;

/** Replaces the robots.txt fetch of a site, for redirects and raw bytes the builder cannot express. */
function withRobots(facts: SiteFacts, spec: ResponseSpec & { body: Buffer | string }): SiteFacts {
  const url = `${origin}/robots.txt`;
  const fetch = response(url, { headers: { 'content-type': 'text/plain' }, ...spec });
  const body = typeof spec.body === 'string' ? Buffer.from(spec.body) : spec.body;
  return { ...facts, robots: { url, fetch, availability: robotsAvailability(fetch.status, body, fetch.hops.length > 6) } };
}

/** robots.txt sent with the type Express gives res.send(string). */
const servedAsHtml = (body: string) => withRobots(site({ pages: [home()], robots: '' }), { body, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** A robots.txt that redirects back to itself, as the HTTP client reports it, with the availability the collector derives and with the one Google applies. */
function redirectLoop(availability: 'collected' | 'missing-file'): SiteFacts {
  const url = `${origin}/robots.txt`;
  const hops: Hop[] = [
    { url, status: 301, headers: headers({ location: '/robots.txt/' }), location: `${url}/`, ttfbMs: 10 },
    { url: `${url}/`, status: 301, headers: headers({ location: '/robots.txt' }), location: url, ttfbMs: 10 },
  ];
  const fetch: FetchResult = { requestedUrl: url, finalUrl: url, hops, status: 301, headers: hops[1]!.headers, body: Buffer.alloc(0), transferBytes: 0, truncated: false,
    durationMs: 20, error: { code: 'redirect-loop', message: `Redirect loop at ${url}` } };
  const robots = availability === 'collected' ? robotsAvailability(undefined, fetch.body) : robotsAvailability(301, fetch.body, true);
  return { ...site({ pages: [home()] }), robots: { url, fetch, availability: robots } };
}

describe('crawl-robots-fetch-status', () => {
  const id = 'crawl-robots-fetch-status';
  test('passes on 200 and on 404', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow:' }).finding, 'pass');
    assertOutcome(run(id, { pages: [home()], robots: { status: 404 } }).finding, 'pass');
  });
  test('fails critical on a server error with the status as evidence', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: { status: 503 } });
    assertFail(finding, 'critical', 'server-error');
    assert.deepEqual(excerpts(), ['HTTP 503']);
  });
  test('fails critical when robots.txt is unreachable', () => {
    assertFail(run(id, { pages: [home()], robots: 'unreachable' }).finding, 'critical', 'network-error');
  });
  test('reports 403 as info only', () => {
    assertFail(run(id, { pages: [home()], robots: { status: 403 } }).finding, 'info', 'access-denied');
  });
  test('passes on a redirect loop, which Google reads as a missing file and crawl-robots-redirects reports', () => {
    for (const availability of ['collected', 'missing-file'] as const) {
      const { finding, excerpts } = run(id, redirectLoop(availability));
      assertOutcome(finding, 'pass');
      assert.deepEqual(excerpts(), ['HTTP 301']);
    }
  });
  test('is not evaluated without a robots.txt fetch', () => {
    assertOutcome(run(id, { pages: [home()] }).finding, 'not_evaluated', 'missing-input:robots');
  });
});

describe('crawl-robots-redirects', () => {
  const id = 'crawl-robots-redirects';
  test('passes on a single protocol redirect', () => {
    const facts = withRobots(site({ pages: [home()], robots: '' }), { body: 'User-agent: *\nDisallow:', redirects: [[301, 'https://www.example.com/robots.txt']] });
    const { finding, excerpts } = run(id, facts);
    assertOutcome(finding, 'pass');
    assert.deepEqual(excerpts(), ['301 -> https://www.example.com/robots.txt']);
  });
  test('fails high after more than five hops', () => {
    const redirects = [1, 2, 3, 4, 5, 6].map(step => [302, `/r${step}.txt`] as const);
    const { finding, excerpts } = run(id, withRobots(site({ pages: [home()], robots: '' }), { body: '', redirects }));
    assertFail(finding, 'high', 'too-many-hops');
    assert.equal(excerpts().length, 6);
    assert.equal(excerpts()[0], '302 -> https://example.com/r1.txt');
  });
  test('fails high on a redirect loop', () => {
    const { finding, excerpts } = run(id, redirectLoop('collected'));
    assertFail(finding, 'high', 'loop');
    assert.deepEqual(excerpts(), [`301 -> ${origin}/robots.txt/`, `301 -> ${origin}/robots.txt`]);
  });
  test('does not apply without a redirect', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *' }).finding, 'not_applicable', 'no-redirect');
  });
});

describe('crawl-robots-format', () => {
  const id = 'crawl-robots-format';
  test('passes on a plain-text file', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /private/' }).finding, 'pass');
  });
  test('fails medium when robots.txt is an HTML page', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: '<!doctype html><html><head><title>App</title></head></html>' });
    assertFail(finding, 'medium', 'html-body');
    assert.match(excerpts()[0]!, /<!doctype html>/u);
  });
  test('reads rules served as text/html, and notes the type as info', () => {
    const { findings, excerpts } = run(id, servedAsHtml('User-agent: *\nDisallow: /admin/\nSitemap: https://example.com/sitemap.xml\n'));
    assert.equal(findings.length, 1);
    assertFail(findings[0]!, 'info', 'content-type');
    assert.deepEqual(excerpts(), ['text/html; charset=utf-8']);
  });
  test('recognises an HTML page by its content, after a byte order mark or a comment', () => {
    assertFail(run(id, { pages: [home()], robots: '\uFEFF\n<!-- app shell -->\n<!DOCTYPE html><html lang="en"><body><div id="app"></div></body></html>' }).finding, 'medium', 'html-body');
    const { findings } = run(id, servedAsHtml('<html><head><title>App</title></head></html>'));
    assert.deepEqual(findings.map(finding => finding.reason), ['html-body']);
  });
  test('fails high when rules sit after the 500 KiB limit', () => {
    const body = `User-agent: *\n${'# filler line for the size limit\n'.repeat(17_000)}Disallow: /private/\n`;
    const { finding, excerpts } = run(id, { pages: [home()], robots: body });
    assertFail(finding, 'high', 'over-size-limit');
    assert.ok(excerpts().includes('Disallow: /private/'));
  });
  test('fails medium on rule paths that are not UTF-8', () => {
    const body = Buffer.concat([Buffer.from('User-agent: *\nDisallow: /caf'), Buffer.from([0xe9]), Buffer.from('/\n')]);
    const { finding, excerpts } = run(id, withRobots(site({ pages: [home()], robots: '' }), { body }));
    assertFail(finding, 'medium', 'invalid-utf8');
    assert.match(excerpts()[0]!, /^Disallow: \/caf/u);
  });
  test('does not apply without a parsed file', () => {
    assertOutcome(run(id, { pages: [home()], robots: { status: 404 } }).finding, 'not_applicable', 'no-robots-file');
  });
});

describe('crawl-robots-parse-errors', () => {
  const id = 'crawl-robots-parse-errors';
  test('passes on a valid file, including an empty Disallow', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow:\n\nUser-agent: Googlebot/2.1\nDisallow: /tmp/' }).finding, 'pass');
  });
  test('fails medium on a misspelled field', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'User-agent: *\nDissallow: /private/' });
    assertFail(finding, 'medium', 'misspelled-field');
    assert.deepEqual(excerpts(), ['dissallow: /private/']);
  });
  test('fails low on a rule outside any group', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'Disallow: /old/\nUser-agent: *\nDisallow: /tmp/' });
    assertFail(finding, 'low', 'rule-outside-group');
    assert.deepEqual(excerpts(), ['disallow: /old/']);
  });
  test('does not apply to an HTML body or a missing file', () => {
    assertOutcome(run(id, { pages: [home()], robots: '<!doctype html><p>app</p>' }).finding, 'not_applicable', 'html-body');
    assertOutcome(run(id, { pages: [home()], robots: { status: 404 } }).finding, 'not_applicable', 'no-robots-file');
  });
  test('still checks rules served as text/html', () => {
    assertFail(run(id, servedAsHtml('User-agent: *\nDissallow: /private/\n')).finding, 'medium', 'misspelled-field');
  });
});

describe('crawl-robots-unsupported-directives', () => {
  const id = 'crawl-robots-unsupported-directives';
  test('passes when only supported fields are used', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /a\nSitemap: https://example.com/s.xml' }).finding, 'pass');
  });
  test('fails high on noindex lines', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'User-agent: *\nNoindex: /old/\nCrawl-delay: 5' });
    assertFail(finding, 'high', 'noindex');
    assert.equal(excerpts()[0], 'noindex: /old/');
  });
  test('reports crawl-delay as info', () => {
    assertFail(run(id, { pages: [home()], robots: 'User-agent: *\nCrawl-delay: 5' }).finding, 'info', 'ignored-fields');
  });
  test('still reports noindex lines served as text/html', () => {
    assertFail(run(id, servedAsHtml('User-agent: *\nDisallow: /admin/\nNoindex: /old/\n')).finding, 'high', 'noindex');
  });
  test('does not apply without a parsed file', () => {
    assertOutcome(run(id, { pages: [home()], robots: { status: 410 } }).finding, 'not_applicable', 'no-robots-file');
  });
});

describe('crawl-robots-blocks-site', () => {
  const id = 'crawl-robots-blocks-site';
  test('passes when the home page is allowed', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /private/' }).finding, 'pass');
  });
  test('fails critical when Googlebot cannot fetch the home page', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /' });
    assertFail(finding, 'critical', 'home-googlebot');
    assert.deepEqual(excerpts(), ['disallow: / (group *)']);
  });
  test('fails high when only Bingbot is blocked', () => {
    assertFail(run(id, { pages: [home()], robots: 'User-agent: bingbot\nDisallow: /\n\nUser-agent: *\nDisallow:' }).finding, 'high', 'home-bingbot');
  });
  test('ignores groups for AI crawlers', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /' }).finding, 'pass');
  });
  test('fails critical when robots.txt disallows most URLs the crawl found, which it never fetches', () => {
    const products = Array.from({ length: 20 }, (_, index) => `${origin}/product/${index}/`);
    const facts: SiteFacts = { ...site({ pages: [home()], robots: 'User-agent: *\nAllow: /$\nDisallow: /', crawled: true }), crawlBlocked: products };
    const { finding, excerpts } = run(id, facts);
    assertFail(finding, 'critical', 'most-pages');
    assert.deepEqual(finding.params, { blocked: 20, total: 21 });
    assert.deepEqual(excerpts(), Array.from({ length: 5 }, () => 'disallow: /'));
  });
  test('does not count disallowed carts, searches, account pages and filtered URLs the crawl found', () => {
    const robots = 'User-agent: *\nDisallow: /cart\nDisallow: /search\nDisallow: /account/\nDisallow: /*?';
    const pages = [home(), page(`${origin}/lamps/`, { html: '<!doctype html><title>Lamps</title>' })];
    const found = [`${origin}/cart`, `${origin}/search/lamps`, `${origin}/account/orders`, `${origin}/lamps/?color=red`, `${origin}/lamps/?sort=price`];
    assertOutcome(run(id, { ...site({ pages, robots, crawled: true }), crawlBlocked: found }).finding, 'pass');
  });
  test('does not apply to a staging host or without rules', () => {
    const staging = page('https://staging.example.com/', { html: '<title>Staging</title>' });
    assertOutcome(run(id, { pages: [staging], robots: 'User-agent: *\nDisallow: /' }).finding, 'not_applicable', 'private-host');
    const found = ['a', 'b', 'c'].map(slug => `https://staging.example.com/${slug}/`);
    assertOutcome(run(id, { ...site({ pages: [staging], robots: 'User-agent: *\nAllow: /$\nDisallow: /', crawled: true }), crawlBlocked: found }).finding, 'not_applicable', 'private-host');
    assertOutcome(run(id, { pages: [home()], robots: { status: 404 } }).finding, 'not_applicable', 'no-robots-rules');
  });
});

describe('crawl-robots-blocks-page', () => {
  const id = 'crawl-robots-blocks-page';
  const post = `${origin}/blog/post/`;
  const postPage = () => page(post, { html: '<!doctype html><title>Post</title><h1>Post</h1>' });
  test('passes when the page is allowed', () => {
    assertOutcome(run(id, { pages: [postPage()], robots: 'User-agent: *\nDisallow: /private/' }, post).finding, 'pass');
  });
  test('fails medium when the page is disallowed', () => {
    const { finding, excerpts } = run(id, { pages: [postPage()], robots: 'User-agent: *\nDisallow: /blog/' }, post);
    assertFail(finding, 'medium', 'disallowed');
    assert.deepEqual(excerpts(), ['disallow: /blog/ (group *)']);
  });
  test('fails critical when a sitemap also lists the page', () => {
    const { finding, excerpts } = run(id, { pages: [postPage()], robots: 'User-agent: *\nDisallow: /blog/', sitemaps: [{ url: `${origin}/sitemap.xml`, xml: urlset([post]) }] }, post);
    assertFail(finding, 'critical', 'conflict-sitemap');
    assert.ok(excerpts().includes(post));
  });
  test('does not apply to utility pages and needs robots.txt', () => {
    const cart = `${origin}/cart`;
    assertOutcome(run(id, { pages: [page(cart, { html: '<title>Cart</title>' })], robots: 'User-agent: *\nDisallow: /cart' }, cart).finding, 'not_applicable', 'utility-page');
    assertOutcome(run(id, { pages: [postPage()] }, post).finding, 'not_evaluated', 'missing-input:robots');
  });
});

describe('crawl-robots-group-override', () => {
  const id = 'crawl-robots-group-override';
  test('passes when the specific group repeats the * rules', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /search\n\nUser-agent: Googlebot\nDisallow: /search\nDisallow: /tmp/' }).finding, 'pass');
  });
  test('fails medium when Googlebot drops a crawl-trap rule', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /search\n\nUser-agent: Googlebot\nDisallow: /private/' });
    assertFail(finding, 'medium', 'crawl-trap');
    assert.deepEqual(excerpts(), ['Disallow: /search (group *, line 2)']);
  });
  test('fails low when an AI crawler group drops a non-trap rule', () => {
    assertFail(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /drafts/\n\nUser-agent: GPTBot\nDisallow: /private/' }).finding, 'low', 'missing-rules');
  });
  test('reports an allow list behind a full * block as info', () => {
    assertFail(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /' }).finding, 'info', 'intentional-allow');
  });
  test('does not apply without named groups, such as a file without AI-crawler groups', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /search' }).finding, 'not_applicable', 'no-specific-group');
  });
});

describe('crawl-robots-sitemap-lines', () => {
  const id = 'crawl-robots-sitemap-lines';
  const map = `${origin}/sitemap_index.xml`;
  test('passes with a declared sitemap, even when /sitemap.xml answers 404', () => {
    const facts = { pages: [home()], robots: `User-agent: *\nDisallow:\nSitemap: ${map}`,
      sitemaps: [{ url: map, xml: urlset([`${origin}/`]) }, { url: `${origin}/sitemap.xml`, status: 404, source: 'default' as const }] };
    assertOutcome(run(id, facts).finding, 'pass');
  });
  test('fails medium on a relative Sitemap line', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'User-agent: *\nSitemap: /sitemap.xml', sitemaps: [] });
    assertFail(finding, 'medium', 'relative-url');
    assert.deepEqual(excerpts(), ['Sitemap: /sitemap.xml']);
  });
  test('fails medium when a declared sitemap does not answer 200', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: `Sitemap: ${map}`, sitemaps: [{ url: map, status: 404 }] });
    assertFail(finding, 'medium', 'declared-not-200');
    assert.deepEqual(excerpts(), ['HTTP 404']);
  });
  test('fails low when no sitemap is found anywhere', () => {
    assertFail(run(id, { pages: [home()], robots: 'User-agent: *', sitemaps: [{ url: `${origin}/sitemap.xml`, status: 404, source: 'default' }] }).finding, 'low', 'no-sitemap');
  });
  test('is not evaluated without robots.txt', () => {
    assertOutcome(run(id, { pages: [home()] }).finding, 'not_evaluated', 'missing-input:robots');
  });
});

describe('crawl-noindex-blocked-by-robots', () => {
  const id = 'crawl-noindex-blocked-by-robots';
  const old = `${origin}/old/page`;
  const noindexPage = () => page(old, { html: '<!doctype html><meta name="robots" content="noindex"><title>Old</title>' });
  test('passes when the noindex page can be crawled', () => {
    assertOutcome(run(id, { pages: [noindexPage()], robots: 'User-agent: *\nDisallow: /private/' }, old).finding, 'pass');
  });
  test('fails high when robots.txt hides the noindex', () => {
    const { finding, excerpts } = run(id, { pages: [noindexPage()], robots: 'User-agent: *\nDisallow: /old/' }, old);
    assertFail(finding, 'high');
    assert.deepEqual(excerpts(), ['disallow: /old/ (group *)', 'noindex']);
  });
  test('does not apply to pages without noindex', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: *\nDisallow: /' }, `${origin}/`).finding, 'not_applicable', 'no-noindex');
  });
});

describe('crawl-bing-crawl-delay', () => {
  const id = 'crawl-bing-crawl-delay';
  test('passes without crawl-delay for Bingbot', () => {
    assertOutcome(run(id, { pages: [home()], robots: 'User-agent: bingbot\nDisallow: /tmp/\n\nUser-agent: *\nCrawl-delay: 20' }).finding, 'pass');
  });
  test('reports a crawl-delay as info', () => {
    const { finding, excerpts } = run(id, { pages: [home()], robots: 'User-agent: *\nCrawl-delay: 5' });
    assertFail(finding, 'info', 'present');
    assert.deepEqual(excerpts(), ['crawl-delay: 5']);
  });
  test('fails low on a long delay for a large site', () => {
    const locs = Array.from({ length: 1001 }, (_, index) => `${origin}/p/${index}`);
    const { finding } = run(id, { pages: [home()], robots: 'User-agent: bingbot\nCrawl-delay: 10', sitemaps: [{ url: `${origin}/sitemap.xml`, xml: urlset(locs) }] });
    assertFail(finding, 'low', 'slow-for-size');
  });
  test('does not apply without a parsed file', () => {
    assertOutcome(run(id, { pages: [home()], robots: { status: 404 } }).finding, 'not_applicable', 'no-robots-file');
  });
});
