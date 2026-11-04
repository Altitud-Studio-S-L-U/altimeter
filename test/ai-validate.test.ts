import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { myths, rule } from '../src/catalog/index.ts';
import { buildPack } from '../src/ai/pack.ts';
import { packSections, passSchema, planPasses, type PassPlan } from '../src/ai/passes.ts';
import { buildCorpus, collectSiteStrings, selectPages, sliceOf } from '../src/ai/site.ts';
import type { Proposal } from '../src/ai/types.ts';
import { defaultMythMatcher, distinctProposals, ownerPlaceholder, recommendsNewMarket, validateAnswer, type MythMatcher, type ValidationContext } from '../src/ai/validate.ts';
import type { Report, ReportFinding } from '../src/report/model.ts';
import { mythMatches } from '../src/rules/myth-filter.ts';
import { homeUrl, hotelAudit, roomsTitle, roomsUrl } from './support/analysis.ts';
import { page, site } from './support/facts.ts';

const audit = hotelAudit();
const siteFacts = audit.collected.site;
const strings = collectSiteStrings(siteFacts, selectPages(siteFacts, 3));
const pages = strings.pages.filter(entry => entry.role !== 'context');
const corpus = buildCorpus(siteFacts, strings);
const { plans } = planPasses({ report: audit.report, site: siteFacts, strings, pages });

function planned(pass: PassPlan['pass']): PassPlan {
  return plans.find(entry => entry.pass === pass && entry.page.key === roomsUrl)!;
}

function context(plan: PassPlan, options: { incomplete?: string; mythMatches?: MythMatcher; keyword?: string[] } = {}): ValidationContext {
  const sections = packSections(plan, strings, audit.report).map(section => (section.name === options.incomplete ? { ...section, complete: false } : section));
  return {
    plan,
    pack: buildPack({ trusted: 'x', sections, nonce: 'n' }),
    schema: passSchema(plan),
    report: audit.report,
    strings,
    corpus,
    keyword: options.keyword ?? [],
    mythMatches: options.mythMatches ?? defaultMythMatcher,
  };
}

const id = (text: string) => [...strings.items.values()].find(item => item.page === roomsUrl && item.text.includes(text))!.id;
const section = (name: 'text' | 'headings' | 'links') => sliceOf(strings, roomsUrl, name)!.id;
const notes = { en: 'Observed on the page.', es: 'Observado en la pagina.', ca: 'Observat a la pagina.' };

function finding(fields: Record<string, unknown>): Record<string, unknown> {
  return { scope: roomsUrl, verdict: 'confirmed', reasonCode: 'observed', severity: 'low', confidence: 'high', absence: false, evidenceIds: [], quotes: [], notes, ...fields };
}

const quote = (phrase: string, text = phrase) => ({ evidenceIds: [id(phrase)], quotes: [{ evidenceId: id(phrase), text }] });

const emptyAssessments = {
  ymyl: { value: 'not_assessable', evidenceId: null, quote: null },
  entityClarity: { value: 'not_assessable', evidenceId: null, quote: null },
  nonCommodityValue: { value: 'not_assessable', evidenceId: null, quote: null },
  intent: { value: 'not_assessable', evidenceId: null, quote: null, inferred: true },
  selfAssessment: [],
};

function content(findings: readonly Record<string, unknown>[], options: Parameters<typeof context>[1] = {}) {
  return validateAnswer({ findings, assessments: emptyAssessments }, context(planned('content'), options));
}

const reasons = (result: ReturnType<typeof validateAnswer>) => result.dropped.map(entry => entry.reason);

/** ASCII text in its full-width forms, which look alike but are other characters. */
const fullWidth = (text: string) => [...text].map(character => (character === ' ' ? ' ' : String.fromCodePoint(character.codePointAt(0)! + 0xfee0))).join('');

describe('validating findings', () => {
  test('keeps well-founded claims and caps judged severity, for the analyst\'s own rules and for candidates', () => {
    const result = content([
      finding({ ruleId: 'content-title-sensational', severity: 'critical', ...quote('Our 45 rooms', 'Our 45 rooms look over the valley') }),
      finding({ ruleId: 'content-keyword-stuffing', severity: 'high', ...quote('Our 45 rooms', 'Our 45 rooms look over the valley') }),
    ]);
    assert.deepEqual(reasons(result), []);
    assert.deepEqual(result.findings.map(entry => [entry.rule.id, entry.severity, entry.adjustments, entry.candidate !== undefined]), [
      ['content-title-sensational', 'medium', ['severity-capped:critical->medium'], false],
      ['content-keyword-stuffing', 'medium', ['severity-capped:high->medium'], true],
    ]);
  });

  test('takes direct claims only on ai-judgment rules; code-decided hybrid rules need a candidate', () => {
    const result = content([
      finding({ ruleId: 'content-hidden-links', ...quote('Our 45 rooms', 'Our 45 rooms look over the valley') }),
      finding({ ruleId: 'content-stale-content', verdict: 'likely', ...quote('Breakfast is served', 'Breakfast is served from 7:00 to 11:00') }),
      finding({ ruleId: 'content-img-alt-quality', verdict: 'not_confirmed', ...quote('Double room', 'Double room with a balcony') }),
    ]);
    assert.deepEqual(reasons(result), ['rule-out-of-scope', 'rule-out-of-scope']);
    assert.equal(result.findings[0]?.candidate?.ruleId, 'content-img-alt-quality');
  });

  test('requires evidence and a quote that sits in the item it cites', () => {
    const result = content([
      finding({ ruleId: 'content-title-sensational' }),
      finding({ ruleId: 'content-headings-descriptive', evidenceIds: [id('Our 45 rooms')] }),
      finding({ ruleId: 'content-subtopic-coverage', evidenceIds: [id('Our 45 rooms')], quotes: [{ evidenceId: id('Breakfast'), text: 'Breakfast is served from 7:00' }] }),
      finding({ ruleId: 'content-intent-match', ...quote('Our 45 rooms', 'the valley') }),
      finding({ ruleId: 'content-ymyl-classification', ...quote('Our 45 rooms', 'Our 46 rooms look over the valley') }),
      finding({ ruleId: 'content-title-sensational', ...quote('Our 45 rooms', 'Breakfast is served from 7:00 to 11:00') }),
    ]);
    assert.deepEqual(reasons(result), ['missing-evidence', 'missing-quote', 'quote-uncited-evidence', 'quote-too-short', 'quote-not-found', 'quote-other-evidence']);
  });

  test('allows a claim of absence only on a complete section', () => {
    const claim = finding({ ruleId: 'content-subtopic-coverage', reasonCode: 'missing-prices', absence: true, evidenceIds: [section('text')] });
    assert.deepEqual(reasons(content([claim])), []);
    assert.deepEqual(reasons(content([claim], { incomplete: 'text' })), ['absence-on-incomplete-slice']);
    const implied = finding({ ruleId: 'content-subtopic-coverage', reasonCode: 'no-prices', evidenceIds: [section('text')] });
    assert.deepEqual(reasons(content([implied], { incomplete: 'text' })), ['absence-on-incomplete-slice'], 'a no- reason code is a claim of absence too');
  });

  test('refuses scopes that are not this call\'s audited page', () => {
    const result = content([
      finding({ ruleId: 'content-title-sensational', scope: 'https://other.example/', ...quote('Our 45 rooms', 'Our 45 rooms look over') }),
      finding({ ruleId: 'content-headings-descriptive', scope: homeUrl, ...quote('Our 45 rooms', 'Our 45 rooms look over') }),
    ]);
    assert.deepEqual(reasons(result), ['scope-not-audited', 'scope-outside-call']);
  });

  test('drops notes that repeat a myth or recommend new markets, with the catalog filter or any other', () => {
    const mythical = finding({ ruleId: 'content-title-sensational', ...quote('Our 45 rooms', 'Our 45 rooms look over'), notes: { ...notes, en: 'Raise the keyword  DENSITY of the page.' } });
    const markets = finding({ ruleId: 'content-headings-descriptive', ...quote('Our 45 rooms', 'Our 45 rooms look over'), notes: { ...notes, es: 'Conviene anadir nuevos idiomas para llegar a otros paises.' } });
    const refuted = finding({ ruleId: 'content-subtopic-coverage', ...quote('Our 45 rooms', 'Our 45 rooms look over'), notes: { ...notes, en: 'There is no need to target keyword density here.' } });
    const result = content([mythical, markets, refuted]);
    assert.deepEqual(reasons(result), ['myth', 'new-market'], 'a refuted myth is not a recommendation');
    assert.deepEqual(result.dropped[0]?.detail, 'keyword-density');
    const strict: MythMatcher = text => (text.includes('Observed') ? [myths[0]!] : []);
    assert.deepEqual(reasons(content([finding({ ruleId: 'content-intent-match', ...quote('Our 45 rooms', 'Our 45 rooms look over') })], { mythMatches: strict })), ['myth']);
    assert.equal(recommendsNewMarket('Consider launching in new markets such as France.'), true);
    assert.equal(recommendsNewMarket('The page mixes English with other languages.'), false);
  });

  test('drops duplicates and claims that repeat or contradict code', () => {
    const base = planned('content');
    const plan: PassPlan = { ...base, rules: [...base.rules, rule('content-title-branding')!, rule('content-h1-missing')!] };
    const result = validateAnswer({
      findings: [
        finding({ ruleId: 'content-img-alt-quality', verdict: 'not_confirmed', ...quote('Double room', 'Double room with a balcony') }),
        finding({ ruleId: 'content-img-alt-quality', verdict: 'not_confirmed', ...quote('Double room', 'Double room with a balcony') }),
        finding({ ruleId: 'content-title-branding', ...quote(roomsTitle) }),
        finding({ ruleId: 'content-title-branding', verdict: 'not_confirmed', ...quote(roomsTitle) }),
        finding({ ruleId: 'content-h1-missing', ...quote('Rooms with valley views') }),
      ],
      assessments: emptyAssessments,
    }, context(plan));
    assert.deepEqual(reasons(result), ['duplicate', 'duplicate-of-deterministic', 'contradicts-deterministic', 'contradicts-deterministic']);
  });

  test('binds each decision to the candidate whose evidence it cites when a rule has several on the page', () => {
    const generic = audit.report.findings.find(entry => entry.ruleId === 'content-img-alt-quality' && entry.needsJudgment === true)!;
    const longAlt = `Double room with a balcony over the valley${', with a view of the mountains'.repeat(8)}`;
    const tooLong: ReportFinding = { ...generic, id: 'F-too-long', reason: 'too-long', evidence: ['E900'] };
    const report: Report = {
      ...audit.report,
      findings: [...audit.report.findings, tooLong],
      evidence: [...audit.report.evidence, { id: 'E900', kind: 'html', url: roomsUrl, label: 'alt text over 250 characters', excerpt: longAlt, complete: true }],
    };
    const base = planned('content');
    const plan: PassPlan = { ...base, candidates: [...base.candidates, tooLong] };
    const both: ValidationContext = { ...context(plan), report, pack: buildPack({ trusted: 'x', sections: packSections(plan, strings, report), nonce: 'n' }) };
    const cited = generic.evidence[0]!;
    const result = validateAnswer({
      findings: [
        finding({ ruleId: 'content-img-alt-quality', reasonCode: 'alt-text-too-long', evidenceIds: ['E900'], quotes: [{ evidenceId: 'E900', text: 'with a view of the mountains' }] }),
        finding({ ruleId: 'content-img-alt-quality', verdict: 'not_confirmed', reasonCode: 'descriptive-alt', evidenceIds: [cited], quotes: [{ evidenceId: cited, text: 'Double room with a balcony' }] }),
        finding({ ruleId: 'content-img-alt-quality', ...quote('Double room', 'Double room with a balcony') }),
        finding({ ruleId: 'content-img-alt-quality', verdict: 'not_confirmed', evidenceIds: ['E900'], quotes: [{ evidenceId: 'E900', text: 'with a view of the mountains' }] }),
      ],
      assessments: emptyAssessments,
    }, both);
    assert.deepEqual(reasons(result), ['ambiguous-candidate', 'duplicate'], 'an answer that cites neither candidate decides neither, and each candidate takes one decision');
    assert.deepEqual(result.findings.map(entry => [entry.candidate?.id, entry.outcome]), [['F-too-long', 'fail'], [generic.id, 'pass']]);
  });

  test('records rules the model could not assess and refuses partial answers as a whole', () => {
    const result = content([finding({ ruleId: 'content-intent-match', verdict: 'not_assessable', severity: 'info' })]);
    assert.deepEqual(result.notAssessable, ['content-intent-match']);
    const partial = validateAnswer({ findings: [] }, context(planned('content')));
    assert.deepEqual(partial.dropped.map(entry => [entry.kind, entry.reason, entry.detail]), [['answer', 'schema', '$: missing assessments']]);
    assert.equal(validateAnswer('not an object', context(planned('content'))).dropped[0]?.reason, 'schema');
    assert.equal(validateAnswer({ findings: [], assessments: emptyAssessments, extra: true }, context(planned('content'))).dropped[0]?.reason, 'schema');
  });

  test('gives an inferred intent at most info severity', () => {
    const result = content([finding({ ruleId: 'content-intent-match', severity: 'medium', ...quote('Our 45 rooms', 'Our 45 rooms look over') })]);
    assert.equal(result.findings[0]?.severity, 'info');
    const withKeyword = content([finding({ ruleId: 'content-intent-match', severity: 'medium', ...quote('Our 45 rooms', 'Our 45 rooms look over') })], { keyword: ['hotel rooms andorra'] });
    assert.equal(withKeyword.findings[0]?.severity, 'medium');
  });
});

describe('validating proposals', () => {
  const serp = (proposals: readonly Record<string, unknown>[]) => validateAnswer({ proposals }, context(planned('serp')));
  const proposal = (kind: string, text: string, language = 'en') => ({ kind, scope: roomsUrl, text, language, evidenceIds: [id('Our 45 rooms')], notes });

  test('checks titles and descriptions for length, language, uniqueness, brand and new facts', () => {
    const result = serp([
      proposal('title', 'Rooms'),
      proposal('title', 'Habitaciones con vistas al valle | Hotel Example', 'es'),
      proposal('meta-description', 'A family hotel in the centre of Andorra la Vella with rooms over the valley.'),
      proposal('meta-description', 'The best rooms in Andorra la Vella, all with valley views and breakfast in the garden room.'),
    ]);
    assert.deepEqual(reasons(result), ['length', 'wrong-language', 'not-unique', 'new-fact']);
    const second = serp([proposal('title', roomsTitle), proposal('title', 'Rooms over the valley of Andorra la Vella')]);
    assert.deepEqual(reasons(second), ['unchanged', 'brand-missing']);
  });

  test('allows two proposals of each kind and replaces unknown URLs with the owner placeholder', () => {
    const result = serp([
      proposal('title', 'Rooms with valley views | Hotel Example'),
      proposal('title', 'Valley view rooms | Hotel Example'),
      proposal('title', 'Rooms over the valley | Hotel Example'),
      proposal('meta-description', 'Our 45 rooms look over the valley of Andorra la Vella. See https://booking.example/hotel for dates.'),
    ]);
    assert.deepEqual(reasons(result), ['too-many']);
    const description = result.proposals.find(entry => entry.kind === 'meta-description')!;
    assert.equal(description.kind === 'meta-description' && description.text, 'Our 45 rooms look over the valley of Andorra la Vella. See OWNER_TO_SUPPLY for dates.');
    assert.equal(description.placeholders, 1);
  });

  test('replaces links without a scheme or with one in capitals too, and reads numbers in any digits', () => {
    const result = serp([
      proposal('title', 'Valley rooms | Hotel Example | HTTPS://EVIL.EXAMPLE'),
      proposal('meta-description', 'Our 45 rooms look over the valley of Andorra la Vella. Book at www.evil.example today.'),
      proposal('meta-description', `Our ${fullWidth('46')} rooms look over the valley of Andorra la Vella, with breakfast in the garden room.`),
    ]);
    assert.deepEqual(reasons(result), ['new-fact']);
    assert.deepEqual(result.proposals.map(entry => (entry.kind === 'json-ld' ? undefined : [entry.text, entry.placeholders])), [
      [`Valley rooms | Hotel Example | ${ownerPlaceholder}`, 1],
      [`Our 45 rooms look over the valley of Andorra la Vella. Book at ${ownerPlaceholder} today.`, 1],
    ]);
  });

  test('keeps proposals for different pages distinct', () => {
    const make = (scope: string): Proposal => ({ kind: 'title', pass: 'serp', scope, text: 'Rooms | Valley', language: 'en', evidenceIds: [], notes, placeholders: 0 });
    const result = distinctProposals([make(roomsUrl), make(homeUrl), make(roomsUrl)]);
    assert.equal(result.kept.length, 2);
    assert.deepEqual(result.dropped.map(entry => entry.reason), ['not-unique']);
  });

  test('parses JSON-LD proposals, refuses invented facts and retired features, keeps known links', () => {
    const plan = planned('schema');
    const jsonLd = (value: unknown) => ({ kind: 'json-ld', scope: roomsUrl, jsonLd: typeof value === 'string' ? value : JSON.stringify(value), evidenceIds: [id('"@type":"Hotel"')], notes });
    const result = validateAnswer({
      findings: [],
      proposals: [
        jsonLd('{"@context": "https://schema.org", "@type": "Hotel", '),
        jsonLd({ '@type': 'Hotel', name: 'Hotel Example' }),
        jsonLd({ '@context': 'https://schema.org', '@type': 'Hotel', name: 'Hotel Example', telephone: '+376 999 999' }),
      ],
    }, context(plan));
    assert.deepEqual(reasons(result), ['invalid-json-ld', 'invalid-json-ld', 'new-fact']);
    const kept = validateAnswer({
      findings: [],
      proposals: [jsonLd({ '@context': 'https://schema.org', '@type': 'Hotel', '@id': `${roomsUrl}#hotel`, name: 'Hotel Example', url: roomsUrl, sameAs: ['https://www.instagram.com/hotelexample/'] })],
    }, context(plan));
    assert.deepEqual(reasons(kept), []);
    assert.equal(kept.proposals[0]?.placeholders, 0);
  });

  test('replaces every link the crawled pages do not show, wherever a JSON-LD proposal puts it and however it is written', () => {
    const plan = planned('schema');
    const jsonLd = (value: unknown) => ({ kind: 'json-ld', scope: roomsUrl, jsonLd: JSON.stringify(value), evidenceIds: [id('"@type":"Hotel"')], notes });
    const base = { '@context': 'https://schema.org', '@type': 'Hotel', name: 'Hotel Example' };
    const invented = {
      ...base, '@id': '//evil.example/#org', url: '/book-now', sameAs: ['www.evil.example', 'HTTPS://EVIL.EXAMPLE/'], slogan: 'www.evil.example',
      description: 'Our 45 rooms look over the valley of Andorra la Vella, book at https://evil.example/book or www.evil.example.',
    };
    const known = {
      ...base, '@id': '#hotel', url: roomsUrl, image: '/img/room.jpg', sameAs: ['//www.instagram.com/hotelexample/'],
      description: 'Our 45 rooms look over the valley of Andorra la Vella; see https://www.instagram.com/hotelexample/.',
      containsPlace: { '@id': '_:room', '@type': 'https://schema.org/HotelRoom', name: 'Double room' },
      makesOffer: { '@type': 'Offer', availability: 'https://schema.org/InStock' },
    };
    const rated = { ...base, aggregateRating: { '@type': 'AggregateRating', ratingValue: fullWidth('4.9') } };
    const result = validateAnswer({ findings: [], proposals: [jsonLd(invented), jsonLd(known), jsonLd(rated)] }, context(plan));
    assert.deepEqual(reasons(result), ['new-fact'], 'a rating in full-width digits is a number the page does not show');
    const [first, second] = result.proposals.map(entry => (entry.kind === 'json-ld' ? { value: JSON.parse(entry.jsonLd) as unknown, placeholders: entry.placeholders } : undefined));
    assert.deepEqual(first, {
      value: {
        ...base, '@id': ownerPlaceholder, url: ownerPlaceholder, sameAs: [ownerPlaceholder, ownerPlaceholder], slogan: ownerPlaceholder,
        description: `Our 45 rooms look over the valley of Andorra la Vella, book at ${ownerPlaceholder} or ${ownerPlaceholder}.`,
      },
      placeholders: 7,
    });
    assert.deepEqual(second, { value: known, placeholders: 0 }, 'links on the page stay, written relative to it or not');
  });

  test('takes as a schema.org term only a whole term, and checks the links a type or a context names', () => {
    const plan = planned('schema');
    const jsonLd = (value: unknown) => ({ kind: 'json-ld', scope: roomsUrl, jsonLd: JSON.stringify(value), evidenceIds: [id('"@type":"Hotel"')], notes });
    const base = { '@context': 'https://schema.org', '@type': 'Hotel', name: 'Hotel Example' };
    const result = validateAnswer({
      findings: [],
      proposals: [
        jsonLd({ ...base, '@context': ['https://schema.org', { '@vocab': 'https://schema.org/' }, 'https://evil.example/context.jsonld'], '@type': ['Hotel', 'https://evil.example/Hotel'], url: 'https://schema.org/../book' }),
        jsonLd({ ...base, description: 'https://schema.org/Hotel Our 45 rooms look over the valley of Andorra la Vella, book at https://evil.example/book' }),
        jsonLd({ ...base, description: 'https://schema.org/Hotel The best rooms in Andorra la Vella, rated 4.9 by 2000 guests' }),
      ],
    }, context(plan));
    assert.deepEqual(reasons(result), ['new-fact'], 'a superlative or a rating after a schema.org address is still a fact the page must show');
    assert.deepEqual(result.proposals.map(entry => (entry.kind === 'json-ld' ? [JSON.parse(entry.jsonLd), entry.placeholders] : undefined)), [
      [{ ...base, '@context': ['https://schema.org', { '@vocab': 'https://schema.org/' }, ownerPlaceholder], '@type': ['Hotel', ownerPlaceholder], url: ownerPlaceholder }, 3],
      [{ ...base, description: `${ownerPlaceholder} Our 45 rooms look over the valley of Andorra la Vella, book at ${ownerPlaceholder}` }, 2],
    ]);
  });
});

describe('validating language claims', () => {
  // A Spanish page with a Catalan paragraph and a Dutch sentence. A mixed-language rule reaches the analyst only as a
  // candidate from code; confirming it is still a language claim.
  const [eAcute, oGrave, oAcute] = [0x00e9, 0x00f2, 0x00f3].map(point => String.fromCodePoint(point));
  const spanishUrl = 'https://hotel.example/es/habitaciones/';
  const spanish = 'Nuestras habitaciones dan al valle y el desayuno se sirve en el patio.';
  const catalan = `Les habitacions donen a la vall i tamb${eAcute} tenen balc${oAcute}, per${oGrave} els preus s${oAcute}n els mateixos.`;
  const dutch = 'Het hotel ligt in de vallei van Andorra.';
  const html = `<!doctype html><html lang="es"><head><title>Habitaciones | Hotel Example</title></head><body><main><p>${spanish}</p><p>${catalan}</p><p>${dutch}</p></main></body></html>`;
  const facts = site({ pages: [page(spanishUrl, { html, pageType: 'other' })] });
  const local = collectSiteStrings(facts, selectPages(facts, 1));
  const plan: PassPlan = { pass: 'intl', page: local.pages[0]!, sitePage: true, rules: [rule('intl-mixed-language-page')!], candidates: [], facts: [], contextPages: [] };
  const intl: ValidationContext = {
    plan, pack: buildPack({ trusted: 'x', sections: packSections(plan, local, audit.report), nonce: 'n' }), schema: passSchema(plan),
    report: audit.report, strings: local, corpus: buildCorpus(facts, local), keyword: [], mythMatches: defaultMythMatcher,
  };
  const cited = (text: string) => {
    const item = [...local.items.values()].find(entry => entry.text === text)!.id;
    return { evidenceIds: [item], quotes: [{ evidenceId: item, text: text.split(' ').slice(0, 5).join(' ') }] };
  };
  const claim = (language: string | null, words: readonly string[], text = catalan, extra: Record<string, unknown> = {}) => finding({
    ruleId: 'intl-mixed-language-page', scope: spanishUrl, reasonCode: 'catalan-paragraph', severity: 'medium', language, discriminatingWords: words, ...cited(text), ...extra,
  });
  const check = (entry: Record<string, unknown>) => reasons(validateAnswer({ findings: [entry] }, intl));

  test('needs two words of the cited items that tell the claimed language apart from every other the detector knows', () => {
    assert.deepEqual(check(claim('ca', [`tamb${eAcute}`, `per${oGrave}`])), []);
    assert.deepEqual(check(claim('ca-AD', ['els', `s${oAcute}n`])), [], 'a region subtag claims its language');
    assert.deepEqual(check(claim('ca', ['la', 'les'])), ['discriminating-words'], 'Spanish uses these words too');
    assert.deepEqual(check(claim('ca', ['el', 'en'], spanish)), ['discriminating-words'], 'a Spanish sentence with shared words shows no Catalan');
    assert.deepEqual(check(claim('ca', ['nuestras', 'habitaciones'], spanish)), ['discriminating-words'], 'Spanish words show Spanish');
    assert.deepEqual(check(claim('ca', [`tamb${eAcute}`, 'aquesta'])), ['discriminating-words'], 'a word must be in the cited items');
  });

  test('refuses a claim without a language, and takes for other languages only words no known language uses', () => {
    assert.deepEqual(check(claim(null, [`tamb${eAcute}`, `per${oGrave}`])), ['discriminating-words']);
    assert.deepEqual(check(claim('und', ['preus', 'mateixos'])), ['discriminating-words']);
    assert.deepEqual(check(claim('nl', ['het', 'ligt'], dutch)), []);
    assert.deepEqual(check(claim('nl', [`tamb${eAcute}`, `per${oGrave}`])), ['discriminating-words'], 'Catalan words do not show Dutch');
  });

  test('never accepts a recommendation to add languages or markets', () => {
    const result = validateAnswer({ findings: [claim('ca', [`tamb${eAcute}`, `per${oGrave}`], catalan, { notes: { ...notes, en: 'Add new languages to reach visitors from more countries.' } })] }, intl);
    assert.deepEqual(reasons(result), ['new-market']);
  });
});

describe('default myth filter', () => {
  test('is the catalog filter: phrase matches per clause, refutations excluded', () => {
    assert.equal(defaultMythMatcher, mythMatches);
    assert.deepEqual(defaultMythMatcher('Aim for a  Keyword DENSITY of 2%').map(entry => entry.id), ['keyword-density']);
    assert.deepEqual(defaultMythMatcher('Do not chase keyword density.'), []);
    assert.deepEqual(defaultMythMatcher('The title reads naturally.'), []);
  });
});
