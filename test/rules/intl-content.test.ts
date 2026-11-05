import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  contentLanguageSignalConflict, htmlLangMissingOrInvalid, htmlLangVsContent, metadataTranslationParity, mixedLanguagePage, ogLocale,
  untranslatedVariant, valueVsContentLanguage,
} from '../../src/rules/intl/language-rules.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';
import { samples } from './intl-language-samples.ts';
import { assertFail, assertOutcome, cluster, excerpts, html, only, prose, url } from './intl-fixtures.ts';

const en = url('/en/');
const ca = url('/ca/');
const es = url('/es/');
const versions = { en, ca, es };
const paragraphs = (language: string) => samples.filter(sample => sample.language === language).map(sample => `<p>${sample.text}</p>`);

describe('intl-hreflang-value-vs-content-language', () => {
  test('passes Catalan content declared as ca', () => {
    const facts = site({ pages: [page(ca, { html: html({ lang: 'ca', head: cluster(versions), body: prose('ca') }) })] });
    assertOutcome(outcomeOn(evaluate(valueVsContentLanguage, facts).findings, ca), 'pass');
  });

  test('fails English content declared as German and quotes the text', () => {
    const de = url('/de/');
    const facts = site({ pages: [page(de, { html: html({ lang: 'de', head: cluster({ en, de }), body: prose('en') }) })] });
    const { findings, evidence } = evaluate(valueVsContentLanguage, facts);
    const finding = outcomeOn(findings, de);
    assertFail(finding, 'medium');
    assert.equal(finding!.needsJudgment, undefined);
    assert.deepEqual([finding!.params?.declared, finding!.params?.detected], ['German', 'English']);
    assert.ok(excerpts(finding!, evidence).some(excerpt => excerpt.startsWith('We are a design studio')));
  });

  test('asks the analyst when Catalan is declared and Spanish is detected', () => {
    const facts = site({ pages: [page(ca, { html: html({ lang: 'ca', head: cluster(versions), body: prose('es') }) })] });
    const finding = outcomeOn(evaluate(valueVsContentLanguage, facts).findings, ca);
    assertFail(finding, 'medium');
    assert.equal(finding!.needsJudgment, true);
  });

  test('does not decide on a short About page', () => {
    const about = url('/ca/qui-som/');
    const facts = site({ pages: [page(about, { html: html({ lang: 'ca', head: cluster({ ca: about, en: url('/en/about/') }), body: '<p>Som un equip petit.</p>' }) })] });
    assertOutcome(outcomeOn(evaluate(valueVsContentLanguage, facts).findings, about), 'not_evaluated', 'language-undetermined');
  });

  test('is not evaluated for languages the identifier does not cover', () => {
    const gl = url('/gl/');
    const facts = site({ pages: [page(gl, { html: html({ lang: 'gl', head: cluster({ gl, es }), body: prose('pt') }) })] });
    assertOutcome(outcomeOn(evaluate(valueVsContentLanguage, facts).findings, gl), 'not_evaluated', 'language-not-detectable');
  });

  test('is not applicable without hreflang for the page', () => {
    assertOutcome(outcomeOn(evaluate(valueVsContentLanguage, site({ pages: [page(en, { html: html({ lang: 'en', body: prose('en') }) })] })).findings, en), 'not_applicable', 'no-hreflang-for-page');
  });
});

describe('intl-html-lang-missing-or-invalid', () => {
  test('passes es-419, which BCP 47 allows', () => {
    assertOutcome(outcomeOn(evaluate(htmlLangMissingOrInvalid, site({ pages: [page(es, { html: html({ lang: 'es-419' }) })] })).findings, es), 'pass');
  });

  test('fails a missing lang and quotes the html start tag', () => {
    const { findings, evidence } = evaluate(htmlLangMissingOrInvalid, site({ pages: [page(es, { html: html({}) })] }));
    const finding = outcomeOn(findings, es);
    assertFail(finding, 'low', 'missing');
    assert.deepEqual(excerpts(finding!, evidence), ['<html>']);
  });

  test('fails an underscore tag', () => {
    assertFail(outcomeOn(evaluate(htmlLangMissingOrInvalid, site({ pages: [page(es, { html: html({ lang: 'es_ES' }) })] })).findings, es), 'low', 'malformed');
  });

  test('is not evaluated without HTML', () => {
    assertOutcome(outcomeOn(evaluate(htmlLangMissingOrInvalid, site({ pages: [page(es, {})] })).findings, es), 'not_evaluated', 'missing-input:raw-html');
  });
});

describe('intl-html-lang-vs-content', () => {
  test('passes a matching lang', () => {
    assertOutcome(outcomeOn(evaluate(htmlLangVsContent, site({ pages: [page(es, { html: html({ lang: 'es-ES', body: prose('es') }) })] })).findings, es), 'pass');
  });

  test('fails lang="en" on a French page', () => {
    const fr = url('/fr/');
    const { findings, evidence } = evaluate(htmlLangVsContent, site({ pages: [page(fr, { html: html({ lang: 'en', body: prose('fr') }) })] }));
    const finding = outcomeOn(findings, fr);
    assertFail(finding, 'low');
    assert.ok(excerpts(finding!, evidence).includes('<html lang="en">'));
  });

  test('is not applicable without a lang attribute', () => {
    assertOutcome(outcomeOn(evaluate(htmlLangVsContent, site({ pages: [page(es, { html: html({ body: prose('es') }) })] })).findings, es), 'not_applicable', 'no-valid-lang');
  });
});

describe('intl-content-language-signal-conflict', () => {
  test('passes a header that matches lang', () => {
    const facts = site({ pages: [page(es, { html: html({ lang: 'es', body: prose('es') }), headers: { 'content-language': 'es' } })] });
    assertOutcome(outcomeOn(evaluate(contentLanguageSignalConflict, facts).findings, es), 'pass');
  });

  test('fails a header that contradicts lang', () => {
    const facts = site({ pages: [page(es, { html: html({ lang: 'es', body: prose('es') }), headers: { 'content-language': 'en' } })] });
    const { findings, evidence } = evaluate(contentLanguageSignalConflict, facts);
    const finding = outcomeOn(findings, es);
    assertFail(finding, 'low', 'conflicts-with-lang');
    assert.ok(excerpts(finding!, evidence).includes('Content-Language: en'));
  });

  test('reports the meta pragma as info', () => {
    const facts = site({ pages: [page(es, { html: html({ lang: 'es', head: '<meta http-equiv="content-language" content="es">', body: prose('es') }) })] });
    assertFail(outcomeOn(evaluate(contentLanguageSignalConflict, facts).findings, es), 'info', 'meta-pragma');
  });

  test('is not applicable without Content-Language, which is normal', () => {
    assertOutcome(outcomeOn(evaluate(contentLanguageSignalConflict, site({ pages: [page(es, { html: html({ lang: 'es' }) })] })).findings, es), 'not_applicable', 'no-content-language');
  });
});

describe('intl-mixed-language-page', () => {
  test('passes a Catalan page with an English cookie banner outside main', () => {
    const banner = '<div id="cookie-banner"><h2>We use cookies</h2><p>We use cookies to understand how visitors use the site and to remember your preferences. You can accept all cookies, reject them or choose which ones to allow in the settings at any time.</p></div>';
    const source = `<!doctype html><html lang="ca"><head><title>Inici</title></head><body>${banner}<main>${prose('ca')}</main></body></html>`;
    assertOutcome(outcomeOn(evaluate(mixedLanguagePage, site({ pages: [page(ca, { html: source })] })).findings, ca), 'pass');
  });

  test('flags English blocks in Catalan main content for the analyst', () => {
    const body = [...paragraphs('ca'), ...paragraphs('ca'), ...paragraphs('en')].join('');
    const { findings, evidence } = evaluate(mixedLanguagePage, site({ pages: [page(ca, { html: html({ lang: 'ca', body }) })] }));
    const finding = outcomeOn(findings, ca);
    assertFail(finding, 'medium');
    assert.equal(finding!.needsJudgment, true);
    assert.deepEqual([finding!.params?.primary, finding!.params?.secondary], ['Catalan', 'English']);
    assert.ok(excerpts(finding!, evidence)[0]!.startsWith('We are a design studio'));
  });

  test('is not evaluated on a page with little text', () => {
    assertOutcome(outcomeOn(evaluate(mixedLanguagePage, site({ pages: [page(ca, { html: html({ lang: 'ca', body: '<p>Hola</p>' }) })] })).findings, ca), 'not_evaluated', 'too-little-text');
  });
});

describe('intl-untranslated-variant', () => {
  test('passes translated versions', () => {
    const pages = [page(ca, { html: html({ lang: 'ca', head: cluster(versions), body: prose('ca') }) }), page(es, { html: html({ lang: 'es', head: cluster(versions), body: prose('es') }) })];
    assertOutcome(only(evaluate(untranslatedVariant, site({ pages })).findings), 'pass');
  });

  test('fails a Spanish version that serves the English text', () => {
    const pages = [page(en, { html: html({ lang: 'en', head: cluster(versions), body: prose('en') }) }), page(es, { html: html({ lang: 'es', head: cluster(versions), body: prose('en') }) })];
    const { findings, evidence } = evaluate(untranslatedVariant, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'medium', 'near-identical');
    assert.equal(finding.params?.similarity, 1);
    assert.ok(excerpts(finding, evidence).every(excerpt => excerpt.startsWith('We are a design studio')));
  });

  test('does not compare regional variants of one language', () => {
    const gb = url('/en-gb/');
    const us = url('/en-us/');
    const head = cluster({ 'en-GB': gb, 'en-US': us });
    const pages = [page(gb, { html: html({ lang: 'en', head, body: prose('en') }) }), page(us, { html: html({ lang: 'en', head, body: prose('en') }) })];
    assertOutcome(only(evaluate(untranslatedVariant, site({ pages })).findings), 'not_evaluated', 'variants-not-fetched');
  });
});

describe('intl-metadata-translation-parity', () => {
  const description = (text: string) => `<meta name="description" content="${text}">`;

  test('passes localized metadata', () => {
    const pages = [
      page(ca, { html: html({ lang: 'ca', title: 'Estudi de disseny per a empreses', head: `${cluster(versions)}${description('Dissenyem webs clares per a empreses petites.')}`, body: prose('ca') }) }),
      page(es, { html: html({ lang: 'es', title: 'Estudio de diseño para empresas', head: `${cluster(versions)}${description('Diseñamos webs claras para empresas pequeñas.')}`, body: prose('es') }) }),
    ];
    assertOutcome(outcomeOn(evaluate(metadataTranslationParity, site({ pages })).findings, ca), 'pass');
  });

  test('flags a description copied from the Spanish version', () => {
    const copied = description('Diseñamos webs claras para empresas pequeñas.');
    const pages = [
      page(ca, { html: html({ lang: 'ca', title: 'Estudi de disseny', head: `${cluster(versions)}${copied}`, body: prose('ca') }) }),
      page(es, { html: html({ lang: 'es', title: 'Estudio de diseño', head: `${cluster(versions)}${copied}`, body: prose('es') }) }),
    ];
    const { findings, evidence } = evaluate(metadataTranslationParity, site({ pages }));
    const finding = outcomeOn(findings, ca);
    assertFail(finding, 'medium', 'identical-to-other-locale');
    assert.equal(finding!.needsJudgment, true);
    assert.ok(excerpts(finding!, evidence).every(excerpt => excerpt === copied));
  });

  test('is not applicable without hreflang for the page', () => {
    assertOutcome(outcomeOn(evaluate(metadataTranslationParity, site({ pages: [page(ca, { html: html({ lang: 'ca', body: prose('ca') }) })] })).findings, ca), 'not_applicable', 'no-hreflang-for-page');
  });
});

describe('intl-og-locale', () => {
  test('passes a matching og:locale', () => {
    const facts = site({ pages: [page(ca, { html: html({ lang: 'ca', head: '<meta property="og:locale" content="ca_AD">', body: prose('ca') }) })] });
    assertOutcome(outcomeOn(evaluate(ogLocale, facts).findings, ca), 'pass');
  });

  test('fails a hyphenated og:locale and quotes it', () => {
    const facts = site({ pages: [page(ca, { html: html({ lang: 'ca', head: '<meta property="og:locale" content="ca-AD">', body: prose('ca') }) })] });
    const { findings, evidence } = evaluate(ogLocale, facts);
    const finding = outcomeOn(findings, ca);
    assertFail(finding, 'low', 'malformed');
    assert.deepEqual(excerpts(finding!, evidence), ['<meta property="og:locale" content="ca-AD">']);
  });

  const og = '<meta property="og:title" content="Inici">';

  test('fails a missing og:locale on a Catalan page, which consumers read as en_US', () => {
    const { findings, evidence } = evaluate(ogLocale, site({ pages: [page(ca, { html: html({ lang: 'ca', head: og, body: prose('ca') }) })] }));
    const finding = outcomeOn(findings, ca);
    assertFail(finding, 'low', 'missing-non-english');
    assert.ok(excerpts(finding!, evidence)[0]!.startsWith('Som un estudi de disseny'));
  });

  test('is not applicable to a page without Open Graph markup', () => {
    assertOutcome(outcomeOn(evaluate(ogLocale, site({ pages: [page(ca, { html: html({ lang: 'ca', body: prose('ca') }) })] })).findings, ca), 'not_applicable', 'no-open-graph');
  });

  test('is not evaluated when the page language is unknown', () => {
    assertOutcome(outcomeOn(evaluate(ogLocale, site({ pages: [page(ca, { html: html({ head: og, body: '<p>Hola</p>' }) })] })).findings, ca), 'not_evaluated', 'page-language-unknown');
  });
});
