import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EvidenceStore } from '../../src/core/evidence.ts';
import type { Finding, RuleImplementation } from '../../src/rules/engine.ts';
import { jsOnlyMarkup, rawRenderedConflict } from '../../src/rules/schema/rendering.ts';
import { duplicateFeatureNodes, idDanglingOrConflicting } from '../../src/rules/schema/identity.ts';
import { extractInventory, jsonLdContext, jsonLdSyntaxError, microdataRdfaStructure } from '../../src/rules/schema/syntax.ts';
import { dateLogic, iso8601Values, placeholderJunkValues, urlValues } from '../../src/rules/schema/values.ts';
import { domainRangeMismatch, enumerationValues, supersededPendingTerm, unknownProperty, unknownType } from '../../src/rules/schema/vocabulary-rules.ts';
import { evaluate, outcomeOn, page, site, type PageSpec } from '../support/facts.ts';

const url = 'https://shop.example/catalog/item';
const ctx = 'https://schema.org';
const ld = (...items: unknown[]) => items.map(item => `<script type="application/ld+json">${typeof item === 'string' ? item : JSON.stringify(item)}</script>`).join('\n');
const doc = (head: string, body = '<p>Content</p>') => `<!doctype html><html lang="en"><head><title>Item</title>${head}</head><body>${body}</body></html>`;

function check(rule: RuleImplementation, spec: PageSpec): { all: Finding[]; finding: Finding; evidence: EvidenceStore } {
  const { findings, evidence } = evaluate(rule, site({ pages: [page(url, spec)] }));
  return { all: findings.filter(entry => entry.scope.kind === 'page'), finding: outcomeOn(findings, url)!, evidence };
}

function failure(rule: RuleImplementation, spec: PageSpec, reason?: string): { finding: Finding; excerpts: string[] } {
  const { all, evidence } = check(rule, spec);
  const finding = all.find(entry => entry.outcome === 'fail' && (reason === undefined || entry.reason === reason));
  assert.ok(finding, `expected a ${reason ?? ''} failure, got ${JSON.stringify(all.map(entry => [entry.outcome, entry.reason]))}`);
  return { finding, excerpts: finding.evidence.map(id => evidence.get(id)?.excerpt ?? '') };
}

function passes(rule: RuleImplementation, spec: PageSpec): void {
  const { all } = check(rule, spec);
  assert.deepEqual(all.map(entry => [entry.outcome, entry.reason]), [['pass', undefined]]);
}

function outcome(rule: RuleImplementation, spec: PageSpec): [string, string | undefined] {
  const { finding } = check(rule, spec);
  return [finding.outcome, finding.reason];
}

const product = { '@context': ctx, '@type': 'Product', name: 'Lamp', image: 'https://shop.example/lamp.jpg',
  offers: { '@type': 'Offer', price: '19.90', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } };

describe('schema-extract-inventory', () => {
  test('lists raw and rendered-only items', () => {
    const { finding, evidence } = check(extractInventory, { html: doc(ld(product)), rendered: doc(ld(product, { '@context': ctx, '@type': 'BreadcrumbList', itemListElement: [] })) });
    assert.equal(finding.outcome, 'pass');
    const labels = finding.evidence.map(id => evidence.get(id)!.label);
    assert.ok(labels.some(label => label.startsWith('json-ld item Product, raw')));
    assert.ok(labels.some(label => label.includes('BreadcrumbList, rendered only')));
  });
  test('is not applicable without structured data', () => {
    assert.deepEqual(outcome(extractInventory, { html: doc('') }), ['not_applicable', 'no-structured-data']);
  });
  test('needs the raw HTML', () => {
    assert.deepEqual(outcome(extractInventory, {}), ['not_evaluated', 'missing-input:raw-html']);
  });
});

describe('schema-jsonld-syntax-error', () => {
  test('passes valid JSON-LD', () => passes(jsonLdSyntaxError, { html: doc(ld(product)) }));
  test('fails a block with a trailing comma, citing the block', () => {
    const broken = '{"@context":"https://schema.org","@type":"Product","name":"Lamp",}';
    const { finding, excerpts } = failure(jsonLdSyntaxError, { html: doc(ld(broken)) });
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], broken);
    assert.match(String(finding.params?.error), /JSON/u);
  });
  test('is not applicable without JSON-LD', () => {
    assert.deepEqual(outcome(jsonLdSyntaxError, { html: doc('') }), ['not_applicable', 'no-jsonld']);
  });
});

describe('schema-jsonld-context', () => {
  test('passes http and https schema.org contexts, with or without slash, and @vocab', () => {
    passes(jsonLdContext, { html: doc(ld({ ...product, '@context': 'http://schema.org/' }, { '@context': { '@vocab': 'https://schema.org/' }, '@type': 'Thing', name: 'x' })) });
  });
  test('fails a context without scheme', () => {
    const { finding, excerpts } = failure(jsonLdContext, { html: doc(ld({ ...product, '@context': 'schema.org' })) }, 'not-schema-org');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], '"schema.org"');
  });
  test('fails an item without context', () => {
    const { finding } = failure(jsonLdContext, { html: doc(ld({ '@type': 'Organization', name: 'Acme' })) }, 'missing-context');
    assert.equal(finding.params?.items, 'Organization');
  });
  test('accepts a context declared once on the @graph wrapper', () => {
    passes(jsonLdContext, { html: doc(ld({ '@context': ctx, '@graph': [{ '@type': 'Organization', name: 'Acme' }, { '@type': 'WebSite', name: 'Acme' }] })) });
  });
  test('is not applicable without JSON-LD', () => {
    assert.deepEqual(outcome(jsonLdContext, { html: doc('<div itemscope itemtype="https://schema.org/Thing"></div>') }), ['not_applicable', 'no-jsonld']);
  });
});

describe('schema-microdata-rdfa-structure', () => {
  test('passes well-formed microdata', () => {
    passes(microdataRdfaStructure, { html: doc('', '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Lamp</span></div>') });
  });
  test('fails an itemprop outside any item at low severity', () => {
    const { finding, excerpts } = failure(microdataRdfaStructure, { html: doc('', '<article><h1 itemprop="headline">News</h1></article>') }, 'orphan-itemprop');
    assert.equal(finding.severity, 'low');
    assert.equal(excerpts[0], '<h1 itemprop="headline">');
  });
  test('fails a relative itemtype naming a feature type at medium severity', () => {
    const { finding, excerpts } = failure(microdataRdfaStructure, { html: doc('', '<div itemscope itemtype="Product"><span itemprop="name">Lamp</span></div>') }, 'invalid-itemtype');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], '<div itemscope itemtype="Product">');
  });
  test('accepts properties reached through itemref and prefixed RDFa types', () => {
    passes(microdataRdfaStructure, { html: doc('', '<div itemscope itemtype="https://schema.org/Product" itemref="extra"></div><p id="extra" itemprop="name">Lamp</p><div typeof="schema:Thing"></div>') });
  });
  test('is not applicable without microdata or RDFa', () => {
    assert.deepEqual(outcome(microdataRdfaStructure, { html: doc(ld(product)) }), ['not_applicable', 'no-microdata-or-rdfa']);
  });
});

describe('schema-unknown-type', () => {
  test('passes defined types, including combined types', () => {
    passes(unknownType, { html: doc(ld({ '@context': ctx, '@type': ['Book', 'Product'], name: 'Novel' })) });
  });
  test('fails a misspelled feature type at high severity with a suggestion', () => {
    const { finding, excerpts } = failure(unknownType, { html: doc(ld({ '@context': ctx, '@type': 'Localbusiness', name: 'Shop' })) });
    assert.equal(finding.severity, 'high');
    assert.equal(finding.params?.items, 'Localbusiness (LocalBusiness?)');
    assert.equal(excerpts[0], 'Localbusiness');
  });
  test('fails an invented type at medium severity', () => {
    assert.equal(failure(unknownType, { html: doc(ld({ '@context': ctx, '@type': 'Zorblax', name: 'x' })) }).finding.severity, 'medium');
  });
  test('ignores types of another vocabulary', () => {
    passes(unknownType, { html: doc(ld({ '@context': ctx, '@type': ['Product', 'https://example.org/vocab/Gadget'], name: 'x' })) });
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(unknownType, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-unknown-property', () => {
  test('passes defined properties and context-defined custom terms', () => {
    passes(unknownProperty, { html: doc(ld({ '@context': [ctx, { custom: 'https://example.org/custom' }], '@type': 'Product', name: 'x', custom: 'y' })) });
  });
  test('fails a misspelled required property at medium severity', () => {
    const { finding, excerpts } = failure(unknownProperty, { html: doc(ld({ '@context': ctx, '@type': 'Event', name: 'Gig', startdate: '2026-12-01' })) });
    assert.equal(finding.severity, 'medium');
    assert.equal(finding.params?.items, 'startdate (startDate?)');
    assert.equal(excerpts[0], 'startdate');
  });
  test('fails other undefined properties at low severity', () => {
    assert.equal(failure(unknownProperty, { html: doc(ld({ '@context': ctx, '@type': 'Organization', name: 'Acme', logoUrl: 'https://shop.example/l.png' })) }).finding.severity, 'low');
  });
  test('accepts the -input and -output annotations of Action properties, and only those', () => {
    const search = (annotation: string) => ({ '@context': ctx, '@type': 'WebSite', name: 'Shop', url: 'https://shop.example/',
      potentialAction: { '@type': 'SearchAction', target: 'https://shop.example/search?q={term}', [annotation]: 'required name=term' } });
    passes(unknownProperty, { html: doc(ld(search('query-input'))) });
    assert.equal(failure(unknownProperty, { html: doc(ld(search('quary-input'))) }).finding.params?.items, 'quary-input');
    assert.equal(failure(unknownProperty, { html: doc(ld({ '@context': ctx, '@type': 'Product', name: 'x', 'name-input': 'required' })) }).finding.params?.items, 'name-input');
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(unknownProperty, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-domain-range-mismatch', () => {
  test('passes properties used within their domain and range', () => passes(domainRangeMismatch, { html: doc(ld(product)) }));
  test('reports a property outside its domain at low severity', () => {
    const { finding, excerpts } = failure(domainRangeMismatch, { html: doc(ld({ '@context': ctx, '@type': 'Person', name: 'Ana', price: '10' })) }, 'domain');
    assert.equal(finding.severity, 'low');
    assert.equal(excerpts[0], '10');
  });
  test('reports a typed value outside the range at low severity', () => {
    const { finding } = failure(domainRangeMismatch, { html: doc(ld({ '@context': ctx, '@type': 'Product', name: 'x', offers: { '@type': 'Person', name: 'Ana' } })) }, 'range');
    assert.equal(finding.params?.items, 'offers: Person');
  });
  test('accepts text where an entity is expected', () => {
    passes(domainRangeMismatch, { html: doc(ld({ '@context': ctx, '@type': 'Article', headline: 'x', author: 'Ana Pons' })) });
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(domainRangeMismatch, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-superseded-pending-term', () => {
  test('passes current terms', () => passes(supersededPendingTerm, { html: doc(ld(product)) }));
  test('reports a superseded property at low severity with its replacement', () => {
    const { finding, excerpts } = failure(supersededPendingTerm, { html: doc(ld({ '@context': ctx, '@type': 'WriteAction', language: 'en' })) }, 'superseded');
    assert.equal(finding.severity, 'low');
    assert.equal(finding.params?.items, 'language -> inLanguage');
    assert.equal(excerpts[0], 'language');
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(supersededPendingTerm, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-enumeration-values', () => {
  test('accepts members written as URL, http URL or bare name', () => {
    passes(enumerationValues, { html: doc(ld({ '@context': ctx, '@type': 'Product', name: 'x', offers: [
      { '@type': 'Offer', price: 1, availability: 'http://schema.org/InStock', itemCondition: 'NewCondition' },
      { '@type': 'Offer', price: 1, availability: 'https://schema.org/PreOrder' }] })) });
  });
  test('fails a localized availability at high severity', () => {
    const { finding, excerpts } = failure(enumerationValues, { html: doc(ld({ ...product, offers: { '@type': 'Offer', price: 1, availability: 'En stock' } })) }, 'not-a-member');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], 'En stock');
  });
  test('fails several availability values on one offer', () => {
    const { finding } = failure(enumerationValues, { html: doc(ld({ ...product, offers: { '@type': 'Offer', price: 1, availability: ['InStock', 'OutOfStock'] } })) }, 'multiple-values');
    assert.equal(finding.severity, 'high');
  });
  test('checks employmentType against Google values', () => {
    const job = { '@context': ctx, '@type': 'JobPosting', title: 'Cook', employmentType: ['FULL_TIME', 'Jornada completa'] };
    assert.equal(failure(enumerationValues, { html: doc(ld(job)) }, 'not-a-member').finding.params?.items, 'employmentType: Jornada completa');
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(enumerationValues, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-url-values', () => {
  test('passes absolute https URLs and fragment identifiers', () => {
    passes(urlValues, { html: doc(ld({ '@context': ctx, '@type': 'Organization', '@id': '#organization', name: 'Acme', url: 'https://shop.example/', logo: 'https://shop.example/logo.png',
      sameAs: ['https://social.example/acme'] })) });
  });
  test('fails a staging host at medium severity', () => {
    const { finding, excerpts } = failure(urlValues, { html: doc(ld({ ...product, image: 'https://staging.shop.example/lamp.jpg' })) }, 'staging-host');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], 'https://staging.shop.example/lamp.jpg');
  });
  test('reports relative URLs as low, since they still resolve', () => {
    const { finding } = failure(urlValues, { html: doc(ld({ ...product, image: '/lamp.jpg' })) }, 'relative');
    assert.equal(finding.severity, 'low');
  });
  test('accepts relative hrefs in Microdata, which resolve to absolute URLs', () => {
    passes(urlValues, { html: doc('', '<div itemscope itemtype="https://schema.org/Product"><a itemprop="url" href="/catalog/item">Lamp</a><img itemprop="image" src="lamp.jpg" alt=""></div>') });
  });
  test('fails http URLs on an https site for same-site URLs only', () => {
    assert.equal(failure(urlValues, { html: doc(ld({ ...product, url: 'http://shop.example/catalog/item' })) }, 'insecure').finding.severity, 'medium');
    passes(urlValues, { html: doc(ld({ '@context': ctx, '@type': 'Organization', name: 'Acme', sameAs: ['http://old-directory.example/acme'] })) });
  });
  test('does not flag Organization or WebSite url pointing to a root that redirects by locale', () => {
    passes(urlValues, { html: doc(ld({ '@context': ctx, '@type': 'WebSite', name: 'Acme', url: 'https://shop.example/' }, { '@context': ctx, '@type': 'Organization', name: 'Acme', url: 'https://shop.example/' })),
      redirects: [[302, '/en/']] });
  });
  test('fails a WebPage url that differs from the canonical', () => {
    const html = doc(`<link rel="canonical" href="${url}">${ld({ '@context': ctx, '@type': 'WebPage', url: 'https://shop.example/other' })}`);
    assert.equal(failure(urlValues, { html }, 'not-canonical').finding.severity, 'medium');
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(urlValues, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-iso8601-values', () => {
  test('passes dates, offsets, durations and opening times', () => {
    passes(iso8601Values, { html: doc(ld({ '@context': ctx, '@type': 'Recipe', name: 'Soup', datePublished: '2026-11-03T09:00:00+01:00', prepTime: 'PT15M', cookTime: 'PT1H30M' },
      { '@context': ctx, '@type': 'LocalBusiness', name: 'Shop', foundingDate: '2001', openingHoursSpecification: { '@type': 'OpeningHoursSpecification', opens: '09:00', closes: '18:30:00' } })) });
  });
  test('fails a localized required date at medium severity', () => {
    const { finding, excerpts } = failure(iso8601Values, { html: doc(ld({ '@context': ctx, '@type': 'Event', name: 'Gig', startDate: '3 de noviembre de 2026' })) }, 'invalid-date');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], '3 de noviembre de 2026');
  });
  test('fails a duration without unit', () => {
    assert.equal(failure(iso8601Values, { html: doc(ld({ '@context': ctx, '@type': 'Recipe', name: 'Soup', image: 'x', totalTime: 'PT90' })) }, 'invalid-duration').finding.params?.items, 'totalTime: PT90');
  });
  test('reports a date-time without offset as low', () => {
    assert.equal(failure(iso8601Values, { html: doc(ld({ '@context': ctx, '@type': 'VideoObject', name: 'v', uploadDate: '2026-11-03T09:00:00' })) }, 'missing-offset').finding.severity, 'low');
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(iso8601Values, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-date-logic', () => {
  const fetched = { date: 'Wed, 04 Nov 2026 08:00:00 GMT' };
  test('passes consistent dates, including mixed precision on the same day', () => {
    passes(dateLogic, { headers: fetched, html: doc(ld({ '@context': ctx, '@type': 'Article', headline: 'x', datePublished: '2026-11-03T10:00:00+01:00', dateModified: '2026-11-03' })) });
  });
  test('fails a modification before publication', () => {
    const { finding, excerpts } = failure(dateLogic, { headers: fetched, html: doc(ld({ '@context': ctx, '@type': 'Article', headline: 'x', datePublished: '2026-10-10', dateModified: '2026-10-01' })) }, 'modified-before-published');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], '2026-10-01');
  });
  test('fails a past priceValidUntil using the HTTP Date header as the clock', () => {
    const html = doc(ld({ ...product, offers: { ...product.offers, priceValidUntil: '2026-01-31' } }));
    assert.equal(failure(dateLogic, { headers: fetched, html }, 'price-valid-until-past').finding.params?.items, 'priceValidUntil: 2026-01-31');
    passes(dateLogic, { html });
  });
  test('is not applicable without dates', () => {
    assert.deepEqual(outcome(dateLogic, { html: doc(ld(product)) }), ['not_applicable', 'no-dates']);
  });
});

describe('schema-placeholder-junk-values', () => {
  test('passes real values', () => passes(placeholderJunkValues, { html: doc(ld(product)) }));
  test('fails an unrendered template token at high severity', () => {
    const { finding, excerpts } = failure(placeholderJunkValues, { html: doc(ld({ ...product, name: '{{ product.title }}' })) }, 'template-token');
    assert.equal(finding.severity, 'high');
    assert.equal(excerpts[0], '{{ product.title }}');
  });
  test('fails an example domain and an empty value', () => {
    assert.equal(failure(placeholderJunkValues, { html: doc(ld({ ...product, image: 'https://www.example.com/image.jpg' })) }, 'example-domain').finding.severity, 'high');
    assert.equal(failure(placeholderJunkValues, { html: doc(ld({ ...product, description: '' })) }, 'empty-value').finding.severity, 'medium');
  });
  test('accepts HTML in a job description and a SearchAction target template', () => {
    passes(placeholderJunkValues, { html: doc(ld({ '@context': ctx, '@type': 'JobPosting', title: 'Cook', description: '<p>Kitchen work</p><ul><li>Shifts</li></ul>' },
      { '@context': ctx, '@type': 'WebSite', name: 'Acme', potentialAction: { '@type': 'SearchAction', target: 'https://shop.example/search?q={search_term_string}', 'query-input': 'required name=search_term_string' } })) });
  });
  test('treats copy about AI, agents and prompts as ordinary text', () => {
    passes(placeholderJunkValues, { html: doc(ld({ '@context': ctx, '@type': 'Article', headline: 'Writing prompts for Claude and Codex agents',
      description: 'Ignore previous instructions is a phrase our guide discusses as an example of prompt injection.' })) });
  });
  test('is not applicable without schema.org markup', () => {
    assert.deepEqual(outcome(placeholderJunkValues, { html: doc('') }), ['not_applicable', 'no-schema-org-markup']);
  });
});

describe('schema-js-only-markup', () => {
  test('passes markup present in both versions', () => passes(jsOnlyMarkup, { html: doc(ld(product)), rendered: doc(ld(product)) }));
  test('fails a Product injected by JavaScript at medium severity', () => {
    const { finding, excerpts } = failure(jsOnlyMarkup, { html: doc(''), rendered: doc(ld(product)) }, 'product-rendered-only');
    assert.equal(finding.severity, 'medium');
    assert.match(excerpts[0]!, /"@type":"Product"/u);
  });
  test('reports other injected types as low', () => {
    assert.equal(failure(jsOnlyMarkup, { html: doc(''), rendered: doc(ld({ '@context': ctx, '@type': 'Organization', name: 'Acme' })) }).finding.severity, 'low');
  });
  test('needs the rendered DOM', () => {
    assert.deepEqual(outcome(jsOnlyMarkup, { html: doc(ld(product)) }), ['not_evaluated', 'missing-input:rendered-dom']);
  });
});

describe('schema-raw-rendered-conflict', () => {
  test('passes equal values written differently', () => {
    passes(rawRenderedConflict, { html: doc(ld(product)), rendered: doc(ld({ ...product, offers: { ...product.offers, price: 19.9, availability: 'InStock' } })) });
  });
  test('fails a price that changes after rendering, citing both versions', () => {
    const { finding, excerpts } = failure(rawRenderedConflict, { html: doc(ld(product)), rendered: doc(ld({ ...product, offers: { ...product.offers, price: '24.90' } })) });
    assert.equal(finding.severity, 'medium');
    assert.deepEqual(excerpts, ['offers.price: 24.90', 'offers.price: 19.90']);
  });
  test('is not applicable when only one version has markup', () => {
    assert.deepEqual(outcome(rawRenderedConflict, { html: doc(''), rendered: doc(ld(product)) }), ['not_applicable', 'markup-in-one-version-only']);
  });
});

describe('schema-id-dangling-or-conflicting', () => {
  test('passes references defined on the page and on other pages', () => {
    passes(idDanglingOrConflicting, { html: doc(ld({ '@context': ctx, '@graph': [
      { '@type': 'Organization', '@id': '#org', name: 'Acme' },
      { '@type': 'WebPage', '@id': `${url}#webpage`, publisher: { '@id': '#org' }, isPartOf: { '@id': 'https://shop.example/#website' } }] })) });
  });
  test('fails one @id defined with unrelated types at medium severity', () => {
    const { finding, excerpts } = failure(idDanglingOrConflicting, { html: doc(ld({ '@context': ctx, '@type': 'Organization', '@id': '#who', name: 'Acme' }, { '@context': ctx, '@type': 'Person', '@id': '#who', name: 'Acme' })) }, 'conflicting-types');
    assert.equal(finding.severity, 'medium');
    assert.deepEqual(excerpts, ['#who: Organization', '#who: Person']);
  });
  test('reports a dangling fragment reference as low', () => {
    const { finding, excerpts } = failure(idDanglingOrConflicting, { html: doc(ld({ '@context': ctx, '@type': 'Article', headline: 'x', author: { '@id': '#author' } })) }, 'dangling-reference');
    assert.equal(finding.severity, 'low');
    assert.equal(excerpts[0], '#author');
  });
  test('accepts partial definitions of one @id that agree', () => {
    passes(idDanglingOrConflicting, { html: doc(ld({ '@context': ctx, '@type': 'Organization', '@id': '#org', name: 'Acme' }, { '@context': ctx, '@type': 'LocalBusiness', '@id': '#org', telephone: '+376 000 001' })) });
  });
  test('is not applicable without identifiers', () => {
    assert.deepEqual(outcome(idDanglingOrConflicting, { html: doc(ld(product)) }), ['not_applicable', 'no-ids']);
  });
});

describe('schema-duplicate-feature-nodes', () => {
  test('passes distinct products on a comparison page', () => {
    passes(duplicateFeatureNodes, { html: doc(ld(product, { ...product, name: 'Desk' })) });
  });
  test('fails two nodes for the same product with different prices', () => {
    const { finding, excerpts } = failure(duplicateFeatureNodes, { html: doc(ld(product, { ...product, offers: { ...product.offers, price: '21.00' } })) }, 'conflicting-duplicate');
    assert.equal(finding.severity, 'medium');
    assert.equal(finding.params?.items, 'Product name:lamp (offers.price)');
    assert.equal(excerpts.length, 2);
  });
  test('reports exact duplicates as low and leaves variants with their own SKUs alone', () => {
    assert.equal(failure(duplicateFeatureNodes, { html: doc(ld(product, product)) }, 'exact-duplicate').finding.severity, 'low');
    passes(duplicateFeatureNodes, { html: doc(ld({ ...product, sku: 'L-1' }, { ...product, sku: 'L-2' })) });
  });
  test('is not applicable without feature nodes', () => {
    assert.deepEqual(outcome(duplicateFeatureNodes, { html: doc(ld({ '@context': ctx, '@type': 'WebSite', name: 'Acme' })) }), ['not_applicable', 'no-feature-nodes']);
  });
});
