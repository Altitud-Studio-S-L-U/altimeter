import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import type { RuleImplementation } from '../../src/rules/engine.ts';
import {
  titleBoilerplate, titleBranding, titleDuplicate, titleH1Mismatch, titleMissing, titleMultiple, titleObsoleteYear, titleRawRenderedMismatch,
  titleStuffing, titleWidth,
} from '../../src/rules/content/titles.ts';
import { evaluate, outcomeOn, page, site, type SiteSpec } from '../support/facts.ts';

const url = 'https://example.com/garden/tools';
const doc = (head: string, body = '<main><p>Text.</p></main>') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

function run(rule: RuleImplementation, pages: readonly PageFacts[], extra: Partial<SiteSpec> = {}) {
  const { findings, evidence } = evaluate(rule, site({ pages, ...extra }));
  const excerpts = (finding: (typeof findings)[number] | undefined) => (finding?.evidence ?? []).map(id => evidence.get(id)?.excerpt);
  const labels = (finding: (typeof findings)[number] | undefined) => (finding?.evidence ?? []).map(id => evidence.get(id)?.label);
  return { findings, at: (target = url) => outcomeOn(findings, target), siteFindings: findings.filter(entry => entry.scope.kind === 'site'), excerpts, labels };
}

describe('content-title-missing', () => {
  test('passes with a non-empty head title', () => {
    const { at, excerpts } = run(titleMissing, [page(url, { html: doc('<title>Garden tools</title>') })]);
    assert.equal(at()?.outcome, 'pass');
    assert.deepEqual(excerpts(at()), ['Garden tools']);
  });

  test('fails high without a title on an indexable page', () => {
    const { at, labels } = run(titleMissing, [page(url, { html: doc('<meta charset="utf-8">') })]);
    assert.deepEqual([at()?.outcome, at()?.severity, at()?.reason], ['fail', 'high', 'absent']);
    assert.deepEqual(labels(at()), ['no title element in the head of the raw HTML']);
  });

  test('reports an empty title with its source, at info when the page is noindex', () => {
    const { at, excerpts } = run(titleMissing, [page(url, { html: doc('<title> </title><meta name="robots" content="noindex">') })]);
    assert.deepEqual([at()?.outcome, at()?.severity, at()?.reason], ['fail', 'info', 'empty']);
    assert.deepEqual(excerpts(at()), ['<title></title>']);
  });

  test('ignores SVG titles, which are accessible names and not document titles', () => {
    const { at } = run(titleMissing, [page(url, { html: doc('', '<svg><title>Menu</title></svg>') })]);
    assert.equal(at()?.reason, 'absent');
  });

  test('is not evaluated without the raw HTML', () => {
    const { at } = run(titleMissing, [page(url)]);
    assert.deepEqual([at()?.outcome, at()?.reason], ['not_evaluated', 'missing-input:raw-html']);
  });
});

describe('content-title-multiple', () => {
  test('passes with one title and inline SVG icon titles', () => {
    const { at } = run(titleMultiple, [page(url, { html: doc('<title>Tools</title>', '<svg><title>Cart</title></svg><svg><title>Search</title></svg>') })]);
    assert.equal(at()?.outcome, 'pass');
  });

  test('fails medium with two head titles', () => {
    const { at, excerpts } = run(titleMultiple, [page(url, { html: doc('<title>Tools</title><title>Shop</title>') })]);
    assert.deepEqual([at()?.outcome, at()?.severity, at()?.params?.count], ['fail', 'medium', 2]);
    assert.deepEqual(excerpts(at()), ['<title>Tools</title>', '<title>Shop</title>']);
  });

  test('is not evaluated without the raw HTML', () => {
    assert.equal(run(titleMultiple, [page(url)]).at()?.outcome, 'not_evaluated');
  });
});

describe('content-title-raw-rendered-mismatch', () => {
  test('passes when only a runtime unread counter differs', () => {
    const { at } = run(titleRawRenderedMismatch, [page(url, { html: doc('<title>Inbox</title>'), rendered: doc('<title>(3) Inbox</title>') })]);
    assert.equal(at()?.outcome, 'pass');
  });

  test('fails medium when the raw title is a framework placeholder', () => {
    const { at, excerpts } = run(titleRawRenderedMismatch, [page(url, { html: doc('<title>React App</title>'), rendered: doc('<title>Garden tools | Acme</title>') })]);
    assert.deepEqual([at()?.outcome, at()?.severity, at()?.reason], ['fail', 'medium', 'placeholder']);
    assert.deepEqual(excerpts(at()), ['React App', 'Garden tools | Acme']);
  });

  test('reports a plain difference as low', () => {
    const { at } = run(titleRawRenderedMismatch, [page(url, { html: doc('<title>Garden tools</title>'), rendered: doc('<title>Garden tools and seeds</title>') })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['low', 'differs']);
  });

  test('is not evaluated without a render', () => {
    const { at } = run(titleRawRenderedMismatch, [page(url, { html: doc('<title>Tools</title>') })]);
    assert.deepEqual([at()?.outcome, at()?.reason], ['not_evaluated', 'missing-input:rendered-dom']);
  });
});

const crawled = { crawled: true, homeUrl: 'https://example.com/' } as const;

describe('content-title-duplicate', () => {
  test('passes with distinct titles', () => {
    const pages = [page('https://example.com/a', { html: doc('<title>Seeds</title>') }), page('https://example.com/b', { html: doc('<title>Tools</title>') })];
    assert.equal(run(titleDuplicate, pages, crawled).siteFindings[0]?.outcome, 'pass');
  });

  test('fails medium for a shared title and cites every page', () => {
    const pages = [page('https://example.com/a', { html: doc('<title>Garden shop</title>') }), page('https://example.com/b', { html: doc('<title>Garden  Shop</title>') })];
    const { siteFindings, excerpts } = run(titleDuplicate, pages, crawled);
    assert.deepEqual([siteFindings[0]?.outcome, siteFindings[0]?.severity, siteFindings[0]?.reason, siteFindings[0]?.params?.count], ['fail', 'medium', 'identical', 2]);
    assert.deepEqual(excerpts(siteFindings[0]), ['Garden shop', 'Garden Shop']);
  });

  test('does not count noindex pages or hreflang alternates that share a brand title', () => {
    const alternates = '<link rel="alternate" hreflang="en" href="https://example.com/en/"><link rel="alternate" hreflang="es" href="https://example.com/es/">';
    const pages = [
      page('https://example.com/en/', { html: doc(`<title>Acme</title>${alternates}`) }),
      page('https://example.com/es/', { html: doc(`<title>Acme</title>${alternates}`) }),
      page('https://example.com/legal', { html: doc('<title>Acme</title><meta name="robots" content="noindex,follow">') }),
    ];
    assert.equal(run(titleDuplicate, pages, crawled).siteFindings[0]?.outcome, 'pass');
  });

  test('is not evaluated without a crawl', () => {
    const pages = [page('https://example.com/a', { html: doc('<title>A</title>') })];
    assert.deepEqual([run(titleDuplicate, pages).siteFindings[0]?.outcome, run(titleDuplicate, pages).siteFindings[0]?.reason], ['not_evaluated', 'missing-input:crawl']);
  });
});

describe('content-title-boilerplate', () => {
  const brand = '<meta property="og:site_name" content="Acme">';

  test('never treats a short brand segment as boilerplate, nor a brand-only home title', () => {
    const pages = [
      page('https://example.com/', { html: doc(`<title>Acme</title>${brand}`) }),
      page('https://example.com/contact', { html: doc(`<title>Contact | Acme</title>${brand}`) }),
      page('https://example.com/services', { html: doc(`<title>Services | Acme</title>${brand}`) }),
    ];
    assert.equal(run(titleBoilerplate, pages, crawled).siteFindings[0]?.outcome, 'pass');
  });

  test('fails medium for a half-empty title', () => {
    const pages = [page('https://example.com/', { html: doc(`<title>Acme</title>${brand}`) }), page('https://example.com/about', { html: doc(`<title>| Acme</title>${brand}`) })];
    const { siteFindings, excerpts } = run(titleBoilerplate, pages, crawled);
    assert.deepEqual([siteFindings[0]?.outcome, siteFindings[0]?.severity, siteFindings[0]?.reason], ['fail', 'medium', 'half-empty']);
    assert.deepEqual(excerpts(siteFindings[0]), ['| Acme']);
  });

  test('reports a long repeated template that outweighs the page-specific text as low', () => {
    const tail = ' | Acme – Best plumbers in Springfield since 1990';
    const pages = ['pipes', 'taps', 'boilers'].map(slug => page(`https://example.com/${slug}`, { html: doc(`<title>${slug[0]!.toUpperCase()}${slug.slice(1)}${tail}</title>${brand}`) }));
    const { siteFindings } = run(titleBoilerplate, pages, crawled);
    assert.equal(siteFindings.length, 3);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.reason], ['low', 'template-dominant']);
  });

  test('is not evaluated without a crawl', () => {
    assert.equal(run(titleBoilerplate, [page(url, { html: doc('<title>A</title>') })]).siteFindings[0]?.outcome, 'not_evaluated');
  });
});

describe('content-title-width', () => {
  test('passes a title of ordinary length', () => {
    assert.equal(run(titleWidth, [page(url, { html: doc('<title>Garden tools for small balconies</title>') })]).at()?.outcome, 'pass');
  });

  test('reports a very short title as low', () => {
    const { at, excerpts } = run(titleWidth, [page(url, { html: doc('<title>Tools</title>') })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.params?.characters], ['low', 'short', 5]);
    assert.deepEqual(excerpts(at()), ['Tools']);
  });

  test('reports a wide title as info only', () => {
    const { at } = run(titleWidth, [page(url, { html: doc('<title>Complete guide to choosing garden tools for small balconies, terraces and indoor plant corners</title>') })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['info', 'likely-truncated']);
  });

  test('does not apply without a title', () => {
    assert.deepEqual([run(titleWidth, [page(url, { html: doc('') })]).at()?.outcome], ['not_applicable']);
  });
});

describe('content-title-stuffing', () => {
  test('passes a natural title', () => {
    assert.equal(run(titleStuffing, [page(url, { html: doc('<title>Running shoes for men | Acme</title>') })]).at()?.outcome, 'pass');
  });

  test('hands a repeated keyword to the analyst at medium', () => {
    const { at, excerpts } = run(titleStuffing, [page(url, { html: doc('<title>Cheap shoes, shoes for men, best shoes online</title>') })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.needsJudgment, at()?.params?.token], ['medium', 'repeated-token', true, 'shoes']);
    assert.deepEqual(excerpts(at()), ['Cheap shoes, shoes for men, best shoes online']);
  });

  test('flags a list of places as a candidate', () => {
    const { at } = run(titleStuffing, [page(url, { html: doc('<title>Plumber, Girona, Tarragona, Lleida, Reus, Vic</title>') })]);
    assert.deepEqual([at()?.reason, at()?.needsJudgment], ['list', true]);
  });

  test('does not apply without a title', () => {
    assert.equal(run(titleStuffing, [page(url, { html: doc('') })]).at()?.outcome, 'not_applicable');
  });
});

describe('content-title-h1-mismatch', () => {
  test('passes when the title and h1 share the topic', () => {
    assert.equal(run(titleH1Mismatch, [page(url, { html: doc('<title>Garden tools for small spaces | Acme</title>', '<main><h1>Garden tools</h1></main>') })]).at()?.outcome, 'pass');
  });

  test('treats one h1 that joins a keyword line and a tagline as a single heading', () => {
    const html = doc('<title>Web design studio | Acme</title>', '<main><h1><span>Web design studio</span><br><span>We build fast sites</span></h1></main>');
    assert.equal(run(titleH1Mismatch, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('hands a low-overlap pair to the analyst at low', () => {
    const { at, excerpts } = run(titleH1Mismatch, [page(url, { html: doc('<title>Pricing plans</title>', '<main><h1>How it started in a garage</h1></main>') })]);
    assert.deepEqual([at()?.severity, at()?.needsJudgment], ['low', true]);
    assert.deepEqual(excerpts(at()), ['Pricing plans', 'How it started in a garage']);
  });

  test('does not apply to the home page, whose h1 is often a slogan', () => {
    const home = 'https://example.com/';
    const { at } = run(titleH1Mismatch, [page(home, { html: doc('<title>Acme plumbing</title>', '<h1>We fix it fast</h1>') })]);
    assert.deepEqual([at(home)?.outcome, at(home)?.reason], ['not_applicable', 'home-page']);
  });
});

describe('content-title-obsolete-year', () => {
  test('passes when the title year matches the heading', () => {
    assert.equal(run(titleObsoleteYear, [page(url, { html: doc('<title>2026 admissions criteria</title>', '<h1>2026 admissions criteria</h1>') })]).at()?.outcome, 'pass');
  });

  test('fails medium when the title year is older than the heading year', () => {
    const { at, excerpts } = run(titleObsoleteYear, [page(url, { html: doc('<title>2020 admissions criteria</title>', '<h1>2021 admissions criteria</h1>') })]);
    assert.deepEqual([at()?.outcome, at()?.severity, at()?.params?.titleYear, at()?.params?.headingYear], ['fail', 'medium', 2020, 2021]);
    assert.deepEqual(excerpts(at()), ['2020 admissions criteria', '2021 admissions criteria']);
  });

  test('passes a historical page whose heading also names the title year', () => {
    assert.equal(run(titleObsoleteYear, [page(url, { html: doc('<title>The 1998 final</title>', '<h1>The 1998 final, 25 years on (2023)</h1>') })]).at()?.outcome, 'pass');
  });

  test('does not apply without a year in the title', () => {
    assert.equal(run(titleObsoleteYear, [page(url, { html: doc('<title>Admissions</title>') })]).at()?.reason, 'no-year-in-title');
  });
});

describe('content-title-branding', () => {
  const brand = '<meta property="og:site_name" content="Acme">';

  test('passes a brand at the end after a delimiter', () => {
    assert.equal(run(titleBranding, [page(url, { html: doc(`<title>Garden tools | Acme</title>${brand}`) })]).at()?.outcome, 'pass');
  });

  test('reports a repeated brand as low', () => {
    const { at, excerpts } = run(titleBranding, [page(url, { html: doc(`<title>Acme garden tools | Acme</title>${brand}`) })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.params?.count], ['low', 'repeated', 2]);
    assert.deepEqual(excerpts(at()), ['Acme garden tools | Acme']);
  });

  test('reports an absent brand as info only', () => {
    assert.deepEqual([run(titleBranding, [page(url, { html: doc(`<title>Garden tools</title>${brand}`) })]).at()?.severity], ['info']);
  });

  test('is not evaluated without a declared site name', () => {
    assert.equal(run(titleBranding, [page(url, { html: doc('<title>Garden tools</title>') })]).at()?.reason, 'no-site-name');
  });

  test('accepts the brand mid-title when it is the subject, as on an about page', () => {
    assert.equal(run(titleBranding, [page(url, { html: doc(`<title>About Acme and its founder Ana Pons</title>${brand}`) })]).at()?.outcome, 'pass');
    assert.equal(run(titleBranding, [page(url, { html: doc(`<title>Garden tools by Acme for small gardens</title>${brand}`) })]).at()?.reason, 'mid-title');
  });

  test('does not apply to a page kept out of search results', () => {
    const noindex = doc(`<title>Legal | Acme Corporation</title><meta name="robots" content="noindex, follow">${brand}`);
    assert.equal(run(titleBranding, [page(url, { html: noindex })]).at()?.reason, 'not-indexable-noindex');
  });
});
