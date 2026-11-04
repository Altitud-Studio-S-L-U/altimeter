import { fold } from '../ai/text.ts';
import type { PageType } from '../core/types.ts';
import type { Language } from '../i18n/messages.ts';
import { brandPattern } from '../owner/gsc-analyses.ts';
import type { GscData } from '../owner/gsc.ts';
import { cleanLine } from '../report/sanitize.ts';
import { contentWords } from '../rules/content/common.ts';
import { brandAliases } from './brand.ts';
import type { PlanNote, PlannedQuery, ProbeEngine, ProbePlan, QueryClass, QueryOrigin, SiteProfile } from './types.ts';
import { domainForms, namesDomain } from './urls.ts';

/** Queries in one probe, the brand question included. */
export const maxQueries = 10;
/** Queries inferred from the site's pages. They are a fallback, so only a few. A tool convention. */
export const maxInferredQueries = 5;
export const defaultRuns = 3;
export const maxRuns = 5;
/**
 * CLI calls one probe may make: 10 queries, 3 runs and 2 engines. A tool convention that keeps a probe a small,
 * user-launched batch; each call spends the user's own plan.
 */
export const maxProbeCalls = 60;
/** The longest query accepted, as for --keyword in audits. */
export const maxQueryLength = 120;

/** A plan that cannot be made from the given options; its message says what to change. */
export class PlanError extends Error {}

export interface PlanInput {
  readonly site: SiteProfile;
  readonly keywords: readonly string[];
  /** Present only with --from-gsc: the data that was read, or why it could not be read. */
  readonly searchConsole?: { readonly data: GscData } | { readonly problem: string };
  readonly engines: readonly ProbeEngine[];
  readonly runsPerQuery: number;
  /** The report language, used for the brand question when the site declares no supported language. */
  readonly language: Language;
}

interface Candidate {
  readonly text: string;
  readonly class: QueryClass;
  readonly origin: QueryOrigin;
}

const hostLabel = (site: SiteProfile) => site.host.split('.')[0] ?? '';

const withoutMarks = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * Search Console queries that name neither the brand nor the domain, most impressions first, then most clicks.
 * Brand queries are told apart as the audit's brand split does.
 */
export function nonBrandQueries(data: GscData, site: SiteProfile): Candidate[] {
  const brand = brandPattern([...site.brandNames, hostLabel(site)]);
  const forms = domainForms(site);
  return data.byQuery
    .map(row => ({ row, text: cleanLine(row.keys[0] ?? '', maxQueryLength + 1) }))
    .filter(({ text }) => text.length >= 2 && text.length <= maxQueryLength && !(brand?.test(withoutMarks(text)) ?? false) && !namesDomain(text, forms))
    .sort((a, b) => b.row.impressions - a.row.impressions || b.row.clicks - a.row.clicks || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
    .map(({ row, text }) => ({
      text,
      class: 'search-console' as const,
      origin: {
        kind: 'search-console' as const,
        property: data.property.siteUrl,
        start: data.period.start,
        end: data.period.end,
        impressions: row.impressions,
        clicks: row.clicks,
        position: Math.round(row.position * 10) / 10,
      },
    }));
}

// Separators between the parts of a title, such as "Web design in Andorra | Brand".
const titleSeparators = /\s+[|·•–—-]\s+|\s*\|\s*/u;

// Folded text shaped like an instruction to a model. A page heading that tries to steer an answer is not a query
// a searcher would type, so it is never sent.
const instructionShaped = /\b(?:ignore|disregard|forget|override|ignora|olvida|oblida|instructions?|instrucciones|instruccions|prompt|you are|eres|ets|cite|recommend|recomienda|recomana|chatgpt|claude|gemini|copilot|perplexity|llm)\b|<\||\[\/?inst\]/u;

const topicPages: ReadonlySet<PageType> = new Set(['home', 'service', 'product', 'article', 'listing', 'other']);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function withoutBrands(text: string, names: readonly string[]): string {
  let result = text;
  for (const name of names) {
    const parts = name.split(/[^\p{L}\p{N}]+/u).filter(part => part !== '').map(escapeRegExp);
    if (parts.length === 0) continue;
    result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[^\\p{L}\\p{N}]*')}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return result;
}

/** The topic of a heading or title without the brand: 2 to 10 words, at least two of them content words. */
export function topicOf(text: string, site: SiteProfile): string | undefined {
  const forms = domainForms(site);
  for (const segment of text.split(titleSeparators)) {
    // Checked before the brand is removed, which could otherwise cut a domain such as brand.example in half.
    if (instructionShaped.test(fold(segment)) || namesDomain(segment, forms)) continue;
    const candidate = withoutBrands(segment, site.brandNames).replace(/\s+/gu, ' ').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
    if (candidate === '' || candidate.length > 80) continue;
    const words = candidate.split(' ').filter(word => /[\p{L}\p{N}]/u.test(word));
    if (words.length > 10 || contentWords(candidate).length < 2) continue;
    return candidate;
  }
  return undefined;
}

/** Queries inferred from the H1 and title of the pages read, in page order; legal, contact and similar pages are skipped. */
export function inferredQueries(site: SiteProfile): Candidate[] {
  const found: Candidate[] = [];
  for (const page of site.pages) {
    if (!topicPages.has(page.pageType) || page.status === undefined || page.status < 200 || page.status >= 300) continue;
    for (const element of ['h1', 'title'] as const) {
      const value = page[element];
      const text = value === undefined ? undefined : topicOf(value, site);
      if (text) found.push({ text, class: 'inferred', origin: { kind: 'inferred', page: page.url, element } });
    }
  }
  return found;
}

const brandQuestions: Readonly<Record<Language, (name: string) => string>> = {
  en: name => `What is ${name}?`,
  es: name => `¿Qué es ${name}?`,
  ca: name => `Què és ${name}?`,
};

const isLanguage = (value: string | undefined): value is Language => value === 'en' || value === 'es' || value === 'ca';

/**
 * "What is <brand>?" with the first distinctive name the site declares, in the site's language when the reports
 * support it. A name that contains the domain is never used, because the probe never names the domain.
 */
export function brandQuestion(site: SiteProfile, language: Language): { readonly question: Candidate } | { readonly reason: 'no-name' | 'names-domain' } {
  const distinctive = site.brandNames.filter(name => brandAliases([name], '').length > 0);
  if (distinctive.length === 0) return { reason: 'no-name' };
  const forms = domainForms(site);
  const name = distinctive.find(entry => !namesDomain(entry, forms));
  if (name === undefined) return { reason: 'names-domain' };
  const asked = isLanguage(site.language) ? site.language : language;
  return { question: { text: brandQuestions[asked](name), class: 'brand', origin: { kind: 'brand', name, language: asked } } };
}

/**
 * The probe's plan: the user's keywords first, then Search Console's non-brand queries when --from-gsc was given,
 * otherwise topics inferred from the site's pages, and a brand question last when there is room. At most ten
 * queries, each with its origin, and never more than maxProbeCalls CLI calls.
 */
export function planProbe(input: PlanInput): ProbePlan {
  const { site } = input;
  if (!Number.isInteger(input.runsPerQuery) || input.runsPerQuery < 1 || input.runsPerQuery > maxRuns) throw new PlanError(`--runs must be a whole number from 1 to ${maxRuns}.`);
  const engines = [...new Set(input.engines)];
  if (engines.length === 0) throw new PlanError('--engines must name claude, codex or both.');
  const forms = domainForms(site);
  const notes: PlanNote[] = [];
  const chosen: Candidate[] = [];
  const seen = new Set<string>();
  const take = (candidate: Candidate, limit: number): boolean => {
    const key = fold(candidate.text);
    if (seen.has(key) || chosen.length >= limit) return false;
    seen.add(key);
    chosen.push(candidate);
    return true;
  };

  for (const keyword of input.keywords) {
    const text = cleanLine(keyword, maxQueryLength + 1);
    if (text === '') continue;
    if (text.length > maxQueryLength) throw new PlanError(`Each --keyword must be at most ${maxQueryLength} characters.`);
    if (namesDomain(text, forms)) {
      throw new PlanError(`The keyword "${text}" names ${site.domain}. The probe checks whether engines find the site without being told its address, so leave the domain out.`);
    }
    if (!take({ text, class: 'keyword', origin: { kind: 'keyword' } }, Number.MAX_SAFE_INTEGER)) continue;
    if (chosen.length > maxQueries) throw new PlanError(`At most ${maxQueries} queries can be probed at once; pass fewer --keyword values.`);
  }

  const brand = brandQuestion(site, input.language);
  const reserved = 'question' in brand && chosen.length < maxQueries ? 1 : 0;
  if (!('question' in brand)) notes.push({ code: 'brand-left-out', reason: brand.reason });
  else if (reserved === 0) notes.push({ code: 'brand-left-out', reason: 'no-room' });
  const limit = maxQueries - reserved;

  if (input.searchConsole) {
    if ('problem' in input.searchConsole) {
      notes.push({ code: 'search-console-failed', message: cleanLine(input.searchConsole.problem, 300) });
    } else {
      const before = chosen.length;
      for (const candidate of nonBrandQueries(input.searchConsole.data, site)) {
        if (chosen.length >= limit) break;
        take(candidate, limit);
      }
      if (chosen.length === before) notes.push({ code: 'search-console-empty' });
    }
  }

  if (chosen.length === 0) {
    let inferred = 0;
    for (const candidate of inferredQueries(site)) {
      if (inferred >= maxInferredQueries) break;
      if (take(candidate, limit)) inferred += 1;
    }
    if (inferred > 0 && input.searchConsole) notes.push({ code: 'inferred-fallback' });
  }

  if ('question' in brand && reserved === 1) take(brand.question, maxQueries);
  if (chosen.length === 0) {
    throw new PlanError('There is no query to probe. Pass --keyword, use --from-gsc, or make sure the home page can be read so that queries can be inferred from it.');
  }
  const queries: PlannedQuery[] = chosen.map((candidate, index) => ({ id: `Q${index + 1}`, ...candidate }));
  const calls = queries.length * input.runsPerQuery * engines.length;
  if (calls > maxProbeCalls) {
    throw new PlanError(`This plan needs ${calls} CLI calls and a probe may make at most ${maxProbeCalls}. Use fewer queries or runs, or one engine.`);
  }
  return { site, queries, engines, runsPerQuery: input.runsPerQuery, calls, notes };
}
