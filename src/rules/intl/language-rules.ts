import { detectLanguage, isDetectable } from '../../analyze/language.ts';
import { evidenceLabel } from '../../core/evidence.ts';
import type { PageFacts } from '../../core/facts.ts';
import { headerValue } from '../../fetch/http.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { metaProperty, pageDocument } from '../helpers.ts';
import { annotationEvidence, elementSource, normalizeUrl } from './annotations.ts';
import { clusters, declaredSets, documentAt, isXDefault, valuesFor } from './cluster.ts';
import { bcp47Problem, primaryLanguage, sameLanguage } from './codes.ts';
import { fail, list, maxEvidence, notApplicable, notEvaluated, pass } from './shared.ts';
import { decisive, isDecisive, jaccard, languageEvidence, languageLabel, mainBlocks, needsConfirmation, pageLanguage, shingles, type DocumentLanguage } from './text.ts';

/** Languages the hreflang cluster assigns to a page's own URL. */
function hreflangLanguages(page: PageFacts, sets: ReturnType<typeof declaredSets>) {
  const self = normalizeUrl(page.fetch.finalUrl) ?? page.fetch.finalUrl;
  const annotations = valuesFor(sets, self).filter(annotation => !isXDefault(annotation));
  const languages: string[] = [];
  for (const annotation of annotations) {
    const language = primaryLanguage(annotation.value);
    if (language && !languages.some(known => sameLanguage(known, language))) languages.push(language);
  }
  return { self, annotations, languages };
}

const matches = (languages: readonly string[], detected: string) => languages.some(language => sameLanguage(language, detected));

export const valueVsContentLanguage: RuleImplementation = {
  id: 'intl-hreflang-value-vs-content-language',
  evaluate({ page, site, evidence }) {
    const { self, annotations, languages } = hreflangLanguages(page!, declaredSets(site));
    if (languages.length === 0) return notApplicable('no-hreflang-for-page');
    // Languages outside the detector's set (Galician, Corsican) resemble ones inside it; comparing would guess.
    if (!languages.every(isDetectable)) return notEvaluated('language-not-detectable');
    const language = pageLanguage(page!);
    if (!language || language.guess.language === 'und') return notEvaluated('language-undetermined');
    const detected = language.guess.language;
    const textId = languageEvidence(evidence, self, language);
    if (matches(languages, detected) || language.guess.confidence < decisive.confidence) return pass([textId]);
    const ids = [...annotations.slice(0, 3).map(annotation => annotationEvidence(evidence, annotation, evidenceLabel('hreflang value assigned to this page by {url}', { url: annotation.declaringUrl }))), textId];
    const params = { declared: list(languages.map(languageLabel)), detected: languageLabel(detected), words: language.guess.words };
    if (language.guess.words < decisive.words) return fail('info', ids, params, 'short-content', true);
    return fail('medium', ids, params, undefined, languages.some(code => needsConfirmation(detected, code)));
  },
};

function langAttribute(page: PageFacts): { readonly value: string | undefined; readonly source: 'raw' | 'rendered' } {
  const raw = page.raw?.parsed.htmlLang;
  if (raw !== undefined) return { value: raw, source: 'raw' };
  const rendered = page.rendered && page.rendered.result.error === undefined ? page.rendered.parsed.htmlLang : undefined;
  return rendered !== undefined ? { value: rendered, source: 'rendered' } : { value: undefined, source: 'raw' };
}

function htmlStart(page: PageFacts, source: 'raw' | 'rendered'): string {
  const html = source === 'raw' ? page.raw?.html ?? '' : page.rendered?.html ?? '';
  return /<html\b[^>]*>/iu.exec(html)?.[0] ?? '';
}

export const htmlLangMissingOrInvalid: RuleImplementation = {
  id: 'intl-html-lang-missing-or-invalid',
  evaluate({ page, evidence }) {
    const url = page!.fetch.finalUrl;
    const raw = page!.raw!.parsed.htmlLang;
    if (raw === undefined) {
      const { value, source } = langAttribute(page!);
      if (source === 'rendered' && value !== undefined && bcp47Problem(value) === undefined) {
        return fail('info', [evidence.add({ kind: 'render', url, label: evidenceLabel('lang attribute set only after rendering'), excerpt: htmlStart(page!, 'rendered') })], { value }, 'set-by-script');
      }
      return fail('low', [evidence.add({ kind: 'html', url, label: evidenceLabel('html element without a lang attribute'), excerpt: htmlStart(page!, 'raw') || '(no html start tag)' })], { value: '' }, 'missing');
    }
    const problem = bcp47Problem(raw);
    const id = evidence.add({ kind: 'html', url, label: evidenceLabel('lang attribute of the html element'), excerpt: htmlStart(page!, 'raw') });
    if (problem === undefined) return pass([id]);
    return fail('low', [id], { value: raw }, problem);
  },
};

export const htmlLangVsContent: RuleImplementation = {
  id: 'intl-html-lang-vs-content',
  evaluate({ page, evidence }) {
    const { value, source } = langAttribute(page!);
    const declared = primaryLanguage(value);
    if (!declared || bcp47Problem(value ?? '') !== undefined) return notApplicable('no-valid-lang');
    if (!isDetectable(declared)) return notEvaluated('language-not-detectable');
    const language = pageLanguage(page!);
    if (!language || language.guess.language === 'und') return notEvaluated('language-undetermined');
    const textId = languageEvidence(evidence, page!.fetch.finalUrl, language);
    const detected = language.guess.language;
    if (sameLanguage(declared, detected) || !isDecisive(language.guess)) return pass([textId]);
    return fail('low', [evidence.add({ kind: source === 'raw' ? 'html' : 'render', url: page!.fetch.finalUrl, label: evidenceLabel('lang attribute of the html element'), excerpt: htmlStart(page!, source) }), textId],
      { lang: value!, declared: languageLabel(declared), detected: languageLabel(detected) }, undefined, needsConfirmation(detected, declared));
  },
};

export const contentLanguageSignalConflict: RuleImplementation = {
  id: 'intl-content-language-signal-conflict',
  evaluate({ page, evidence }) {
    const url = page!.fetch.finalUrl;
    const header = headerValue(page!.fetch.headers, 'content-language');
    const pragma = page!.raw!.parsed.metas.find(meta => (meta.attrs['http-equiv'] ?? '').toLowerCase() === 'content-language');
    if (header === undefined && !pragma) return notApplicable('no-content-language');
    const results: RuleResult[] = [];
    const ids: string[] = [];
    const declared: string[] = [];
    if (header !== undefined) {
      ids.push(evidence.add({ kind: 'header', url, label: evidenceLabel('Content-Language response header'), excerpt: `Content-Language: ${header}` }));
      declared.push(...header.split(',').map(entry => primaryLanguage(entry)).filter((code): code is string => code !== undefined));
    }
    if (pragma) {
      const pragmaId = evidence.add({ kind: 'html', url, label: evidenceLabel('content-language pragma, which HTML marks non-conforming'), excerpt: elementSource(page!.raw!.html, pragma), line: pragma.line });
      ids.push(pragmaId);
      declared.push(...(pragma.attrs.content ?? '').split(',').map(entry => primaryLanguage(entry)).filter((code): code is string => code !== undefined));
      results.push(fail('info', [pragmaId], { value: pragma.attrs.content ?? '' }, 'meta-pragma'));
    }
    if (declared.length === 0) return results.length > 0 ? results : pass(ids);
    const lang = primaryLanguage(langAttribute(page!).value);
    if (lang && !matches(declared, lang)) {
      results.push(fail('low', [...ids, evidence.add({ kind: 'html', url, label: evidenceLabel('lang attribute of the html element'), excerpt: htmlStart(page!, 'raw') })],
        { declared: list(declared), other: lang }, 'conflicts-with-lang'));
      return results;
    }
    const language = pageLanguage(page!);
    if (language && isDecisive(language.guess) && !matches(declared, language.guess.language) && declared.every(isDetectable)) {
      results.push(fail('low', [...ids, languageEvidence(evidence, url, language)], { declared: list(declared), other: languageLabel(language.guess.language) },
        'conflicts-with-content', declared.some(code => needsConfirmation(language.guess.language, code))));
    }
    return results.length > 0 ? results : pass(ids);
  },
};

/** Share of main-content words that must be in another language before the analyst is asked to look. */
const secondaryShare = 0.2;

export const mixedLanguagePage: RuleImplementation = {
  id: 'intl-mixed-language-page',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!);
    if (!doc) return notEvaluated('no-document');
    const blocks = mainBlocks(doc);
    const words = new Map<string, { count: number; samples: string[] }>();
    let total = 0;
    for (const block of blocks) {
      const guess = detectLanguage(block.text, { minWords: 12 });
      total += guess.words;
      if (guess.language === 'und' || guess.confidence < 0.9) continue;
      const entry = words.get(guess.language) ?? { count: 0, samples: [] };
      entry.count += guess.words;
      if (entry.samples.length < 3) entry.samples.push(block.text);
      words.set(guess.language, entry);
    }
    if (total < 60 || words.size === 0) return notEvaluated('too-little-text');
    const ranked = [...words].sort((a, b) => b[1].count - a[1].count);
    const [primary, primaryEntry] = ranked[0]!;
    const secondary = ranked.slice(1).filter(([, entry]) => entry.count >= 30 && entry.count / total >= secondaryShare);
    if (secondary.length === 0) return pass();
    const [other, otherEntry] = secondary[0]!;
    const ids = [
      ...otherEntry.samples.map(sample => evidence.add({ kind: 'text', url: page!.fetch.finalUrl, label: evidenceLabel('main-content block detected as {language}', { language: languageLabel(other) }), excerpt: sample.slice(0, 300) })),
      evidence.add({ kind: 'text', url: page!.fetch.finalUrl, label: evidenceLabel('main-content block detected as {language}', { language: languageLabel(primary) }), excerpt: primaryEntry.samples[0]!.slice(0, 300) }),
    ];
    return fail('medium', ids, { primary: languageLabel(primary), secondary: languageLabel(other), share: otherEntry.count / total }, undefined, true);
  },
};

interface Variant {
  readonly url: string;
  readonly page: PageFacts;
  readonly languages: readonly string[];
  readonly language: DocumentLanguage;
  readonly shingles: ReadonlySet<string>;
}

export const untranslatedVariant: RuleImplementation = {
  id: 'intl-untranslated-variant',
  evaluate({ site, evidence }) {
    const sets = declaredSets(site);
    if (sets.size === 0) return notApplicable('no-hreflang');
    const variantOf = (url: string): Variant | undefined => {
      const page = documentAt(site, url);
      const language = page ? pageLanguage(page) : undefined;
      if (!page || !language) return undefined;
      const languages = [...new Set(valuesFor(sets, url).filter(annotation => !isXDefault(annotation)).map(annotation => primaryLanguage(annotation.value)).filter((code): code is string => code !== undefined))];
      return languages.length > 0 ? { url, page, languages, language, shingles: shingles(language.text) } : undefined;
    };
    const results: RuleResult[] = [];
    let compared = 0;
    // Versions are compared within their own cluster only: those are the pages that claim to be translations.
    for (const members of clusters(sets)) {
      const variants = members.map(variantOf).filter((variant): variant is Variant => variant !== undefined);
      for (const [index, a] of variants.entries()) for (const b of variants.slice(index + 1)) {
        // Same-language regional variants may share their text; only versions in different languages are compared.
        if (a.languages.some(x => b.languages.some(y => sameLanguage(x, y)))) continue;
        compared += 1;
        const similarity = a.language.guess.words >= 50 && b.language.guess.words >= 50 ? jaccard(a.shingles, b.shingles) : 0;
        const params = { url: a.url, other: b.url, languages: `${list(a.languages)} / ${list(b.languages)}`, similarity };
        const ids = () => [languageEvidence(evidence, a.url, a.language), languageEvidence(evidence, b.url, b.language)];
        if (similarity >= 0.9) {
          results.push(fail('medium', ids(), params, 'near-identical'));
          continue;
        }
        const same = isDecisive(a.language.guess) && isDecisive(b.language.guess) && a.language.guess.language === b.language.guess.language;
        if (!same) continue;
        const detected = a.language.guess.language;
        const confirm = [...a.languages, ...b.languages].some(code => needsConfirmation(detected, code));
        results.push(fail('medium', ids(), { ...params, detected: languageLabel(detected) }, 'same-language', confirm));
      }
    }
    if (results.length > 0) return results;
    return compared === 0 ? notEvaluated('variants-not-fetched') : pass();
  },
};

interface Field {
  readonly name: string;
  readonly text: string;
  readonly excerpt: string;
  readonly line?: number;
}

function metadataFields(page: PageFacts): Field[] {
  const doc = page.raw!;
  const fields: Field[] = [];
  const title = doc.parsed.titles[0];
  if (title) fields.push({ name: 'title', text: title.text.trim(), excerpt: title.text.trim(), line: title.line });
  const describe = doc.parsed.metas.find(meta => (meta.attrs.name ?? '').toLowerCase() === 'description');
  if (describe?.attrs.content) fields.push({ name: 'meta description', text: describe.attrs.content.trim(), excerpt: elementSource(doc.html, describe), line: describe.line });
  for (const property of ['og:title', 'og:description']) {
    const meta = metaProperty(doc, property)[0];
    if (meta?.attrs.content) fields.push({ name: property, text: meta.attrs.content.trim(), excerpt: elementSource(doc.html, meta), line: meta.line });
  }
  return fields;
}

const wordCount = (text: string) => (text.match(/\p{L}+/gu) ?? []).length;

export const metadataTranslationParity: RuleImplementation = {
  id: 'intl-metadata-translation-parity',
  evaluate({ page, site, evidence }) {
    const sets = declaredSets(site);
    const { self, languages } = hreflangLanguages(page!, sets);
    if (languages.length === 0) return notApplicable('no-hreflang-for-page');
    const results: RuleResult[] = [];
    const fields = metadataFields(page!);
    // Fields copied verbatim from a version in another language were not localized (brand-only fields are short).
    const others = new Set((sets.get(self)?.annotations ?? [])
      .filter(annotation => annotation.href && annotation.href !== self && !isXDefault(annotation) && !matches(languages, primaryLanguage(annotation.value) ?? ''))
      .map(annotation => annotation.href!));
    for (const href of others) {
      const other = documentAt(site, href);
      if (!other?.raw) continue;
      const theirs = metadataFields(other);
      for (const field of fields) {
        const twin = theirs.find(entry => entry.name === field.name && entry.text === field.text);
        if (!twin || wordCount(field.text) < 4) continue;
        results.push(fail('medium', [
          evidence.add({ kind: 'html', url: self, label: evidenceLabel('{field} of this page', { field: field.name }), excerpt: field.excerpt, ...(field.line ? { line: field.line } : {}) }),
          evidence.add({ kind: 'html', url: href, label: evidenceLabel('identical {field} on the version in another language', { field: field.name }), excerpt: twin.excerpt, ...(twin.line ? { line: twin.line } : {}) }),
        ], { field: field.name, other: href }, 'identical-to-other-locale', true));
      }
    }
    // Long fields can be language-identified on their own; image alt texts are pooled.
    const doc = page!.raw!;
    const alts = doc.parsed.images.map(image => image.attrs.alt ?? '').filter(alt => alt.trim() !== '').join('. ');
    const reference = pageLanguage(page!);
    const pageCode = reference && isDecisive(reference.guess, 100) ? reference.guess.language : languages.find(isDetectable);
    if (pageCode) {
      const candidates: Field[] = [...fields, ...(alts ? [{ name: 'image alt texts', text: alts, excerpt: alts.slice(0, 300) }] : [])];
      for (const field of candidates) {
        const guess = detectLanguage(field.text);
        if (guess.language === 'und' || guess.confidence < 0.9 || sameLanguage(guess.language, pageCode)) continue;
        results.push(fail('medium', [evidence.add({ kind: 'html', url: self, label: evidenceLabel('{field} detected as {language} (confidence {confidence, number, ::.00})', { field: field.name, language: languageLabel(guess.language), confidence: guess.confidence }), excerpt: field.excerpt, ...(field.line ? { line: field.line } : {}) })],
          { field: field.name, detected: languageLabel(guess.language), expected: languageLabel(pageCode) }, 'field-language', needsConfirmation(guess.language, pageCode)));
      }
    }
    return results.length > 0 ? results.slice(0, maxEvidence) : pass();
  },
};

const ogFormat = /^[a-z]{2,3}_[a-z]{2}$/iu;

export const ogLocale: RuleImplementation = {
  id: 'intl-og-locale',
  evaluate({ page, site, evidence }) {
    const doc = page!.raw!;
    const url = page!.fetch.finalUrl;
    const locale = metaProperty(doc, 'og:locale')[0];
    const alternates = metaProperty(doc, 'og:locale:alternate');
    const detected = pageLanguage(page!);
    const fromContent = detected && isDecisive(detected.guess, 100) ? detected.guess.language : undefined;
    const fromLang = primaryLanguage(doc.parsed.htmlLang);
    const fromHreflang = hreflangLanguages(page!, declaredSets(site)).languages[0];
    const pageCode = fromContent ?? fromLang ?? fromHreflang;
    if (!locale?.attrs.content) {
      // Without Open Graph markup there is no preview metadata for og:locale to describe.
      if (!doc.parsed.metas.some(meta => (meta.attrs.property ?? '').toLowerCase().startsWith('og:'))) return notApplicable('no-open-graph');
      if (!pageCode) return notEvaluated('page-language-unknown');
      if (sameLanguage(pageCode, 'en')) return pass();
      const ids = [fromContent ? languageEvidence(evidence, url, detected!) : evidence.add({ kind: 'html', url, label: evidenceLabel('declared page language'), excerpt: fromLang ? `lang="${doc.parsed.htmlLang}"` : `hreflang ${fromHreflang}` })];
      return fail('low', ids, { language: languageLabel(pageCode) }, 'missing-non-english');
    }
    const value = locale.attrs.content.trim();
    const id = evidence.add({ kind: 'html', url, label: evidenceLabel('og:locale meta element'), excerpt: elementSource(doc.html, locale), line: locale.line });
    const results: RuleResult[] = [];
    const malformed = [locale, ...alternates].filter(meta => !ogFormat.test((meta.attrs.content ?? '').trim()));
    if (malformed.length > 0) {
      results.push(fail('low', malformed.map(meta => evidence.add({ kind: 'html', url, label: evidenceLabel('{property} value not in language_TERRITORY form', { property: (meta.attrs.property ?? '').toLowerCase() }), excerpt: elementSource(doc.html, meta), line: meta.line })),
        { value: list(malformed.map(meta => `"${(meta.attrs.content ?? '').trim()}"`)) }, 'malformed'));
    }
    const ogLanguage = primaryLanguage(value);
    if (ogLanguage && pageCode && !sameLanguage(ogLanguage, pageCode)) {
      results.push(fail('low', [id, fromContent ? languageEvidence(evidence, url, detected!) : evidence.add({ kind: 'html', url, label: evidenceLabel('declared page language'), excerpt: fromLang ? `lang="${doc.parsed.htmlLang}"` : `hreflang ${fromHreflang}` })],
        { value, language: languageLabel(pageCode) }, 'language-mismatch'));
    }
    return results.length > 0 ? results : pass([id]);
  },
};

export const languageImplementations: readonly RuleImplementation[] = [
  valueVsContentLanguage, htmlLangMissingOrInvalid, htmlLangVsContent, contentLanguageSignalConflict, mixedLanguagePage,
  untranslatedVariant, metadataTranslationParity, ogLocale,
];

