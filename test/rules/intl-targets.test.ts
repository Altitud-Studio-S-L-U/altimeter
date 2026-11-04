import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageFacts } from '../../src/core/facts.ts';
import {
  canonicalCrossLanguage, localizedUrlsUnreachable, mixedProtocolOrHost, onNonCanonicalPage, targetBlockedByRobots, targetNoindex,
  targetNot200, targetNotCanonical,
} from '../../src/rules/intl/targets.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';
import { assertFail, assertOutcome, cluster, excerpts, html, links, only, prose, url } from './intl-fixtures.ts';

const en = url('/en/');
const ca = url('/ca/');
const es = url('/es/');
const root = url('/');
const versions = { en, ca, es };
const set = cluster(versions, root);
const member = (address: string, lang: string, head = set, extra: Parameters<typeof page>[1] = {}): PageFacts =>
  page(address, { html: html({ lang, head, body: prose(lang) }), ...extra });
const healthy = () => [member(ca, 'ca'), member(en, 'en'), member(es, 'es')];
const monolingual = site({ pages: [page(en, { html: html({ lang: 'en', body: prose('en') }) })] });

describe('intl-hreflang-target-not-200', () => {
  test('passes targets that answer 200', () => {
    assertOutcome(only(evaluate(targetNot200, site({ pages: healthy() })).findings), 'pass');
  });

  test('accepts an x-default root that redirects by locale to a member of the cluster', () => {
    const pages = [...healthy(), page(root, { redirects: [[302, '/en/']], html: html({ lang: 'en', head: set, body: prose('en') }) })];
    assertOutcome(only(evaluate(targetNot200, site({ pages, homeUrl: en })).findings), 'pass');
  });

  test('fails a target that answers 404 and shows the response', () => {
    const pages = [member(ca, 'ca'), member(en, 'en'), page(es, { status: 404, html: html({ body: 'No' }) })];
    const { findings, evidence } = evaluate(targetNot200, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'high', 'error');
    assert.ok(excerpts(finding, evidence).includes(`404 ${es}`));
  });

  test('grades a plain redirect lower', () => {
    const pages = [member(ca, 'ca', links([['ca', ca], ['es', url('/es')]])), member(url('/es'), 'es', links([['ca', ca], ['es', url('/es')]]), { redirects: [[301, '/es/']] })];
    assertFail(only(evaluate(targetNot200, site({ pages })).findings), 'medium', 'redirect');
  });

  test('is not evaluated when no target was fetched', () => {
    assertOutcome(only(evaluate(targetNot200, site({ pages: [member(ca, 'ca', links([['ca', url('/ca/x')], ['en', url('/en/x')]]))] })).findings), 'not_evaluated', 'targets-not-fetched');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(only(evaluate(targetNot200, monolingual).findings), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-localized-urls-unreachable', () => {
  test('passes locale URLs reachable directly', () => {
    assertOutcome(only(evaluate(localizedUrlsUnreachable, site({ pages: healthy() })).findings), 'pass');
  });

  test('passes when only the x-default root redirects by locale', () => {
    const pages = [...healthy(), page(root, { redirects: [[302, '/en/']], html: html({ lang: 'en', head: set, body: prose('en') }) })];
    assertOutcome(only(evaluate(localizedUrlsUnreachable, site({ pages, homeUrl: en })).findings), 'pass');
  });

  test('fails a locale URL that sends crawlers to another locale', () => {
    const pages = [member(ca, 'ca'), member(en, 'en'), member(es, 'en', set, { redirects: [[302, '/en/']] })];
    const { findings, evidence } = evaluate(localizedUrlsUnreachable, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'critical', 'redirected-away');
    assert.deepEqual([finding.params?.url, finding.params?.final], [es, en]);
    assert.ok(excerpts(finding, evidence).some(excerpt => excerpt.includes(`302 ${es} -> ${en}`)));
  });

  test('treats a redirect to the root that hosts the same language as an ordinary redirect', () => {
    const head = links([['en', root], ['ca', ca]]);
    const pages = [member(ca, 'ca', links([['en', url('/en/')], ['ca', ca]])), member(root, 'en', head), page(url('/en/'), { redirects: [[301, '/']], html: html({ lang: 'en', head, body: prose('en') }) })];
    const facts = site({ pages });
    assertOutcome(only(evaluate(localizedUrlsUnreachable, facts).findings), 'pass');
    assertFail(only(evaluate(targetNot200, facts).findings), 'medium', 'redirect');
  });

  test('is not evaluated when no locale URL was fetched', () => {
    assertOutcome(only(evaluate(localizedUrlsUnreachable, site({ pages: [member(ca, 'ca', links([['ca', url('/ca/x')], ['en', url('/en/x')]]))] })).findings), 'not_evaluated', 'targets-not-fetched');
  });
});

describe('intl-hreflang-target-noindex', () => {
  test('passes indexable targets', () => {
    assertOutcome(only(evaluate(targetNoindex, site({ pages: healthy() })).findings), 'pass');
  });

  test('fails a noindex target of an indexable page and quotes the directive', () => {
    const pages = [member(ca, 'ca'), member(en, 'en'), member(es, 'es', `${set}<meta name="robots" content="noindex">`)];
    const { findings, evidence } = evaluate(targetNoindex, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'high');
    assert.ok(excerpts(finding, evidence).includes('noindex'));
  });

  test('passes a legal set that is noindex in every language', () => {
    const legal = { ca: url('/ca/avis-legal/'), es: url('/es/aviso-legal/') };
    const head = `${cluster(legal)}<meta name="robots" content="noindex,follow">`;
    const pages = [member(legal.ca, 'ca', head), member(legal.es, 'es', head)];
    assertOutcome(only(evaluate(targetNoindex, site({ pages })).findings), 'pass');
  });

  test('is not evaluated when no target was fetched', () => {
    assertOutcome(only(evaluate(targetNoindex, site({ pages: [member(ca, 'ca', links([['ca', url('/ca/x')], ['en', url('/en/x')]]))] })).findings), 'not_evaluated', 'targets-not-fetched');
  });
});

describe('intl-hreflang-target-blocked-by-robots', () => {
  test('passes allowed targets', () => {
    assertOutcome(only(evaluate(targetBlockedByRobots, site({ pages: healthy(), robots: 'User-agent: *\nDisallow: /admin/' })).findings), 'pass');
  });

  test('fails a disallowed locale section and cites the rule', () => {
    const { findings, evidence } = evaluate(targetBlockedByRobots, site({ pages: [member(ca, 'ca')], robots: 'User-agent: *\nDisallow: /es/' }));
    const finding = only(findings);
    assertFail(finding, 'high');
    assert.ok(excerpts(finding, evidence).includes('Disallow: /es/'));
  });

  test('is not evaluated without robots.txt', () => {
    assertOutcome(only(evaluate(targetBlockedByRobots, site({ pages: healthy() })).findings), 'not_evaluated', 'missing-input:robots');
  });
});

describe('intl-hreflang-target-not-canonical', () => {
  test('passes self-canonical targets', () => {
    const pages = [member(ca, 'ca'), member(es, 'es', `${set}<link rel="canonical" href="${es}">`)];
    assertOutcome(only(evaluate(targetNotCanonical, site({ pages })).findings), 'pass');
  });

  test('fails a target that canonicalizes to a parameter-free URL', () => {
    const tracked = url('/es/?ref=nav');
    const head = cluster({ ca, es: tracked });
    const pages = [member(ca, 'ca', head), member(tracked, 'es', `${head}<link rel="canonical" href="${es}">`)];
    const { findings, evidence } = evaluate(targetNotCanonical, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'high');
    assert.ok(excerpts(finding, evidence).includes(`<link rel="canonical" href="${es}">`));
  });

  test('is not evaluated when no target was fetched', () => {
    assertOutcome(only(evaluate(targetNotCanonical, site({ pages: [member(ca, 'ca')] })).findings), 'not_evaluated', 'targets-not-fetched');
  });
});

describe('intl-hreflang-mixed-protocol-or-host', () => {
  test('passes targets on the site protocol and host', () => {
    assertOutcome(only(evaluate(mixedProtocolOrHost, site({ pages: healthy() })).findings), 'pass');
  });

  test('fails http targets on an https site', () => {
    const { findings, evidence } = evaluate(mixedProtocolOrHost, site({ pages: [member(ca, 'ca', links([['ca', ca], ['es', 'http://example.com/es/']]))] }));
    const finding = only(findings);
    assertFail(finding, 'medium', 'http-scheme');
    assert.match(excerpts(finding, evidence)[0]!, /href="http:\/\/example.com\/es\/"/u);
  });

  test('fails a www target when the www host redirects', () => {
    const facts = site({ pages: [member(ca, 'ca', links([['ca', ca], ['es', 'https://www.example.com/es/']]))], variants: [{ label: 'www', url: 'https://www.example.com/ca/', redirects: [[301, ca]] }] });
    assertFail(only(evaluate(mixedProtocolOrHost, facts).findings), 'medium', 'host-variant');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(only(evaluate(mixedProtocolOrHost, monolingual).findings), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-hreflang-on-non-canonical-page', () => {
  test('passes a canonical, indexable page', () => {
    assertOutcome(outcomeOn(evaluate(onNonCanonicalPage, site({ pages: [member(ca, 'ca', `${set}<link rel="canonical" href="${ca}">`)] })).findings, ca), 'pass');
  });

  test('fails a filtered URL that inherits the template set with the base canonical', () => {
    const filtered = url('/ca/?page=2');
    const { findings, evidence } = evaluate(onNonCanonicalPage, site({ pages: [member(filtered, 'ca', `${set}<link rel="canonical" href="${ca}">`)] }));
    const finding = outcomeOn(findings, filtered);
    assertFail(finding, 'medium', 'canonical-elsewhere');
    assert.ok(excerpts(finding!, evidence).includes(`<link rel="canonical" href="${ca}">`));
  });

  test('passes a noindex,follow legal page with hreflang', () => {
    const legal = url('/ca/avis-legal/');
    const facts = site({ pages: [member(legal, 'ca', `${cluster({ ca: legal, es: url('/es/aviso-legal/') })}<meta name="robots" content="noindex,follow">`)] });
    assertOutcome(outcomeOn(evaluate(onNonCanonicalPage, facts).findings, legal), 'pass');
  });

  test('is not applicable without hreflang', () => {
    assertOutcome(outcomeOn(evaluate(onNonCanonicalPage, monolingual).findings, en), 'not_applicable', 'no-hreflang');
  });
});

describe('intl-canonical-cross-language', () => {
  test('passes self-canonical locale pages', () => {
    const pages = [member(ca, 'ca', `${set}<link rel="canonical" href="${ca}">`), member(en, 'en')];
    assertOutcome(only(evaluate(canonicalCrossLanguage, site({ pages })).findings), 'not_applicable', 'no-cross-url-canonical');
  });

  test('fails a Catalan version that canonicalizes to the English one', () => {
    const pages = [member(ca, 'ca', `${set}<link rel="canonical" href="${en}">`), member(en, 'en')];
    const { findings, evidence } = evaluate(canonicalCrossLanguage, site({ pages }));
    const finding = only(findings);
    assertFail(finding, 'high', 'hreflang-languages');
    assert.deepEqual([finding.params?.language, finding.params?.canonicalLanguage], ['Catalan', 'English']);
    assert.ok(excerpts(finding, evidence).includes(`<link rel="canonical" href="${en}">`));
  });

  test('accepts an untranslated variant that canonicalizes to the original', () => {
    const pages = [member(ca, 'en', `${set}<link rel="canonical" href="${en}">`), member(en, 'en')];
    assertOutcome(only(evaluate(canonicalCrossLanguage, site({ pages })).findings), 'pass');
  });

  test('passes regional duplicates in one language', () => {
    const fr = url('/fr/');
    const be = url('/fr-be/');
    const head = links([['fr-FR', fr], ['fr-BE', be]]);
    const pages = [member(be, 'fr', `${head}<link rel="canonical" href="${fr}">`), member(fr, 'fr', head)];
    assertOutcome(only(evaluate(canonicalCrossLanguage, site({ pages })).findings), 'pass');
  });
});
