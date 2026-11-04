import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EvidenceStore } from '../../src/core/evidence.ts';
import type { PageType } from '../../src/core/types.ts';
import type { Finding, RuleImplementation } from '../../src/rules/engine.ts';
import {
  article, breadcrumb, carouselItemList, dataset, discussionForum, event, imageMetadata, jobPosting, localBusiness, paywalledContent, profilePage, qaPage,
  recipe, video,
} from '../../src/rules/schema/page-features.ts';
import { blockedOrNonindexableCarrier, mainEntityPageFit, visibleContentParity } from '../../src/rules/schema/policy.ts';
import { faqPageRetired, retiredFeatureMarkup } from '../../src/rules/schema/retired.ts';
import { evaluate, outcomeOn, page, site, type PageSpec, type SiteSpec } from '../support/facts.ts';

const url = 'https://shop.example/section/page';
const ctx = 'https://schema.org';
const ld = (...items: unknown[]) => items.map(item => `<script type="application/ld+json">${JSON.stringify({ '@context': ctx, ...(item as object) })}</script>`).join('\n');
const doc = (head: string, body = '<main><p>Body</p></main>') => `<!doctype html><html lang="en"><head><title>Page</title>${head}</head><body>${body}</body></html>`;

interface Spec extends PageSpec {
  readonly at?: string;
  readonly site?: Omit<SiteSpec, 'pages'>;
}

function run(rule: RuleImplementation, spec: Spec): { all: Finding[]; evidence: EvidenceStore } {
  const target = spec.at ?? url;
  const { findings, evidence } = evaluate(rule, site({ ...spec.site, pages: [page(target, spec)] }));
  return { all: findings.filter(entry => entry.scope.kind === 'page' && entry.scope.url === target), evidence };
}

function failure(rule: RuleImplementation, spec: Spec, reason: string): { finding: Finding; excerpts: string[] } {
  const { all, evidence } = run(rule, spec);
  const finding = all.find(entry => entry.outcome === 'fail' && entry.reason === reason);
  assert.ok(finding, `expected a ${reason} failure, got ${JSON.stringify(all.map(entry => [entry.outcome, entry.reason, entry.params]))}`);
  return { finding, excerpts: finding.evidence.map(id => evidence.get(id)?.excerpt ?? '') };
}

function passes(rule: RuleImplementation, spec: Spec): void {
  assert.deepEqual(run(rule, spec).all.map(entry => [entry.outcome, entry.reason]), [['pass', undefined]]);
}

function outcome(rule: RuleImplementation, spec: Spec): [string, string | undefined] {
  const { findings } = evaluate(rule, site({ ...spec.site, pages: [page(spec.at ?? url, spec)] }));
  const finding = outcomeOn(findings, spec.at ?? url)!;
  return [finding.outcome, finding.reason];
}

const on = (pageType: PageType, ...items: unknown[]): Spec => ({ html: doc(ld(...items)), pageType });

describe('schema-localbusiness', () => {
  const shop = { '@type': 'Store', name: 'Acme', address: { '@type': 'PostalAddress', streetAddress: 'Carrer 1', addressCountry: 'AD' },
    geo: { '@type': 'GeoCoordinates', latitude: 42.50779, longitude: 1.52109 } };
  test('passes a complete business', () => passes(localBusiness, on('contact', shop)));
  test('fails a business without address at medium severity', () => {
    const { address: _address, ...noAddress } = shop;
    const { finding, excerpts } = failure(localBusiness, on('contact', noAddress), 'missing-required');
    assert.deepEqual([finding.severity, finding.params?.items], ['medium', 'address']);
    assert.match(excerpts[0]!, /"@type":"Store"/u);
  });
  test('reads coordinate precision from the literal, so trailing zeros count', () => {
    const html = doc(`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Store","name":"Acme","address":"Carrer 1",
      "geo":{"@type":"GeoCoordinates","latitude":42.50000,"longitude":1.5}}</script>`);
    const { finding } = failure(localBusiness, { html, pageType: 'contact' }, 'geo-precision');
    assert.deepEqual([finding.severity, finding.params?.items], ['low', 'longitude (1 decimals)']);
  });
  test('treats a service-area business without address as exempt', () => {
    passes(localBusiness, on('contact', { '@type': 'Plumber', name: 'Acme', areaServed: 'Andorra' }));
  });
  test('is not applicable without LocalBusiness or on other page types', () => {
    assert.deepEqual(outcome(localBusiness, on('contact', { '@type': 'Organization', name: 'Acme' })), ['not_applicable', 'no-local-business']);
    assert.deepEqual(outcome(localBusiness, on('product', shop)), ['not_applicable', 'page-type:product']);
  });
});

describe('schema-article', () => {
  const post = { '@type': 'BlogPosting', headline: 'Notes', image: 'https://shop.example/a.jpg', datePublished: '2026-11-01', author: { '@type': 'Person', name: 'Ana Pons', url: 'https://shop.example/team/ana' } };
  test('passes a complete post', () => passes(article, on('article', post)));
  test('fails a blog post without image at medium severity', () => {
    const { image: _image, ...noImage } = post;
    const { finding } = failure(article, on('article', noImage), 'missing-image');
    assert.deepEqual([finding.severity, finding.params?.items], ['medium', 'BlogPosting']);
  });
  test('reports several people in one Person author as low', () => {
    const { finding, excerpts } = failure(article, on('article', { ...post, author: { '@type': 'Person', name: 'Ana Pons and Joan Vila' } }), 'merged-authors');
    assert.equal(finding.severity, 'low');
    assert.equal(excerpts[0], 'Ana Pons and Joan Vila');
  });
  test('is not applicable without Article markup', () => {
    assert.deepEqual(outcome(article, on('article', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-article']);
  });
});

describe('schema-breadcrumb', () => {
  const trail = (items: unknown[]) => ({ '@type': 'BreadcrumbList', itemListElement: items });
  const item = (position: unknown, name: string, target?: string) => ({ '@type': 'ListItem', position, name, ...(target ? { item: target } : {}) });
  test('passes a two-level trail whose last item has no URL', () => {
    passes(breadcrumb, on('other', trail([item(1, 'Home', 'https://shop.example/'), item(2, 'Section', 'https://shop.example/section/'), item(3, 'Page')])));
  });
  test('reports a missing position as low', () => {
    const { finding, excerpts } = failure(breadcrumb, on('other', trail([item(1, 'Home', 'https://shop.example/'), item(undefined, 'Page')])), 'invalid-position');
    assert.deepEqual([finding.severity, finding.params?.items], ['low', 'none']);
    assert.equal(excerpts[0], 'null');
  });
  test('accepts a single item on a top-level page', () => {
    passes(breadcrumb, { ...on('other', trail([item(1, 'About')])), at: 'https://shop.example/about' });
  });
  test('reports a single item on a deep page', () => {
    failure(breadcrumb, on('other', trail([item(1, 'Page')])), 'too-few-items');
  });
  test('is not applicable without BreadcrumbList', () => {
    assert.deepEqual(outcome(breadcrumb, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-breadcrumb']);
  });
  test('reports a step named after the page title with the site name, but not the site name alone', () => {
    const titled = trail([item(1, 'Altitud Studio', 'https://shop.example/'), item(2, 'Fractional CTO Services in Europe | Altitud Studio', 'https://shop.example/cto/')]);
    const { finding } = failure(breadcrumb, on('other', titled), 'name-with-site-name');
    assert.deepEqual([finding.severity, finding.params?.items], ['low', 'Fractional CTO Services in Europe | Altitud Studio']);
    passes(breadcrumb, on('other', trail([item(1, 'Home', 'https://shop.example/'), item(2, 'Garden tools', 'https://shop.example/garden/')])));
    passes(breadcrumb, on('other', trail([item(1, 'Altitud Studio', 'https://shop.example/'), item(2, 'Fractional CTO', 'https://shop.example/cto/')])));
  });
});

describe('schema-profile-page', () => {
  const profile = { '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: 'Ana Pons' } };
  test('passes a single-person profile', () => passes(profilePage, on('about', profile)));
  test('fails a mainEntity without name at medium severity', () => {
    const { finding } = failure(profilePage, on('about', { '@type': 'ProfilePage', mainEntity: { '@type': 'Person', jobTitle: 'Editor' } }), 'main-entity-without-name');
    assert.equal(finding.severity, 'medium');
  });
  test('hands a team page with many people to the analyst', () => {
    const people = ['Ana', 'Joan', 'Marta'].map(name => ({ '@type': 'Person', name }));
    const { finding } = failure(profilePage, on('about', { '@type': 'ProfilePage', mainEntity: people }), 'several-people');
    assert.deepEqual([finding.severity, finding.needsJudgment], ['medium', true]);
  });
  test('is not applicable without ProfilePage', () => {
    assert.deepEqual(outcome(profilePage, on('about', { '@type': 'AboutPage', name: 'x' })), ['not_applicable', 'no-profile-page']);
  });
});

describe('schema-video', () => {
  const clip = { '@type': 'VideoObject', name: 'Tour', thumbnailUrl: 'https://shop.example/t.jpg', uploadDate: '2026-10-01T10:00:00+02:00', contentUrl: 'https://shop.example/t.mp4' };
  test('passes a complete video', () => passes(video, on('other', clip)));
  test('fails a video without uploadDate at medium severity', () => {
    const { uploadDate: _date, ...noDate } = clip;
    const { finding } = failure(video, on('other', noDate), 'missing-required');
    assert.deepEqual([finding.severity, finding.params?.items], ['medium', 'uploadDate']);
  });
  test('reports both region lists as low', () => {
    assert.equal(failure(video, on('other', { ...clip, regionsAllowed: 'ES', ineligibleRegion: 'FR' }), 'both-region-lists').finding.severity, 'low');
  });
  test('is not applicable without video markup', () => {
    assert.deepEqual(outcome(video, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-video']);
  });
});

describe('schema-image-metadata', () => {
  test('passes a licensable image', () => {
    passes(imageMetadata, on('other', { '@type': 'ImageObject', contentUrl: 'https://shop.example/p.jpg', license: 'https://shop.example/license', acquireLicensePage: 'https://shop.example/buy' }));
  });
  test('reports an image with only an acquire-license page as low', () => {
    const { finding } = failure(imageMetadata, on('other', { '@type': 'ImageObject', contentUrl: 'https://shop.example/p.jpg', acquireLicensePage: 'https://shop.example/buy' }), 'missing-license-info');
    assert.equal(finding.severity, 'low');
  });
  test('is not applicable to logos and photos without licensing details', () => {
    assert.deepEqual(outcome(imageMetadata, on('other', { '@type': 'Organization', name: 'Acme', logo: { '@type': 'ImageObject', url: 'https://shop.example/logo.svg' } })),
      ['not_applicable', 'no-image-licensing-markup']);
  });
});

describe('schema-event', () => {
  const gig = { '@type': 'MusicEvent', name: 'Concert', startDate: '2026-12-01T21:00:00+01:00',
    location: { '@type': 'Place', name: 'Hall', address: { '@type': 'PostalAddress', streetAddress: 'Plaça 1', addressCountry: 'AD' } } };
  test('passes a physical event', () => passes(event, on('other', gig)));
  test('fails a location without address at high severity', () => {
    const { finding, excerpts } = failure(event, on('other', { ...gig, location: { '@type': 'Place', name: 'Hall' } }), 'location-without-address');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], '{"@type":"Place","name":"Hall"}');
  });
  test('reports a virtual-only event as medium', () => {
    assert.equal(failure(event, on('other', { ...gig, location: { '@type': 'VirtualLocation', url: 'https://stream.example/' } }), 'virtual-only').finding.severity, 'medium');
  });
  test('is not applicable without events', () => {
    assert.deepEqual(outcome(event, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-event']);
  });
});

describe('schema-jobposting', () => {
  const job = { '@type': 'JobPosting', title: 'Cook', description: '<p>Kitchen</p>', datePosted: '2026-10-01', validThrough: '2026-12-31',
    hiringOrganization: { '@type': 'Organization', name: 'Acme' }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'AD' } } };
  const fetched = { date: 'Wed, 04 Nov 2026 08:00:00 GMT' };
  test('passes an open single job', () => passes(jobPosting, { ...on('other', job), headers: fetched }));
  test('fails an expired job on a live page at high severity', () => {
    const { finding, excerpts } = failure(jobPosting, { ...on('other', { ...job, validThrough: '2026-10-15' }), headers: fetched }, 'expired');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], '2026-10-15');
  });
  test('does not call an expired job live when the page is noindex', () => {
    passes(jobPosting, { ...on('other', { ...job, validThrough: '2026-10-15' }), headers: { ...fetched, 'x-robots-tag': 'noindex' } });
  });
  test('fails several jobs on one page', () => {
    assert.equal(failure(jobPosting, { ...on('listing', job, { ...job, title: 'Waiter' }), headers: fetched }, 'several-jobs').finding.params?.items, '2 JobPosting');
  });
  test('is not applicable without job postings', () => {
    assert.deepEqual(outcome(jobPosting, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-job-posting']);
  });
});

describe('schema-dataset', () => {
  const data = { '@type': 'Dataset', name: 'Rainfall', description: 'Daily rainfall measured at twelve stations between 2000 and 2025.' };
  test('passes a described dataset', () => passes(dataset, on('other', data)));
  test('reports a short description as low', () => {
    const { finding } = failure(dataset, on('other', { ...data, description: 'Rain data.' }), 'description-length');
    assert.deepEqual([finding.severity, finding.params?.items], ['low', '10 characters']);
  });
  test('is not applicable without datasets', () => {
    assert.deepEqual(outcome(dataset, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-dataset']);
  });
});

describe('schema-qapage', () => {
  const answer = { '@type': 'Answer', text: 'Use a torque wrench.', author: { '@type': 'Person', name: 'Joan' } };
  const qa = { '@type': 'QAPage', mainEntity: { '@type': 'Question', name: 'How tight?', answerCount: 1, author: { '@type': 'Person', name: 'Ana' }, acceptedAnswer: answer } };
  test('passes a community question', () => passes(qaPage, on('other', qa)));
  test('fails several questions on one QAPage at high severity', () => {
    const { finding } = failure(qaPage, on('other', { '@type': 'QAPage', mainEntity: [qa.mainEntity, { ...qa.mainEntity, name: 'Which oil?' }] }), 'several-questions');
    assert.equal(finding.severity, 'high');
  });
  test('hands an authorless question and answer to the analyst', () => {
    const faq = { '@type': 'QAPage', mainEntity: { '@type': 'Question', name: 'Do you ship?', answerCount: 1, acceptedAnswer: { '@type': 'Answer', text: 'Yes.' } } };
    const { finding } = failure(qaPage, on('other', faq), 'site-authored-candidate');
    assert.deepEqual([finding.severity, finding.needsJudgment], ['medium', true]);
  });
  test('is not applicable without QAPage', () => {
    assert.deepEqual(outcome(qaPage, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-qapage']);
  });
});

describe('schema-discussion-forum', () => {
  const post = { '@type': 'DiscussionForumPosting', headline: 'Hello', text: 'First post', datePublished: '2026-11-01T10:00:00+01:00', author: { '@type': 'Person', name: 'Ana' },
    comment: { '@type': 'Comment', text: 'Welcome', datePublished: '2026-11-01T11:00:00+01:00', author: { '@type': 'Person', name: 'Joan' } } };
  test('passes a post with a comment', () => passes(discussionForum, on('other', post)));
  test('fails a comment without date at medium severity', () => {
    const { finding } = failure(discussionForum, on('other', { ...post, comment: { ...post.comment, datePublished: undefined } }), 'missing-date');
    assert.deepEqual([finding.severity, finding.params?.items], ['medium', 'Comment']);
  });
  test('does not require content for a post that lives on another page', () => {
    passes(discussionForum, on('other', { '@type': 'DiscussionForumPosting', url: 'https://shop.example/forum/thread-1', datePublished: '2026-11-01', author: 'Ana' }));
  });
  test('is not applicable without forum markup', () => {
    assert.deepEqual(outcome(discussionForum, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-forum-posting']);
  });
});

describe('schema-paywalled-content', () => {
  const gated = (selector: string) => ({ '@type': 'NewsArticle', headline: 'x', isAccessibleForFree: false,
    hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: selector } });
  const body = '<main><p>Intro</p><div class="paywall"><p>Rest</p></div></main>';
  test('passes a class selector that matches the gated section', () => passes(paywalledContent, { html: doc(ld(gated('.paywall')), body), pageType: 'article' }));
  test('fails a selector that matches nothing at medium severity', () => {
    const { finding, excerpts } = failure(paywalledContent, { html: doc(ld(gated('.locked')), body), pageType: 'article' }, 'selector-unmatched');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], '.locked');
  });
  test('fails an id selector', () => {
    failure(paywalledContent, { html: doc(ld(gated('#paywall')), body), pageType: 'article' }, 'non-class-selector');
  });
  test('is not applicable to free content', () => {
    assert.deepEqual(outcome(paywalledContent, { html: doc(ld({ '@type': 'NewsArticle', headline: 'x' })), pageType: 'article' }), ['not_applicable', 'no-paywall-markup']);
  });
});

describe('schema-recipe', () => {
  const soup = { '@type': 'Recipe', name: 'Soup', image: 'https://shop.example/soup.jpg', recipeYield: '4', nutrition: { '@type': 'NutritionInformation', calories: '200 calories' } };
  test('passes a complete recipe', () => passes(recipe, on('article', soup)));
  test('fails calories without yield at medium severity', () => {
    const { recipeYield: _yield, ...noYield } = soup;
    assert.equal(failure(recipe, on('article', noYield), 'calories-without-yield').finding.severity, 'medium');
  });
  test('is not applicable without recipes', () => {
    assert.deepEqual(outcome(recipe, on('article', { '@type': 'Article', headline: 'x' })), ['not_applicable', 'no-recipe']);
  });
});

describe('schema-carousel-itemlist', () => {
  const item = (position: number, name: string) => ({ '@type': 'ListItem', position, item: { '@type': 'Product', name, image: 'https://shop.example/i.jpg', url: `https://shop.example/p/${name}` } });
  test('passes a summary list of distinct product pages', () => passes(carouselItemList, on('listing', { '@type': 'ItemList', itemListElement: [item(1, 'a'), item(2, 'b'), item(3, 'c')] })));
  test('reports fewer than three items in a beta carousel as low', () => {
    const { finding } = failure(carouselItemList, on('listing', { '@type': 'ItemList', itemListElement: [item(1, 'a'), item(2, 'b')] }), 'too-few-items');
    assert.deepEqual([finding.severity, finding.params?.items], ['low', '2 items']);
  });
  test('reports repeated URLs in a url-only summary list', () => {
    const urls = [1, 2].map(position => ({ '@type': 'ListItem', position, url: 'https://shop.example/r/soup' }));
    failure(carouselItemList, on('listing', { '@type': 'ItemList', itemListElement: urls }), 'duplicate-urls');
  });
  test('is not applicable without ItemList markup', () => {
    assert.deepEqual(outcome(carouselItemList, on('listing', { '@type': 'BreadcrumbList', itemListElement: [] })), ['not_applicable', 'no-carousel-markup']);
  });
});

describe('schema-faqpage-retired', () => {
  const faq = { '@type': 'FAQPage', mainEntity: { '@type': 'Question', name: 'Do you ship?', acceptedAnswer: { '@type': 'Answer', text: 'Yes.' } } };
  test('reports valid FAQPage markup as info, never as an error', () => {
    const { finding } = failure(faqPageRetired, on('other', faq), 'present');
    assert.equal(finding.severity, 'info');
  });
  test('is not applicable without FAQPage', () => {
    assert.deepEqual(outcome(faqPageRetired, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-faqpage']);
  });
  test('needs the raw HTML', () => {
    assert.deepEqual(outcome(faqPageRetired, { pageType: 'other' }), ['not_evaluated', 'missing-input:raw-html']);
  });
});

describe('schema-retired-feature-markup', () => {
  test('reports HowTo markup as info with its retirement date', () => {
    const { finding } = failure(retiredFeatureMarkup, on('other', { '@type': 'HowTo', name: 'Fix a tap' }), 'retired');
    assert.deepEqual([finding.severity, finding.params?.items], ['info', 'How-to (2023-09-13)']);
  });
  test('does not treat recipe steps as HowTo markup', () => {
    assert.deepEqual(outcome(retiredFeatureMarkup, on('article', { '@type': 'Recipe', name: 'Soup', recipeInstructions: [{ '@type': 'HowToStep', text: 'Boil.' }] })),
      ['not_applicable', 'no-retired-feature-markup']);
  });
  test('needs the raw HTML', () => {
    assert.deepEqual(outcome(retiredFeatureMarkup, { pageType: 'other' }), ['not_evaluated', 'missing-input:raw-html']);
  });
});

describe('schema-main-entity-page-fit', () => {
  const product = (name: string) => ({ '@type': 'Product', name, offers: { '@type': 'Offer', price: 1, priceCurrency: 'EUR' } });
  test('passes one product on a product page', () => passes(mainEntityPageFit, on('product', product('a'))));
  test('hands three top-level products to the analyst', () => {
    const { finding } = failure(mainEntityPageFit, on('listing', product('a'), product('b'), product('c')), 'several-products');
    assert.deepEqual([finding.severity, finding.needsJudgment, finding.params?.items], ['medium', true, '3 Product']);
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(mainEntityPageFit, { html: doc(''), pageType: 'other' }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-visible-content-parity', () => {
  const lamp = { '@type': 'Product', name: 'Lamp', offers: { '@type': 'Offer', price: '1299.00', priceCurrency: 'EUR' },
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', reviewCount: '120' } };
  test('finds prices and ratings written with local separators and in image alt text', () => {
    passes(visibleContentParity, { html: doc(ld(lamp), '<main><p>1.299,00 €</p><img src="s.svg" alt="4,5 out of 5"><span>(120 reviews)</span></main>'), pageType: 'product' });
  });
  test('hands a price that appears nowhere on the page to the analyst', () => {
    const { finding, excerpts } = failure(visibleContentParity, { html: doc(ld(lamp), '<main><p>4.5 stars, 120 reviews</p></main>'), pageType: 'product' }, 'value-not-on-page');
    assert.deepEqual([finding.severity, finding.needsJudgment], ['medium', true]);
    assert.equal(excerpts[0], '1299.00');
  });
  test('counts sections hidden until a reveal fires as present', () => {
    const rendered = { html: doc(ld(lamp), '<main><section data-reveal style="opacity:0"><p>1.299,00 € 4,5 (120)</p></section></main>'),
      textBlocks: [{ selector: 'section[data-reveal] p', text: '1.299,00 € 4,5 (120)', hidden: 'opacity-zero' as const, fontSize: 16, top: 900, inMain: true }] };
    passes(visibleContentParity, { html: doc(ld(lamp), '<main><section data-reveal><p>1.299,00 € 4,5 (120)</p></section></main>'), rendered, pageType: 'product' });
  });
  test('is not applicable without prices or ratings', () => {
    assert.deepEqual(outcome(visibleContentParity, on('other', { '@type': 'WebPage', name: 'x' })), ['not_applicable', 'no-checked-values']);
  });
});

describe('schema-blocked-or-nonindexable-carrier', () => {
  const lamp = { '@type': 'Product', name: 'Lamp', image: 'https://shop.example/img/lamp.jpg', offers: { '@type': 'Offer', price: 1, priceCurrency: 'EUR' } };
  test('passes an indexable product page with crawlable images', () => {
    passes(blockedOrNonindexableCarrier, { ...on('product', lamp), site: { robots: 'User-agent: *\nDisallow: /cart\n' } });
  });
  test('fails a product image disallowed for Googlebot-Image at high severity', () => {
    const { finding, excerpts } = failure(blockedOrNonindexableCarrier, { ...on('product', lamp), site: { robots: 'User-agent: *\nDisallow: /img/\n' } }, 'image-blocked');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], 'disallow: /img/ (line 2)');
  });
  test('fails feature markup on a noindex page', () => {
    const html = doc(`<meta name="robots" content="noindex">${ld(lamp)}`);
    assert.equal(failure(blockedOrNonindexableCarrier, { html, pageType: 'product' }, 'noindex').excerpts[0], 'noindex');
  });
  test('exempts noindex,follow legal pages and site-wide Organization markup', () => {
    const html = doc(`<meta name="robots" content="noindex,follow">${ld({ '@type': 'Organization', name: 'Acme' })}`);
    assert.deepEqual(outcome(blockedOrNonindexableCarrier, { html, pageType: 'legal', at: 'https://shop.example/privacy' }), ['not_applicable', 'legal-page']);
    assert.deepEqual(outcome(blockedOrNonindexableCarrier, { html, pageType: 'other' }), ['not_applicable', 'no-feature-markup']);
  });
  const store = { '@type': 'Store', '@id': 'https://shop.example/#store', name: 'Shop Example', url: 'https://shop.example/', telephone: '+376 800 800',
    address: { '@type': 'PostalAddress', streetAddress: 'Av. Meritxell 1', addressLocality: 'Andorra la Vella', addressCountry: 'AD' } };
  const noindex = '<meta name="robots" content="noindex, follow">';
  test('does not apply to utility and error pages, which are kept out of the index on purpose', () => {
    const template = (path: string) => ld({ '@graph': [store, { '@type': 'WebPage', '@id': `https://shop.example${path}#webpage`, url: `https://shop.example${path}`, publisher: { '@id': 'https://shop.example/#store' } }] });
    assert.deepEqual(outcome(blockedOrNonindexableCarrier, { html: doc(`${noindex}${template('/cart/')}${ld(lamp)}`), at: 'https://shop.example/cart/' }), ['not_applicable', 'utility-page']);
    assert.deepEqual(outcome(blockedOrNonindexableCarrier, { html: doc(`${template('/old-lamp/')}${ld(lamp)}`), status: 404, at: 'https://shop.example/old-lamp/' }), ['not_applicable', 'error-page']);
  });
  test('reads a business anchored at the home page as site identity on the other pages', () => {
    const listing = { html: doc(`${noindex}${ld(store)}`), pageType: 'listing' as const, at: 'https://shop.example/tag/lamps/' };
    assert.deepEqual(outcome(blockedOrNonindexableCarrier, listing), ['not_applicable', 'no-feature-markup']);
    assert.deepEqual(outcome(blockedOrNonindexableCarrier, { ...listing, html: doc(`${noindex}${ld({ ...store, url: undefined })}`) }), ['not_applicable', 'no-feature-markup']);
    failure(blockedOrNonindexableCarrier, { ...listing, pageType: 'home', at: 'https://shop.example/' }, 'noindex');
    failure(blockedOrNonindexableCarrier, { ...listing, pageType: 'home', at: 'https://shop.example/en/' }, 'noindex');
    const location = { ...store, '@id': 'https://shop.example/stores/andorra/#store', url: 'https://shop.example/stores/andorra/' };
    failure(blockedOrNonindexableCarrier, { html: doc(`${noindex}${ld(location)}`), pageType: 'contact', at: 'https://shop.example/stores/andorra/' }, 'noindex');
    const { finding } = failure(blockedOrNonindexableCarrier, { html: doc(`${noindex}${ld(store, lamp)}`), pageType: 'product', at: 'https://shop.example/lamp' }, 'noindex');
    assert.equal(finding.params?.items, 'Product');
  });
});
