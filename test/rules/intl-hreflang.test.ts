import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bcp47Problem, iso3166, iso639_1, parseHreflang } from '../../src/rules/intl/codes.ts';
import { documentFacts } from '../../src/collect/page.ts';
import { documentAnnotations, parseLinkHeader } from '../../src/rules/intl/annotations.ts';
import { combinedLinkAttributes, httpHeaderFormat, outsideHead, relativeUrl, renderedOnly } from '../../src/rules/intl/placement.ts';
import { invalidLanguageCode, invalidRegionCode, invalidScriptOrSyntax, regionOnlyValue } from '../../src/rules/intl/values.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';
import { assertFail, assertOutcome, excerpts, html, links, prose, url } from './intl-fixtures.ts';

const home = url('/en/');
const withLinks = (entries: ReadonlyArray<readonly [string, string]>, extra: { headers?: Record<string, string>; rendered?: string } = {}) =>
  site({ pages: [page(home, { html: html({ lang: 'en', head: links(entries), body: prose('en') }), ...extra })] });
const noHreflang = site({ pages: [page(home, { html: html({ lang: 'en', body: '<p>Hello</p>' }) })] });

describe('hreflang annotations', () => {
  test('resolve relative hrefs against the base element and belong to the page that declares them', () => {
    const doc = documentFacts(html({ lang: 'en', head: `<base href="${url('/en/blog/')}">\n${links([['ca', 'ca/']])}` }));
    const [annotation] = documentAnnotations(doc, url('/en/about/'), 'html');
    assert.deepEqual([annotation?.href, annotation?.declaringUrl], [url('/en/blog/ca/'), url('/en/about/')]);
  });
});

describe('hreflang grammar', () => {
  test('bundles complete code lists', () => {
    assert.equal(iso3166.size, 249);
    assert.ok(iso639_1.size >= 183);
  });

  test('parses the documented forms case-insensitively', () => {
    for (const value of ['en', 'EN', 'en-GB', 'en-gb', 'zh-Hant', 'zh-Hans-US', 'x-default', 'X-Default', 'ca', 'ca-AD']) {
      assert.deepEqual(parseHreflang(value).problems, [], value);
    }
  });

  test('names each defect', () => {
    const problems = (value: string) => parseHreflang(value).problems;
    assert.deepEqual(problems('en_GB'), ['underscore']);
    assert.deepEqual(problems('en-UK'), ['reserved-region']);
    assert.deepEqual(problems('es-419'), ['numeric-region']);
    assert.deepEqual(problems('fil'), ['language-not-two-letters']);
    assert.deepEqual(problems('us'), ['country-as-language']);
    assert.deepEqual(problems('zh-TW-Hant'), ['script-after-region']);
    assert.deepEqual(problems('ca-ES-valencia'), ['variant']);
    assert.deepEqual(problems('x-klingon'), ['private-use']);
    assert.deepEqual(problems('iw'), ['withdrawn-language']);
    assert.deepEqual(problems('sr-Abcd'), ['unknown-script']);
  });

  test('validates lang attributes as BCP 47, which allows more than hreflang', () => {
    for (const value of ['es-419', 'ast', 'ca-ES-valencia', 'sr-Latn-RS', 'en']) assert.equal(bcp47Problem(value), undefined, value);
    assert.equal(bcp47Problem('en_US'), 'malformed');
    assert.equal(bcp47Problem('zz'), 'unknown-language');
    assert.equal(bcp47Problem(''), 'empty');
  });

  test('parses Link headers with quoted commas and several lines', () => {
    const parsed = parseLinkHeader(['<https://example.com/a,b>; rel="alternate"; hreflang="en", <https://example.com/fr/>; rel=alternate; hreflang=fr', '<https://example.com/de/>; rel="alternate"; hreflang="de"']);
    assert.deepEqual(parsed.links.map(link => [link.uri, link.params.hreflang]), [['https://example.com/a,b', 'en'], ['https://example.com/fr/', 'fr'], ['https://example.com/de/', 'de']]);
    assert.deepEqual(parsed.errors, []);
  });
});

describe('intl-hreflang-invalid-language-code', () => {
  test('passes ISO 639-1 codes in any case', () => {
    const { findings } = evaluate(invalidLanguageCode, withLinks([['EN', home], ['ca', url('/ca/')], ['x-default', home]]));
    assertOutcome(outcomeOn(findings, home), 'pass');
  });

  test('fails a three-letter code and quotes the element', () => {
    const { findings, evidence } = evaluate(invalidLanguageCode, withLinks([['en', home], ['fil', url('/fil/')]]));
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'medium', 'language-not-two-letters');
    assert.equal(finding!.params?.values, '"fil"');
    assert.match(excerpts(finding!, evidence)[0]!, /<link rel="alternate" hreflang="fil" href="https:\/\/example.com\/fil\/">/u);
  });

  test('reads the Link header and grades a withdrawn code lower', () => {
    const facts = withLinks([['en', home]], { headers: { link: '<https://example.com/he/>; rel="alternate"; hreflang="iw"' } });
    const finding = outcomeOn(evaluate(invalidLanguageCode, facts).findings, home);
    assertFail(finding, 'low', 'withdrawn-language');
    assert.equal(finding!.params?.replacement, 'he');
  });

  test('leaves a country code used alone to the region-only rule', () => {
    assertOutcome(outcomeOn(evaluate(invalidLanguageCode, withLinks([['en', home], ['us', url('/us/')]])).findings, home), 'pass');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(invalidLanguageCode, noHreflang).findings, home), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-region-only-value', () => {
  test('passes "ca" when the target is in Catalan', () => {
    const ca = url('/ca/');
    const facts = site({ pages: [
      page(home, { html: html({ lang: 'en', head: links([['en', home], ['ca', ca]]), body: prose('en') }) }),
      page(ca, { html: html({ lang: 'ca', head: links([['en', home], ['ca', ca]]), body: prose('ca') }) }),
    ] });
    assertOutcome(outcomeOn(evaluate(regionOnlyValue, facts).findings, home), 'pass');
  });

  test('fails a country code that is not a language', () => {
    const { findings, evidence } = evaluate(regionOnlyValue, withLinks([['en', home], ['at', url('/at/')]]));
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'medium', 'country-as-language');
    assert.match(excerpts(finding!, evidence)[0]!, /hreflang="at"/u);
  });

  test('asks the analyst when "ca" points to English content', () => {
    const canada = url('/canada/');
    const facts = site({ pages: [
      page(home, { html: html({ lang: 'en', head: links([['en', home], ['ca', canada]]), body: prose('en') }) }),
      page(canada, { html: html({ lang: 'en', head: links([['en', home], ['ca', canada]]), body: prose('en') }) }),
    ] });
    const finding = outcomeOn(evaluate(regionOnlyValue, facts).findings, home);
    assertFail(finding, 'medium', 'possible-country');
    assert.equal(finding!.needsJudgment, true);
    assert.equal(finding!.params?.detected, 'English');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(regionOnlyValue, noHreflang).findings, home), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-invalid-region-code', () => {
  test('passes assigned regions', () => {
    assertOutcome(outcomeOn(evaluate(invalidRegionCode, withLinks([['en-GB', home], ['ca-AD', url('/ca/')]])).findings, home), 'pass');
  });

  test('fails en-UK with the replacement', () => {
    const { findings, evidence } = evaluate(invalidRegionCode, withLinks([['en-GB', home], ['en-UK', url('/uk/')]]));
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'medium', 'reserved-region');
    assert.equal(finding!.params?.replacement, 'GB');
    assert.match(excerpts(finding!, evidence)[0]!, /hreflang="en-UK"/u);
  });

  test('fails es-419', () => {
    assertFail(outcomeOn(evaluate(invalidRegionCode, withLinks([['en', home], ['es-419', url('/latam/')]])).findings, home), 'medium', 'numeric-region');
  });

  test('is not applicable when no value has a region', () => {
    assertOutcome(outcomeOn(evaluate(invalidRegionCode, withLinks([['en', home], ['ca', url('/ca/')]])).findings, home), 'not_applicable', 'no-region-subtag');
  });
});

describe('intl-hreflang-invalid-script-or-syntax', () => {
  test('passes language-Script-REGION', () => {
    assertOutcome(outcomeOn(evaluate(invalidScriptOrSyntax, withLinks([['zh-Hant-TW', url('/tw/')], ['en', home]])).findings, home), 'pass');
  });

  test('fails an underscore separator', () => {
    const { findings, evidence } = evaluate(invalidScriptOrSyntax, withLinks([['en_GB', home]]));
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'medium', 'underscore');
    assert.match(excerpts(finding!, evidence)[0]!, /hreflang="en_GB"/u);
  });

  test('reports a variant as undocumented, below real errors', () => {
    assertFail(outcomeOn(evaluate(invalidScriptOrSyntax, withLinks([['en', home], ['ca-ES-valencia', url('/va/')]])).findings, home), 'low', 'variant');
  });

  test('ignores og:locale, which uses underscores by definition', () => {
    const facts = site({ pages: [page(home, { html: html({ lang: 'en', head: `${links([['en', home]])}<meta property="og:locale" content="en_GB">` }) })] });
    assertOutcome(outcomeOn(evaluate(invalidScriptOrSyntax, facts).findings, home), 'pass');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(invalidScriptOrSyntax, noHreflang).findings, home), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-relative-url', () => {
  test('passes absolute URLs', () => {
    assertOutcome(outcomeOn(evaluate(relativeUrl, withLinks([['en', home], ['ca', url('/ca/')]])).findings, home), 'pass');
  });

  test('fails a root-relative href and quotes it as written', () => {
    const { findings, evidence } = evaluate(relativeUrl, withLinks([['en', home], ['ca', '/ca/']]));
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'high', 'relative');
    assert.equal(finding!.params?.hrefs, '"/ca/"');
    assert.match(excerpts(finding!, evidence)[0]!, /href="\/ca\/"/u);
  });

  test('grades protocol-relative URLs lower', () => {
    assertFail(outcomeOn(evaluate(relativeUrl, withLinks([['en', home], ['ca', '//example.com/ca/']])).findings, home), 'medium', 'protocol-relative');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(relativeUrl, noHreflang).findings, home), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-outside-head', () => {
  test('passes links inside the head', () => {
    assertOutcome(outcomeOn(evaluate(outsideHead, withLinks([['en', home]])).findings, home), 'pass');
  });

  test('fails links pushed into the body by an element in the head, naming the cause', () => {
    const source = `<!doctype html><html lang="en"><head><title>A</title>\n<img src="/pixel.gif">\n${links([['en', home], ['ca', url('/ca/')]])}\n</head><body><p>Hi</p></body></html>`;
    const { findings, evidence } = evaluate(outsideHead, site({ pages: [page(home, { html: source })] }));
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'high', 'raw-body');
    assert.equal(finding!.params?.cause, '<img> element');
    assert.ok(excerpts(finding!, evidence).includes('<img>'));
  });

  test('is not applicable without hreflang links', () => {
    assertOutcome(outcomeOn(evaluate(outsideHead, noHreflang).findings, home), 'not_applicable', 'no-hreflang-links');
  });
});

describe('intl-hreflang-rendered-only', () => {
  const served = html({ lang: 'en', head: links([['en', home]]) });

  test('passes when rendering keeps the same links', () => {
    assertOutcome(outcomeOn(evaluate(renderedOnly, withLinks([['en', home]], { rendered: served })).findings, home), 'pass');
  });

  test('fails links that exist only after rendering', () => {
    const facts = site({ pages: [page(home, { html: html({ lang: 'en' }), rendered: served })] });
    const { findings, evidence } = evaluate(renderedOnly, facts);
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'low', 'rendered-only');
    assert.match(excerpts(finding!, evidence)[0]!, /hreflang="en"/u);
  });

  test('is not evaluated without a render', () => {
    assertOutcome(outcomeOn(evaluate(renderedOnly, withLinks([['en', home]])).findings, home), 'not_evaluated', 'missing-input:rendered-dom');
  });
});

describe('intl-hreflang-combined-link-attributes', () => {
  test('passes separate link elements', () => {
    const facts = site({ pages: [page(home, { html: html({ head: `${links([['en', home]])}<link rel="alternate" media="only screen and (max-width: 640px)" href="https://m.example.com/">` }) })] });
    assertOutcome(outcomeOn(evaluate(combinedLinkAttributes, facts).findings, home), 'pass');
  });

  test('fails hreflang with media in one element', () => {
    const facts = site({ pages: [page(home, { html: html({ head: '<link rel="alternate" hreflang="en" media="only screen and (max-width: 640px)" href="https://m.example.com/">' }) })] });
    const { findings, evidence } = evaluate(combinedLinkAttributes, facts);
    const finding = outcomeOn(findings, home);
    assertFail(finding, 'low', 'media');
    assert.match(excerpts(finding!, evidence)[0]!, /media="only screen/u);
  });

  test('fails hreflang on a canonical link', () => {
    const facts = site({ pages: [page(home, { html: html({ head: `<link rel="canonical" hreflang="en" href="${home}">` }) })] });
    assertFail(outcomeOn(evaluate(combinedLinkAttributes, facts).findings, home), 'low', 'canonical');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(combinedLinkAttributes, noHreflang).findings, home), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-http-header-format', () => {
  const pdf = url('/guide.pdf');
  const headerPage = (link: string) => site({ pages: [page(pdf, { headers: { 'content-type': 'application/pdf', link } })] });

  test('passes a complete header set', () => {
    assertOutcome(outcomeOn(evaluate(httpHeaderFormat, headerPage(`<${pdf}>; rel="alternate"; hreflang="en", <https://example.com/guia.pdf>; rel="alternate"; hreflang="es"`)).findings, pdf), 'pass');
  });

  test('fails a header set without the response URL', () => {
    const { findings, evidence } = evaluate(httpHeaderFormat, headerPage('<https://example.com/guia.pdf>; rel="alternate"; hreflang="es"'));
    const finding = outcomeOn(findings, pdf);
    assertFail(finding, 'low', 'missing-self');
    assert.match(excerpts(finding!, evidence)[0]!, /guia\.pdf/u);
  });

  test('fails a link-value that does not parse', () => {
    assertFail(outcomeOn(evaluate(httpHeaderFormat, headerPage(`<${pdf}>; rel="alternate"; hreflang="en", https://example.com/guia.pdf; rel=alternate; hreflang=es`)).findings, pdf), 'low', 'parse-error');
  });

  test('is not applicable without a Link header, which is normal', () => {
    assertOutcome(outcomeOn(evaluate(httpHeaderFormat, withLinks([['en', home]])).findings, home), 'not_applicable', 'no-link-header');
  });
});
