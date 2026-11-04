import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EvidenceStore } from '../../src/core/evidence.ts';
import type { Finding, RuleImplementation } from '../../src/rules/engine.ts';
import {
  gs1CheckDigitValid, gtinValidity, merchantListing, offerPriceSpecification, productSnippet, productVariants, reviewAuthenticity, reviewSnippet,
  selfServingReviews, serviceOfferCatalog, shippingDetails, softwareApp,
} from '../../src/rules/schema/commerce.ts';
import type { PageType } from '../../src/core/types.ts';
import { evaluate, outcomeOn, page, site, type PageSpec } from '../support/facts.ts';

const url = 'https://shop.example/catalog/lamp';
const ctx = 'https://schema.org';
const ld = (...items: unknown[]) => items.map(item => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join('\n');
const doc = (head: string, body = '<p>Lamp 19,90 €</p>') => `<!doctype html><html lang="en"><head><title>Lamp</title>${head}</head><body>${body}</body></html>`;

function check(rule: RuleImplementation, spec: PageSpec): { all: Finding[]; evidence: EvidenceStore } {
  const { findings, evidence } = evaluate(rule, site({ pages: [page(url, spec)] }));
  return { all: findings.filter(entry => entry.scope.kind === 'page'), evidence };
}

function failure(rule: RuleImplementation, spec: PageSpec, reason: string): { finding: Finding; excerpts: string[] } {
  const { all, evidence } = check(rule, spec);
  const finding = all.find(entry => entry.outcome === 'fail' && entry.reason === reason);
  assert.ok(finding, `expected a ${reason} failure, got ${JSON.stringify(all.map(entry => [entry.outcome, entry.reason, entry.params]))}`);
  return { finding, excerpts: finding.evidence.map(id => evidence.get(id)?.excerpt ?? '') };
}

function passes(rule: RuleImplementation, spec: PageSpec): void {
  const { all } = check(rule, spec);
  assert.deepEqual(all.map(entry => [entry.outcome, entry.reason]), [['pass', undefined]]);
}

function outcome(rule: RuleImplementation, spec: PageSpec): [string, string | undefined] {
  const { findings } = evaluate(rule, site({ pages: [page(url, spec)] }));
  const finding = outcomeOn(findings, url)!;
  return [finding.outcome, finding.reason];
}

const productPage = (item: unknown, pageType: PageType = 'product'): PageSpec => ({ html: doc(ld(item)), pageType });
const offer = { '@type': 'Offer', price: '19.90', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' };
const lamp = { '@context': ctx, '@type': 'Product', name: 'Lamp', image: 'https://shop.example/lamp.jpg', brand: { '@type': 'Brand', name: 'Lumo' }, offers: offer };

describe('schema-product-snippet', () => {
  test('passes a product with a priced offer', () => passes(productSnippet, productPage(lamp)));
  test('fails a price with currency symbol and thousands separator', () => {
    const { finding, excerpts } = failure(productSnippet, productPage({ ...lamp, offers: { ...offer, price: '1.299,00 €' } }), 'malformed-price');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], '1.299,00 €');
  });
  test('fails a product with none of offers, review or rating', () => {
    assert.equal(failure(productSnippet, productPage({ '@context': ctx, '@type': 'Product', name: 'Lamp' }), 'missing-offer-or-review').finding.severity, 'high');
  });
  test('does not check the ProductGroup itself, only its variants', () => {
    passes(productSnippet, productPage({ '@context': ctx, '@type': 'ProductGroup', name: 'Lamp', hasVariant: [{ '@type': 'Product', name: 'Lamp red', offers: offer }] }));
  });
  test('is not applicable without products and outside product pages', () => {
    assert.deepEqual(outcome(productSnippet, productPage({ '@context': ctx, '@type': 'Thing', name: 'x' })), ['not_applicable', 'no-product']);
    assert.deepEqual(outcome(productSnippet, productPage(lamp, 'article')), ['not_applicable', 'page-type:article']);
  });
});

describe('schema-merchant-listing', () => {
  test('passes a complete offer', () => passes(merchantListing, productPage(lamp)));
  test('fails a price of zero at high severity', () => {
    const { finding, excerpts } = failure(merchantListing, productPage({ ...lamp, offers: { ...offer, price: 0 } }), 'price-not-positive');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], '0');
  });
  test('reports missing identifiers as medium and missing image as high', () => {
    const { brand: _brand, ...noBrand } = lamp;
    assert.equal(failure(merchantListing, productPage(noBrand), 'missing-identifiers').finding.severity, 'medium');
    const { image: _image, ...noImage } = lamp;
    assert.equal(failure(merchantListing, productPage(noImage), 'missing-image').finding.severity, 'high');
  });
  test('is not applicable to products shown without an offer', () => {
    assert.deepEqual(outcome(merchantListing, productPage({ '@context': ctx, '@type': 'Product', name: 'Lamp', review: { '@type': 'Review' } })), ['not_applicable', 'no-offer']);
  });
});

describe('schema-gtin-validity', () => {
  test('validates GS1 check digits', () => {
    assert.equal(gs1CheckDigitValid('4006381333931'), true);
    assert.equal(gs1CheckDigitValid('4006381333932'), false);
  });
  test('passes valid GTINs and the same GTIN in variants of distinct products', () => passes(gtinValidity, productPage({ ...lamp, gtin13: '4006381333931' })));
  test('fails a wrong check digit at medium severity', () => {
    const { finding, excerpts } = failure(gtinValidity, productPage({ ...lamp, gtin13: '4006381333932' }), 'check-digit');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], '4006381333932');
  });
  test('fails a URL form, a wrong length and a zero-filled value', () => {
    failure(gtinValidity, productPage({ ...lamp, gtin: 'https://id.gs1.org/01/04006381333931' }), 'not-numeric');
    failure(gtinValidity, productPage({ ...lamp, gtin12: '4006381333931' }), 'wrong-length');
    failure(gtinValidity, productPage({ ...lamp, gtin13: '0000000000000' }), 'repeated-digits');
  });
  test('is not applicable without GTINs', () => {
    assert.deepEqual(outcome(gtinValidity, productPage(lamp)), ['not_applicable', 'no-gtin']);
  });
});

describe('schema-product-variants', () => {
  const group = { '@context': ctx, '@type': 'ProductGroup', name: 'Lamp', productGroupID: 'L1', variesBy: ['https://schema.org/color'],
    hasVariant: [{ '@type': 'Product', name: 'Lamp red', sku: 'L1-R', inProductGroupWithID: 'L1', offers: offer },
      { '@type': 'Product', name: 'Lamp blue', sku: 'L1-B', inProductGroupWithID: 'L1', offers: offer }] };
  test('passes a consistent group', () => passes(productVariants, productPage(group)));
  test('fails mismatched group IDs and unsupported variesBy', () => {
    const broken = { ...group, variesBy: ['https://schema.org/flavor'], hasVariant: [{ ...group.hasVariant[0], inProductGroupWithID: 'L2' }, group.hasVariant[1]] };
    const mismatch = failure(productVariants, productPage(broken), 'group-id-mismatch');
    assert.equal(mismatch.finding.severity, 'medium');
    assert.equal(mismatch.excerpts[0], 'L2');
    assert.equal(failure(productVariants, productPage(broken), 'invalid-varies-by').excerpts[0], 'https://schema.org/flavor');
  });
  test('fails variants sharing a SKU', () => {
    const twins = { ...group, hasVariant: [group.hasVariant[0], { ...group.hasVariant[1], sku: 'L1-R' }] };
    assert.equal(failure(productVariants, productPage(twins), 'duplicate-variant-id').finding.params?.items, 'sku:L1-R');
  });
  test('is not applicable to single products', () => {
    assert.deepEqual(outcome(productVariants, productPage(lamp)), ['not_applicable', 'no-product-group']);
  });
});

describe('schema-offer-price-specification', () => {
  const sale = { ...offer, price: '15.00', priceSpecification: { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: '19.90', priceCurrency: 'EUR' } };
  test('passes a sale price under a strikethrough price', () => passes(offerPriceSpecification, productPage({ ...lamp, offers: sale })));
  test('fails an active price that is not lower than the strikethrough price', () => {
    const { finding, excerpts } = failure(offerPriceSpecification, productPage({ ...lamp, offers: { ...sale, price: '25.00' } }), 'not-discounted');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], '25');
  });
  test('fails an unsupported price type and a member tier combined with a price type', () => {
    const spec = { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/SalePrice', price: '19.90', validForMemberTier: { '@id': '#gold' } };
    failure(offerPriceSpecification, productPage({ ...lamp, offers: { ...offer, priceSpecification: spec } }), 'unsupported-price-type');
    failure(offerPriceSpecification, productPage({ ...lamp, offers: { ...offer, priceSpecification: spec } }), 'member-tier-with-price-type');
  });
  test('is not applicable without price specifications', () => {
    assert.deepEqual(outcome(offerPriceSpecification, productPage(lamp)), ['not_applicable', 'no-price-specification']);
  });
});

describe('schema-shipping-details', () => {
  const shipping = { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: 4.95, currency: 'EUR' },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'ES' },
    deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1, unitCode: 'DAY' },
      transitTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 3, unitCode: 'DAY' } } };
  test('passes complete offer shipping details', () => passes(shippingDetails, productPage({ ...lamp, offers: { ...offer, shippingDetails: shipping } })));
  test('fails a shipping currency that differs from the offer', () => {
    const { finding, excerpts } = failure(shippingDetails, productPage({ ...lamp, offers: { ...offer, shippingDetails: { ...shipping, shippingRate: { '@type': 'MonetaryAmount', value: 5, currency: 'USD' } } } }), 'currency-mismatch');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], 'USD');
  });
  test('fails missing destination and both region and postal code', () => {
    const { shippingDestination: _destination, ...noDestination } = shipping;
    failure(shippingDetails, productPage({ ...lamp, offers: { ...offer, shippingDetails: noDestination } }), 'missing-destination');
    const both = { ...shipping, shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US', addressRegion: 'CA', postalCode: '94043' } };
    failure(shippingDetails, productPage({ ...lamp, offers: { ...offer, shippingDetails: both } }), 'region-and-postal-code');
  });
  test('is not applicable without shipping markup', () => {
    assert.deepEqual(outcome(shippingDetails, productPage(lamp)), ['not_applicable', 'no-shipping-markup']);
  });
});

describe('schema-review-snippet', () => {
  const rated = { ...lamp, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', reviewCount: '12' },
    review: { '@type': 'Review', author: { '@type': 'Person', name: 'Ana' }, reviewRating: { '@type': 'Rating', ratingValue: 5 } } };
  test('passes nested review and rating on a product, with percentages tolerated', () => {
    passes(reviewSnippet, productPage(rated));
    passes(reviewSnippet, productPage({ ...lamp, aggregateRating: { '@type': 'AggregateRating', ratingValue: '90%', ratingCount: 3 } }));
  });
  test('fails a rating above the scale at high severity', () => {
    const { finding, excerpts } = failure(reviewSnippet, productPage({ ...lamp, aggregateRating: { '@type': 'AggregateRating', ratingValue: 6, reviewCount: 3 } }), 'out-of-bounds');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], 'ratingValue 6, worstRating 1, bestRating 5');
  });
  test('fails a review without author and a top-level rating without item', () => {
    failure(reviewSnippet, productPage({ ...lamp, review: { '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: 4 } } }), 'missing-author');
    failure(reviewSnippet, productPage({ '@context': ctx, '@type': 'AggregateRating', ratingValue: 4, ratingCount: 3 }), 'missing-item-reviewed');
  });
  test('fails a rating about an unsupported type', () => {
    const page = { '@context': ctx, '@type': 'WebPage', name: 'Home', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4, ratingCount: 3 } };
    assert.equal(failure(reviewSnippet, productPage(page, 'other'), 'unsupported-item-type').finding.params?.items, 'WebPage');
  });
  test('is not applicable without reviews', () => {
    assert.deepEqual(outcome(reviewSnippet, productPage(lamp)), ['not_applicable', 'no-reviews']);
  });
});

describe('schema-self-serving-reviews', () => {
  const own = { '@context': ctx, '@type': 'LocalBusiness', name: 'Acme', url: 'https://shop.example/', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.9, reviewCount: 80 } };
  test('passes reviews of products the business sells', () => passes(selfServingReviews, productPage({ ...lamp, aggregateRating: { '@type': 'AggregateRating', ratingValue: 4, reviewCount: 3 } })));
  test('reports ratings of the site owner as low', () => {
    const { finding, excerpts } = failure(selfServingReviews, productPage(own, 'home'), 'self-serving');
    assert.equal(finding.severity, 'low');
    assert.match(excerpts[0]!, /"ratingValue":4.9/u);
  });
  test('passes a review site rating another business', () => {
    passes(selfServingReviews, productPage({ ...own, url: 'https://another-business.example/' }, 'other'));
  });
  test('is not applicable without reviews', () => {
    assert.deepEqual(outcome(selfServingReviews, productPage(lamp)), ['not_applicable', 'no-reviews']);
  });
});

describe('schema-review-authenticity', () => {
  const review = (author: string, body: string, rating: number) => ({ '@type': 'Review', author: { '@type': 'Person', name: author }, reviewBody: body,
    reviewRating: { '@type': 'Rating', ratingValue: rating } });
  test('passes distinct reviews by named authors', () => {
    passes(reviewAuthenticity, productPage({ ...lamp, review: [review('Ana', 'Warm light and solid build.', 5), review('Joan', 'Shade arrived dented, quickly replaced.', 4)] }));
  });
  test('hands repeated review text to the analyst', () => {
    const text = 'Great product, would buy again from this shop.';
    const { finding, excerpts } = failure(reviewAuthenticity, productPage({ ...lamp, review: [review('Ana', text, 5), review('Joan', text, 5)] }), 'duplicate-text');
    assert.deepEqual([finding.severity, finding.needsJudgment], ['medium', true]);
    assert.equal(excerpts[0], text);
  });
  test('hands placeholder authors to the analyst', () => {
    assert.equal(failure(reviewAuthenticity, productPage({ ...lamp, review: [review('Admin', 'Five stars for this lamp.', 5)] }), 'placeholder-author').finding.needsJudgment, true);
  });
  test('is not applicable without reviews', () => {
    assert.deepEqual(outcome(reviewAuthenticity, productPage(lamp)), ['not_applicable', 'no-reviews']);
  });
});

describe('schema-software-app', () => {
  const app = { '@context': ctx, '@type': 'MobileApplication', name: 'Tally', offers: { '@type': 'Offer', price: 0 },
    aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.2, ratingCount: 120 } };
  test('passes a free app with ratings', () => passes(softwareApp, productPage(app)));
  test('fails an app without ratings at medium severity', () => {
    const { aggregateRating: _rating, ...noRating } = app;
    const { finding, excerpts } = failure(softwareApp, productPage(noRating), 'missing-rating');
    assert.equal(finding.severity, 'medium');
    assert.match(excerpts[0]!, /MobileApplication/u);
  });
  test('fails a VideoGame that is not co-typed', () => {
    failure(softwareApp, productPage({ ...app, '@type': 'VideoGame' }), 'video-game-not-co-typed');
    passes(softwareApp, productPage({ ...app, '@type': ['VideoGame', 'MobileApplication'] }));
  });
  test('is not applicable without software applications', () => {
    assert.deepEqual(outcome(softwareApp, productPage(lamp)), ['not_applicable', 'no-software-application']);
  });
});

describe('schema-service-offercatalog', () => {
  const service = { '@context': ctx, '@type': 'Service', name: 'Audit', provider: { '@type': 'Organization', name: 'Acme', url: 'https://shop.example/' } };
  test('passes Service markup without ratings', () => passes(serviceOfferCatalog, productPage(service, 'service')));
  test('reports ratings on the site own service as low', () => {
    const { finding, excerpts } = failure(serviceOfferCatalog, productPage({ ...service, aggregateRating: { '@type': 'AggregateRating', ratingValue: 5, ratingCount: 9 } }, 'service'), 'self-serving-rating');
    assert.equal(finding.severity, 'low');
    assert.equal(excerpts[0], '{"@type":"AggregateRating","ratingValue":5,"ratingCount":9}');
  });
  test('is not applicable without Service markup', () => {
    assert.deepEqual(outcome(serviceOfferCatalog, productPage(lamp)), ['not_applicable', 'no-service']);
  });
});
