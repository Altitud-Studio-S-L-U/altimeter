import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import type { RuleImplementation } from '../../src/rules/engine.ts';
import {
  anchorTextEmpty, anchorTextQuality, linkSchemesVisible, outboundCitations, paidLinksUnqualified, thinAffiliate, ugcLinkQualifiers,
} from '../../src/rules/content/link-rules.ts';
import { evaluate, outcomeOn, page, site, type SiteSpec } from '../support/facts.ts';

const url = 'https://example.com/reviews/drills';
const doc = (body: string) => `<!doctype html><html lang="en"><head><title>Drills</title></head><body>${body}</body></html>`;
const crawled = { crawled: true, homeUrl: 'https://example.com/' } as const;

function run(rule: RuleImplementation, pages: readonly PageFacts[], extra: Partial<SiteSpec> = {}) {
  const { findings, evidence } = evaluate(rule, site({ pages, ...extra }));
  const excerpts = (finding: (typeof findings)[number] | undefined) => (finding?.evidence ?? []).map(id => evidence.get(id)?.excerpt);
  return { at: (target = url) => outcomeOn(findings, target), siteFindings: findings.filter(entry => entry.scope.kind === 'site'), excerpts };
}

describe('content-thin-affiliate', () => {
  test('passes a product page without affiliate links', () => {
    assert.equal(run(thinAffiliate, [page(url, { html: doc('<main><a href="https://maker.example/">Maker</a></main>'), pageType: 'product' })]).at()?.outcome, 'pass');
  });

  test('hands a page with affiliate links to the analyst', () => {
    const { at, excerpts } = run(thinAffiliate, [page(url, { html: doc('<main><a href="https://amzn.to/abc" rel="sponsored">Buy</a></main>'), pageType: 'article' })]);
    assert.deepEqual([at()?.severity, at()?.needsJudgment, at()?.params?.networks], ['medium', true, 'Amazon']);
    assert.deepEqual(excerpts(at()), ['<a href="https://amzn.to/abc" rel="sponsored">Buy</a>']);
  });

  test('does not apply to service pages', () => {
    assert.equal(run(thinAffiliate, [page(url, { html: doc(''), pageType: 'service' })]).at()?.reason, 'page-type:service');
  });
});

describe('content-paid-links-unqualified', () => {
  test('passes qualified affiliate links', () => {
    assert.equal(run(paidLinksUnqualified, [page(url, { html: doc('<a href="https://www.amazon.com/dp/1?tag=me-21" rel="sponsored noopener">Buy</a>') })]).at()?.outcome, 'pass');
  });

  test('fails medium on an unqualified affiliate link', () => {
    const { at, excerpts } = run(paidLinksUnqualified, [page(url, { html: doc('<a href="https://www.awin1.com/cread.php?id=1">Deal</a>') })]);
    assert.deepEqual([at()?.severity, at()?.params?.count], ['medium', 1]);
    assert.deepEqual(excerpts(at()), ['<a href="https://www.awin1.com/cread.php?id=1">Deal</a>']);
  });

  test('flags links inside a sponsored block but not a partners logo strip', () => {
    assert.equal(run(paidLinksUnqualified, [page(url, { html: doc('<div class="sponsored-post"><a href="https://brand.example/">Brand</a></div>') })]).at()?.outcome, 'fail');
    assert.equal(run(paidLinksUnqualified, [page(url, { html: doc('<section class="partners"><a href="https://client.example/">Client</a></section>') })]).at()?.reason, 'no-paid-links');
  });

  test('is not evaluated without the raw HTML', () => {
    assert.equal(run(paidLinksUnqualified, [page(url)]).at()?.outcome, 'not_evaluated');
  });
});

describe('content-ugc-link-qualifiers', () => {
  test('passes qualified comment links', () => {
    const html = doc('<ol class="commentlist"><li><a href="https://blog.example/" rel="external nofollow ugc">Ann</a></li></ol>');
    assert.equal(run(ugcLinkQualifiers, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails medium on a followed link in a comment', () => {
    const { at, excerpts } = run(ugcLinkQualifiers, [page(url, { html: doc('<div id="comments"><p>Nice! <a href="https://loans.example/">loans</a></p></div>') })]);
    assert.deepEqual([at()?.severity, at()?.params?.count], ['medium', 1]);
    assert.deepEqual(excerpts(at()), ['<a href="https://loans.example/">loans</a>']);
  });

  test('reads comment regions from schema.org itemtype URLs, not from look-alike URLs', () => {
    const typed = doc('<div itemscope itemtype="https://schema.org/Comment"><a href="https://loans.example/">loans</a></div>');
    assert.equal(run(ugcLinkQualifiers, [page(url, { html: typed })]).at()?.severity, 'medium');
    const lookalike = doc('<div itemscope itemtype="https://types.example/schema.org/Comment"><a href="https://maker.example/">Maker</a></div>');
    assert.equal(run(ugcLinkQualifiers, [page(url, { html: lookalike })]).at()?.reason, 'no-ugc-region');
  });

  test('does not apply without user-generated content', () => {
    assert.equal(run(ugcLinkQualifiers, [page(url, { html: doc('<main><a href="https://maker.example/">Maker</a></main>') })]).at()?.reason, 'no-ugc-region');
  });
});

describe('content-link-schemes-visible', () => {
  const footer = (links: string) => doc(`<main><p>Text</p></main><footer>${links}</footer>`);
  const pages = (links: string) => ['/', '/a', '/b'].map(path => page(`https://example.com${path}`, { html: footer(links) }));

  test('passes design credits and social profiles in the footer', () => {
    const links = '<a href="https://studio.example/">Web design by Studio Example</a><a href="https://www.instagram.com/acme">Follow us on Instagram</a>';
    assert.equal(run(linkSchemesVisible, pages(links), crawled).siteFindings[0]?.outcome, 'pass');
  });

  test('hands a sitewide keyword link to the analyst', () => {
    const { siteFindings, excerpts } = run(linkSchemesVisible, pages('<a href="https://seo.example/">best cheap seo services</a>'), crawled);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.needsJudgment, siteFindings[0]?.params?.pages], ['medium', true, 3]);
    assert.deepEqual(excerpts(siteFindings[0]), ['<a href="https://seo.example/">best cheap seo services</a>']);
  });

  test('is not evaluated without a crawl', () => {
    assert.equal(run(linkSchemesVisible, pages('')).siteFindings[0]?.reason, 'missing-input:crawl');
  });
});

describe('content-anchor-text-empty', () => {
  test('passes text, alt, aria-label and SVG-title links', () => {
    const html = doc('<a href="/a">Tools</a><a href="/b"><img src="x.png" alt="Seeds"></a><a href="https://social.example/" aria-label="Social"><svg></svg></a><a href="/c"><svg><title>Cart</title></svg></a>');
    assert.equal(run(anchorTextEmpty, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails medium on an empty internal link', () => {
    const { at, excerpts } = run(anchorTextEmpty, [page(url, { html: doc('<a href="/offers" class="card-link"></a>') })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['medium', 'internal']);
    assert.deepEqual(excerpts(at()), ['<a href="/offers" class="card-link"></a>']);
  });

  test('reports an empty external link as low', () => {
    assert.equal(run(anchorTextEmpty, [page(url, { html: doc('<a href="https://maker.example/"><img src="logo.png"></a>') })]).at()?.severity, 'low');
  });

  test('does not apply without links', () => {
    assert.equal(run(anchorTextEmpty, [page(url, { html: doc('<p>x</p>') })]).at()?.reason, 'no-links');
  });
});

describe('content-anchor-text-quality', () => {
  test('accepts "Read more" next to a descriptive link to the same page', () => {
    const html = doc('<main><h2><a href="/post">Choosing a drill</a></h2><a href="/post">Read more</a></main>');
    assert.equal(run(anchorTextQuality, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails low on a generic anchor in the main content', () => {
    const { at, excerpts } = run(anchorTextQuality, [page(url, { html: doc('<main><p>Our prices are <a href="/pricing">here</a>.</p></main>') })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.params?.examples], ['low', 'generic', 'here']);
    assert.deepEqual(excerpts(at()), ['<a href="/pricing">here</a>']);
  });

  test('reports a very long anchor but not a card link that wraps blocks', () => {
    const long = 'a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(50);
    assert.equal(run(anchorTextQuality, [page(url, { html: doc(`<main><a href="/x">${long}</a></main>`) })]).at()?.reason, 'too-long');
    assert.equal(run(anchorTextQuality, [page(url, { html: doc(`<main><a href="/x"><h3>Card</h3><p>${long}</p></a></main>`) })]).at()?.outcome, 'pass');
  });

  test('does not apply without content links', () => {
    assert.equal(run(anchorTextQuality, [page(url, { html: doc('<main><p>x</p></main><nav><a href="/">Home</a></nav>') })]).at()?.reason, 'no-content-links');
  });
});

describe('content-outbound-citations', () => {
  const cited = (rel: string) => doc(`<main><a href="https://stats.example/a"${rel}>study</a><a href="https://gov.example/b"${rel}>law</a><a href="https://journal.example/c"${rel}>paper</a></main>`);

  test('passes when editorial links are followed', () => {
    assert.equal(run(outboundCitations, [page(url, { html: cited('') })]).siteFindings[0]?.outcome, 'pass');
  });

  test('fails low when every editorial link is nofollow', () => {
    const { siteFindings, excerpts } = run(outboundCitations, [page(url, { html: cited(' rel="nofollow"') })]);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.params?.count], ['low', 3]);
    assert.equal(excerpts(siteFindings[0])[0], '<a href="https://stats.example/a" rel="nofollow">study</a>');
  });

  test('does not count social profiles, so a site with only those does not apply', () => {
    const html = doc('<main><a href="https://www.instagram.com/acme" rel="nofollow">ig</a><a href="https://www.linkedin.com/company/acme" rel="nofollow">in</a><a href="https://x.com/acme" rel="nofollow">x</a></main>');
    assert.equal(run(outboundCitations, [page(url, { html })]).siteFindings[0]?.reason, 'fewer-than-three-editorial-links');
  });
});
