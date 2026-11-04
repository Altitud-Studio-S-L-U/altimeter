import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import type { PageType } from '../../src/core/types.ts';
import type { RuleImplementation } from '../../src/rules/engine.ts';
import { imageInfo } from '../../src/rules/schema/image-size.ts';
import {
  authorEntityQuality, courseList, entityConsistencySitewide, featureOpportunity, inLanguage, organization, organizationIdentifiers, organizationLogo,
  returnPolicy, siteNameWebsite, sitelinksSearchboxObsolete,
} from '../../src/rules/schema/site.ts';
import { evaluate, page, site, type SiteSpec } from '../support/facts.ts';

const origin = 'https://shop.example';
const home = `${origin}/`;
const ctx = 'https://schema.org';
const ld = (...items: unknown[]) => items.map(item => `<script type="application/ld+json">${JSON.stringify({ '@context': ctx, ...(item as object) })}</script>`).join('\n');
const doc = (head: string, lang = 'en') => `<!doctype html><html lang="${lang}"><head><title>Acme</title>${head}</head><body><main><p>Body</p></main></body></html>`;
const at = (url: string, head: string, pageType?: PageType, lang?: string): PageFacts => page(url, { html: doc(head, lang), ...(pageType ? { pageType } : {}) });

function siteResult(rule: RuleImplementation, pages: readonly PageFacts[], extra: Omit<SiteSpec, 'pages'> = {}) {
  const { findings, evidence } = evaluate(rule, site({ homeUrl: home, ...extra, pages }));
  const all = findings.filter(entry => entry.scope.kind === 'site');
  return { all, evidence, first: all[0]! };
}

function failure(rule: RuleImplementation, pages: readonly PageFacts[], reason: string, extra: Omit<SiteSpec, 'pages'> = {}) {
  const { all, evidence } = siteResult(rule, pages, extra);
  const finding = all.find(entry => entry.outcome === 'fail' && entry.reason === reason);
  assert.ok(finding, `expected a ${reason} failure, got ${JSON.stringify(all.map(entry => [entry.outcome, entry.reason, entry.params]))}`);
  return { finding, excerpts: finding.evidence.map(id => evidence.get(id)?.excerpt ?? '') };
}

function passes(rule: RuleImplementation, pages: readonly PageFacts[], extra: Omit<SiteSpec, 'pages'> = {}) {
  assert.deepEqual(siteResult(rule, pages, extra).all.map(entry => [entry.outcome, entry.reason]), [['pass', undefined]]);
}

function outcome(rule: RuleImplementation, pages: readonly PageFacts[], extra: Omit<SiteSpec, 'pages'> = {}): [string, string | undefined] {
  const { first } = siteResult(rule, pages, extra);
  return [first.outcome, first.reason];
}

const org = { '@type': 'Organization', '@id': `${origin}/#organization`, name: 'Acme', url: home, logo: `${origin}/logo.png`, sameAs: ['https://social.example/acme'] };
const website = { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'Acme', url: home };

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('image header reader', () => {
  test('reads PNG, GIF and SVG', () => {
    assert.deepEqual(imageInfo(png(300, 120)), { format: 'png', width: 300, height: 120 });
    const gif = Buffer.from('GIF89a\x40\x00\x20\x00', 'latin1');
    assert.deepEqual(imageInfo(gif), { format: 'gif', width: 64, height: 32 });
    assert.deepEqual(imageInfo(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 10 10"></svg>')), { format: 'svg' });
  });
});

describe('schema-organization', () => {
  test('passes a complete Organization on the home page', () => passes(organization, [at(home, ld(org, website), 'home')]));
  test('reports missing Organization markup as low', () => {
    const { finding, excerpts } = failure(organization, [at(home, ld(website), 'home')], 'missing');
    assert.equal(finding.severity, 'low');
    assert.equal(excerpts[0], '1 structured data items');
  });
  test('fails an Organization whose url is another host', () => {
    const { finding, excerpts } = failure(organization, [at(home, ld({ ...org, '@id': undefined, url: 'https://other-host.example/' }), 'home')], 'foreign-url');
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], 'https://other-host.example/');
  });
  test('accepts an Organization url at a root that redirects by locale', () => {
    const localeHome = page(`${origin}/en/`, { html: doc(ld(org, website)), pageType: 'home' });
    const { all } = siteResult(organization, [localeHome], { homeUrl: `${origin}/en/` });
    assert.deepEqual(all.map(entry => entry.outcome), ['pass']);
  });
  test('needs the home page', () => {
    assert.deepEqual(outcome(organization, [at(`${origin}/a/b`, ld(org), 'other')], { homeUrl: `${origin}/missing/` }), ['not_evaluated', 'no-home-page']);
  });
  test('needs fetched pages', () => {
    assert.deepEqual(outcome(organization, []), ['not_evaluated', 'missing-input:http']);
  });
});

describe('schema-organization-logo', () => {
  const pages = [at(home, ld(org), 'home')];
  test('passes a large raster logo', () => {
    passes(organizationLogo, pages, { resources: [{ url: `${origin}/logo.png`, purpose: 'logo', body: png(300, 300), headers: { 'content-type': 'image/png' } }] });
  });
  test('fails a logo smaller than 112 pixels', () => {
    const { finding, excerpts } = failure(organizationLogo, pages, 'too-small', { resources: [{ url: `${origin}/logo.png`, purpose: 'logo', body: png(100, 40), headers: { 'content-type': 'image/png' } }] });
    assert.equal(finding.severity, 'medium');
    assert.equal(excerpts[0], '100x40 png');
  });
  test('never fails an SVG logo on size', () => {
    const svgPages = [at(home, ld({ ...org, logo: `${origin}/logo.svg` }), 'home')];
    assert.deepEqual(outcome(organizationLogo, svgPages, { resources: [{ url: `${origin}/logo.svg`, purpose: 'logo', body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', headers: { 'content-type': 'image/svg+xml' } }] }),
      ['not_evaluated', 'svg-size-unmeasurable']);
  });
  test('fails a logo that does not answer 200', () => {
    failure(organizationLogo, pages, 'not-200', { resources: [{ url: `${origin}/logo.png`, purpose: 'logo', status: 404 }] });
  });
  test('is not applicable without a logo and needs fetched resources', () => {
    assert.deepEqual(outcome(organizationLogo, [at(home, ld({ ...org, logo: undefined }), 'home')], { resources: [{ url: `${origin}/favicon.ico`, purpose: 'favicon' }] }),
      ['not_applicable', 'no-logo']);
    assert.deepEqual(outcome(organizationLogo, pages), ['not_evaluated', 'missing-input:resources']);
  });
});

describe('schema-organization-identifiers', () => {
  const company = { ...org, leiCode: '5493001KJTIIGC8Y1R12', vatID: 'ESB12345678', telephone: '+34 600 000 001',
    address: { '@type': 'PostalAddress', addressCountry: 'ES' } };
  test('passes well-formed identifiers', () => passes(organizationIdentifiers, [at(home, ld(company), 'home')]));
  test('reports a country name as low, by shape for identifiers', () => {
    const { finding, excerpts } = failure(organizationIdentifiers, [at(home, ld({ ...company, address: { '@type': 'PostalAddress', addressCountry: 'Spain' } }), 'home')], 'country-not-alpha2');
    assert.equal(finding.severity, 'low');
    assert.equal(excerpts[0], 'Spain');
    const lei = failure(organizationIdentifiers, [at(home, ld({ ...company, leiCode: '5493001KJTIIGC8Y1R13' }), 'home')], 'malformed-identifier');
    assert.equal(lei.excerpts[0], '9999999AAAAAAA9A9A99');
  });
  test('is not applicable without organizations', () => {
    assert.deepEqual(outcome(organizationIdentifiers, [at(home, ld(website), 'home')]), ['not_applicable', 'no-organization']);
  });
});

describe('schema-site-name-website', () => {
  const og = '<meta property="og:site_name" content="Acme">';
  test('passes one named WebSite consistent with og:site_name and Organization', () => passes(siteNameWebsite, [at(home, og + ld(website, { ...org, name: 'Acme S.L.' }), 'home')]));
  test('reports a missing WebSite as low, since Google falls back to other signals', () => {
    const { finding } = failure(siteNameWebsite, [at(home, og + ld(org), 'home')], 'missing');
    assert.equal(finding.severity, 'low');
  });
  test('fails several WebSite items at medium severity', () => {
    const { finding } = failure(siteNameWebsite, [at(home, ld(website, { '@type': 'WebSite', name: 'Acme Shop' }), 'home')], 'several-websites');
    assert.deepEqual([finding.severity, finding.params?.items], ['medium', '2 WebSite']);
  });
  test('hands a name conflict to the analyst', () => {
    const { finding, excerpts } = failure(siteNameWebsite, [at(home, '<meta property="og:site_name" content="Lumo Store">' + ld(website), 'home')], 'name-conflict');
    assert.deepEqual([finding.severity, finding.needsJudgment], ['medium', true]);
    assert.deepEqual(excerpts, ['Acme', 'Lumo Store']);
  });
  test('accepts markup on the locale home page the root redirects to, with url at the root', () => {
    const localeHome = page(`${origin}/es/`, { html: doc(og + ld(website), 'es'), pageType: 'home' });
    const { all } = siteResult(siteNameWebsite, [localeHome], { homeUrl: `${origin}/es/` });
    assert.deepEqual(all.map(entry => entry.outcome), ['pass']);
  });
  test('needs the home page', () => {
    assert.deepEqual(outcome(siteNameWebsite, [at(`${origin}/a/b`, ld(website), 'other')], { homeUrl: `${origin}/gone/` }), ['not_evaluated', 'no-home-page']);
  });
});

describe('schema-sitelinks-searchbox-obsolete', () => {
  test('passes when SearchAction is absent, always', () => passes(sitelinksSearchboxObsolete, [at(home, ld(website), 'home')]));
  test('reports SearchAction as info', () => {
    const search = { ...website, potentialAction: { '@type': 'SearchAction', target: `${origin}/search?q={q}`, 'query-input': 'required name=q' } };
    const { finding } = failure(sitelinksSearchboxObsolete, [at(home, ld(search), 'home')], 'present');
    assert.equal(finding.severity, 'info');
  });
  test('needs fetched pages', () => assert.deepEqual(outcome(sitelinksSearchboxObsolete, []), ['not_evaluated', 'missing-input:http']));
});

describe('schema-inlanguage', () => {
  test('passes inLanguage matching html lang, and a missing inLanguage', () => {
    passes(inLanguage, [at(home, ld({ '@type': 'WebPage', inLanguage: 'es-ES' }), 'home', 'es'), at(`${origin}/a`, ld({ '@type': 'WebPage', name: 'x' }), 'other')]);
  });
  test('reports a contradiction with html lang as low', () => {
    const { finding, excerpts } = failure(inLanguage, [at(home, ld({ '@type': 'WebPage', inLanguage: 'en' }), 'home', 'ca')], 'contradicts-html-lang');
    assert.equal(finding.severity, 'low');
    assert.deepEqual(excerpts, ['en', 'ca']);
  });
  test('needs fetched pages', () => assert.deepEqual(outcome(inLanguage, []), ['not_evaluated', 'missing-input:http']));
});

describe('schema-return-policy', () => {
  const policy = { '@type': 'MerchantReturnPolicy', applicableCountry: 'ES', returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow', merchantReturnDays: 30 };
  test('passes a complete organization-level policy', () => passes(returnPolicy, [at(home, ld({ ...org, hasMerchantReturnPolicy: policy }), 'home')]));
  test('fails a finite window without days at medium severity', () => {
    const { merchantReturnDays: _days, ...noDays } = policy;
    const { finding } = failure(returnPolicy, [at(home, ld({ ...org, hasMerchantReturnPolicy: noDays }), 'home')], 'finite-without-days');
    assert.equal(finding.severity, 'medium');
  });
  test('accepts a policy given only as a link', () => {
    passes(returnPolicy, [at(home, ld({ ...org, hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', merchantReturnLink: `${origin}/returns` } }), 'home')]);
  });
  test('is not applicable without return policies', () => {
    assert.deepEqual(outcome(returnPolicy, [at(home, ld(org), 'home')]), ['not_applicable', 'no-return-policy']);
  });
});

describe('schema-course-list', () => {
  const course = (name: string) => ({ '@type': 'ListItem', position: 1, item: { '@type': 'Course', name, description: `${name} course`, provider: { '@type': 'Organization', name: 'Acme' } } });
  test('passes a list of three complete courses', () => passes(courseList, [at(`${origin}/courses`, ld({ '@type': 'ItemList', itemListElement: [course('A'), course('B'), course('C')] }), 'listing')]));
  test('reports a list of two courses as low', () => {
    const { finding } = failure(courseList, [at(`${origin}/courses`, ld({ '@type': 'ItemList', itemListElement: [course('A'), course('B')] }), 'listing')], 'too-few-courses');
    assert.deepEqual([finding.severity, finding.params?.items], ['low', '2 courses']);
  });
  test('is not applicable without courses', () => assert.deepEqual(outcome(courseList, [at(home, ld(org), 'home')]), ['not_applicable', 'no-course']));
});

describe('schema-author-entity-quality', () => {
  const post = (author: unknown) => ({ '@type': 'BlogPosting', headline: 'x', author });
  test('passes one consistent author', () => {
    passes(authorEntityQuality, [at(`${origin}/blog/a`, ld(post({ '@type': 'Person', '@id': `${origin}/#ana`, name: 'Ana Pons' })), 'article'),
      at(`${origin}/blog/b`, ld(post({ '@type': 'Person', '@id': `${origin}/#ana`, name: 'Ana Pons' })), 'article')]);
  });
  test('hands placeholder and inconsistent authors to the analyst as low', () => {
    const placeholder = failure(authorEntityQuality, [at(`${origin}/blog/a`, ld(post({ '@type': 'Person', name: 'Admin' })), 'article')], 'placeholder-author');
    assert.deepEqual([placeholder.finding.severity, placeholder.finding.needsJudgment, placeholder.excerpts[0]], ['low', true, 'Admin']);
    const renamed = failure(authorEntityQuality, [at(`${origin}/blog/a`, ld(post({ '@type': 'Person', '@id': '#ana', name: 'Ana Pons' })), 'article'),
      at(`${origin}/blog/b`, ld(post({ '@type': 'Person', '@id': '#ana', name: 'A. Pons' })), 'article')], 'inconsistent-names');
    assert.equal(renamed.finding.params?.items, 'Ana Pons / A. Pons');
  });
  test('is not applicable without authors', () => assert.deepEqual(outcome(authorEntityQuality, [at(home, ld(org), 'home')]), ['not_applicable', 'no-authors']));
});

describe('schema-feature-opportunity', () => {
  test('passes a deep page with breadcrumbs and an article with markup', () => {
    passes(featureOpportunity, [at(`${origin}/blog/post`, `<meta property="og:type" content="article">${ld({ '@type': 'BlogPosting', headline: 'x' }, { '@type': 'BreadcrumbList', itemListElement: [] })}`, 'article')]);
  });
  test('hands og:type article without Article markup to the analyst', () => {
    const { finding, excerpts } = failure(featureOpportunity, [at(`${origin}/news`, '<meta property="og:type" content="article">', 'other')], 'article-markup-missing');
    assert.deepEqual([finding.severity, finding.needsJudgment], ['low', true]);
    assert.equal(excerpts[0], 'og:type article');
  });
  test('never suggests markup for legal pages or the home page', () => {
    passes(featureOpportunity, [at(home, ld(org), 'home'), at(`${origin}/legal/privacy`, '<meta name="robots" content="noindex,follow">', 'legal')]);
  });
  test('needs fetched pages', () => assert.deepEqual(outcome(featureOpportunity, []), ['not_evaluated', 'missing-input:http']));
});

describe('schema-entity-consistency-sitewide', () => {
  test('passes the same Organization on every page, with locale paths in url', () => {
    passes(entityConsistencySitewide, [at(home, ld(org, website), 'home'), at(`${origin}/es/contacto`, ld({ ...org, url: `${origin}/es/` }, website), 'contact')]);
  });
  test('fails differing logos across pages at medium severity', () => {
    const { finding, excerpts } = failure(entityConsistencySitewide, [at(home, ld(org), 'home'), at(`${origin}/about`, ld({ ...org, logo: `${origin}/old-logo.png` }), 'about')], 'conflicting-organization');
    assert.deepEqual([finding.severity, finding.params?.items], ['medium', 'logo']);
    assert.deepEqual(excerpts, [`${origin}/logo.png`, `${origin}/old-logo.png`]);
  });
  test('compares telephones by their digits, with 00 read as the international prefix', () => {
    for (const [first, second] of [['+376 812 345', '+376812345'], ['+376 812 345', '00376 812 345'], ['(376) 812-345', '376 812 345']]) {
      passes(entityConsistencySitewide, [at(home, ld({ ...org, telephone: first }), 'home'), at(`${origin}/about`, ld({ ...org, telephone: second }), 'about')]);
    }
    const { finding } = failure(entityConsistencySitewide, [at(home, ld({ ...org, telephone: '+376 812 345' }), 'home'), at(`${origin}/about`, ld({ ...org, telephone: '+376 812 346' }), 'about')], 'conflicting-organization');
    assert.equal(finding.params?.items, 'telephone');
  });
  test('exempts groups with sub-organizations', () => {
    const group = { ...org, subOrganization: { '@type': 'Organization', name: 'Acme Labs' } };
    assert.deepEqual(outcome(entityConsistencySitewide, [at(home, ld(group), 'home'), at(`${origin}/labs`, ld({ ...org, name: 'Acme Labs' }), 'other')]), ['not_applicable', 'multi-brand-group']);
  });
  test('needs more than one page', () => assert.deepEqual(outcome(entityConsistencySitewide, [at(home, ld(org), 'home')]), ['not_evaluated', 'single-page']));
});
