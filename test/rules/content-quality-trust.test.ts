import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import { browserAgent } from '../../src/data/agents.ts';
import type { TextBlock } from '../../src/render/chrome.ts';
import { boilerplateRatio, fillerBeforeMc, originality, scaledDoorway } from '../../src/rules/content/quality.ts';
import { bylineAuthor, dateConsistency, dateManipulation, datesInText, staleContent, trustPages } from '../../src/rules/content/trust.ts';
import type { RuleImplementation } from '../../src/rules/engine.ts';
import { evaluate, outcomeOn, page, response, site, type SiteSpec } from '../support/facts.ts';

const origin = 'https://example.com';
const url = `${origin}/blog/pruning-roses`;
const served = { date: 'Wed, 04 Nov 2026 10:00:00 GMT' };
const doc = (body: string, head = '<title>Pruning roses</title>') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const template = '<header><nav><a href="/">Home</a><a href="/blog">Blog</a></nav></header>';
const footer = '<footer><p>Acme garden studio, 12 Example Street. Opening hours Monday to Friday.</p></footer>';
const crawled = { crawled: true, homeUrl: `${origin}/` } as const;
const prose = (seed: string, count: number) => Array.from({ length: count }, (_, index) => `${seed}${index}`).join(' ');
const block = (selector: string, text: string, extra: Partial<TextBlock> = {}): TextBlock => ({ selector, text, fontSize: 16, top: 400, inMain: true, ...extra });
const jsonLd = (value: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...value as object })}</script>`;

function run(rule: RuleImplementation, pages: readonly PageFacts[], extra: Partial<SiteSpec> = {}) {
  const { findings, evidence } = evaluate(rule, site({ pages, ...extra }));
  const excerpts = (finding: (typeof findings)[number] | undefined) => (finding?.evidence ?? []).map(id => evidence.get(id)?.excerpt);
  return { at: (target = url) => outcomeOn(findings, target), siteFindings: findings.filter(entry => entry.scope.kind === 'site'), excerpts };
}

describe('content-boilerplate-ratio', () => {
  const pageWith = (path: string, words: number, pageType?: PageFacts['pageType']) =>
    page(`${origin}${path}`, { html: doc(`${template}<main><p>${prose(path.replace(/\W/gu, ''), words)}</p></main>${footer}`), ...(pageType ? { pageType } : {}) });

  test('passes pages with substantial page-specific text', () => {
    const pages = [pageWith('/a', 150), pageWith('/b', 150), pageWith('/c', 150)];
    assert.equal(run(boilerplateRatio, pages, crawled).siteFindings[0]?.outcome, 'pass');
  });

  test('hands a page with little unique text to the analyst, but never a short About page', () => {
    const pages = [pageWith('/a', 150), pageWith('/b', 150), pageWith('/thin', 20), pageWith('/about', 15, 'about')];
    const { siteFindings, excerpts } = run(boilerplateRatio, pages, crawled);
    assert.equal(siteFindings.length, 1);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.needsJudgment, siteFindings[0]?.params?.url, siteFindings[0]?.params?.uniqueWords], ['medium', true, `${origin}/thin`, 20]);
    assert.match(String(excerpts(siteFindings[0])[0]), /^thin0 thin1/u);
  });

  test('is not evaluated without a crawl', () => {
    assert.equal(run(boilerplateRatio, [pageWith('/a', 10)]).siteFindings[0]?.reason, 'missing-input:crawl');
  });
});

describe('content-filler-before-mc', () => {
  const html = doc('<main><p>x</p></main>');
  const paragraph = 'This is the paragraph that answers the question the page title asks, with the details a reader came for and the steps to follow.';

  test('passes when the main content starts within two phone screens', () => {
    assert.equal(run(fillerBeforeMc, [page(url, { html, pageType: 'article', userRender: { html, textBlocks: [block('main > p', paragraph, { top: 700 })] } })]).at()?.outcome, 'pass');
  });

  test('hands content that starts far down to the analyst', () => {
    const { at, excerpts } = run(fillerBeforeMc, [page(url, { html, pageType: 'article', userRender: { html, textBlocks: [block('main > p', paragraph, { top: 2100 })] } })]);
    assert.deepEqual([at()?.severity, at()?.needsJudgment, at()?.params?.viewports], ['medium', true, 2.6]);
    assert.match(String(excerpts(at())[0]), /^This is the paragraph/u);
  });

  test('does not apply without paragraph text, and is not evaluated without the user render', () => {
    assert.equal(run(fillerBeforeMc, [page(url, { html, pageType: 'article', userRender: { html, textBlocks: [block('main > p', 'Short')] } })]).at()?.reason, 'no-paragraph-text');
    assert.equal(run(fillerBeforeMc, [page(url, { html, pageType: 'article' })]).at()?.reason, 'missing-input:user-render');
  });

  test('does not apply to a home page built from short sections', () => {
    const home = page(`${origin}/`, { html, pageType: 'home', userRender: { html, textBlocks: [block('main > p', paragraph, { top: 6400 })] } });
    assert.equal(run(fillerBeforeMc, [home]).at(`${origin}/`)?.reason, 'page-type:home');
  });
});

describe('content-originality', () => {
  const article = (path: string, text: string, head = '<title>t</title>') => page(`${origin}${path}`, { html: doc(`<main><p>${text}</p></main>`, head) });

  test('passes distinct pages', () => {
    const pages = [article('/blog/a', prose('alpha', 80)), article('/blog/b', prose('beta', 80))];
    assert.equal(run(originality, pages, crawled).at(`${origin}/blog/a`)?.outcome, 'pass');
  });

  test('hands a near copy of another indexable page to the analyst', () => {
    const pages = [article('/blog/a', prose('same', 80)), article('/blog/b', `${prose('same', 80)} extra`)];
    const { at, excerpts } = run(originality, pages, crawled);
    assert.deepEqual([at(`${origin}/blog/a`)?.severity, at(`${origin}/blog/a`)?.needsJudgment, at(`${origin}/blog/a`)?.params?.overlap], ['medium', true, 100]);
    assert.equal(excerpts(at(`${origin}/blog/a`))[0], `${origin}/blog/b`);
  });

  test('ignores a noindex duplicate and pages with too little text', () => {
    const pages = [article('/blog/a', prose('same', 80)), article('/print/a', prose('same', 80), '<meta name="robots" content="noindex">'), article('/blog/c', 'Too short.')];
    const result = run(originality, pages, crawled);
    assert.equal(result.at(`${origin}/blog/a`)?.outcome, 'pass');
    assert.equal(result.at(`${origin}/print/a`)?.reason, 'not-indexable');
    assert.equal(result.at(`${origin}/blog/c`)?.reason, 'too-little-text');
  });
});

describe('content-scaled-doorway', () => {
  const cities = ['girona', 'lleida', 'reus', 'vic', 'manresa', 'tarragona', 'figueres', 'olot', 'igualada', 'terrassa', 'sabadell'];
  const body = (city: string) => `Plumber in ${city}. ${prose('service', 70)}`;

  test('passes pages with their own content', () => {
    const pages = cities.map(city => page(`${origin}/plumber-${city}`, { html: doc(`<main><p>${prose(city, 70)}</p></main>`) }));
    assert.equal(run(scaledDoorway, pages, crawled).siteFindings[0]?.outcome, 'pass');
  });

  test('hands ten or more place-swapped pages to the analyst', () => {
    const pages = cities.map(city => page(`${origin}/plumber-${city}`, { html: doc(`<main><p>${body(city)}</p></main>`) }));
    const { siteFindings, excerpts } = run(scaledDoorway, pages, crawled);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.needsJudgment, siteFindings[0]?.params?.count], ['medium', true, 11]);
    assert.match(String(excerpts(siteFindings[0])[0]), /^plumber in girona service0/u);
  });

  test('does not apply to fewer than ten pages', () => {
    const pages = cities.slice(0, 3).map(city => page(`${origin}/plumber-${city}`, { html: doc(`<main><p>${body(city)}</p></main>`) }));
    assert.equal(run(scaledDoorway, pages, crawled).siteFindings[0]?.reason, 'fewer-than-ten-pages-with-text');
  });
});

describe('content-byline-author', () => {
  const marked = (author: unknown) => jsonLd({ '@type': 'BlogPosting', headline: 'Pruning roses', author });

  test('passes a visible byline that matches the markup', () => {
    const html = doc('<main><h1>Pruning roses</h1><p class="byline">By Jane Roe</p><p>Text</p></main>', `<title>Pruning roses</title>${marked({ '@type': 'Person', name: 'Jane Roe' })}`);
    const { at, excerpts } = run(bylineAuthor, [page(url, { html })]);
    assert.equal(at()?.outcome, 'pass');
    assert.deepEqual(excerpts(at()), ['By Jane Roe']);
  });

  test('passes a plain-text byline near the heading whatever the case of its keyword', () => {
    const lines: Array<[string, string]> = [
      ['By Jane Roe · 3 March 2025', 'By Jane'], ['Por María López', 'Por María'], ['Per Jordi Puig', 'Per Jordi'], ['Author: Jane Roe', 'Author: Jane'],
      ['Written By Jane Roe', 'Written By Jane'], ['BY JANE ROE', 'BY JANE'], ['Posted by Jane Roe', 'by Jane'],
    ];
    for (const [line, excerpt] of lines) {
      const html = doc(`<main><h1>Pruning roses</h1><p class="meta">${line}</p><p>Text</p></main>`, `<title>Pruning roses</title>${jsonLd({ '@type': 'BlogPosting', headline: 'Pruning roses' })}`);
      const { at, excerpts } = run(bylineAuthor, [page(url, { html })]);
      assert.equal(at()?.outcome, 'pass', line);
      assert.deepEqual(excerpts(at()), [excerpt]);
    }
  });

  test('does not take a sentence that starts with By for a byline', () => {
    const html = doc('<main><h1>Pruning roses</h1><p>By pruning in March you get more roses.</p></main>', `<title>Pruning roses</title>${jsonLd({ '@type': 'BlogPosting', headline: 'Pruning roses' })}`);
    assert.equal(run(bylineAuthor, [page(url, { html })]).at()?.reason, 'no-byline');
  });

  test('passes content published under the organisation', () => {
    const html = doc('<main><h1>Pruning roses</h1></main>', `<title>Pruning roses</title>${marked({ '@type': 'Organization', name: 'Acme' })}`);
    assert.equal(run(bylineAuthor, [page(url, { html })]).at()?.outcome, 'pass');
  });

  test('fails medium when the markup author is not shown on the page', () => {
    const html = doc('<main><h1>Pruning roses</h1><p>Text</p></main>', `<title>Pruning roses</title>${marked({ '@type': 'Person', name: 'Jane Roe' })}`);
    const { at, excerpts } = run(bylineAuthor, [page(url, { html })]);
    assert.deepEqual([at()?.severity, at()?.reason], ['medium', 'markup-not-visible']);
    assert.deepEqual(excerpts(at()), ['Jane Roe']);
  });

  test('fails medium without any byline, and does not apply to service pages', () => {
    const html = doc('<main><h1>Pruning roses</h1><p>Text</p></main>', `<title>Pruning roses</title>${jsonLd({ '@type': 'BlogPosting', headline: 'Pruning roses' })}`);
    assert.equal(run(bylineAuthor, [page(url, { html })]).at()?.reason, 'no-byline');
    assert.equal(run(bylineAuthor, [page(url, { html, pageType: 'service' })]).at()?.reason, 'page-type:service');
  });

  test('reads the author of the recipe a recipe page is about', () => {
    const recipeUrl = `${origin}/recipes/rose-petal-jam`;
    const head = (author: unknown) => `<title>Rose petal jam</title>${jsonLd({ '@type': 'Recipe', name: 'Rose petal jam', image: `${origin}/jam.jpg`, author })}`;
    const at = (author: unknown, body = '<p>Text</p>') => run(bylineAuthor, [page(recipeUrl, { html: doc(`<main><h1>Rose petal jam</h1>${body}</main>`, head(author)) })]).at(recipeUrl);
    assert.equal(at({ '@type': 'Organization', name: 'Acme' })?.outcome, 'pass');
    assert.equal(at({ '@type': 'Person', name: 'Jane Roe' }, '<p>A recipe from Jane Roe.</p>')?.outcome, 'pass');
    assert.equal(at({ '@type': 'Person', name: 'Jane Roe' })?.reason, 'markup-not-visible');
  });
});

describe('content-date-consistency', () => {
  const dated = (published: string, body: string) => doc(`<main><h1>Pruning roses</h1>${body}</main>`, `<title>t</title>${jsonLd({ '@type': 'BlogPosting', headline: 'h', datePublished: published })}`);

  test('reads dates written in English, Spanish and Catalan', () => {
    assert.deepEqual(datesInText('Published March 3, 2026; publicado el 3 de marzo de 2026; publicat el 3 de març del 2026').map(entry => entry.date), ['2026-03-03', '2026-03-03', '2026-03-03']);
  });

  test('passes a visible date that matches datePublished', () => {
    const html = dated('2026-03-01T09:00:00+01:00', '<time datetime="2026-03-01">1 March 2026</time>');
    assert.equal(run(dateConsistency, [page(url, { html, headers: served })]).at()?.outcome, 'pass');
  });

  test('fails medium when the shown date disagrees with the markup', () => {
    const { at, excerpts } = run(dateConsistency, [page(url, { html: dated('2026-03-01', '<p>Published: 15 March 2026</p>'), headers: served })]);
    assert.deepEqual([at()?.severity, at()?.reason, at()?.params?.visible], ['medium', 'visible-mismatch', '2026-03-15']);
    assert.match(String(excerpts(at())[1]), /Published: 15 March 2026/u);
  });

  test('reads marked time elements and ignores dates of related posts', () => {
    const related = dated('2026-03-01', '<p>Text</p><aside><time class="entry-date" datetime="2025-01-01">1 Jan 2025</time></aside><article class="card"><time datetime="2024-05-05">5 May</time></article>');
    assert.equal(run(dateConsistency, [page(url, { html: related, headers: served })]).at()?.outcome, 'pass');
    const marked = dated('2026-03-01', '<p class="post-meta"><time class="entry-date published" datetime="2026-03-09">9 March 2026</time></p>');
    const { at, excerpts } = run(dateConsistency, [page(url, { html: marked, headers: served })]);
    assert.deepEqual([at()?.reason, at()?.params?.visible], ['visible-mismatch', '2026-03-09']);
    assert.equal(excerpts(at())[1], '<time datetime="2026-03-09">9 March 2026</time>');
  });

  test('fails medium on a future date and low on a distant sitemap lastmod', () => {
    assert.equal(run(dateConsistency, [page(url, { html: dated('2027-02-01', ''), headers: served })]).at()?.reason, 'future-date');
    const html = doc('<main><h1>h</h1></main>', jsonLd({ '@type': 'BlogPosting', headline: 'h', datePublished: '2026-01-01', dateModified: '2026-02-01' }));
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc><lastmod>2026-06-01</lastmod></url></urlset>`;
    const { at } = run(dateConsistency, [page(url, { html, headers: served })], { sitemaps: [{ url: `${origin}/sitemap.xml`, xml }] });
    assert.deepEqual([at()?.severity, at()?.reason], ['low', 'lastmod-differs']);
  });

  test('does not compare event dates, and does not apply without structured dates', () => {
    const event = doc('<main><time datetime="2026-12-20">20 Dec</time></main>', jsonLd({ '@graph': [{ '@type': 'MusicEvent', name: 'Gig', startDate: '2026-12-20' }, { '@type': 'WebPage', datePublished: '2026-01-10' }] }));
    assert.equal(run(dateConsistency, [page(url, { html: event, headers: served })]).at()?.outcome, 'pass');
    assert.equal(run(dateConsistency, [page(url, { html: doc('<p>x</p>') })]).at()?.reason, 'no-structured-dates');
  });
});

describe('content-date-manipulation', () => {
  const modified = (value: string) => doc('<main><p>x</p></main>', jsonLd({ '@type': 'WebPage', dateModified: value }));

  test('passes a stable dateModified', () => {
    const html = modified('2026-05-02T08:00:00Z');
    const uaProbes = [{ agent: browserAgent, url, fetch: response(url, { body: html }) }];
    assert.equal(run(dateManipulation, [page(url, { html, uaProbes })]).siteFindings[0]?.outcome, 'pass');
  });

  test('fails medium when dateModified changes between two fetches', () => {
    const uaProbes = [{ agent: browserAgent, url, fetch: response(url, { body: modified('2026-11-04T10:00:03Z') }) }];
    const { siteFindings, excerpts } = run(dateManipulation, [page(url, { html: modified('2026-11-04T10:00:01Z'), uaProbes })]);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.reason, siteFindings[0]?.needsJudgment], ['medium', 'per-request', undefined]);
    assert.deepEqual(excerpts(siteFindings[0]), ['2026-11-04T10:00:01Z', '2026-11-04T10:00:03Z']);
  });

  test('fails when most crawled pages carry the crawl day as dateModified', () => {
    const pages = ['a', 'b', 'c', 'd', 'e'].map(slug => page(`${origin}/${slug}`, { html: modified('2026-11-04T06:00:00Z'), headers: served }));
    assert.equal(run(dateManipulation, pages, crawled).siteFindings[0]?.reason, 'crawl-date');
  });

  test('does not apply without dateModified', () => {
    assert.equal(run(dateManipulation, [page(url, { html: doc('<p>x</p>') })]).siteFindings[0]?.reason, 'no-date-modified');
  });
});

describe('content-trust-pages', () => {
  const home = `${origin}/`;

  test('counts a /#contact section reachable from the footer as a contact page', () => {
    const html = doc('<main><p>Studio</p></main><footer><a href="/about">About us</a><a href="/#contact">Contact</a></footer>');
    const { siteFindings, excerpts } = run(trustPages, [page(home, { html })]);
    assert.equal(siteFindings[0]?.outcome, 'pass');
    assert.deepEqual(excerpts(siteFindings[0]), ['Contact -> https://example.com/#contact', 'About us -> https://example.com/about']);
  });

  test('fails medium without any contact route', () => {
    const { siteFindings } = run(trustPages, [page(home, { html: doc('<main><p>Studio</p></main><footer><a href="/sobre-nosotros">Sobre nosotros</a></footer>') })]);
    assert.deepEqual([siteFindings[0]?.severity, siteFindings[0]?.reason, siteFindings[0]?.needsJudgment], ['medium', 'no-contact', undefined]);
  });

  test('recognises an about page named after the brand', () => {
    for (const link of ['<a href="/ca/sobre-altitud/">Sobre Altitud</a>', '<a href="/en/company-story/">About Acme</a>', '<a href="/es/x/">Acerca de Acme</a>']) {
      const { siteFindings } = run(trustPages, [page(home, { html: doc(`<footer>${link}<a href="mailto:hi@example.com">hi@example.com</a></footer>`) })]);
      assert.equal(siteFindings[0]?.outcome, 'pass', link);
    }
  });

  test('hands a missing about page to the analyst when a mailto link gives contact', () => {
    const { siteFindings } = run(trustPages, [page(home, { html: doc('<footer><a href="mailto:hello@example.com">hello@example.com</a></footer>') })]);
    assert.deepEqual([siteFindings[0]?.reason, siteFindings[0]?.needsJudgment], ['no-about', true]);
  });

  test('is not evaluated without the home page', () => {
    assert.equal(run(trustPages, [page(url, { html: doc('<p>x</p>') })]).siteFindings[0]?.reason, 'no-home-page');
  });
});

describe('content-stale-content', () => {
  test('passes a current title', () => {
    assert.equal(run(staleContent, [page(url, { html: doc('<h1>Best pruning shears 2026</h1>', '<title>Best pruning shears 2026</title>'), headers: served })]).at()?.outcome, 'pass');
  });

  test('hands an old year in the title to the analyst', () => {
    const { at, excerpts } = run(staleContent, [page(url, { html: doc('<main><p>Prices as of 2022 are listed below.</p></main>', '<title>Best pruning shears 2022</title>'), headers: served })]);
    assert.deepEqual([at()?.severity, at()?.needsJudgment, at()?.params?.year], ['medium', true, 2026]);
    assert.equal(excerpts(at())[0], 'Best pruning shears 2022');
  });

  test('is not evaluated without the response date', () => {
    assert.equal(run(staleContent, [page(url, { html: doc('<p>x</p>', '<title>Guide 2019</title>') })]).at()?.reason, 'no-served-date');
  });
});
