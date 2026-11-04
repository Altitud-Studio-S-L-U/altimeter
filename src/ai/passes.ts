import { rules as catalogRules } from '../catalog/index.ts';
import type { EvidenceItem } from '../core/evidence.ts';
import type { SiteFacts } from '../core/facts.ts';
import { severities, type Myth, type RuleMeta, type Severity } from '../core/types.ts';
import type { Report, ReportFinding } from '../report/model.ts';
import { cleanText } from '../report/sanitize.ts';
import { inputAvailable } from '../rules/engine.ts';
import { safeReason, type DeterministicFact, type PackEntry, type PackSection } from './pack.ts';
import type { Schema } from './schema.ts';
import { itemsOf, normalizeUrl, sliceOf, type PageInfo, type SiteItem, type SiteStrings, type SliceName } from './site.ts';
import type { PassId, SkippedPass } from './types.ts';

export interface PassDefinition {
  readonly id: PassId;
  /** The catalog category whose rules and rubric the pass uses. */
  readonly category: 'content' | 'schema' | 'intl';
  readonly heading: string;
  /** Page slices sent to the model, most important first, so the size cap cuts the least useful ones. */
  readonly slices: readonly SliceName[];
}

export const passDefinitions: readonly PassDefinition[] = [
  { id: 'content', category: 'content', heading: 'Content quality and E-E-A-T', slices: ['metadata', 'headings', 'text', 'hidden-text', 'images', 'links', 'structured-data'] },
  { id: 'serp', category: 'content', heading: 'Title and meta description proposals', slices: ['metadata', 'headings', 'text'] },
  { id: 'schema', category: 'schema', heading: 'Structured data', slices: ['structured-data', 'metadata', 'headings', 'text', 'images', 'links'] },
  { id: 'intl', category: 'intl', heading: 'International and language', slices: ['metadata', 'http', 'hreflang', 'headings', 'text', 'links'] },
];

export function passDefinition(id: PassId): PassDefinition {
  return passDefinitions.find(entry => entry.id === id)!;
}

/** Title and description checks whose failures make a rewrite worth proposing. */
export const serpRules: readonly string[] = [
  'content-title-missing', 'content-title-multiple', 'content-title-duplicate', 'content-title-boilerplate', 'content-title-width',
  'content-title-stuffing', 'content-title-h1-mismatch', 'content-title-language-mismatch', 'content-title-obsolete-year', 'content-title-branding',
  'content-title-sensational', 'content-meta-description-missing', 'content-meta-description-duplicate', 'content-meta-description-quality',
];

/** Rules whose findings are claims about the language of content; they need discriminating words. */
export const languageRules: readonly string[] = [
  'intl-mixed-language-page', 'intl-html-lang-vs-content', 'intl-hreflang-value-vs-content-language', 'intl-untranslated-variant', 'intl-metadata-translation-parity',
];

export interface PassPlan {
  readonly pass: PassId;
  readonly page: PageInfo;
  /** True for the one call per pass that also judges the category's site-scope rules. */
  readonly sitePage: boolean;
  readonly rules: readonly RuleMeta[];
  /** Deterministic findings with needsJudgment that this call confirms or dismisses. */
  readonly candidates: readonly ReportFinding[];
  /** Deterministic pass and fail results shown to the model as read-only facts. */
  readonly facts: readonly ReportFinding[];
  /** Other pages whose metadata is included: every page for SERP uniqueness, hreflang alternates for parity. */
  readonly contextPages: readonly PageInfo[];
}

function lessSevere(a: Severity, b: Severity): Severity {
  return severities.indexOf(a) > severities.indexOf(b) ? a : b;
}

/** The highest severity a judgment may carry: medium, the rule's own maximum, or info for an inferred intent. */
export function judgmentCap(rule: RuleMeta, keyword: readonly string[]): Severity {
  if (rule.id === 'content-intent-match' && keyword.length === 0) return 'info';
  return lessSevere(rule.maxSeverity, 'medium');
}

function onScope(finding: ReportFinding, rule: Pick<RuleMeta, 'scope'>, page: PageInfo): boolean {
  return rule.scope === 'site' ? finding.scope.kind === 'site' : finding.scope.kind === 'page' && finding.scope.url === page.key;
}

/**
 * The findings a model may see. Owner data, such as Search Console, never enters a request: neither findings
 * with origin owner-data nor findings that cite owner-data evidence, whatever rule produced them.
 */
export function shareableFindings(report: Report): ReportFinding[] {
  const owned = new Set(report.evidence.filter(item => item.kind === 'owner-data').map(item => item.id));
  return report.findings.filter(finding => finding.origin !== 'owner-data' && !finding.evidence.some(id => owned.has(id)));
}

function scopeRules(definition: PassDefinition, page: PageInfo, sitePage: boolean, findings: readonly ReportFinding[], site: SiteFacts): { rules: RuleMeta[]; candidates: ReportFinding[] } {
  const rules: RuleMeta[] = [];
  const candidates: ReportFinding[] = [];
  if (definition.id === 'serp') return { rules, candidates };
  const facts = site.pages.get(page.key);
  for (const rule of catalogRules) {
    if (rule.category !== definition.category || rule.status !== 'v1' || (rule.method !== 'ai-judgment' && rule.method !== 'hybrid')) continue;
    if (rule.scope === 'site' && !sitePage) continue;
    if (rule.scope === 'page' && rule.appliesTo !== 'all' && !rule.appliesTo.includes(page.pageType)) continue;
    // Site-scope rules are judged from the site page, so page inputs are checked on it.
    if (rule.inputs.some(input => input !== 'ai' && !inputAvailable(input, site, facts))) continue;
    const existing = findings.filter(finding => finding.ruleId === rule.id && onScope(finding, rule, page));
    const pending = existing.filter(finding => finding.outcome === 'fail' && finding.needsJudgment === true);
    if (pending.length > 0) {
      rules.push(rule);
      candidates.push(...pending);
      continue;
    }
    const decided = existing.some(finding => finding.outcome === 'pass' || finding.outcome === 'fail' || finding.outcome === 'not_applicable');
    if (decided) continue;
    // Direct claims are for ai-judgment rules and for hybrid rules that list the analyst as an input; any other
    // hybrid rule is decided by code and reaches the analyst only as a candidate to confirm or dismiss.
    if (rule.method === 'ai-judgment' || rule.inputs.includes('ai')) rules.push(rule);
  }
  return { rules, candidates };
}

function touchesPage(finding: ReportFinding, page: PageInfo, evidence: ReadonlyMap<string, EvidenceItem>): boolean {
  if (finding.scope.kind === 'page') return finding.scope.url === page.key;
  return finding.evidence.some(id => {
    const url = evidence.get(id)?.url;
    return url !== undefined && (url === page.url || url === page.finalUrl);
  });
}

function factsFor(definition: PassDefinition, page: PageInfo, findings: readonly ReportFinding[], evidence: ReadonlyMap<string, EvidenceItem>): ReportFinding[] {
  // A site-wide title problem, such as duplicates, only asks for a rewrite on the pages its evidence names.
  const relevant = findings.filter(finding => (finding.outcome === 'pass' || finding.outcome === 'fail') && finding.needsJudgment !== true
    && (definition.id === 'serp' ? serpRules.includes(finding.ruleId) && touchesPage(finding, page, evidence) : finding.category === definition.category && (finding.scope.kind === 'site' || touchesPage(finding, page, evidence))));
  return relevant.sort((a, b) => (a.outcome === b.outcome ? 0 : a.outcome === 'fail' ? -1 : 1)).slice(0, 60);
}

function alternatesOf(page: PageInfo, strings: SiteStrings): PageInfo[] {
  const targets = new Set(itemsOf(strings, page.key, 'hreflang').map(item => (item.href ? normalizeUrl(item.href) : undefined)).filter(Boolean));
  return strings.pages.filter(other => other.key !== page.key && (targets.has(normalizeUrl(other.finalUrl)) || targets.has(normalizeUrl(other.url))));
}

export interface PlanInput {
  readonly report: Report;
  readonly site: SiteFacts;
  readonly strings: SiteStrings;
  /** The pages to analyse, in priority order; the first is the audited page. */
  readonly pages: readonly PageInfo[];
}

/**
 * Decides which passes run on which pages. A pass runs only when its inputs exist and something is left to
 * judge: rules the analyst owns, candidates from code, a title or description problem for the SERP pass,
 * structured data for the schema pass, and alternates or several languages for the international pass.
 */
export function planPasses(input: PlanInput): { plans: PassPlan[]; skipped: SkippedPass[] } {
  const plans: PassPlan[] = [];
  const skipped: SkippedPass[] = [];
  const evidence = new Map(input.report.evidence.map(item => [item.id, item]));
  const findings = shareableFindings(input.report);
  const sitePage = input.pages.find(page => page.role === 'home') ?? input.pages[0];
  const languages = new Set(input.pages.map(page => page.language?.split('-')[0]?.toLowerCase()).filter(Boolean));
  for (const definition of passDefinitions) {
    for (const page of input.pages) {
      const isSitePage = page === sitePage;
      const { rules, candidates } = scopeRules(definition, page, isSitePage, findings, input.site);
      const facts = factsFor(definition, page, findings, evidence);
      const skip = (reason: string) => skipped.push({ pass: definition.id, page: page.key, reason });
      if (definition.id === 'serp') {
        const metadata = itemsOf(input.strings, page.key, 'metadata');
        const hasBasis = metadata.length > 0 || itemsOf(input.strings, page.key, 'text').length > 0;
        if (!hasBasis) skip('no title, description or text to work from');
        else if (!facts.some(finding => finding.outcome === 'fail')) skip('no failed title or description check');
        else plans.push({ pass: 'serp', page, sitePage: isSitePage, rules, candidates, facts, contextPages: input.strings.pages.filter(other => other.key !== page.key).slice(0, 30) });
        continue;
      }
      if (rules.length === 0) {
        skip('no rule left for the analyst');
        continue;
      }
      if (definition.id === 'schema' && candidates.length === 0 && itemsOf(input.strings, page.key, 'structured-data').length === 0) {
        skip('no structured data and no candidate');
        continue;
      }
      if (definition.id === 'intl' && candidates.length === 0 && itemsOf(input.strings, page.key, 'hreflang').length === 0 && languages.size < 2) {
        skip('a single language and no hreflang annotations');
        continue;
      }
      plans.push({ pass: definition.id, page, sitePage: isSitePage, rules, candidates, facts, contextPages: definition.id === 'intl' ? alternatesOf(page, input.strings) : [] });
    }
  }
  return { plans, skipped };
}

function entryOf(item: SiteItem): PackEntry {
  return {
    id: item.id,
    label: item.label,
    text: item.text,
    ...(item.href === undefined ? {} : { href: item.href }),
    ...(item.path === undefined ? {} : { path: item.path }),
    ...(item.hidden === undefined ? {} : { hidden: item.hidden }),
    complete: item.complete,
  };
}

/** The untrusted sections of a pass: evidence behind the candidates and failures first, then the page's slices. */
export function packSections(plan: PassPlan, strings: SiteStrings, report: Report): PackSection[] {
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  const sections: PackSection[] = [];
  const cited = [...new Set([...plan.candidates.flatMap(finding => finding.evidence), ...plan.facts.filter(finding => finding.outcome === 'fail').flatMap(finding => finding.evidence)])];
  const entries = cited.map(id => evidence.get(id)).filter((item): item is EvidenceItem => item !== undefined && item.kind !== 'owner-data').map(item => ({
    id: item.id,
    label: cleanText(item.label, 300),
    text: cleanText(item.excerpt ?? '', 2000),
    ...(item.url ? { href: cleanText(item.url, 2000) } : {}),
    ...(item.path ? { path: cleanText(item.path, 300) } : {}),
    complete: item.complete,
  }));
  if (entries.length > 0) sections.push({ name: 'deterministic-evidence', complete: true, entries });
  for (const name of passDefinition(plan.pass).slices) {
    const slice = sliceOf(strings, plan.page.key, name);
    if (slice) sections.push({ name, id: slice.id, page: plan.page, complete: slice.complete, entries: slice.items.map(id => entryOf(strings.items.get(id)!)) });
  }
  for (const page of plan.contextPages) {
    const slice = sliceOf(strings, page.key, 'metadata');
    if (slice) sections.push({ name: 'metadata', id: slice.id, page, complete: slice.complete, entries: slice.items.map(id => entryOf(strings.items.get(id)!)) });
  }
  return sections;
}

/** Deterministic results in the form the trusted part shows them; site text never appears here. */
export function factLines(plan: PassPlan): DeterministicFact[] {
  const label = (finding: ReportFinding) => (finding.scope.kind === 'site' ? 'site' : plan.page.label);
  return [...plan.candidates, ...plan.facts].map(finding => {
    const reason = safeReason(finding.reason);
    return {
      rule: finding.ruleId,
      page: label(finding),
      outcome: finding.needsJudgment ? 'candidate' : finding.outcome,
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(reason ? { reason } : {}),
      evidence: finding.evidence,
    };
  });
}

const mythTopics: Readonly<Record<PassId, RegExp>> = {
  content: /title|description|h1|heading|word count|keyword|e-e-a-t|eeat|rater|ai-generated|ai content|duplicate content|readability|alt text|alt-text|hidden|tabs|accordion|publish|fresh|nofollow|llms|chunk|helpful content|domain name/u,
  serp: /title|description|truncat|separator|keyword|meta/u,
  schema: /schema|markup|json-ld|rich result|faq|howto|searchaction|sitelinks|structured data|review|breadcrumb|headline|organization|event|qapage|videoobject|professionalservice|microdata/u,
  intl: /hreflang|lang|language|translat|country|cctld|x-default|geo|server|business profile|town|bing|canonicali/u,
};

/** The myths a pass could plausibly repeat; code still filters every note against the whole list. */
export function mythsFor(pass: PassId, myths: readonly Myth[]): Myth[] {
  return myths.filter(myth => mythTopics[pass].test(`${myth.id} ${myth.claim}`.toLowerCase())).slice(0, 40);
}

const evidenceId: Schema = { type: 'string', pattern: '^[AE][1-9][0-9]{0,5}$' };
const nullableEvidenceId: Schema = { type: ['string', 'null'], pattern: '^[AE][1-9][0-9]{0,5}$' };
const note: Schema = { type: 'string', maxLength: 200 };
const notesSchema: Schema = { type: 'object', additionalProperties: false, required: ['en', 'es', 'ca'], properties: { en: note, es: note, ca: note } };
const quoteText: Schema = { type: 'string', minLength: 1, maxLength: 400 };
const pageUrl: Schema = { type: 'string', minLength: 1, maxLength: 2048 };

function findingSchema(ruleIds: readonly string[], extra: Readonly<Record<string, Schema>> = {}): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ruleId', 'scope', 'verdict', 'reasonCode', 'severity', 'confidence', 'absence', 'evidenceIds', 'quotes', 'notes', ...Object.keys(extra)],
    properties: {
      ruleId: { type: 'string', enum: ruleIds },
      scope: pageUrl,
      verdict: { type: 'string', enum: ['confirmed', 'likely', 'not_confirmed', 'not_assessable'] },
      reasonCode: { type: 'string', maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
      severity: { type: 'string', enum: [...severities] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      absence: { type: 'boolean', description: 'true when the finding says something is missing' },
      evidenceIds: { type: 'array', maxItems: 12, items: evidenceId },
      quotes: {
        type: 'array',
        maxItems: 6,
        items: { type: 'object', additionalProperties: false, required: ['evidenceId', 'text'], properties: { evidenceId, text: quoteText } },
      },
      notes: notesSchema,
      ...extra,
    },
  };
}

function judged(values: readonly string[], extra: Readonly<Record<string, Schema>> = {}): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'evidenceId', 'quote', ...Object.keys(extra)],
    properties: { value: { type: 'string', enum: values }, evidenceId: nullableEvidenceId, quote: { type: ['string', 'null'], maxLength: 400 }, ...extra },
  };
}

/** Google's people-first self-assessment questions that page evidence can answer. */
export const selfAssessmentQuestions: Readonly<Record<string, string>> = {
  'original-information': 'Does the content provide original information, reporting, research or analysis?',
  'substantial-description': 'Does the content provide a substantial, complete or comprehensive description of the topic?',
  'beyond-obvious': 'Does the content provide insightful analysis or interesting information that is beyond the obvious?',
  'added-value': 'If the content draws on other sources, does it avoid simply copying or rewriting them and add substantial value and originality?',
  'descriptive-heading': 'Does the main heading or page title provide a descriptive, helpful summary of the content?',
  'no-exaggeration': 'Does the main heading or page title avoid exaggerating or being shocking in nature?',
  'trustworthy-presentation': 'Is the content presented in a way that makes you want to trust it, such as clear sourcing, evidence of the expertise involved, or background about the author or the site?',
  'first-hand-expertise': 'Does the content clearly demonstrate first-hand expertise and a depth of knowledge?',
  'clear-purpose': 'Does the page have a clear primary purpose or focus?',
  'goal-achieved': 'Would someone reading the page learn enough about its topic to achieve their goal?',
  'clear-authorship': 'Is it self-evident who created the content, where a visitor would expect to know?',
};

const proposalNotes = { notes: notesSchema };

export function passSchema(plan: PassPlan): Schema {
  const ruleIds = plan.rules.map(rule => rule.id);
  const findings = (extra?: Readonly<Record<string, Schema>>): Schema => ({ type: 'array', maxItems: 40, items: findingSchema(ruleIds, extra) });
  switch (plan.pass) {
    case 'content':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['findings', 'assessments'],
        properties: {
          findings: findings(),
          assessments: {
            type: 'object',
            additionalProperties: false,
            required: ['ymyl', 'entityClarity', 'nonCommodityValue', 'intent', 'selfAssessment'],
            properties: {
              ymyl: judged(['clear', 'maybe', 'not', 'not_assessable']),
              entityClarity: judged(['yes', 'no', 'not_assessable']),
              nonCommodityValue: judged(['yes', 'no', 'not_assessable']),
              intent: judged(['informational', 'commercial', 'transactional', 'navigational', 'local', 'not_assessable'], { inferred: { type: 'boolean' } }),
              selfAssessment: {
                type: 'array',
                maxItems: Object.keys(selfAssessmentQuestions).length,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['question', 'answer', 'evidenceId', 'quote'],
                  properties: {
                    question: { type: 'string', enum: Object.keys(selfAssessmentQuestions) },
                    answer: { type: 'string', enum: ['yes', 'no', 'not_assessable'] },
                    evidenceId: nullableEvidenceId,
                    quote: { type: ['string', 'null'], maxLength: 400 },
                  },
                },
              },
            },
          },
        },
      };
    case 'serp':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['proposals'],
        properties: {
          proposals: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'scope', 'text', 'language', 'evidenceIds', 'notes'],
              properties: {
                kind: { type: 'string', enum: ['title', 'meta-description'] },
                scope: pageUrl,
                text: { type: 'string', minLength: 1, maxLength: 300 },
                language: { type: 'string', maxLength: 35, pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$' },
                evidenceIds: { type: 'array', maxItems: 8, items: evidenceId },
                ...proposalNotes,
              },
            },
          },
        },
      };
    case 'schema':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['findings', 'proposals'],
        properties: {
          findings: findings(),
          proposals: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'scope', 'jsonLd', 'evidenceIds', 'notes'],
              properties: {
                kind: { type: 'string', enum: ['json-ld'] },
                scope: pageUrl,
                jsonLd: { type: 'string', minLength: 2, maxLength: 6000, description: 'one JSON-LD object or array, as JSON text' },
                evidenceIds: { type: 'array', maxItems: 12, items: evidenceId },
                ...proposalNotes,
              },
            },
          },
        },
      };
    case 'intl':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['findings'],
        properties: {
          findings: findings({
            language: { type: ['string', 'null'], maxLength: 35, pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$' },
            discriminatingWords: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 40 } },
          }),
        },
      };
  }
}

const outputContract = `## Output contract

This contract replaces the "Output per finding" section of the rubric. Altimeter writes the report text from its own templates, so notes stay short.

- findings: one entry per rule in scope (for page rules, about the page named above). When "Deterministic results" lists several candidates for one rule, give one entry per candidate and cite that candidate's evidence ids. Fields:
  - ruleId: a rule from "Rules in scope".
  - scope: the URL of the page, exactly as its section line gives it.
  - verdict: confirmed or likely when the problem is shown; not_confirmed when the evidence shows no problem or a legitimate pattern (for a candidate, this rejects it); not_assessable when the evidence cannot decide.
  - reasonCode: a short kebab-case code for what you found, such as decorative-alt-missing.
  - severity: at most the rule's severityCap; info for not_confirmed and not_assessable.
  - confidence: high, medium or low; at most medium for likely.
  - absence: true when the finding says something is missing. Cite the id of the complete section where it would appear; never call something absent from a section with complete:false.
  - evidenceIds: the A or E ids the claim rests on.
  - quotes: verbatim passages, each from one cited item (evidenceId), at least three words. Use ... between passages you skip, keeping their order. A finding that is not about absence needs at least one quote.
  - notes: one sentence each in English (en), Spanish (es) and Catalan (ca), at most 200 characters, describing what you observed.`;

function pageLine(plan: PassPlan): string {
  return `${plan.page.label} (${plan.page.role} page, type ${plan.page.pageType})`;
}

/** The trusted, pass-specific task text. */
export function passInstructions(plan: PassPlan, keyword: readonly string[]): string {
  const page = pageLine(plan);
  const site = plan.sitePage ? ' Site-scope rules in the list are judged from this page for the whole site.' : '';
  switch (plan.pass) {
    case 'content': {
      const questions = Object.entries(selfAssessmentQuestions).map(([id, text]) => `  - ${id}: ${text}`).join('\n');
      const intent = keyword.length > 0
        ? 'classify the intent behind the target keyword, set inferred to false and judge content-intent-match against that keyword.'
        : 'no target keyword was given. Infer the intent from the title and h1, set inferred to true, and give content-intent-match severity info.';
      return `You are the content analyst for ${page}. Judge every rule in "Rules in scope" for this page and answer the assessments.${site}

- Candidates (candidate:true) were found by code. Confirm them (confirmed or likely) when the evidence shows the problem, or answer not_confirmed when it shows a legitimate pattern from exemptWhen or the rubric.
- assessments.selfAssessment: answer each of Google's self-assessment questions with yes, no or not_assessable. A yes needs an evidence id and a verbatim quote; a no needs a quote or the id of the complete section that lacks it.
${questions}
- assessments.ymyl: clear, maybe or not, with a quote. Most topics are not YMYL.
- assessments.entityClarity: yes when the page makes clear which business or person is responsible for it, no when it does not.
- assessments.nonCommodityValue: yes when the page offers something only this site can (original data, photos, prices, first-hand experience, case studies); no when it says what any similar site says.
- assessments.intent: ${intent}
- For each assessment, give evidenceId and quote, or null for both when the value is not_assessable.

${outputContract}`;
    }
    case 'serp':
      return `Propose better titles and meta descriptions for ${page}, in the language of its visible text${plan.page.language ? ` (its html lang says ${plan.page.language})` : ''}.

- At most two titles and two meta descriptions. Each must be true to the visible text: never add numbers, prices, phone numbers, addresses, ratings, years or superlatives the page does not show, and include no URLs.
- Keep the site's brand when the current title includes it.
- Each title must differ from the titles of the other pages in the metadata sections, and each description from their descriptions.
- Write titles a searcher can read at a glance and descriptions of one or two sentences. Never cite a character limit.
- Address the title and description checks that failed in "Deterministic results".
- language: the BCP 47 tag of the proposal's language, such as en, es or ca. evidenceIds: the items the proposal is based on.
- notes: one sentence each in English (en), Spanish (es) and Catalan (ca), at most 200 characters, saying what the proposal fixes.`;
    case 'schema':
      return `Judge the structured data of ${page} for the rules in scope: whether the main type fits the page, whether marked-up values are visible, and whether the markup is misleading.${site}

- For visibility, quote the marked-up value and the visible text where it appears, or cite the complete text section where it is missing.
- proposals: at most three JSON-LD blocks, as JSON text in jsonLd, only for features this page clearly qualifies for under the rubric. Every value must come from the visible text. For a URL that is not a link on the page, write OWNER_TO_SUPPLY. Never propose FAQPage, HowTo, ClaimReview, SpecialAnnouncement, VehicleListing or a SearchAction.
- proposal notes: one sentence each in English, Spanish and Catalan, at most 200 characters.

${outputContract}`;
    case 'intl':
      return `Judge ${page} for the international rules in scope: translation parity with its alternates, mixed languages, and whether the content language matches what the page declares.${site}

- Decide the content language from the text itself, never from lang, hreflang or the URL.
- For every finding about the language of content, set language to the BCP 47 tag you detected and list in discriminatingWords at least two words, copied from the cited items, that only that language uses, such as articles, pronouns or conjunctions that neighbouring languages do not share. Otherwise set language to null and discriminatingWords to [].
- Never recommend entering new markets, targeting new countries or adding languages; those are the owner's decisions.

${outputContract}`;
  }
}
