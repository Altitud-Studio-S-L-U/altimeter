import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, metaProperty } from '../helpers.ts';
import { bareTerm, has, hasPath, nodesAt, text, texts, values, type GraphNode, type PageGraph } from './graph.ts';
import { cite, hostOf, isResult, nodesOfType, normalizeName, pageGraph, perNode, plainNumber, report, sameHost, type Problem } from './support.ts';
import { isA } from './vocabulary.ts';

/** Products a feature is about: top-level or main entities, and the variants of a ProductGroup; never the group itself. */
function products(graph: PageGraph): GraphNode[] {
  return nodesOfType(graph, 'Product').filter(node => !isA(node.types, 'ProductGroup')
    && (node.parent === undefined || ['mainEntity', 'hasVariant'].includes(node.parent.property)));
}

function overProducts(context: RuleContext, none: string, check: (graph: PageGraph, node: GraphNode) => Problem[] | undefined): RuleResult[] | RuleResult {
  const graph = pageGraph(context);
  if (isResult(graph)) return graph;
  const nodes = products(graph);
  if (nodes.length === 0) return { outcome: 'not_applicable', reason: 'no-product' };
  const results = nodes.map(node => check(graph, node));
  if (results.every(entry => entry === undefined)) return { outcome: 'not_applicable', reason: none };
  return report(results.flatMap(entry => entry ?? []), nodes.slice(0, 3).map(node => cite(context, graph, node, 'Product node')));
}

const offersOf = (graph: PageGraph, node: GraphNode) => nodesAt(graph, node, 'offers');
const isAggregate = (node: GraphNode) => isA(node.types, 'AggregateOffer');

/** Prices an offer states: its own price and those of price specifications without a price type. */
function activePrices(graph: PageGraph, offer: GraphNode): string[] {
  const own = texts(graph, offer, 'price');
  if (own.length > 0) return own;
  return nodesAt(graph, offer, 'priceSpecification').filter(spec => !has(graph, spec, 'priceType') && !has(graph, spec, 'validForMemberTier'))
    .flatMap(spec => texts(graph, spec, 'price'));
}

const currencyOf = (graph: PageGraph, offer: GraphNode) => text(graph, offer, 'priceCurrency')
  ?? nodesAt(graph, offer, 'priceSpecification').map(spec => text(graph, spec, 'priceCurrency')).find(Boolean);

export const productSnippet: RuleImplementation = {
  id: 'schema-product-snippet',
  evaluate: context => overProducts(context, 'no-product', (graph, node) => {
    const problems: Problem[] = [];
    const add = (reason: string, severity: Problem['severity'], subject: string, label: string, on = node, property?: string, excerpt?: string) =>
      problems.push({ reason, severity, subject, evidence: cite(context, graph, on, label, property, excerpt) });
    const name = text(graph, node, 'name');
    if (!name) add('missing-name', 'high', 'name', 'Product without name');
    if (!has(graph, node, 'review') && !has(graph, node, 'aggregateRating') && !has(graph, node, 'offers')) {
      add('missing-offer-or-review', 'high', name ?? 'Product', 'Product with none of offers, review or aggregateRating');
    }
    for (const offer of offersOf(graph, node)) {
      if (isAggregate(offer)) {
        if (!has(graph, offer, 'lowPrice') || !currencyOf(graph, offer)) add('aggregate-offer-incomplete', 'high', name ?? 'Product', 'AggregateOffer without lowPrice or priceCurrency', offer);
        continue;
      }
      const prices = activePrices(graph, offer);
      if (prices.length === 0 && !nodesAt(graph, offer, 'priceSpecification').some(spec => has(graph, spec, 'price'))) {
        add('offer-without-price', 'high', name ?? 'Product', 'Offer without price', offer);
      }
      for (const price of [...texts(graph, offer, 'price'), ...nodesAt(graph, offer, 'priceSpecification').flatMap(spec => texts(graph, spec, 'price'))]) {
        if (plainNumber(price) === undefined) add('malformed-price', 'high', price, 'price that is not a plain number', offer, 'price', price);
      }
      const currency = currencyOf(graph, offer);
      if (currency !== undefined && !/^[A-Z]{3}$/u.test(currency)) add('invalid-currency', 'medium', currency, 'priceCurrency that is not an ISO 4217 code', offer, 'priceCurrency', currency);
    }
    return problems;
  }),
};

/** Values of a product that a ProductGroup may hold for all its variants. */
function inherited(graph: PageGraph, node: GraphNode, property: string): boolean {
  return has(graph, node, property) || (node.parent?.property === 'hasVariant' && has(graph, node.parent.node, property));
}

export const merchantListing: RuleImplementation = {
  id: 'schema-merchant-listing',
  evaluate: context => overProducts(context, 'no-offer', (graph, node) => {
    const offers = offersOf(graph, node).filter(offer => !isAggregate(offer));
    if (offers.length === 0) return undefined;
    const problems: Problem[] = [];
    const name = text(graph, node, 'name') ?? 'Product';
    const add = (reason: string, severity: Problem['severity'], label: string, on = node, property?: string, excerpt?: string) =>
      problems.push({ reason, severity, subject: name, evidence: cite(context, graph, on, label, property, excerpt) });
    if (!inherited(graph, node, 'image')) add('missing-image', 'high', 'Product without image');
    for (const offer of offers) {
      if (!currencyOf(graph, offer)) add('missing-currency', 'high', 'Offer without priceCurrency', offer);
      for (const price of activePrices(graph, offer)) {
        const number = plainNumber(price);
        if (number !== undefined && number <= 0) add('price-not-positive', 'high', 'Offer price of zero or less', offer, 'price', price);
      }
      if (!has(graph, offer, 'availability')) add('missing-availability', 'low', 'Offer without availability', offer);
    }
    const identifiers = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'isbn', 'mpn', 'brand'];
    if (!identifiers.some(property => inherited(graph, node, property))) add('missing-identifiers', 'medium', 'Product without gtin, mpn or brand');
    return problems;
  }),
};

const gtinLengths: Readonly<Record<string, readonly number[]>> = { gtin: [8, 12, 13, 14], gtin8: [8], gtin12: [12], gtin13: [13], gtin14: [14] };

export function gs1CheckDigitValid(digits: string): boolean {
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = body.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(body[i]) * weight;
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export const gtinValidity: RuleImplementation = {
  id: 'schema-gtin-validity',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const nodes = nodesOfType(graph, 'Product');
    const problems: Problem[] = [];
    const seen = new Map<string, GraphNode>();
    let found = 0;
    for (const node of nodes) {
      for (const [property, lengths] of Object.entries(gtinLengths)) {
        for (const value of node.properties.get(property) ?? []) {
          const written = value.kind === 'text' ? value.value : value.kind === 'number' ? String(value.value) : undefined;
          if (written === undefined) continue;
          found += 1;
          const add = (reason: string, label: string) => problems.push({ reason, severity: 'medium', subject: `${property}: ${written}`,
            evidence: cite(context, graph, node, label, property, written) });
          if (!/^\d+$/u.test(written)) add('not-numeric', 'GTIN with characters other than digits');
          else if (!lengths.includes(written.length)) add('wrong-length', `GTIN of ${written.length} digits for ${property}`);
          else if (/^(\d)\1+$/u.test(written)) add('repeated-digits', 'GTIN made of one repeated digit');
          else if (!gs1CheckDigitValid(written)) add('check-digit', 'GTIN whose GS1 check digit does not match');
          else if (node.parent === undefined) {
            const previous = seen.get(written);
            const name = (entry: GraphNode) => normalizeName(text(graph, entry, 'name') ?? '');
            if (previous && previous !== node && name(previous) !== name(node)) add('duplicate', 'same GTIN on two different products');
            else seen.set(written, node);
          }
        }
      }
    }
    if (found === 0) return { outcome: 'not_applicable', reason: 'no-gtin' };
    return report(problems);
  },
};

const variesByAllowed = new Set(['color', 'size', 'suggestedAge', 'suggestedGender', 'material', 'pattern']);

export const productVariants: RuleImplementation = {
  id: 'schema-product-variants',
  evaluate: context => perNode(context, 'ProductGroup', 'no-product-group', (graph, group) => {
    const problems: Problem[] = [];
    const add = (reason: string, severity: Problem['severity'], subject: string, label: string, on = group, property?: string, excerpt?: string) =>
      problems.push({ reason, severity, subject, evidence: cite(context, graph, on, label, property, excerpt) });
    if (!text(graph, group, 'name')) add('missing-name', 'medium', 'name', 'ProductGroup without name');
    for (const value of texts(graph, group, 'variesBy')) {
      if (!variesByAllowed.has(bareTerm(value))) add('invalid-varies-by', 'medium', value, 'variesBy value Google does not support', group, 'variesBy', value);
    }
    const groupId = text(graph, group, 'productGroupID');
    const variants = [...nodesAt(graph, group, 'hasVariant'),
      ...nodesOfType(graph, 'Product').filter(node => node.parent === undefined && group.id !== undefined
        && values(graph, node, 'isVariantOf').some(value => (value.kind === 'ref' && value.id === group.id) || (value.kind === 'node' && value.node.id === group.id)))];
    const ids = new Map<string, GraphNode>();
    for (const variant of new Set(variants)) {
      const declared = text(graph, variant, 'inProductGroupWithID');
      if (groupId && declared && declared !== groupId) add('group-id-mismatch', 'medium', declared, `inProductGroupWithID differs from productGroupID ${groupId}`, variant, 'inProductGroupWithID', declared);
      const keys = ['sku', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14'].flatMap(property => texts(graph, variant, property).map(value => `${property}:${value}`));
      if (keys.length === 0) add('variant-without-id', 'medium', text(graph, variant, 'name') ?? 'variant', 'variant without sku or gtin', variant);
      for (const key of keys) {
        if (ids.has(key) && ids.get(key) !== variant) add('duplicate-variant-id', 'medium', key, 'two variants with the same identifier', variant, key.split(':')[0], key);
        ids.set(key, variant);
      }
      if (!has(graph, variant, 'offers')) add('variant-without-offer', 'low', text(graph, variant, 'name') ?? 'variant', 'variant without offers', variant);
    }
    return problems;
  }),
};

const strikethroughTypes = new Set(['StrikethroughPrice', 'ListPrice']);

export const offerPriceSpecification: RuleImplementation = {
  id: 'schema-offer-price-specification',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const offers = nodesOfType(graph, 'Offer').filter(offer => has(graph, offer, 'priceSpecification'));
    if (offers.length === 0) return { outcome: 'not_applicable', reason: 'no-price-specification' };
    const problems: Problem[] = [];
    for (const offer of offers) {
      const specs = nodesAt(graph, offer, 'priceSpecification');
      const add = (reason: string, subject: string, label: string, on: GraphNode, property?: string, excerpt?: string) =>
        problems.push({ reason, severity: 'medium', subject, evidence: cite(context, graph, on, label, property, excerpt) });
      const struck: number[] = [];
      for (const spec of specs) {
        const priceType = text(graph, spec, 'priceType');
        const tier = has(graph, spec, 'validForMemberTier');
        if (priceType && !strikethroughTypes.has(bareTerm(priceType))) add('unsupported-price-type', priceType, 'priceType other than StrikethroughPrice', spec, 'priceType', priceType);
        if (priceType && tier) add('member-tier-with-price-type', priceType, 'validForMemberTier combined with priceType', spec, 'priceType', priceType);
        if (has(graph, spec, 'membershipPointsEarned') && !tier) add('points-without-member-tier', 'membershipPointsEarned', 'membershipPointsEarned without validForMemberTier', spec, 'membershipPointsEarned');
        if (has(graph, spec, 'priceValidUntil')) add('price-valid-until-on-specification', 'priceValidUntil', 'priceValidUntil inside a price specification', spec, 'priceValidUntil');
        for (const quantity of nodesAt(graph, spec, 'referenceQuantity')) {
          if (!has(graph, quantity, 'value') || !has(graph, quantity, 'unitCode')) add('reference-quantity-incomplete', 'referenceQuantity', 'referenceQuantity without value or unitCode', quantity);
        }
        if (priceType && strikethroughTypes.has(bareTerm(priceType))) struck.push(...texts(graph, spec, 'price').map(plainNumber).filter((n): n is number => n !== undefined));
      }
      const active = activePrices(graph, offer).map(plainNumber).filter((n): n is number => n !== undefined);
      if (struck.length > 0 && active.length === 0) add('strikethrough-only', 'price', 'strikethrough price with no active price', offer);
      for (const price of active) {
        if (struck.some(previous => price >= previous)) add('not-discounted', String(price), `active price not lower than the strikethrough price ${struck.join(', ')}`, offer, 'price', String(price));
      }
    }
    return report(problems);
  },
};

function nonNegativeInteger(value: string | undefined): boolean {
  return value === undefined || /^\d+$/u.test(value.trim());
}

export const shippingDetails: RuleImplementation = {
  id: 'schema-shipping-details',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const details = nodesOfType(graph, 'OfferShippingDetails').filter(node => node.parent?.property !== 'shippingConditions');
    const services = nodesOfType(graph, 'ShippingService');
    if (details.length === 0 && services.length === 0) return { outcome: 'not_applicable', reason: 'no-shipping-markup' };
    const problems: Problem[] = [];
    const add = (reason: string, subject: string, label: string, on: GraphNode, property?: string, excerpt?: string) =>
      problems.push({ reason, severity: 'medium', subject, evidence: cite(context, graph, on, label, property, excerpt) });
    for (const detail of details) {
      const doesNotShip = texts(graph, detail, 'doesNotShip').some(value => /^(true|https?:\/\/schema\.org\/True)$/iu.test(value));
      const times = nodesAt(graph, detail, 'deliveryTime');
      if (!doesNotShip && times.length === 0) add('missing-delivery-time', 'deliveryTime', 'OfferShippingDetails without deliveryTime', detail);
      if (times.length > 1) add('several-delivery-times', 'deliveryTime', 'OfferShippingDetails with more than one deliveryTime', detail, 'deliveryTime');
      for (const time of times) {
        for (const range of [...nodesAt(graph, time, 'handlingTime'), ...nodesAt(graph, time, 'transitTime')]) {
          const unit = text(graph, range, 'unitCode');
          if (!nonNegativeInteger(text(graph, range, 'minValue')) || !nonNegativeInteger(text(graph, range, 'maxValue')) || (unit !== undefined && !/^(DAY|d)$/u.test(unit))) {
            add('invalid-time-range', 'handlingTime/transitTime', 'delivery time range that is not whole days', range);
          }
        }
      }
      const destinations = nodesAt(graph, detail, 'shippingDestination');
      if (destinations.length === 0) add('missing-destination', 'shippingDestination', 'OfferShippingDetails without shippingDestination', detail);
      for (const region of destinations) {
        if (!has(graph, region, 'addressCountry')) add('destination-without-country', 'addressCountry', 'shipping destination without addressCountry', region);
        if (has(graph, region, 'addressRegion') && has(graph, region, 'postalCode')) add('region-and-postal-code', 'addressRegion+postalCode', 'shipping destination with both addressRegion and postalCode', region);
      }
      if (doesNotShip) continue;
      const rates = nodesAt(graph, detail, 'shippingRate');
      if (rates.length === 0) add('missing-rate', 'shippingRate', 'OfferShippingDetails without shippingRate', detail);
      const offer = detail.parent?.property === 'shippingDetails' ? detail.parent.node : undefined;
      const offerCurrency = offer ? currencyOf(graph, offer) : undefined;
      for (const rate of rates) {
        if (!has(graph, rate, 'value') && !has(graph, rate, 'maxValue')) add('rate-without-value', 'shippingRate', 'shippingRate without value or maxValue', rate);
        const currency = text(graph, rate, 'currency');
        if (!currency) add('rate-without-currency', 'shippingRate.currency', 'shippingRate without currency', rate);
        else if (offerCurrency && currency !== offerCurrency) add('currency-mismatch', currency, `shipping currency differs from the offer's ${offerCurrency}`, rate, 'currency', currency);
      }
    }
    for (const service of services) {
      const conditions = nodesAt(graph, service, 'shippingConditions');
      if (conditions.length === 0) add('missing-shipping-conditions', 'shippingConditions', 'ShippingService without shippingConditions', service);
      for (const condition of conditions) {
        const blocked = texts(graph, condition, 'doesNotShip').some(value => /^(true|https?:\/\/schema\.org\/True)$/iu.test(value));
        if (blocked && (has(graph, condition, 'shippingRate') || has(graph, condition, 'transitTime'))) {
          add('does-not-ship-with-rate', 'doesNotShip', 'doesNotShip with a shipping rate or transit time', condition);
        }
      }
    }
    return report(problems);
  },
};

/** What a review or rating is about: its itemReviewed, or the node that carries it. */
export function subjectOf(graph: PageGraph, node: GraphNode): { node?: GraphNode; present: boolean } {
  const reviewed = values(graph, node, 'itemReviewed');
  if (reviewed.length > 0) {
    const resolved = nodesAt(graph, node, 'itemReviewed')[0];
    return resolved ? { node: resolved, present: true } : { present: true };
  }
  if (node.parent && ['review', 'reviews', 'aggregateRating'].includes(node.parent.property)) return { node: node.parent.node, present: true };
  return { present: false };
}

const reviewableTypes = ['Book', 'Course', 'CreativeWorkSeason', 'CreativeWorkSeries', 'Episode', 'Event', 'Game', 'HowTo', 'LocalBusiness', 'MediaObject',
  'Movie', 'MusicPlaylist', 'MusicRecording', 'Organization', 'Product', 'Recipe', 'SoftwareApplication'];

function ratingBounds(graph: PageGraph, rating: GraphNode): { value?: number; best: number; worst: number; malformed?: string } {
  const raw = text(graph, rating, 'ratingValue');
  const best = plainNumber(text(graph, rating, 'bestRating') ?? '5') ?? 5;
  const worst = plainNumber(text(graph, rating, 'worstRating') ?? '1') ?? 1;
  if (raw === undefined) return { best, worst };
  if (/^\d+,\d+$/u.test(raw.trim())) return { best, worst, malformed: raw };
  const value = plainNumber(raw);
  return value === undefined ? { best, worst } : { value, best, worst };
}

function authorName(graph: PageGraph, review: GraphNode): string | undefined {
  const author = values(graph, review, 'author')[0];
  if (!author) return undefined;
  if (author.kind === 'text') return author.value;
  const node = nodesAt(graph, review, 'author')[0];
  return node ? text(graph, node, 'name') : undefined;
}

export const reviewSnippet: RuleImplementation = {
  id: 'schema-review-snippet',
  evaluate: context => perNode(context, ['Review', 'AggregateRating'], 'no-reviews', (graph, node) => {
    const subject = subjectOf(graph, node);
    if (subject.node && isA(subject.node.types, 'Service')) return [];
    const problems: Problem[] = [];
    const type = isA(node.types, 'Review') ? 'Review' : 'AggregateRating';
    const add = (reason: string, subjectText: string, label: string, property?: string, excerpt?: string) =>
      problems.push({ reason, severity: 'high', subject: subjectText, evidence: cite(context, graph, node, label, property, excerpt) });
    if (!subject.present) add('missing-item-reviewed', type, `${type} without itemReviewed or a parent item`);
    else if (subject.node && !text(graph, subject.node, 'name')) add('item-reviewed-without-name', type, `${type} whose reviewed item has no name`);
    if (subject.node && subject.node.types.length > 0 && !reviewableTypes.some(entry => isA(subject.node!.types, entry))) {
      add('unsupported-item-type', subject.node.types.join('+'), `${type} about a type review snippets do not support`, undefined, subject.node.types.join(', '));
    }
    let rating: GraphNode | undefined = node;
    if (type === 'Review') {
      const name = authorName(graph, node);
      if (!has(graph, node, 'author')) add('missing-author', 'author', 'Review without author');
      else if (name !== undefined && name.length >= 100) add('author-name-too-long', name.slice(0, 40), 'Review author name of 100 characters or more', 'author', name);
      rating = nodesAt(graph, node, 'reviewRating')[0];
      if (!rating || !has(graph, rating, 'ratingValue')) {
        add('missing-rating', 'reviewRating.ratingValue', 'Review without reviewRating.ratingValue');
        rating = undefined;
      }
    } else {
      if (!has(graph, node, 'ratingValue')) add('missing-rating', 'ratingValue', 'AggregateRating without ratingValue');
      const counts = [...texts(graph, node, 'ratingCount'), ...texts(graph, node, 'reviewCount')];
      if (counts.length === 0) add('missing-count', 'ratingCount/reviewCount', 'AggregateRating without ratingCount or reviewCount');
      for (const count of counts) {
        if (!/^\d+$/u.test(count.trim()) || Number(count) < 1) add('invalid-count', count, 'rating count that is not a whole number of at least 1', undefined, count);
      }
    }
    if (rating) {
      const bounds = ratingBounds(graph, rating);
      if (bounds.malformed) add('malformed-rating', bounds.malformed, 'rating with a decimal comma', 'ratingValue', bounds.malformed);
      else if (bounds.value !== undefined && (bounds.value < bounds.worst || bounds.value > bounds.best)) {
        add('out-of-bounds', String(bounds.value), `rating outside ${bounds.worst} to ${bounds.best}`, undefined, `ratingValue ${bounds.value}, worstRating ${bounds.worst}, bestRating ${bounds.best}`);
      }
    }
    return problems;
  }),
};

/** Whether an organization node describes the site that publishes the page. */
export function isSiteOwner(graph: PageGraph, organization: GraphNode): boolean {
  const pageHost = hostOf(graph.base);
  const url = text(graph, organization, 'url');
  if (url !== undefined) return sameHost(hostOf(url, graph.base), pageHost);
  if (organization.id !== undefined && /^(https?:|\/|#)/u.test(organization.id)) return sameHost(hostOf(absoluteUrl(organization.id, graph.base)), pageHost);
  const name = text(graph, organization, 'name');
  if (name === undefined) return false;
  const siteNames = [
    ...nodesOfType(graph, 'WebSite').flatMap(site => [...texts(graph, site, 'name'), ...texts(graph, site, 'alternateName')]),
    ...metaProperty(graph.doc, 'og:site_name').map(meta => meta.attrs.content ?? ''),
  ].map(normalizeName);
  return siteNames.includes(normalizeName(name));
}

export const selfServingReviews: RuleImplementation = {
  id: 'schema-self-serving-reviews',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const ratings = [...nodesOfType(graph, 'Review'), ...nodesOfType(graph, 'AggregateRating')];
    if (ratings.length === 0) return { outcome: 'not_applicable', reason: 'no-reviews' };
    const problems: Problem[] = [];
    for (const rating of ratings) {
      const subject = subjectOf(graph, rating).node;
      if (!subject || !isA(subject.types, 'Organization') || !isSiteOwner(graph, subject)) continue;
      problems.push({ reason: 'self-serving', severity: 'low', subject: text(graph, subject, 'name') ?? subject.types.join('+'),
        evidence: cite(context, graph, rating, `${rating.types.join('+')} about the site's own ${subject.types.join('+')}`) });
    }
    return report(problems);
  },
};

const placeholderAuthor = /^(?:admin|administrator|administrador|customer|cliente|client|user|usuario|usuari|anonymous|anonimo|anónimo|anònim|guest|staff|test)$/iu;

export const reviewAuthenticity: RuleImplementation = {
  id: 'schema-review-authenticity',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const reviews = nodesOfType(graph, 'Review');
    if (reviews.length === 0) return { outcome: 'not_applicable', reason: 'no-reviews' };
    const problems: Problem[] = [];
    const add = (reason: string, subject: string, label: string, node: GraphNode, property?: string, excerpt?: string) =>
      problems.push({ reason, severity: 'medium', subject, needsJudgment: true, evidence: cite(context, graph, node, label, property, excerpt) });
    const bodies = new Map<string, GraphNode>();
    for (const review of reviews) {
      const name = authorName(graph, review);
      if (name && placeholderAuthor.test(name.trim())) add('placeholder-author', name, 'review author that reads as a placeholder', review, 'author', name);
      const body = text(graph, review, 'reviewBody');
      if (!body || body.length < 20) continue;
      const key = normalizeName(body);
      const first = bodies.get(key);
      if (first) add('duplicate-text', body.slice(0, 40), 'review text repeated in another review', review, 'reviewBody', body);
      else bodies.set(key, review);
    }
    for (const aggregate of nodesOfType(graph, 'AggregateRating')) {
      const subject = subjectOf(graph, aggregate).node;
      if (!subject) continue;
      const own = reviews.filter(review => subjectOf(graph, review).node === subject);
      const scores = own.map(review => nodesAt(graph, review, 'reviewRating')[0]).map(rating => (rating ? plainNumber(text(graph, rating, 'ratingValue') ?? '') : undefined))
        .filter((n): n is number => n !== undefined);
      const count = plainNumber(text(graph, aggregate, 'reviewCount') ?? text(graph, aggregate, 'ratingCount') ?? '');
      const value = plainNumber(text(graph, aggregate, 'ratingValue') ?? '');
      if (scores.length < 2 || count !== scores.length || value === undefined) continue;
      const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      if (Math.abs(average - value) > 0.15) add('aggregate-mismatch', String(value), `aggregate rating differs from the average ${average.toFixed(2)} of the marked-up reviews`, aggregate, 'ratingValue', String(value));
    }
    return report(problems);
  },
};

export const softwareApp: RuleImplementation = {
  id: 'schema-software-app',
  evaluate: context => perNode(context, 'SoftwareApplication', 'no-software-application', (graph, node) => {
    const problems: Problem[] = [];
    const name = text(graph, node, 'name') ?? 'SoftwareApplication';
    const add = (reason: string, label: string) => problems.push({ reason, severity: 'medium', subject: name, evidence: cite(context, graph, node, label) });
    if (!text(graph, node, 'name')) add('missing-name', 'SoftwareApplication without name');
    if (!hasPath(graph, node, 'offers.price')) add('missing-price', 'SoftwareApplication without offers.price');
    if (!has(graph, node, 'aggregateRating') && !has(graph, node, 'review')) add('missing-rating', 'SoftwareApplication without aggregateRating or review');
    if (node.types.every(type => type === 'VideoGame')) add('video-game-not-co-typed', 'VideoGame not co-typed with an application type');
    return problems;
  }, { select: (_graph, node) => node.parent === undefined || node.parent.property === 'mainEntity' }),
};

export const serviceOfferCatalog: RuleImplementation = {
  id: 'schema-service-offercatalog',
  evaluate: context => perNode(context, 'Service', 'no-service', (graph, node) => {
    const providers = nodesAt(graph, node, 'provider');
    const own = providers.length === 0 || providers.some(provider => isSiteOwner(graph, provider));
    if (!own || (!has(graph, node, 'aggregateRating') && !has(graph, node, 'review'))) return [];
    return [{ reason: 'self-serving-rating', severity: 'low', subject: text(graph, node, 'name') ?? 'Service',
      evidence: cite(context, graph, node, 'rating on a Service the site itself provides', has(graph, node, 'aggregateRating') ? 'aggregateRating' : 'review') }];
  }),
};
