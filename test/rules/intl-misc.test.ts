import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  areaServedFormat, geoMetaTagsIgnored, languageSwitcherCrawlable, notranslateInUse, tldGeotargetingClassification, urlStructureAssessment,
} from '../../src/rules/intl/misc.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';
import { assertFail, assertOutcome, cluster, excerpts, html, links, only, prose, url } from './intl-fixtures.ts';

const ca = url('/ca/');
const service = url('/ca/serveis/');
const jsonLd = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe('intl-geo-meta-tags-ignored', () => {
  test('passes a page without locational meta elements', () => {
    assertOutcome(outcomeOn(evaluate(geoMetaTagsIgnored, site({ pages: [page(ca, { html: html({}) })] })).findings, ca), 'pass');
  });

  test('reports geo.region as info, never as a signal', () => {
    const { findings, evidence } = evaluate(geoMetaTagsIgnored, site({ pages: [page(ca, { html: html({ head: '<meta name="geo.region" content="AD-07">' }) })] }));
    const finding = outcomeOn(findings, ca);
    assertFail(finding, 'info');
    assert.deepEqual(excerpts(finding!, evidence), ['<meta name="geo.region" content="AD-07">']);
  });

  test('is not evaluated without HTML', () => {
    assertOutcome(outcomeOn(evaluate(geoMetaTagsIgnored, site({ pages: [page(ca, {})] })).findings, ca), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('intl-tld-geotargeting-classification', () => {
  test('treats .ad as generic', () => {
    const facts = site({ origin: 'https://example.ad', pages: [page('https://example.ad/ca/', { html: html({ head: links([['ca-AD', 'https://example.ad/ca/'], ['es-ES', 'https://example.ad/es/']]) }) })] });
    const { findings, evidence } = evaluate(tldGeotargetingClassification, facts);
    assertOutcome(only(findings), 'pass');
    assert.equal(evidence.get(only(findings).evidence[0]!)?.label, '.ad, which Google treats as generic');
  });

  test('notes hreflang regions for other countries on a country-code TLD', () => {
    const facts = site({ origin: 'https://example.fr', pages: [page('https://example.fr/', { html: html({ head: links([['fr-FR', 'https://example.fr/'], ['es-ES', 'https://example.fr/es/']]) }) })] });
    const finding = only(evaluate(tldGeotargetingClassification, facts).findings);
    assertFail(finding, 'info', 'cctld-foreign-regions');
    assert.equal(finding.params?.regions, 'ES');
  });

  test('is not applicable to an IP address', () => {
    assertOutcome(only(evaluate(tldGeotargetingClassification, site({ origin: 'https://192.0.2.1', pages: [page('https://192.0.2.1/', { html: html({}) })] })).findings), 'not_applicable', 'no-domain-name');
  });
});

describe('intl-url-structure-assessment', () => {
  test('describes subdirectories without judging them', () => {
    assertOutcome(only(evaluate(urlStructureAssessment, site({ pages: [page(ca, { html: html({ head: cluster({ ca, es: url('/es/'), en: url('/') }) }) })] })).findings), 'pass');
  });

  test('notes mixed schemes as info', () => {
    const facts = site({ pages: [page(ca, { html: html({ head: links([['ca', ca], ['fr', 'https://fr.example.com/']]) }) })] });
    const { findings, evidence } = evaluate(urlStructureAssessment, facts);
    const finding = only(findings);
    assertFail(finding, 'info', 'mixed-schemes');
    assert.equal(excerpts(finding, evidence).length, 2);
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(only(evaluate(urlStructureAssessment, site({ pages: [page(ca, { html: html({}) })] })).findings), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-area-served-format', () => {
  test('passes places and plain names', () => {
    const markup = jsonLd({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Studio', areaServed: [{ '@type': 'Country', name: 'Andorra' }, 'Pyrenees'] });
    assertOutcome(outcomeOn(evaluate(areaServedFormat, site({ pages: [page(ca, { html: html({ head: markup }) })] })).findings, ca), 'pass');
  });

  test('fails a postal address used as the served area', () => {
    const value = { '@type': 'PostalAddress', addressLocality: 'Andorra la Vella' };
    const markup = jsonLd({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Studio', areaServed: value });
    const { findings, evidence } = evaluate(areaServedFormat, site({ pages: [page(ca, { html: html({ head: markup }) })] }));
    const finding = outcomeOn(findings, ca);
    assertFail(finding, 'low', 'invalid-value-type');
    assert.deepEqual(excerpts(finding!, evidence), [JSON.stringify(value)]);
  });

  test('fails a page URL used as the served area', () => {
    const markup = jsonLd({ '@context': 'https://schema.org', '@type': 'Service', name: 'Design', areaServed: 'https://example.com/ca/zones/' });
    assertFail(outcomeOn(evaluate(areaServedFormat, site({ pages: [page(ca, { html: html({ head: markup }) })] })).findings, ca), 'low', 'url-value');
  });

  test('is not applicable without areaServed', () => {
    assertOutcome(outcomeOn(evaluate(areaServedFormat, site({ pages: [page(ca, { html: html({}) })] })).findings, ca), 'not_applicable', 'no-area-served');
  });
});

describe('intl-notranslate-in-use', () => {
  test('passes without notranslate', () => {
    assertOutcome(outcomeOn(evaluate(notranslateInUse, site({ pages: [page(ca, { html: html({ head: '<meta name="robots" content="max-image-preview:large">' }) })] })).findings, ca), 'pass');
  });

  test('reports notranslate as context', () => {
    const { findings, evidence } = evaluate(notranslateInUse, site({ pages: [page(ca, { html: html({}), headers: { 'x-robots-tag': 'notranslate' } })] }));
    const finding = outcomeOn(findings, ca);
    assertFail(finding, 'info');
    assert.deepEqual(excerpts(finding!, evidence), ['notranslate']);
  });

  test('is not evaluated without HTML', () => {
    assertOutcome(outcomeOn(evaluate(notranslateInUse, site({ pages: [page(ca, {})] })).findings, ca), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('intl-language-switcher-crawlable', () => {
  const servicio = url('/es/servicios/');
  const head = cluster({ ca: service, es: servicio });

  test('passes a link to the equivalent page', () => {
    const facts = site({ pages: [page(service, { html: html({ head, body: `<nav><a href="/es/servicios/" hreflang="es">Español</a></nav>${prose('ca')}` }) })] });
    const { findings, evidence } = evaluate(languageSwitcherCrawlable, facts);
    assertOutcome(outcomeOn(findings, service), 'pass');
    assert.match(excerpts(outcomeOn(findings, service)!, evidence)[0]!, /href="\/es\/servicios\/"/u);
  });

  test('flags a button switcher without links for the analyst', () => {
    const facts = site({ pages: [page(service, { html: html({ head, body: `<button onclick="setLang('es')">Español</button>${prose('ca')}` }) })] });
    const { findings, evidence } = evaluate(languageSwitcherCrawlable, facts);
    const finding = outcomeOn(findings, service);
    assertFail(finding, 'medium', 'no-crawlable-links');
    assert.equal(finding!.needsJudgment, true);
    assert.ok(excerpts(finding!, evidence).includes('<button>Español</button>'));
  });

  test('notes links that only reach locale home pages', () => {
    const facts = site({ pages: [page(service, { html: html({ head, body: `<a href="/es/">Español</a>${prose('ca')}` }) })] });
    assertFail(outcomeOn(evaluate(languageSwitcherCrawlable, facts).findings, service), 'info', 'homepages-only');
  });

  test('is not applicable to a page without other language versions', () => {
    assertOutcome(outcomeOn(evaluate(languageSwitcherCrawlable, site({ pages: [page(service, { html: html({ body: prose('ca') }) })] })).findings, service), 'not_applicable', 'no-alternates');
  });
});

