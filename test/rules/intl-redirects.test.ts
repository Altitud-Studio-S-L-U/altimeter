import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProbeFacts, SiteFacts } from '../../src/core/facts.ts';
import type { SiteSpec } from '../support/facts.ts';
import { xDefaultMissing } from '../../src/rules/intl/clusters.ts';
import { autoRedirectByLanguage, localeAdaptiveSameUrl, rootLocaleRedirector, separateUrlsPerLocale } from '../../src/rules/intl/redirects.ts';
import { localizedUrlsUnreachable, targetNot200 } from '../../src/rules/intl/targets.ts';
import { evaluate, page, site } from '../support/facts.ts';
import { assertFail, assertOutcome, cluster, excerpts, html, links, only, prose, url } from './intl-fixtures.ts';

const root = url('/');
const en = url('/en/');
const es = url('/es/');
const ca = url('/ca/');
const service = url('/ca/serveis/');
const languages = ['none', 'en', 'es', 'ca', 'fr', 'de'];
type Probe = NonNullable<SiteSpec['localeProbes']>[number];
const probes = (target: string, spec: (language: string) => Omit<Probe, 'label' | 'url'>): Probe[] =>
  languages.map(language => ({ label: `accept-language:${language}`, url: target, ...spec(language) }));
const servicePage = page(service, { html: html({ lang: 'ca', body: prose('ca') }) });

describe('intl-auto-redirect-by-language', () => {
  test('passes a localized URL that ignores Accept-Language by design', () => {
    const facts = site({ pages: [servicePage], localeProbes: probes(service, () => ({ body: html({ lang: 'ca', body: prose('ca') }) })) });
    assertOutcome(only(evaluate(autoRedirectByLanguage, facts).findings), 'pass');
  });

  test('fails a localized URL that redirects Spanish visitors and shows each hop', () => {
    const facts = site({ pages: [servicePage], localeProbes: probes(service, language => (language === 'es' ? { redirects: [[302, '/es/servicios/']] } : {})) });
    const { findings, evidence } = evaluate(autoRedirectByLanguage, facts);
    const finding = only(findings);
    assertFail(finding, 'high');
    assert.equal(finding.params?.count, 2);
    assert.ok(excerpts(finding, evidence).some(excerpt => excerpt.includes(`302 ${service} -> ${url('/es/servicios/')}`)));
  });

  test('is not applicable when only the root was probed', () => {
    assertOutcome(only(evaluate(autoRedirectByLanguage, site({ pages: [servicePage], localeProbes: probes(root, () => ({})) })).findings), 'not_applicable', 'only-root-probed');
  });

  test('is not evaluated without language probes', () => {
    assertOutcome(only(evaluate(autoRedirectByLanguage, site({ pages: [servicePage] })).findings), 'not_evaluated', 'no-locale-probes');
  });
});

describe('intl-root-locale-redirector', () => {
  const byLanguage = (status: number, headers: Record<string, string>) => probes(root, language => ({
    redirects: [[status, language === 'es' ? '/es/' : '/en/']],
    headers,
  }));
  // The fixture builder puts headers on the final response; the redirect's own headers belong to the first hop.
  const onFirstHop = (probe: ProbeFacts, headers: Record<string, string>): ProbeFacts => {
    const [first, ...rest] = probe.fetch.hops;
    const merged = { ...first!.headers, ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]])) };
    return { ...probe, fetch: { ...probe.fetch, hops: [{ ...first!, headers: merged }, ...rest] } };
  };
  const withHopHeaders = (status: number, headers: Record<string, string>): SiteFacts => {
    const facts = site({ pages: [page(root, { html: html({}) })], localeProbes: byLanguage(status, headers) });
    return { ...facts, localeProbes: facts.localeProbes.map(probe => onFirstHop(probe, headers)) };
  };

  test('passes a temporary, private redirect with Vary: Cookie', () => {
    const facts = withHopHeaders(302, { 'cache-control': 'private, no-store', vary: 'Cookie' });
    assertOutcome(only(evaluate(rootLocaleRedirector, facts).findings), 'pass');
  });

  test('fails a cacheable permanent redirect that depends on Accept-Language', () => {
    const { findings, evidence } = evaluate(rootLocaleRedirector, withHopHeaders(301, {}));
    const finding = findings.find(entry => entry.reason === 'permanent-redirect');
    assertFail(finding, 'low', 'permanent-redirect');
    assert.ok(excerpts(finding!, evidence).some(excerpt => excerpt.startsWith(`301 ${root} -> ${es}`)));
  });

  test('fails a publicly cached redirect without Vary: Accept-Language', () => {
    const findings = evaluate(rootLocaleRedirector, withHopHeaders(302, { 'cache-control': 'public, max-age=3600' })).findings;
    assertFail(only(findings), 'low', 'missing-vary');
  });

  test('passes a root that redirects to one locale whatever the language', () => {
    const facts = site({ pages: [page(root, { html: html({}) })], localeProbes: probes(root, () => ({ redirects: [[301, '/en/']] })) });
    assertOutcome(only(evaluate(rootLocaleRedirector, facts).findings), 'pass');
  });

  test('is not applicable when the root does not redirect', () => {
    const facts = site({ pages: [page(root, { html: html({}) })], localeProbes: probes(root, () => ({})) });
    assertOutcome(only(evaluate(rootLocaleRedirector, facts).findings), 'not_applicable', 'root-does-not-redirect');
  });
});

describe('a root that redirects by country or language to reachable locale homes', () => {
  const versions = { en, es, ca };
  const set = cluster(versions, root);
  const facts = site({
    pages: [
      page(root, { redirects: [[302, '/en/']], headers: { 'cache-control': 'private, no-store', vary: 'Cookie' }, html: html({ lang: 'en', head: set, body: prose('en') }) }),
      page(es, { html: html({ lang: 'es', head: set, body: prose('es') }) }),
      page(ca, { html: html({ lang: 'ca', head: set, body: prose('ca') }) }),
    ],
    homeUrl: en,
    localeProbes: probes(root, language => ({ redirects: [[302, language === 'es' ? '/es/' : language === 'ca' ? '/ca/' : '/en/']] })),
  });

  test('is not reported by any locale rule', () => {
    for (const rule of [xDefaultMissing, targetNot200, localizedUrlsUnreachable, rootLocaleRedirector]) {
      const finding = only(evaluate(rule, facts).findings);
      assert.notEqual(finding.outcome, 'fail', `${rule.id} failed with ${finding.reason ?? ''}`);
    }
  });
});

describe('intl-locale-adaptive-same-url', () => {
  test('passes a URL that serves the same language to every probe', () => {
    const facts = site({ pages: [servicePage], localeProbes: probes(service, () => ({ body: html({ lang: 'ca', body: prose('ca') }) })) });
    assertOutcome(only(evaluate(localeAdaptiveSameUrl, facts).findings), 'pass');
  });

  test('fails a URL that swaps its main content by Accept-Language', () => {
    const facts = site({ pages: [servicePage], localeProbes: probes(service, language => ({ body: html({ lang: language === 'es' ? 'es' : 'ca', body: prose(language === 'es' ? 'es' : 'ca') }) })) });
    const { findings, evidence } = evaluate(localeAdaptiveSameUrl, facts);
    const finding = only(findings);
    assertFail(finding, 'high', 'content-language');
    assert.ok(excerpts(finding, evidence).some(excerpt => excerpt.startsWith('Somos un estudio')));
  });

  test('is not evaluated without language probes', () => {
    assertOutcome(only(evaluate(localeAdaptiveSameUrl, site({ pages: [servicePage] })).findings), 'not_evaluated', 'no-locale-probes');
  });
});

describe('intl-separate-urls-per-locale', () => {
  test('passes distinct paths per locale', () => {
    assertOutcome(only(evaluate(separateUrlsPerLocale, site({ pages: [page(ca, { html: html({ head: cluster({ ca, es }) }) })] })).findings), 'pass');
  });

  test('fails locales selected by a parameter', () => {
    const facts = site({ pages: [page(ca, { html: html({ head: links([['ca', ca], ['es', url('/?lang=es')]]) }) })] });
    const { findings, evidence } = evaluate(separateUrlsPerLocale, facts);
    const finding = only(findings);
    assertFail(finding, 'medium', 'locale-parameter');
    assert.match(excerpts(finding, evidence)[0]!, /href="https:\/\/example.com\/\?lang=es"/u);
  });

  test('ignores tracking parameters', () => {
    assertOutcome(only(evaluate(separateUrlsPerLocale, site({ pages: [page(ca, { html: html({ head: links([['ca', ca], ['es', url('/es/?utm_source=nav')]]) }) })] })).findings), 'pass');
  });

  test('is not applicable without locale signals', () => {
    assertOutcome(only(evaluate(separateUrlsPerLocale, site({ pages: [page(ca, { html: html({ body: '<a href="/contact">Contacte</a>' }) })] })).findings), 'not_applicable', 'no-locale-signals');
  });
});
