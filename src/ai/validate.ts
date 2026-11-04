import { detectableLanguages, isDetectable, languageScores, listingLanguages, tokenize } from '../analyze/language.ts';
import { rule as catalogRule } from '../catalog/index.ts';
import { severities, type Myth, type RuleMeta, type Severity } from '../core/types.ts';
import type { Report, ReportFinding } from '../report/model.ts';
import type { FindingScope } from '../rules/engine.ts';
import { mythMatches } from '../rules/myth-filter.ts';
import { isTerm, rangesOf } from '../rules/schema/vocabulary.ts';
import type { EvidencePack } from './pack.ts';
import { judgmentCap, languageRules, type PassPlan } from './passes.ts';
import { validateSchema, type Schema } from './schema.ts';
import { normalizeUrl, type FactCorpus, type PageInfo, type SiteStrings } from './site.ts';
import { checkQuote, cleanDisplay, fold, unsupportedFacts, urlPattern } from './text.ts';
import type {
  Confidence, DroppedClaim, DropReason, JsonLdProposal, JudgedValue, Notes, PageAssessment, PassId, Proposal, Quote, SelfAssessmentAnswer, SerpProposal,
} from './types.ts';

export type MythMatcher = (text: string) => readonly Myth[];

/**
 * The catalog's myth filter: phrase matching per clause that ignores case and punctuation and lets a nearby
 * negation ("do not add rel=next") stand as a refutation. A myth match drops the claim; it is not sent back.
 */
export const defaultMythMatcher: MythMatcher = mythMatches;

/** A finding that passed validation, before verification and before it becomes a report finding. */
export interface DraftFinding {
  readonly pass: PassId;
  readonly rule: RuleMeta;
  readonly page: PageInfo;
  readonly scope: FindingScope;
  readonly verdict: 'confirmed' | 'likely' | 'not_confirmed';
  readonly outcome: 'fail' | 'pass';
  readonly reasonCode: string;
  readonly severity?: Severity;
  readonly confidence: Confidence;
  readonly absence: boolean;
  readonly evidenceIds: readonly string[];
  readonly quotes: readonly Quote[];
  readonly notes: Notes;
  readonly candidate?: ReportFinding;
  readonly adjustments: readonly string[];
}

export interface ValidationContext {
  readonly plan: PassPlan;
  readonly pack: EvidencePack;
  readonly schema: Schema;
  readonly report: Report;
  readonly strings: SiteStrings;
  readonly corpus: FactCorpus;
  readonly keyword: readonly string[];
  readonly mythMatches: MythMatcher;
}

export interface AnswerValidation {
  readonly findings: DraftFinding[];
  readonly proposals: Proposal[];
  readonly assessment?: PageAssessment;
  /** Rules the model could not assess on this page. */
  readonly notAssessable: string[];
  readonly dropped: DroppedClaim[];
}

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const summaryKeys = ['ruleId', 'scope', 'verdict', 'reasonCode', 'severity', 'confidence', 'absence', 'evidenceIds', 'kind', 'text', 'language', 'question', 'answer', 'value', 'evidenceId', 'quote', 'jsonLd'];

function bounded(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return cleanDisplay(value, 300);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return depth > 2 ? [] : value.slice(0, 12).map(entry => bounded(entry, depth + 1));
  if (isRecord(value) && depth <= 2) return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, entry]) => [cleanDisplay(key, 40), bounded(entry, depth + 1)]));
  return undefined;
}

/** The claim as the model made it, cleaned and bounded, so the report can show what was dropped and why. */
function summary(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return { value: bounded(raw) ?? null };
  const result: Record<string, unknown> = {};
  for (const key of summaryKeys) if (key in raw) result[key] = bounded(raw[key]);
  if (isRecord(raw.notes) && typeof raw.notes.en === 'string') result.note = cleanDisplay(raw.notes.en, 200);
  if (Array.isArray(raw.quotes)) result.quotes = bounded(raw.quotes);
  return result;
}

function cleanNotes(notes: Raw): Notes {
  return { en: cleanDisplay(String(notes.en ?? ''), 200), es: cleanDisplay(String(notes.es ?? ''), 200), ca: cleanDisplay(String(notes.ca ?? ''), 200) };
}

const absenceCode = /^(?:missing|no|absent|lack|lacks|lacking|without|none|empty)(?:-|$)/u;

/** Absence claims that code has already settled: a passing check here means the thing is present. */
const settledAbsences: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/(?:^|-)title(?:-|$)/u, ['content-title-missing']],
  [/(?:^|-)h1(?:-|$)/u, ['content-h1-missing']],
  [/(?:^|-)(?:meta-)?description(?:-|$)/u, ['content-meta-description-missing']],
  [/(?:^|-)alt(?:-|$)/u, ['content-img-alt-missing']],
  [/(?:^|-)(?:author|byline)(?:-|$)/u, ['content-byline-author']],
  [/(?:^|-)(?:html-)?lang(?:-|$)/u, ['intl-html-lang-missing-or-invalid']],
  [/(?:^|-)self-reference(?:-|$)/u, ['intl-hreflang-missing-self-reference']],
  [/(?:^|-)x-default(?:-|$)/u, ['intl-hreflang-x-default-missing']],
];

// Folded text (lower case, no accents). A recommendation needs a verb of adding or reaching before the market,
// so a description such as "mixes English with other languages" is not one.
const newMarketPatterns: readonly RegExp[] = [
  /\b(?:add|offer|launch|creat|introduc|enter|target|expand|reach)\w*\b[^.]{0,30}\b(?:new|additional|more|other|further)\s+(?:markets?|countr(?:y|ies)|languages?|locales?|regions?)\b/u,
  /\b(?:anad|agreg|ofrec|lanz|crea|entra|expand|dirig|llega)\w*\b[^.]{0,30}\b(?:nuev|otr|mas)\w*\s+(?:mercados?|paises|idiomas?|lenguas?|regiones)\b/u,
  /\b(?:afeg|ofer|llanc|crea|entra|expand|arrib)\w*\b[^.]{0,30}\b(?:nous?|noves|altres|mes)\s+(?:mercats?|paisos|idiomes|llengues|regions)\b/u,
  /\btranslat(?:e|ing)\s+(?:the|your|this)\s+(?:site|website|content|pages?)\s+into\b/u,
  /\btraduc(?:ir|e)\s+(?:el|la|su|tu|los|las)\s+(?:sitio|web|contenido|paginas?)\s+al?\b/u,
  /\btradu(?:ir|eix)\s+(?:el|la|els|les)\s+(?:lloc|web|contingut|pagines)\s+(?:a|al)\b/u,
];

export function recommendsNewMarket(text: string): boolean {
  const folded = fold(text);
  return newMarketPatterns.some(pattern => pattern.test(folded));
}

function lessSevere(a: Severity, b: Severity): Severity {
  return severities.indexOf(a) > severities.indexOf(b) ? a : b;
}

const confidenceOrder: readonly Confidence[] = ['high', 'medium', 'low'];

function capConfidence(value: Confidence, cap: Confidence): Confidence {
  return confidenceOrder.indexOf(value) > confidenceOrder.indexOf(cap) ? value : cap;
}

export function scopeKey(scope: FindingScope): string {
  return scope.kind === 'page' ? scope.url : `site:${scope.origin}`;
}

function findingsAt(report: Report, ruleId: string, scope: FindingScope): ReportFinding[] {
  const key = scopeKey(scope);
  return report.findings.filter(finding => finding.ruleId === ruleId && scopeKey(finding.scope) === key);
}

class Rejection {
  readonly reason: DropReason;
  readonly detail: string | undefined;

  constructor(reason: DropReason, detail?: string) {
    this.reason = reason;
    this.detail = detail;
  }
}

const reject = (reason: DropReason, detail?: string) => new Rejection(reason, detail);

/** The call's page, when the model's scope URL names it. */
function scopePage(url: string, context: ValidationContext): PageInfo | Rejection {
  const wanted = normalizeUrl(url);
  const page = context.plan.page;
  if (wanted !== undefined && (normalizeUrl(page.url) === wanted || normalizeUrl(page.finalUrl) === wanted)) return page;
  const audited = context.strings.pages.some(entry => normalizeUrl(entry.url) === wanted || normalizeUrl(entry.finalUrl) === wanted);
  return reject(audited ? 'scope-outside-call' : 'scope-not-audited', cleanDisplay(url, 200));
}

function checkEvidence(ids: readonly string[], context: ValidationContext): Rejection | undefined {
  const unknown = ids.find(id => !context.pack.included.has(id));
  return unknown === undefined ? undefined : reject('unknown-evidence', unknown);
}

/** A quote must appear, after normalisation, inside the one evidence item it cites. */
function checkQuotes(quotes: readonly Quote[], cited: readonly string[], context: ValidationContext): Rejection | undefined {
  for (const quote of quotes) {
    if (!cited.includes(quote.evidenceId)) return reject('quote-uncited-evidence', quote.evidenceId);
    const target = context.pack.included.get(quote.evidenceId);
    if (!target) return reject('unknown-evidence', quote.evidenceId);
    const result = target.section ? 'quote-not-found' : checkQuote(quote.text, target.text);
    if (result === 'quote-too-short') return reject('quote-too-short', quote.evidenceId);
    if (result === 'quote-not-found') {
      const elsewhere = [...context.pack.included].some(([id, other]) => id !== quote.evidenceId && !other.section && checkQuote(quote.text, other.text) === 'ok');
      return reject(elsewhere ? 'quote-other-evidence' : 'quote-not-found', quote.evidenceId);
    }
  }
  return undefined;
}

/** Notes and codes must not repeat a myth or recommend new markets, countries or languages. */
function checkRecommendations(texts: readonly string[], context: ValidationContext): Rejection | undefined {
  for (const text of texts) {
    const myth = context.mythMatches(text)[0];
    if (myth) return reject('myth', myth.id);
  }
  return texts.some(recommendsNewMarket) ? reject('new-market') : undefined;
}

/**
 * Whether a word tells a language apart: the language detector lists it as a function word of that language and of
 * no other. Spelling features describe running text, not one word: Spanish "nació" ends as Catalan words do, and
 * Catalan "castell" has the ll of Spanish. For a language the detector does not know, no list or feature may count it.
 */
function discriminates(token: string, language: string): boolean {
  if (!isDetectable(language)) {
    const scores = languageScores([token]);
    return detectableLanguages.every(other => scores[other] === 0);
  }
  const listed = listingLanguages(token);
  return listed.length === 1 && listed[0] === language;
}

/**
 * Language claims need a language and at least two distinct words, found in the cited items, that only that language
 * uses. Words are compared as the detector reads them, with their accents, so Catalan "més" is not Spanish "mes".
 */
function checkDiscriminatingWords(language: string | null | undefined, words: readonly string[], cited: readonly string[], context: ValidationContext): Rejection | undefined {
  const claimed = primaryLanguage(language ?? undefined);
  if (claimed === undefined || claimed === 'und') return reject('discriminating-words', 'no language given');
  const present = new Set(cited.map(id => context.pack.included.get(id)).flatMap(item => (item && !item.section ? tokenize(item.text) : [])));
  const tokens = words.map(word => tokenize(word)).filter(entry => entry.length === 1).map(([token]) => token!);
  const found = new Set(tokens.filter(token => [...token].length >= 2 && present.has(token) && discriminates(token, claimed)));
  return found.size >= 2 ? undefined : reject('discriminating-words', `${found.size} of ${words.length} found and discriminating`);
}

interface FindingAnswer {
  readonly ruleId: string;
  readonly scope: string;
  readonly verdict: 'confirmed' | 'likely' | 'not_confirmed' | 'not_assessable';
  readonly reasonCode: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly absence: boolean;
  readonly evidenceIds: readonly string[];
  readonly quotes: readonly Quote[];
  readonly notes: Raw;
  readonly language?: string | null;
  readonly discriminatingWords?: readonly string[];
}

/**
 * The candidate an answer decides. A rule with one candidate on the scope takes the answer; with several, the
 * answer must cite more of one candidate's evidence than of any other's.
 */
function candidateFor(answer: FindingAnswer, candidates: readonly ReportFinding[]): ReportFinding | Rejection {
  if (candidates.length === 1) return candidates[0]!;
  const shared = candidates.map(candidate => candidate.evidence.filter(id => answer.evidenceIds.includes(id)).length);
  const most = Math.max(...shared);
  const matched = candidates.filter((_, index) => shared[index] === most);
  return most > 0 && matched.length === 1 ? matched[0]! : reject('ambiguous-candidate', answer.ruleId);
}

function deterministicConflict(answer: FindingAnswer, outcome: 'fail' | 'pass', absence: boolean, scope: FindingScope, page: PageInfo, context: ValidationContext): Rejection | ReportFinding | undefined {
  const existing = findingsAt(context.report, answer.ruleId, scope);
  const candidates = existing.filter(finding => finding.outcome === 'fail' && finding.needsJudgment === true);
  if (candidates.length > 0) return candidateFor(answer, candidates);
  if (existing.some(finding => finding.outcome === 'fail')) return reject(outcome === 'fail' ? 'duplicate-of-deterministic' : 'contradicts-deterministic', answer.ruleId);
  if (existing.some(finding => finding.outcome === 'pass')) return reject(outcome === 'fail' ? 'contradicts-deterministic' : 'duplicate-of-deterministic', answer.ruleId);
  if (absence && outcome === 'fail') {
    for (const [pattern, ruleIds] of settledAbsences) {
      if (!pattern.test(answer.reasonCode)) continue;
      const passed = context.report.findings.find(finding => ruleIds.includes(finding.ruleId) && finding.outcome === 'pass' && finding.scope.kind === 'page' && finding.scope.url === page.key);
      if (passed) return reject('contradicts-deterministic', passed.ruleId);
    }
  }
  return undefined;
}

function validateFinding(raw: unknown, index: number, itemSchema: Schema, context: ValidationContext, seen: Set<string>): DraftFinding | Rejection | 'not_assessable' {
  const ruleId = isRecord(raw) && typeof raw.ruleId === 'string' ? raw.ruleId : undefined;
  if (ruleId !== undefined && !catalogRule(ruleId)) return reject('rule-not-in-catalog', cleanDisplay(ruleId, 80));
  const rule = context.plan.rules.find(entry => entry.id === ruleId);
  if (ruleId !== undefined && !rule) return reject('rule-out-of-scope', ruleId);
  const errors = validateSchema(raw, itemSchema, `$.findings[${index}]`);
  if (errors.length > 0 || !rule) return reject('schema', errors[0]);
  const answer = raw as unknown as FindingAnswer;
  if (answer.verdict === 'not_assessable') return 'not_assessable';
  const page = scopePage(answer.scope, context);
  if (page instanceof Rejection) return page;
  if (answer.evidenceIds.length === 0) return reject('missing-evidence');
  const failure = checkEvidence(answer.evidenceIds, context) ?? checkQuotes(answer.quotes, answer.evidenceIds, context);
  if (failure) return failure;
  const absence = answer.absence || absenceCode.test(answer.reasonCode);
  if (absence) {
    const incomplete = answer.evidenceIds.find(id => {
      const item = context.pack.included.get(id)!;
      return !item.sectionComplete || !item.complete;
    });
    if (incomplete) return reject('absence-on-incomplete-slice', incomplete);
  } else if (answer.quotes.length === 0) {
    return reject('missing-quote');
  }
  const notes = cleanNotes(answer.notes);
  const recommendation = checkRecommendations([notes.en, notes.es, notes.ca, answer.reasonCode.replace(/-/gu, ' ')], context);
  if (recommendation) return recommendation;
  const outcome = answer.verdict === 'not_confirmed' ? 'pass' : 'fail';
  if (context.plan.pass === 'intl' && languageRules.includes(rule.id) && outcome === 'fail') {
    const words = checkDiscriminatingWords(answer.language, answer.discriminatingWords ?? [], answer.evidenceIds, context);
    if (words) return words;
  }
  const scope: FindingScope = rule.scope === 'site' ? { kind: 'site', origin: context.report.target.origin } : { kind: 'page', url: page.key };
  const conflict = deterministicConflict(answer, outcome, absence, scope, page, context);
  if (conflict instanceof Rejection) return conflict;
  // Each candidate takes one decision; without candidates, a rule takes one claim per scope.
  const key = conflict ? `candidate|${conflict.id}` : `${rule.id}|${scopeKey(scope)}`;
  if (seen.has(key)) return reject('duplicate', rule.id);
  seen.add(key);
  const adjustments: string[] = [];
  let severity: Severity | undefined;
  if (outcome === 'fail') {
    const cap = judgmentCap(rule, context.keyword);
    severity = lessSevere(answer.severity, cap);
    if (severity !== answer.severity) adjustments.push(`severity-capped:${answer.severity}->${severity}`);
  }
  const confidence = answer.verdict === 'likely' ? capConfidence(answer.confidence, 'medium') : answer.confidence;
  if (confidence !== answer.confidence) adjustments.push(`confidence-capped:${answer.confidence}->${confidence}`);
  return {
    pass: context.plan.pass,
    rule,
    page,
    scope,
    verdict: answer.verdict,
    outcome,
    reasonCode: answer.reasonCode,
    ...(severity ? { severity } : {}),
    confidence,
    absence,
    evidenceIds: [...new Set(answer.evidenceIds)],
    quotes: answer.quotes.map(quote => ({ evidenceId: quote.evidenceId, text: cleanDisplay(quote.text, 400) })),
    notes,
    ...(conflict ? { candidate: conflict } : {}),
    adjustments,
  };
}

const titleLength = { min: 10, max: 70 };
const descriptionLength = { min: 50, max: 160 };
export const ownerPlaceholder = 'OWNER_TO_SUPPLY';

/** Whether a URL reference names one the collected pages reference: resolved against the page, with either scheme when it has none. */
function knownLink(reference: string, page: PageInfo, context: ValidationContext): boolean {
  const forms = reference.startsWith('//') ? [`https:${reference}`, `http:${reference}`]
    : /^www\./iu.test(reference) ? [`https://${reference}`, `http://${reference}`] : [reference];
  return forms.some(form => {
    let absolute: string;
    try {
      absolute = new URL(form, page.finalUrl).href;
    } catch {
      return false;
    }
    const normalized = normalizeUrl(absolute);
    return normalized !== undefined && context.corpus.links.has(normalized);
  });
}

/** A full stop or comma after a URL ends the sentence, not the URL. */
const trailingPunctuation = /[.,;:!?]+$/u;

/** URLs not referenced by any collected page become OWNER_TO_SUPPLY, so a proposal never invents a link. */
function replaceUnknownUrls(text: string, page: PageInfo, context: ValidationContext): { text: string; placeholders: number } {
  let placeholders = 0;
  const replaced = text.replace(urlPattern, match => {
    const url = match.replace(trailingPunctuation, '');
    if (knownLink(url, page, context)) return match;
    placeholders += 1;
    return `${ownerPlaceholder}${match.slice(url.length)}`;
  });
  return { text: replaced, placeholders };
}

function primaryLanguage(tag: string | undefined): string | undefined {
  return tag?.split('-')[0]?.toLowerCase();
}

function validateSerpProposal(raw: unknown, index: number, itemSchema: Schema, context: ValidationContext, counts: Map<string, number>): SerpProposal | Rejection {
  const errors = validateSchema(raw, itemSchema, `$.proposals[${index}]`);
  if (errors.length > 0) return reject('schema', errors[0]);
  const answer = raw as unknown as { kind: 'title' | 'meta-description'; scope: string; text: string; language: string; evidenceIds: readonly string[]; notes: Raw };
  const page = scopePage(answer.scope, context);
  if (page instanceof Rejection) return page;
  const evidence = checkEvidence(answer.evidenceIds, context);
  if (evidence) return evidence;
  const count = (counts.get(answer.kind) ?? 0) + 1;
  counts.set(answer.kind, count);
  if (count > 2) return reject('too-many', answer.kind);
  const corpus = context.corpus.pages.get(page.key);
  const urls = replaceUnknownUrls(cleanDisplay(answer.text, 300), page, context);
  const text = urls.text;
  const bounds = answer.kind === 'title' ? titleLength : descriptionLength;
  const length = [...text].length;
  if (length < bounds.min || length > bounds.max) return reject('length', `${length} characters`);
  const pageLanguage = primaryLanguage(corpus?.language);
  if (pageLanguage && primaryLanguage(answer.language) !== pageLanguage) return reject('wrong-language', cleanDisplay(answer.language, 35));
  const current = answer.kind === 'title' ? corpus?.title : corpus?.description;
  if (current !== undefined && fold(current) === fold(text)) return reject('unchanged');
  for (const [key, other] of context.corpus.pages) {
    if (key === page.key) continue;
    const value = answer.kind === 'title' ? other.title : other.description;
    if (value !== undefined && fold(value) === fold(text)) return reject('not-unique', key);
  }
  const brand = context.corpus.brand;
  if (answer.kind === 'title' && brand && current && fold(current).includes(fold(brand)) && !fold(text).includes(fold(brand))) return reject('brand-missing');
  if (corpus) {
    const missing = unsupportedFacts(text, corpus.facts);
    if (missing.length > 0) return reject('new-fact', cleanDisplay(missing.join(', '), 200));
  }
  const notes = cleanNotes(answer.notes);
  const recommendation = checkRecommendations([text, notes.en, notes.es, notes.ca], context);
  if (recommendation) return recommendation;
  return {
    kind: answer.kind,
    pass: 'serp',
    scope: page.key,
    text,
    language: answer.language,
    ...(current === undefined ? {} : { current }),
    evidenceIds: [...new Set(answer.evidenceIds)],
    notes,
    placeholders: urls.placeholders,
  };
}

const retiredTypes = new Set(['FAQPage', 'HowTo', 'ClaimReview', 'SpecialAnnouncement', 'VehicleListing', 'SearchAction']);
const contactKeys = new Set(['telephone', 'faxNumber', 'email', 'streetAddress', 'postalCode', 'addressLocality', 'addressRegion']);
const schemaContext = /^https?:\/\/schema\.org\/?$/iu;

function typeNames(value: unknown): string[] {
  const types = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return types.map(type => type.replace(/^https?:\/\/schema\.org\//iu, '').replace(/^schema:/iu, ''));
}

function hasSchemaContext(value: unknown): boolean {
  if (typeof value === 'string') return schemaContext.test(value.trim());
  if (Array.isArray(value)) return value.some(hasSchemaContext);
  return isRecord(value) && typeof value['@vocab'] === 'string' && schemaContext.test(value['@vocab'].trim());
}

interface JsonLdReview {
  readonly value: unknown;
  readonly placeholders: number;
  readonly missing: string[];
  readonly retired: string[];
}

const vocabularyIri = /^https?:\/\/schema\.org(?:\/([^\s/?#]*))?$/iu;

/** The schema.org vocabulary itself or one of its terms, such as https://schema.org/InStock, which name no page. */
function vocabularyTerm(value: string): boolean {
  const match = vocabularyIri.exec(value);
  return match !== null && (match[1] === undefined || match[1] === '' || isTerm(match[1]));
}

const webReference = /^(?:https?:\/\/|\/\/|www\.)/iu;
const otherScheme = /^(?!https?:)[a-z][a-z\d+.-]*:/iu;

/** Keys whose values are URLs even when relative: @id, the item of a breadcrumb and properties with a URL range but no Text range. */
function holdsUrls(key: string): boolean {
  if (key === '@id' || key === 'item') return true;
  const ranges = rangesOf(key);
  return ranges.includes('URL') && !ranges.includes('Text');
}

/** Whether a whole JSON-LD string names a link: any value of a key that holds URLs, or a lone web address in another property. */
function namesLink(value: string, key: string): boolean {
  // An @id may also be a blank node or a URN, which names no page.
  if (holdsUrls(key)) return value !== '' && (key !== '@id' || !(value.startsWith('_:') || otherScheme.test(value)));
  return webReference.test(value) && !/\s/u.test(value);
}

/** Walks a proposed JSON-LD value: unknown URLs become placeholders, facts must be visible, retired features are refused. */
function reviewJsonLd(value: unknown, key: string, context: ValidationContext, page: PageInfo, review: { placeholders: number; missing: string[]; retired: string[] }): unknown {
  const facts = context.corpus.pages.get(page.key)?.facts;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (value === ownerPlaceholder || vocabularyTerm(trimmed)) return value;
    if (namesLink(trimmed, key)) {
      if (knownLink(trimmed, page, context)) return value;
      review.placeholders += 1;
      return ownerPlaceholder;
    }
    // A type, an id or a context entry that names no address states no fact.
    if (key === '@id' || key === '@type' || key === '@context') return value;
    const urls = replaceUnknownUrls(value, page, context);
    review.placeholders += urls.placeholders;
    if (facts) {
      if (contactKeys.has(key) && !facts.text.includes(fold(urls.text))) review.missing.push(urls.text);
      else review.missing.push(...unsupportedFacts(urls.text, facts));
    }
    return urls.text;
  }
  if (typeof value === 'number') {
    if (facts) review.missing.push(...unsupportedFacts(String(value), facts));
    return value;
  }
  if (Array.isArray(value)) return value.map(entry => reviewJsonLd(entry, key, context, page, review));
  if (isRecord(value)) {
    for (const type of typeNames(value['@type'])) if (retiredTypes.has(type)) review.retired.push(type);
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, reviewJsonLd(entry, name, context, page, review)]));
  }
  return value;
}

function validateJsonLdProposal(raw: unknown, index: number, itemSchema: Schema, context: ValidationContext): JsonLdProposal | Rejection {
  const errors = validateSchema(raw, itemSchema, `$.proposals[${index}]`);
  if (errors.length > 0) return reject('schema', errors[0]);
  const answer = raw as unknown as { scope: string; jsonLd: string; evidenceIds: readonly string[]; notes: Raw };
  const page = scopePage(answer.scope, context);
  if (page instanceof Rejection) return page;
  const evidence = checkEvidence(answer.evidenceIds, context);
  if (evidence) return evidence;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.jsonLd);
  } catch {
    return reject('invalid-json-ld', 'not JSON');
  }
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  if (roots.length === 0 || !roots.every(root => isRecord(root) && hasSchemaContext(root['@context']) && (typeNames(root['@type']).length > 0 || Array.isArray(root['@graph'])))) {
    return reject('invalid-json-ld', 'each block needs a schema.org @context and an @type or @graph');
  }
  const review: JsonLdReview = { value: undefined, placeholders: 0, missing: [], retired: [] };
  const value = reviewJsonLd(parsed, '', context, page, review);
  if (review.retired.length > 0) return reject('retired-feature', review.retired.join(', '));
  if (review.missing.length > 0) return reject('new-fact', cleanDisplay([...new Set(review.missing)].join(', '), 200));
  const notes = cleanNotes(answer.notes);
  const recommendation = checkRecommendations([notes.en, notes.es, notes.ca], context);
  if (recommendation) return recommendation;
  return { kind: 'json-ld', pass: 'schema', scope: page.key, jsonLd: JSON.stringify(value, null, 2), evidenceIds: [...new Set(answer.evidenceIds)], notes, placeholders: review.placeholders };
}

/** An assessment answer needs a cited item and a matching quote, or, for a negative answer, a complete section. */
function judgedEvidence(answer: string, evidenceId: string | null, quote: string | null, negative: boolean, context: ValidationContext): Rejection | undefined {
  if (answer === 'not_assessable') return undefined;
  if (evidenceId === null) return reject('missing-evidence');
  const target = context.pack.included.get(evidenceId);
  if (!target) return reject('unknown-evidence', evidenceId);
  if (quote === null || quote.trim() === '') {
    if (negative && target.section && target.sectionComplete) return undefined;
    return reject(negative && target.section ? 'absence-on-incomplete-slice' : 'missing-quote', evidenceId);
  }
  return checkQuotes([{ evidenceId, text: quote }], [evidenceId], context);
}

function validateAssessments(raw: unknown, assessmentSchema: Schema, context: ValidationContext, dropped: DroppedClaim[]): PageAssessment | undefined {
  const errors = validateSchema(raw, assessmentSchema, '$.assessments');
  const base = { pass: context.plan.pass, role: 'analyst' as const, page: context.plan.page.key };
  if (errors.length > 0) {
    dropped.push({ ...base, kind: 'assessment', reason: 'schema', detail: errors[0]!, claim: summary(raw) });
    return undefined;
  }
  const record = raw as Raw;
  const judgedValue = (name: string, negatives: readonly string[]): JudgedValue | undefined => {
    const entry = record[name] as { value: string; evidenceId: string | null; quote: string | null };
    const problem = judgedEvidence(entry.value, entry.evidenceId, entry.quote, negatives.includes(entry.value), context);
    if (problem) {
      dropped.push({ ...base, kind: 'assessment', reason: problem.reason, ...(problem.detail ? { detail: problem.detail } : {}), claim: { assessment: name, ...summary(entry) } });
      return undefined;
    }
    return { value: entry.value, ...(entry.evidenceId ? { evidenceId: entry.evidenceId } : {}), ...(entry.quote ? { quote: cleanDisplay(entry.quote, 400) } : {}) };
  };
  const ymyl = judgedValue('ymyl', ['not']);
  const entityClarity = judgedValue('entityClarity', ['no']);
  const nonCommodityValue = judgedValue('nonCommodityValue', ['no']);
  const intentValue = judgedValue('intent', []);
  const intentRecord = record.intent as { inferred: boolean };
  const answers: SelfAssessmentAnswer[] = [];
  const asked = new Set<string>();
  for (const entry of record.selfAssessment as ReadonlyArray<{ question: string; answer: SelfAssessmentAnswer['answer']; evidenceId: string | null; quote: string | null }>) {
    if (asked.has(entry.question)) continue;
    asked.add(entry.question);
    const problem = judgedEvidence(entry.answer, entry.evidenceId, entry.quote, entry.answer === 'no', context);
    if (problem) {
      dropped.push({ ...base, kind: 'assessment', reason: problem.reason, ...(problem.detail ? { detail: problem.detail } : {}), claim: summary(entry) });
      continue;
    }
    answers.push({ question: entry.question, answer: entry.answer, ...(entry.evidenceId ? { evidenceId: entry.evidenceId } : {}), ...(entry.quote ? { quote: cleanDisplay(entry.quote, 400) } : {}) });
  }
  return {
    page: context.plan.page.key,
    ...(ymyl ? { ymyl } : {}),
    ...(entityClarity ? { entityClarity } : {}),
    ...(nonCommodityValue ? { nonCommodityValue } : {}),
    ...(intentValue ? { intent: { ...intentValue, inferred: intentRecord.inferred || context.keyword.length === 0 } } : {}),
    selfAssessment: answers,
  };
}

/** Top-level shape: every required list present, no unknown keys. A partial answer is refused as a whole. */
function shapeProblem(value: unknown, schema: Schema): string | undefined {
  if (!isRecord(value)) return '$: expected an object';
  const properties = schema.properties ?? {};
  for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) return `$: unexpected property ${cleanDisplay(key, 40)}`;
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) return `$: missing ${key}`;
    const expected = properties[key]!;
    if (expected.type === 'array' && !Array.isArray(value[key])) return `$.${key}: expected an array`;
    if (expected.type === 'object' && !isRecord(value[key])) return `$.${key}: expected an object`;
  }
  return undefined;
}

/**
 * Checks one analyst answer deterministically. Every claim that fails a check is dropped and kept with its
 * reason; nothing the model says is trusted until the evidence backs it.
 */
export function validateAnswer(value: unknown, context: ValidationContext): AnswerValidation {
  const findings: DraftFinding[] = [];
  const proposals: Proposal[] = [];
  const notAssessable: string[] = [];
  const dropped: DroppedClaim[] = [];
  const base = { pass: context.plan.pass, role: 'analyst' as const, page: context.plan.page.key };
  const shape = shapeProblem(value, context.schema);
  if (shape) {
    dropped.push({ ...base, kind: 'answer', reason: 'schema', detail: shape, claim: summary(value) });
    return { findings, proposals, notAssessable, dropped };
  }
  const record = value as Raw;
  const properties = context.schema.properties!;
  const seen = new Set<string>();
  const findingItems = properties.findings?.items;
  if (findingItems) {
    const list = record.findings as readonly unknown[];
    list.forEach((raw, index) => {
      const result = index >= (properties.findings!.maxItems ?? Number.POSITIVE_INFINITY) ? reject('too-many') : validateFinding(raw, index, findingItems, context, seen);
      if (result === 'not_assessable') notAssessable.push((raw as { ruleId: string }).ruleId);
      else if (result instanceof Rejection) {
        const ruleId = isRecord(raw) && typeof raw.ruleId === 'string' ? cleanDisplay(raw.ruleId, 80) : undefined;
        dropped.push({ ...base, kind: 'finding', ...(ruleId ? { ruleId } : {}), reason: result.reason, ...(result.detail ? { detail: result.detail } : {}), claim: summary(raw) });
      } else findings.push(result);
    });
  }
  const proposalItems = properties.proposals?.items;
  if (proposalItems) {
    const counts = new Map<string, number>();
    (record.proposals as readonly unknown[]).forEach((raw, index) => {
      const result = index >= (properties.proposals!.maxItems ?? Number.POSITIVE_INFINITY)
        ? reject('too-many')
        : context.plan.pass === 'serp' ? validateSerpProposal(raw, index, proposalItems, context, counts) : validateJsonLdProposal(raw, index, proposalItems, context);
      if (result instanceof Rejection) dropped.push({ ...base, kind: 'proposal', reason: result.reason, ...(result.detail ? { detail: result.detail } : {}), claim: summary(raw) });
      else proposals.push(result);
    });
  }
  const assessment = properties.assessments ? validateAssessments(record.assessments, properties.assessments, context, dropped) : undefined;
  return { findings, proposals, ...(assessment ? { assessment } : {}), notAssessable, dropped };
}

/** Proposals for different pages must not end up identical to each other either. */
export function distinctProposals(proposals: readonly Proposal[]): { kept: Proposal[]; dropped: DroppedClaim[] } {
  const kept: Proposal[] = [];
  const dropped: DroppedClaim[] = [];
  const seen = new Map<string, string>();
  for (const proposal of proposals) {
    if (proposal.kind === 'json-ld') {
      kept.push(proposal);
      continue;
    }
    const key = `${proposal.kind}|${fold(proposal.text)}`;
    const owner = seen.get(key);
    if (owner !== undefined && owner !== proposal.scope) {
      dropped.push({ pass: 'serp', role: 'analyst', kind: 'proposal', page: proposal.scope, reason: 'not-unique', detail: owner, claim: { kind: proposal.kind, text: proposal.text } });
      continue;
    }
    seen.set(key, proposal.scope);
    kept.push(proposal);
  }
  return { kept, dropped };
}
