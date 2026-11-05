import { png } from '../support/assets.ts';
import { addPage, isoDate, page, replaceOnce, served, siteNodes, transform, webPage } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts, type Studio } from '../support/studio.ts';

const shop = '/en/shop/';
const checklist = '/en/shop/data-platform-checklist-print/';
const workbook = '/en/shop/automation-workbook/';
const meetup = '/en/events/valencia-data-meetup/';
const workshop = '/en/events/postgres-workshop/';
const job = '/en/careers/data-engineer/';

const address = { '@type': 'PostalAddress', streetAddress: 'Carrer de Colón 12', addressLocality: 'Valencia', postalCode: '46004', addressCountry: 'ES' };

function shipping(currency: string): Record<string, unknown> {
  const days = (minValue: number, maxValue: number) => ({ '@type': 'QuantitativeValue', minValue, maxValue, unitCode: 'DAY' });
  return {
    '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: 4.9, currency },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'ES' },
    deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: days(0, 1), transitTime: days(1, 3) },
  };
}

function product(site: Studio, path: string, title: string, h1: string, price: string, body: string, node: Record<string, unknown>): void {
  const url = site.url(path);
  const created = addPage(site, path, {
    title, h1, label: h1,
    description: `${h1}, printed and bound by Vellora Studio in Valencia and shipped within Spain.`,
    lead: `${price}. Ships from Valencia in one to three working days.`,
    body: `<img src="/images/shop/${path.split('/')[3]}.png" alt="${h1} on a desk" width="800" height="600">
<section>
<h2>What is inside</h2>
${body}
<p><strong>${price}</strong></p>
<form method="POST" action="/api/cart"><input type="hidden" name="sku" value="${String(node.sku)}"><button type="submit">Add to cart</button></form>
</section>`,
    graph: [...siteNodes(site), webPage(site, path, title), { '@type': 'Product', '@id': `${url}#product`, url, brand: { '@type': 'Brand', name: 'Vellora Studio' }, ...node }],
  });
  transform(created, html => replaceOnce(html, '<meta property="og:type" content="website">', '<meta property="og:type" content="product">'));
  site.routes.set(`/images/shop/${path.split('/')[3]}.png`, site.file('image/png', png(800, 600, [210, 180, 140])));
}

export default defineScenario({
  name: 'holdout-shop',
  summary: 'A small shop crawled from a product page: a free product with an out-of-range rating, a bad GTIN, a localized availability, a shipping rate in another currency and a return policy without its required fields; its correct twin; events, an expired job and a LocalBusiness.',
  hosts: studioHosts,
  options: { crawl: true, maxPages: 40 },
  build: context => {
    const site = studio(context);
    product(site, checklist, 'Printed data platform checklist | Vellora Studio', 'Printed data platform checklist', 'Free with any project', '<p>The eight questions of our data platform checklist, with space for your own answers and a page for each source system.</p>', {
      name: 'Printed data platform checklist', description: 'A printed, spiral-bound copy of the data platform checklist.',
      image: [site.url(`/images/shop/${checklist.split('/')[3]}.png`)], sku: 'VS-CHK-01', gtin13: '4006381333932',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 6, bestRating: 5, ratingCount: 12 },
      offers: {
        '@type': 'Offer', url: site.url(checklist), price: 0, priceCurrency: 'EUR', availability: 'En stock', itemCondition: 'https://schema.org/NewCondition',
        shippingDetails: shipping('USD'), hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', returnFees: 'https://schema.org/FreeReturn' },
      },
    });
    product(site, workbook, 'Process automation workbook | Vellora Studio', 'Process automation workbook', '29 euros', '<p>Worksheets to measure a repetitive process for two weeks and decide whether it is worth automating.</p>', {
      name: 'Process automation workbook', description: 'Worksheets to measure a repetitive process before automating it.',
      image: [site.url(`/images/shop/${workbook.split('/')[3]}.png`)], sku: 'VS-WB-02', gtin13: '4006381333931',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, bestRating: 5, ratingCount: 18 },
      offers: {
        '@type': 'Offer', url: site.url(workbook), price: 29, priceCurrency: 'EUR', availability: 'http://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition',
        shippingDetails: shipping('EUR'),
        hasMerchantReturnPolicy: {
          '@type': 'MerchantReturnPolicy', applicableCountry: 'ES', returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
          merchantReturnDays: 30, returnMethod: 'https://schema.org/ReturnByMail', returnFees: 'https://schema.org/FreeReturn',
        },
      },
    });

    const [organization, founder, website] = siteNodes(site);
    organization!.aggregateRating = { '@type': 'AggregateRating', ratingValue: 4.9, bestRating: 5, reviewCount: 37 };
    addPage(site, shop, {
      title: 'Shop | Vellora Studio', h1: 'Shop', description: 'Printed checklists and workbooks from the Vellora Studio team.',
      lead: 'Printed versions of the checklists and workbooks we use with clients.',
      body: `<section><h2>Printed guides</h2><ul>
<li><a href="${checklist}">Printed data platform checklist</a></li>
<li><a href="${workbook}">Process automation workbook</a></li>
</ul><p>Rated 4.9 out of 5 by 37 clients.</p></section>`,
      graph: [organization!, founder!, website!, webPage(site, shop, 'Shop | Vellora Studio', { '@type': 'CollectionPage' }), { '@type': 'Organisation', name: 'Vellora Studio SL', url: site.origin }],
    });

    page(site, '/en/about/').graph.push({
      '@type': 'LocalBusiness', '@id': `${site.origin}/#localbusiness`, name: 'Vellora Studio', url: site.url('/en/about/'), telephone: '+34 960 123 456',
      address: 'Carrer de Colón 12, 46004 Valencia, Spain', geo: { '@type': 'GeoCoordinates', latitude: 39.47, longitude: -0.38 },
    });

    const organizer = { '@type': 'Organization', name: 'Vellora Studio SL', url: site.origin };
    addPage(site, meetup, {
      title: 'Valencia data meetup | Vellora Studio', h1: 'Valencia data meetup', description: 'An evening of short talks on data platforms for small teams.',
      lead: 'Three short talks on running data platforms in small companies, followed by questions.',
      body: '<section><h2>Programme</h2><p>Talks start at half past six and finish by eight. Entry is free; please register so we can plan the room.</p></section>',
      graph: [...siteNodes(site), webPage(site, meetup, 'Valencia data meetup'), {
        '@type': 'Event', name: 'Valencia data meetup', startDate: `${isoDate(30)}T18:30:00+01:00`, eventStatus: 'https://schema.org/EventScheduled',
        description: 'Three short talks on running data platforms in small companies.', organizer,
      }],
    });
    addPage(site, workshop, {
      title: 'PostgreSQL workshop for small teams | Vellora Studio', h1: 'PostgreSQL workshop for small teams', description: 'A four-hour hands-on workshop on running PostgreSQL in production.',
      lead: 'Four hours of hands-on practice with backups, upgrades and query plans, at the studio in Valencia.',
      body: '<section><h2>What you will practise</h2><p>Restoring a backup, upgrading a major version and reading a query plan, on a laptop we provide.</p></section>',
      graph: [...siteNodes(site), webPage(site, workshop, 'PostgreSQL workshop for small teams'), {
        '@type': 'Event', name: 'PostgreSQL workshop for small teams', startDate: `${isoDate(45)}T10:00:00+01:00`, endDate: `${isoDate(45)}T14:00:00+01:00`,
        eventStatus: 'https://schema.org/EventScheduled', image: [site.url('/images/og-default.png')], description: 'Hands-on practice with backups, upgrades and query plans.',
        location: { '@type': 'Place', name: 'Vellora Studio', address }, organizer,
        offers: { '@type': 'Offer', price: 40, priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: site.url(workshop), validFrom: isoDate(-10) },
      }],
    });
    addPage(site, job, {
      title: 'Data engineer | Careers | Vellora Studio', h1: 'Data engineer', description: 'Join Vellora Studio in Valencia as a data engineer working on client data platforms.',
      lead: 'We are looking for a data engineer to build pipelines and reports for our clients.',
      body: '<section><h2>The role</h2><p>You will design pipelines, review data models with clients and keep the platforms we build documented and tested.</p></section>',
      graph: [...siteNodes(site), webPage(site, job, 'Data engineer'), {
        '@type': 'JobPosting', title: 'Data engineer', description: '<p>Design pipelines, review data models with clients and keep platforms documented and tested.</p>',
        datePosted: '2024-11-04', validThrough: '2025-01-31T23:59:59+01:00', employmentType: 'FULL_TIME',
        hiringOrganization: { '@type': 'Organization', name: 'Vellora Studio SL', sameAs: site.origin },
        jobLocation: { '@type': 'Place', address },
      }],
    });
    return served(site, checklist);
  },
  mustFail: [
    { rule: 'schema-merchant-listing', severity: 'high', page: checklist },
    { rule: 'schema-gtin-validity', severity: 'medium', page: checklist },
    { rule: 'schema-enumeration-values', page: checklist },
    { rule: 'schema-review-snippet', severity: 'high', page: checklist },
    { rule: 'schema-shipping-details', severity: 'medium', page: checklist },
    { rule: 'schema-return-policy', severity: 'medium' },
    { rule: 'schema-self-serving-reviews', severity: 'low', page: shop },
    { rule: 'schema-unknown-type', page: shop },
    { rule: 'schema-localbusiness', severity: 'low', page: '/en/about/' },
    { rule: 'schema-event', severity: 'high', page: meetup },
    { rule: 'schema-jobposting', severity: 'high', page: job },
  ],
  mustNotFail: [
    { rule: 'schema-product-snippet', page: checklist },
    { rule: 'schema-self-serving-reviews', page: checklist },
    { rule: 'schema-enumeration-values', page: workbook },
    { rule: 'schema-gtin-validity', page: workbook },
    { rule: 'schema-event', page: workshop },
    { rule: 'schema-date-logic', page: job },
  ],
});
