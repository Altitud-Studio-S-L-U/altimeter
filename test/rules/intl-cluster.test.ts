import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import {
  clusterInconsistentSets, duplicateLocaleInCluster, missingReturnLink, missingSelfReference, noLanguageCatchall, oneUrlManyLanguages,
  sourceConflict, xDefaultInconsistent, xDefaultMissing,
} from '../../src/rules/intl/clusters.ts';
import { sitemapFormat } from '../../src/rules/intl/sitemap.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';
import { assertFail, assertOutcome, cluster, excerpts, html, links, only, origin, prose, sitemap, url } from './intl-fixtures.ts';

const en = url('/en/');
const ca = url('/ca/');
const es = url('/es/');
const root = url('/');
const versions = { en, ca, es };
const member = (address: string, lang: string, head: string): PageFacts => page(address, { html: html({ lang, head, body: prose(lang) }) });
const complete = () => [member(en, 'en', cluster(versions, root)), member(ca, 'ca', cluster(versions, root)), member(es, 'es', cluster(versions, root))];
const monolingual = site({ pages: [page(en, { html: html({ lang: 'en', body: prose('en') }) })] });

describe('intl-hreflang-missing-self-reference', () => {
  test('passes a set that lists the page', () => {
    assertOutcome(outcomeOn(evaluate(missingSelfReference, site({ pages: complete() })).findings, en), 'pass');
  });

  test('explains a trailing-slash near miss', () => {
    const facts = site({ pages: [member(en, 'en', links([['en', url('/en')], ['ca', ca]]))] });
    const { findings, evidence } = evaluate(missingSelfReference, facts);
    const finding = outcomeOn(findings, en);
    assertFail(finding, 'medium', 'near-miss');
    assert.equal(finding!.params?.closest, url('/en'));
    assert.ok(excerpts(finding!, evidence).includes(en));
  });

  test('fails a set without the page', () => {
    assertFail(outcomeOn(evaluate(missingSelfReference, site({ pages: [member(en, 'en', links([['ca', ca], ['es', es]]))] })).findings, en), 'medium', 'absent');
  });

  test('accepts the self entry from the sitemap', () => {
    const facts = site({ pages: [member(en, 'en', links([['ca', ca]]))], sitemaps: [{ url: url('/sitemap.xml'), xml: sitemap([{ loc: en, alternates: [['en', en], ['ca', ca]] }]) }] });
    assertOutcome(outcomeOn(evaluate(missingSelfReference, facts).findings, en), 'pass');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(missingSelfReference, monolingual).findings, en), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-one-url-many-languages', () => {
  test('allows several regions of one language on one URL', () => {
    assertOutcome(outcomeOn(evaluate(oneUrlManyLanguages, site({ pages: [member(en, 'en', links([['en-US', en], ['en-GB', en], ['x-default', en]]))] })).findings, en), 'pass');
  });

  test('fails one URL declared as Spanish and Catalan', () => {
    const { findings, evidence } = evaluate(oneUrlManyLanguages, site({ pages: [member(en, 'en', links([['en', en], ['es', root], ['ca', root]]))] }));
    const finding = outcomeOn(findings, en);
    assertFail(finding, 'medium');
    assert.equal(finding!.params?.languages, 'es, ca');
    assert.match(excerpts(finding!, evidence).join('\n'), /hreflang="ca" href="https:\/\/example.com\/"/u);
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(oneUrlManyLanguages, monolingual).findings, en), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-missing-return-link', () => {
  test('passes a reciprocal cluster', () => {
    assertOutcome(only(evaluate(missingReturnLink, site({ pages: complete() })).findings), 'pass');
  });

  test('fails a target that does not link back and says which pairs still work', () => {
    const pages = [member(en, 'en', cluster(versions)), member(ca, 'ca', cluster(versions)), member(es, 'es', links([['es', es], ['ca', ca]]))];
    const { findings, evidence } = evaluate(missingReturnLink, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'high');
    assert.deepEqual([finding.params?.count, finding.params?.working], [1, 4]);
    assert.match(excerpts(finding, evidence).join('\n'), /hreflang="es" href="https:\/\/example.com\/es\/"/u);
  });

  test('does not require the x-default page to list inner pages', () => {
    const inner = url('/en/about/');
    const innerCa = url('/ca/about/');
    const set = cluster({ en: inner, ca: innerCa }, root);
    const pages = [member(inner, 'en', set), member(innerCa, 'ca', set), member(root, 'en', cluster(versions, root))];
    assertOutcome(only(evaluate(missingReturnLink, site({ pages })).findings), 'pass');
  });

  test('is not evaluated when no target was fetched', () => {
    assertOutcome(only(evaluate(missingReturnLink, site({ pages: [member(en, 'en', cluster(versions))] })).findings), 'not_evaluated', 'targets-not-fetched');
  });

  test('checks the alternates fetched for a single-page audit', () => {
    const alternates = [member(ca, 'ca', cluster(versions)), member(es, 'es', links([['es', es], ['ca', ca]]))];
    assertFail(only(evaluate(missingReturnLink, site({ pages: [member(en, 'en', cluster(versions))], alternates })).findings), 'high');
  });

  test('fails a fetched target without any hreflang when the declaring page serves its set in the HTML', () => {
    const finding = only(evaluate(missingReturnLink, site({ pages: [member(en, 'en', cluster(versions)), member(ca, 'ca', '')] })).findings);
    assertFail(finding, 'high');
    assert.deepEqual([finding.params?.count, finding.params?.working, finding.params?.unverified], [1, 0, 1]);
  });

  test('leaves a target unverified when the declaring set exists only after rendering and the target was not rendered', () => {
    const shell = (lang: string) => html({ lang, body: '<div id="root"></div><script src="/app.js"></script>' });
    const app = page(en, { html: shell('en'), rendered: html({ lang: 'en', head: cluster(versions), body: prose('en') }) });
    const crawled = (...targets: PageFacts[]) => site({ pages: [app, ...targets], crawled: true });
    assertOutcome(only(evaluate(missingReturnLink, crawled(page(ca, { html: shell('ca') }), page(es, { html: shell('es') }))).findings), 'not_evaluated', 'targets-not-rendered');
    const renderedEs = page(es, { html: shell('es'), rendered: html({ lang: 'es', body: prose('es') }) });
    const finding = only(evaluate(missingReturnLink, crawled(page(ca, { html: shell('ca') }), renderedEs)).findings);
    assertFail(finding, 'high');
    assert.deepEqual([finding.params?.count, finding.params?.working, finding.params?.unverified], [1, 0, 1]);
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(only(evaluate(missingReturnLink, monolingual).findings), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-duplicate-locale-in-cluster', () => {
  test('passes one URL per value, even when a URL has two values', () => {
    assertOutcome(only(evaluate(duplicateLocaleInCluster, site({ pages: [member(en, 'en', links([['en', en], ['x-default', en], ['ca', ca]]))] })).findings), 'pass');
  });

  test('fails a value that maps to two URLs, case-insensitively', () => {
    const { findings, evidence } = evaluate(duplicateLocaleInCluster, site({ pages: [member(en, 'en', links([['en-GB', en], ['en-gb', url('/uk/')], ['ca', ca]]))] }));
    const finding = only(findings);
    assertFail(finding, 'high', 'within-page');
    assert.equal(finding.params?.value, 'en-gb');
    assert.deepEqual(excerpts(finding, evidence), [`<link rel="alternate" hreflang="en-GB" href="${en}">`, `<link rel="alternate" hreflang="en-gb" href="${url('/uk/')}">`]);
  });

  test('fails members that disagree on the URL of a value', () => {
    const pages = [member(en, 'en', links([['en', en], ['ca', ca]])), member(ca, 'ca', links([['en', url('/en/home')], ['ca', ca]]))];
    assertFail(only(evaluate(duplicateLocaleInCluster, site({ pages })).findings), 'medium', 'across-cluster');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(only(evaluate(duplicateLocaleInCluster, monolingual).findings), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-cluster-inconsistent-sets', () => {
  test('passes identical sets', () => {
    assertOutcome(only(evaluate(clusterInconsistentSets, site({ pages: complete() })).findings), 'pass');
  });

  test('fails conflicting values for one URL', () => {
    const pages = [member(en, 'en', links([['en', en], ['fr', ca]])), member(ca, 'ca', links([['en', en], ['ca', ca]]))];
    const { findings, evidence } = evaluate(clusterInconsistentSets, site({ pages }));
    const conflict = findings.find(finding => finding.reason === 'conflicting-values');
    assertFail(conflict, 'medium', 'conflicting-values');
    assert.match(excerpts(conflict!, evidence).join('\n'), /hreflang="fr"/u);
  });

  test('keeps missing entries at low', () => {
    const pages = [member(en, 'en', cluster(versions)), member(ca, 'ca', links([['en', en], ['ca', ca]])), member(es, 'es', cluster(versions))];
    assertFail(only(evaluate(clusterInconsistentSets, site({ pages })).findings), 'low', 'missing-entries');
  });

  test('is not evaluated when only one member set is known', () => {
    assertOutcome(only(evaluate(clusterInconsistentSets, site({ pages: [member(en, 'en', cluster(versions))] })).findings), 'not_evaluated', 'single-member-clusters');
  });
});

describe('intl-hreflang-x-default-missing', () => {
  test('passes a cluster with x-default', () => {
    assertOutcome(only(evaluate(xDefaultMissing, site({ pages: complete() })).findings), 'pass');
  });

  test('reports a missing x-default as info', () => {
    const { findings, evidence } = evaluate(xDefaultMissing, site({ pages: [member(en, 'en', cluster(versions))] }));
    const finding = only(findings);
    assertFail(finding, 'info', 'no-x-default');
    assert.equal(excerpts(finding, evidence)[0], 'en, ca, es');
  });

  test('raises it to low when the root redirects by locale', () => {
    const pages = [page(root, { redirects: [[302, '/en/']], html: html({ lang: 'en', head: cluster(versions) }) }), member(ca, 'ca', cluster(versions))];
    const finding = only(evaluate(xDefaultMissing, site({ pages, homeUrl: en })).findings);
    assertFail(finding, 'low', 'redirecting-root');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(only(evaluate(xDefaultMissing, monolingual).findings), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-x-default-inconsistent', () => {
  test('passes one x-default per cluster, and inner clusters may use their own fallback', () => {
    const inner = url('/en/about/');
    const innerCa = url('/ca/about/');
    const pages = [...complete(), member(inner, 'en', cluster({ en: inner, ca: innerCa }, inner)), member(innerCa, 'ca', cluster({ en: inner, ca: innerCa }, inner))];
    assertOutcome(only(evaluate(xDefaultInconsistent, site({ pages })).findings), 'pass');
  });

  test('fails members that point x-default at different URLs', () => {
    const pages = [member(en, 'en', cluster(versions, root)), member(ca, 'ca', cluster(versions, en))];
    const { findings, evidence } = evaluate(xDefaultInconsistent, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'medium');
    assert.equal(finding.params?.count, 2);
    assert.match(excerpts(finding, evidence).join('\n'), /hreflang="x-default"/u);
  });

  test('is not applicable when no member declares x-default', () => {
    assertOutcome(only(evaluate(xDefaultInconsistent, site({ pages: [member(en, 'en', cluster(versions))] })).findings), 'not_applicable', 'no-x-default');
  });
});

describe('intl-hreflang-no-language-catchall', () => {
  test('passes when a language-only value exists', () => {
    assertOutcome(only(evaluate(noLanguageCatchall, site({ pages: [member(es, 'es', links([['es-ES', es], ['es', es], ['es-AD', url('/es-ad/')]]))] })).findings), 'pass');
  });

  test('fails region-only Spanish values without x-default', () => {
    const { findings, evidence } = evaluate(noLanguageCatchall, site({ pages: [member(es, 'es', links([['es-ES', es], ['es-AD', url('/es-ad/')]]))] }));
    const finding = only(findings);
    assertFail(finding, 'low');
    assert.equal(finding.params?.code, 'es');
    assert.match(excerpts(finding, evidence).join('\n'), /hreflang="es-AD"/u);
  });

  test('passes when x-default is the catch-all', () => {
    assertOutcome(only(evaluate(noLanguageCatchall, site({ pages: [member(es, 'es', links([['es-ES', es], ['es-AD', url('/es-ad/')], ['x-default', es]]))] })).findings), 'pass');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(only(evaluate(noLanguageCatchall, monolingual).findings), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-source-conflict', () => {
  const map = url('/sitemap.xml');

  test('passes identical HTML and sitemap sets', () => {
    const facts = site({ pages: [member(en, 'en', links([['en', en], ['ca', ca]]))], sitemaps: [{ url: map, xml: sitemap([{ loc: en, alternates: [['en', en], ['ca', ca]] }]) }] });
    assertOutcome(outcomeOn(evaluate(sourceConflict, facts).findings, en), 'pass');
  });

  test('fails a value whose target differs between the HTML and the sitemap', () => {
    const facts = site({ pages: [member(en, 'en', links([['en', en], ['ca', ca]]))], sitemaps: [{ url: map, xml: sitemap([{ loc: en, alternates: [['en', en], ['ca', url('/cat/')]] }]) }] });
    const { findings, evidence } = evaluate(sourceConflict, facts);
    const finding = findings.find(entry => entry.reason === 'conflicting-target');
    assertFail(finding, 'medium', 'conflicting-target');
    assert.ok(excerpts(finding!, evidence).some(excerpt => excerpt.includes('/cat/')));
  });

  test('is not applicable with a single source', () => {
    assertOutcome(outcomeOn(evaluate(sourceConflict, site({ pages: [member(en, 'en', links([['en', en]]))] })).findings, en), 'not_applicable', 'single-source');
  });
});

describe('intl-hreflang-sitemap-format', () => {
  const map = url('/sitemap-pages.xml');
  const good = sitemap([{ loc: en, alternates: [['en', en], ['ca', ca]] }, { loc: ca, alternates: [['en', en], ['ca', ca]] }]);

  test('passes a complete, reciprocal sitemap', () => {
    assertOutcome(only(evaluate(sitemapFormat, site({ pages: [], origin, sitemaps: [{ url: map, xml: good }] })).findings), 'pass');
  });

  test('passes when /sitemap.xml is 404 but the declared sitemap is fine', () => {
    const facts = site({ pages: [], origin, sitemaps: [{ url: url('/sitemap.xml'), status: 404, source: 'default' }, { url: map, xml: good, source: 'robots' }] });
    assertOutcome(only(evaluate(sitemapFormat, facts).findings), 'pass');
  });

  test('fails an entry without its own alternate and quotes the entry', () => {
    const xml = sitemap([{ loc: en, alternates: [['ca', ca]] }, { loc: ca, alternates: [['en', en], ['ca', ca]] }]);
    const { findings, evidence } = evaluate(sitemapFormat, site({ pages: [], origin, sitemaps: [{ url: map, xml }] }));
    const finding = findings.find(entry => entry.reason === 'missing-self');
    assertFail(finding, 'medium', 'missing-self');
    assert.match(excerpts(finding!, evidence)[0]!, /<loc>https:\/\/example.com\/en\/<\/loc>/u);
  });

  test('fails links outside the xhtml namespace, which are not read', () => {
    const xml = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/en/</loc><xhtml:link rel="alternate" hreflang="ca" href="https://example.com/ca/"/></url></urlset>';
    const finding = only(evaluate(sitemapFormat, site({ pages: [], origin, sitemaps: [{ url: map, xml }] })).findings);
    assertFail(finding, 'medium', 'namespace');
  });

  test('fails an alternate that has no entry of its own', () => {
    const xml = sitemap([{ loc: en, alternates: [['en', en], ['ca', ca]] }]);
    assertFail(only(evaluate(sitemapFormat, site({ pages: [], origin, sitemaps: [{ url: map, xml }] })).findings), 'medium', 'alternate-not-listed');
  });

  test('looks for missing entries only once every declared sitemap was read', () => {
    const languages = ['en', 'es', 'ca', 'fr', 'de', 'it'];
    const set = languages.map(language => [language, url(`/${language}/`)] as const);
    const maps = languages.map(language => ({ url: url(`/sitemap-${language}.xml`), xml: sitemap([{ loc: url(`/${language}/`), alternates: set }]) }));
    const robots = (count: number) => maps.slice(0, count).map(entry => `Sitemap: ${entry.url}`).join('\n');
    const fetched = maps.slice(0, 5);
    assertOutcome(only(evaluate(sitemapFormat, site({ pages: [], origin, robots: robots(6), sitemaps: fetched })).findings), 'pass');
    const declaring = page(url('/'), { html: html({ head: '<link rel="sitemap" type="application/xml" href="/sitemap-it.xml">' }) });
    assertOutcome(only(evaluate(sitemapFormat, site({ pages: [declaring], origin, robots: robots(5), sitemaps: fetched })).findings), 'pass');
    assertFail(only(evaluate(sitemapFormat, site({ pages: [], origin, robots: robots(5), sitemaps: fetched })).findings), 'medium', 'alternate-not-listed');
  });

  test('finds the sitemap a page links where the collector read it: against the final URL and base of that page', () => {
    const xml = sitemap([{ loc: en, alternates: [['en', en], ['ca', ca]] }]);
    const redirected = page(url('/en'), { redirects: [[301, '/en/']], html: html({ head: '<link rel="sitemap" href="sitemap-pages.xml">' }) });
    assertFail(only(evaluate(sitemapFormat, site({ pages: [redirected], origin, sitemaps: [{ url: url('/en/sitemap-pages.xml'), xml }] })).findings), 'medium', 'alternate-not-listed');
    const based = page(en, { html: html({ head: '<base href="/maps/"><link rel="sitemap" href="pages.xml">' }) });
    assertFail(only(evaluate(sitemapFormat, site({ pages: [based], origin, sitemaps: [{ url: url('/maps/pages.xml'), xml }] })).findings), 'medium', 'alternate-not-listed');
  });

  test('does not look for missing entries in a sitemap cut at the 50,000-entry limit', () => {
    const filler = Array.from({ length: 49_999 }, (_, index) => ({ loc: url(`/p/${index}`) }));
    const xml = sitemap([{ loc: en, alternates: [['en', en], ['ca', ca]] }, ...filler, { loc: ca, alternates: [['en', en], ['ca', ca]] }]);
    assertOutcome(only(evaluate(sitemapFormat, site({ pages: [], origin, sitemaps: [{ url: map, xml }] })).findings), 'pass');
  });

  test('accepts alternates on other domains', () => {
    const xml = sitemap([{ loc: en, alternates: [['en', en], ['de', 'https://example.de/']] }]);
    assertOutcome(only(evaluate(sitemapFormat, site({ pages: [], origin, sitemaps: [{ url: map, xml }] })).findings), 'pass');
  });

  test('is not applicable to sitemaps without hreflang', () => {
    assertOutcome(only(evaluate(sitemapFormat, site({ pages: [], origin, sitemaps: [{ url: map, xml: sitemap([{ loc: en }]) }] })).findings), 'not_applicable', 'no-sitemap-hreflang');
  });

  test('is not evaluated without sitemaps', () => {
    assertOutcome(only(evaluate(sitemapFormat, site({ pages: [], origin })).findings), 'not_evaluated', 'missing-input:sitemaps');
  });
});
