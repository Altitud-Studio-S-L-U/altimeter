import { decodeHtml, documentFacts, isHtmlResponse } from '../../collect/page.ts';
import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts } from '../../core/facts.ts';
import { attribute, collapse } from '../../parse/html.ts';
import type { StructuredNode } from '../../parse/structured-data.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import {
  cite, clip, contentText, docOf, elements, firstH1, firstString, fold, homePage, indexablePages, inOverlay, isHtmlElement, lineOf,
  nodesOf, notApplicable, notEvaluated, pageTitle, servedAt, siteNames, textContent,
} from './common.ts';
import { anchorsOf } from './links.ts';
import { mainHeading } from './titles.ts';

// ---------------------------------------------------------------------------------------------------------------
// Dates

const monthNames: Record<string, number> = {};
const monthLists = [
  'january february march april may june july august september october november december',
  'jan feb mar apr may jun jul aug sep oct nov dec',
  'enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre',
  'ene feb mar abr may jun jul ago sept oct nov dic',
  'gener febrer marc abril maig juny juliol agost setembre octubre novembre desembre',
];
for (const list of monthLists) list.split(' ').forEach((name, index) => { monthNames[name] ??= index + 1; });
monthNames.setiembre = 9;

const iso = (year: number, month: number, day: number) => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDate() === day ? date.toISOString().slice(0, 10) : undefined;
};

/** Calendar dates written in English, Spanish or Catalan prose, with their position in the text. */
export function datesInText(text: string): Array<{ readonly date: string; readonly index: number; readonly raw: string }> {
  const folded = fold(text);
  const found: Array<{ date: string; index: number; raw: string }> = [];
  const add = (date: string | undefined, index: number, raw: string) => { if (date) found.push({ date, index, raw }); };
  for (const match of folded.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) add(iso(Number(match[1]), Number(match[2]), Number(match[3])), match.index, match[0]);
  for (const match of folded.matchAll(/\b([a-z]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gu)) {
    const month = monthNames[match[1]!];
    if (month) add(iso(Number(match[3]), month, Number(match[2])), match.index, match[0]);
  }
  for (const match of folded.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+|d')?([a-z]{3,10})\.?,?\s+(?:de\s+|del\s+)?(\d{4})\b/gu)) {
    const month = monthNames[match[2]!];
    if (month) add(iso(Number(match[3]), month, Number(match[1])), match.index, match[0]);
  }
  return found;
}

const dateLabel = /(published|posted|updated|last updated|modified|publicado|actualizado|ultima actualizacion|publicat|actualitzat|darrera actualitzacio)\W{0,4}(on\s+|el\s+|en\s+)?$/u;

const calendar = (value: string) => /^(\d{4}-\d{2}-\d{2})/u.exec(value.trim())?.[1];
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

interface StructuredDates {
  readonly node: StructuredNode;
  readonly published?: string;
  readonly modified?: string;
}

function structuredDates(doc: DocumentFacts): StructuredDates[] {
  return doc.data.nodes.filter(node => !node.nested && !node.types.some(type => type.endsWith('Event')))
    .map(node => {
      const published = firstString(node.properties.datePublished);
      const modified = firstString(node.properties.dateModified);
      return { node, ...(published ? { published } : {}), ...(modified ? { modified } : {}) };
    })
    .filter(entry => entry.published !== undefined || entry.modified !== undefined);
}

const commentRegion = /comment|reply|review/iu;
const publicationMarker = /publish|posted|updated|modified|entry-date|post-date|post-meta|entry-meta|article-meta|byline|datepublished|datemodified/iu;
const markerOf = (element: Parameters<typeof attribute>[0]) => `${attribute(element, 'class') ?? ''} ${attribute(element, 'id') ?? ''} ${attribute(element, 'itemprop') ?? ''}`;

/**
 * Publication dates shown to readers: <time datetime> marked as a publication or update date (by itemprop, class or
 * a nearby byline container), or dates written after a 'Published' or 'Updated' label. Dates of related posts,
 * comments and events are not the page's own dates.
 */
function visibleDates(doc: DocumentFacts): Array<{ readonly date: string; readonly excerpt: string; readonly line?: number }> {
  const times = elements(doc.parsed.document, (element, ancestors) => isHtmlElement(element) && element.tagName === 'time'
    && attribute(element, 'datetime') !== undefined && !inOverlay(ancestors)
    && !ancestors.some(ancestor => ['nav', 'footer', 'aside'].includes(ancestor.tagName) || commentRegion.test(markerOf(ancestor)))
    && [element, ...ancestors.slice(-3)].some(entry => publicationMarker.test(markerOf(entry))))
    .flatMap(visit => {
      const date = calendar(attribute(visit.element, 'datetime')!);
      return date ? [{ date, excerpt: `<time datetime="${attribute(visit.element, 'datetime')}">${textContent(visit.element)}</time>`, line: lineOf(visit.element) }] : [];
    });
  const text = contentText(doc, { wholeBody: true });
  const folded = fold(text);
  const labelled = datesInText(text).filter(entry => dateLabel.test(folded.slice(Math.max(0, entry.index - 30), entry.index)))
    .map(entry => ({ date: entry.date, excerpt: clip(text.slice(Math.max(0, entry.index - 30), entry.index + entry.raw.length), 120) }));
  return [...times, ...labelled];
}

export const dateConsistency: RuleImplementation = {
  id: 'content-date-consistency',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const structured = structuredDates(doc);
    if (structured.length === 0) return notApplicable('no-structured-dates');
    const main = structured[0]!;
    const structuredCalendar = [main.published, main.modified].filter((value): value is string => value !== undefined).map(value => ({ value, date: calendar(value) }))
      .filter((entry): entry is { value: string; date: string } => entry.date !== undefined);
    const markup = cite(context, 'structured-data', evidenceLabel('datePublished and dateModified'), { excerpt: `datePublished: ${main.published ?? '(none)'}; dateModified: ${main.modified ?? '(none)'}`, path: main.node.path });
    const results: RuleResult[] = [];
    const served = servedAt(page);
    const future = served ? structuredCalendar.find(entry => Date.parse(`${entry.date}T00:00:00Z`) > served.getTime() + 86_400_000) : undefined;
    if (future) results.push({ outcome: 'fail', severity: 'medium', reason: 'future-date', params: { date: future.value }, evidence: [markup, cite(context, 'header', evidenceLabel('Date header of the response'), { excerpt: served!.toUTCString() })] });
    const hasEvents = nodesOf(doc, ['Event']).length > 0 || doc.data.nodes.some(node => node.types.some(type => type.endsWith('Event')));
    const shown = hasEvents ? [] : visibleDates(doc);
    if (shown.length > 0 && structuredCalendar.length > 0 && !shown.some(entry => structuredCalendar.some(other => daysBetween(entry.date, other.date) <= 1))) {
      results.push({ outcome: 'fail', severity: 'medium', reason: 'visible-mismatch', params: { visible: shown[0]!.date, structured: structuredCalendar.map(entry => entry.date).join(', ') },
        evidence: [markup, ...shown.slice(0, 2).map(entry => cite(context, 'html', evidenceLabel('date shown on the page'), { excerpt: entry.excerpt, line: entry.line }))] });
    }
    const modified = main.modified ? calendar(main.modified) : undefined;
    const entry = modified ? context.site.sitemaps.flatMap(sitemap => (sitemap.document?.urls ?? []).map(url => ({ sitemap, url }))).find(item => item.url.loc === page.fetch.finalUrl && item.url.lastmod) : undefined;
    const lastmod = entry ? calendar(entry.url.lastmod!) : undefined;
    if (entry && modified && lastmod && daysBetween(lastmod, modified) > 1) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'lastmod-differs', params: { lastmod: entry.url.lastmod!, modified: main.modified! },
        evidence: [markup, cite(context, 'sitemap', evidenceLabel('sitemap lastmod'), { url: entry.sitemap.url, excerpt: `<lastmod>${entry.url.lastmod}</lastmod>`, line: entry.url.line })] });
    }
    return results.length > 0 ? results : { outcome: 'pass', evidence: [markup] };
  },
};

export const dateManipulation: RuleImplementation = {
  id: 'content-date-manipulation',
  evaluate(context) {
    const results: RuleResult[] = [];
    let seen = 0;
    for (const page of context.site.pages.values()) {
      const doc = docOf(page);
      const modified = doc ? structuredDates(doc)[0]?.modified : undefined;
      if (!modified) continue;
      seen += 1;
      for (const probe of page.uaProbes ?? []) {
        if (probe.fetch.status !== 200 || !isHtmlResponse(probe.fetch.headers, probe.fetch.body)) continue;
        const again = structuredDates(documentFacts(decodeHtml(probe.fetch.headers, probe.fetch.body)))[0]?.modified;
        if (!again || again === modified) continue;
        results.push({ outcome: 'fail', severity: 'medium', reason: 'per-request', params: { first: modified, second: again, url: page.fetch.finalUrl },
          evidence: [
            cite(context, 'structured-data', evidenceLabel('dateModified in the audited response'), { url: page.fetch.finalUrl, excerpt: modified }),
            cite(context, 'probe', evidenceLabel('dateModified when the same URL was fetched again'), { url: probe.fetch.finalUrl, excerpt: again }),
          ] });
        break;
      }
    }
    if (seen === 0) return notApplicable('no-date-modified');
    if (context.site.crawled) {
      const dated = indexablePages(context.site).flatMap(entry => {
        const modified = structuredDates(entry.doc)[0]?.modified;
        const date = modified ? calendar(modified) : undefined;
        return date ? [{ ...entry, modified: modified!, date }] : [];
      });
      const counts = new Map<string, typeof dated>();
      for (const entry of dated) counts.set(entry.date, [...(counts.get(entry.date) ?? []), entry]);
      const [date, group] = [...counts].sort((a, b) => b[1].length - a[1].length)[0] ?? ['', []];
      if (dated.length >= 5 && group.length / dated.length >= 0.8) {
        const crawlDay = group.every(entry => servedAt(entry.page)?.toISOString().slice(0, 10) === date);
        results.push({ outcome: 'fail', severity: 'medium', reason: crawlDay ? 'crawl-date' : 'shared-date', ...(crawlDay ? {} : { needsJudgment: true }),
          params: { date, count: group.length, total: dated.length },
          evidence: group.slice(0, 3).map(entry => cite(context, 'structured-data', evidenceLabel('dateModified'), { url: entry.page.fetch.finalUrl, excerpt: entry.modified })) });
      }
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Authorship and site identity

const bylineMarker = /(^|[\s_-])(author|byline|autor|autora|writer)([\s_-]|$)/iu;
const bylineText = /(?:^|[\s(|·•-])(?:by|written by|por|escrito por|per|escrit per|autor|autora|author)\s*:?\s+\p{Lu}[\p{L}'’.-]+/u;

function authorsOf(doc: DocumentFacts): Array<{ readonly type: string; readonly name: string }> {
  const articles = nodesOf(doc, ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'ScholarlyArticle', 'LiveBlogPosting']);
  const byId = new Map(doc.data.nodes.filter(node => node.id).map(node => [node.id!, node]));
  const result: Array<{ type: string; name: string }> = [];
  for (const article of articles) {
    const values = Array.isArray(article.properties.author) ? article.properties.author : [article.properties.author];
    for (const value of values) {
      if (typeof value === 'string') result.push({ type: 'Text', name: value });
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const target = typeof record['@id'] === 'string' && record.name === undefined ? byId.get(record['@id']) : undefined;
        const type = target?.types[0] ?? firstString(record['@type']) ?? 'Thing';
        const name = firstString(target ? target.properties.name : record.name);
        if (name) result.push({ type: type.replace(/^https?:\/\/schema\.org\//u, ''), name: collapse(name) });
      }
    }
  }
  return result;
}

export const bylineAuthor: RuleImplementation = {
  id: 'content-byline-author',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const authors = authorsOf(doc);
    const names = new Set(siteNames(context.site).map(fold));
    if (authors.some(author => author.type === 'Organization' || author.type.endsWith('Organization') || names.has(fold(author.name)))) {
      return { outcome: 'pass', evidence: [cite(context, 'structured-data', evidenceLabel('article author is the organisation'), { excerpt: authors[0]!.name })] };
    }
    const text = contentText(doc, { wholeBody: true });
    const marked = elements(doc.parsed.document, (element, ancestors) => isHtmlElement(element) && !inOverlay(ancestors) && !ancestors.some(ancestor => ancestor.tagName === 'footer')
      && ((attribute(element, 'rel') ?? '').split(/\s+/u).includes('author') || (attribute(element, 'itemprop') ?? '').split(/\s+/u).includes('author')
        || bylineMarker.test(`${attribute(element, 'class') ?? ''} ${attribute(element, 'id') ?? ''}`)))
      .find(visit => textContent(visit.element) !== '');
    const heading = mainHeading(context);
    const at = heading ? text.indexOf(heading.text) : -1;
    const nearHeading = at >= 0 ? text.slice(Math.max(0, at - 200), at + heading!.text.length + 400) : text.slice(0, 600);
    const textual = bylineText.exec(nearHeading);
    const people = authors.filter(author => author.type !== 'Text' || author.name !== '');
    const visibleName = people.find(author => fold(text).includes(fold(author.name)));
    const byline = marked ? textContent(marked.element) : textual?.[0].trim() ?? visibleName?.name;
    if (byline && (people.length === 0 || visibleName)) {
      return { outcome: 'pass', evidence: [cite(context, 'html', evidenceLabel('visible byline'), { excerpt: clip(byline, 120), ...(marked ? { line: lineOf(marked.element) } : {}) })] };
    }
    if (people.length > 0) {
      return { outcome: 'fail', severity: 'medium', reason: 'markup-not-visible', params: { author: people[0]!.name },
        evidence: [cite(context, 'structured-data', evidenceLabel('author in Article markup'), { excerpt: people.map(author => author.name).join(', ') })] };
    }
    return { outcome: 'fail', severity: 'medium', reason: 'no-byline', evidence: [cite(context, 'html', evidenceLabel('no byline near the main heading and no author in Article markup'), { excerpt: clip(nearHeading, 160) })] };
  },
};

// "About <brand>" pages are common too: /about-acme/, /sobre-altitud/, "Acerca de Acme".
const aboutWords = /^(?:about|aboutus|who-we-are|our-story|company|team|nosotros|quienes-somos|quien-soy|sobre|empresa|equipo|el-estudio|qui-som|nosaltres|equip|a-propos|qui-sommes-nous|ueber-uns|uber-uns|chi-siamo|(?:about|sobre|acerca-de|a-propos-de|ueber|uber)-[\p{L}\d-]+)$/u;
const aboutText = /^(?:about|who we are|our story|our company|the team|team|company|nosotros|quienes somos|quien soy|empresa|equipo|el estudio|qui som|nosaltres|equip|a propos|qui sommes nous|uber uns|chi siamo|(?:about|sobre|acerca de|a propos de|uber) [\p{L}\d -]+)$/u;
const contactWords = /^(contact|contact-us|contacto|contactanos|contacte|contacta|contactar|kontakt|contatti|get-in-touch)$/u;
const contactText = /^(contact|contact us|contacto|contactanos|contacte|contacta|contactar|kontakt|contatti|get in touch|escribenos|escriu-nos)$/u;

function matchesLink(href: string, text: string, words: RegExp, phrase: RegExp): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const segments = url.pathname.split('/').filter(Boolean).map(segment => fold(decodeURIComponent(segment)).replace(/\.(html?|php|aspx?)$/u, ''));
  const fragment = fold(decodeURIComponent(url.hash.slice(1)));
  return segments.some(segment => words.test(segment)) || words.test(fragment) || phrase.test(fold(text).replace(/[^\p{L}\s-]/gu, '').trim());
}

export const trustPages: RuleImplementation = {
  id: 'content-trust-pages',
  evaluate(context) {
    const home = homePage(context.site);
    const doc = home ? docOf(home) : undefined;
    if (!home || !doc) return notEvaluated('no-home-page');
    const anchors = anchorsOf(doc, home.fetch.finalUrl);
    const contactLink = anchors.find(anchor => /^(mailto|tel):/iu.test(anchor.href) || (!anchor.external && matchesLink(anchor.href, anchor.text, contactWords, contactText)));
    const contactSection = elements(doc.parsed.document, element => contactWords.test(fold(attribute(element, 'id') ?? '')))[0];
    const contactMarkup = doc.data.nodes.find(node => ['telephone', 'email', 'contactPoint', 'address'].some(name => node.properties[name] !== undefined)
      && node.types.some(type => type === 'Organization' || type.endsWith('Business') || type === 'Person' || type === 'Store' || type === 'Restaurant'));
    const aboutLink = anchors.find(anchor => !anchor.external && matchesLink(anchor.href, anchor.text, aboutWords, aboutText));
    const aboutSection = elements(doc.parsed.document, element => aboutWords.test(fold(attribute(element, 'id') ?? '')))[0];
    const results: RuleResult[] = [];
    const url = home.fetch.finalUrl;
    if (!contactLink && !contactSection && !contactMarkup) {
      results.push({ outcome: 'fail', severity: 'medium', reason: 'no-contact', evidence: [cite(context, 'html', evidenceLabel('no contact link, contact section, email or phone link on the home page'), { url })] });
    }
    if (!aboutLink && !aboutSection) {
      results.push({ outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'no-about', evidence: [cite(context, 'html', evidenceLabel('no link to an about page and no about section on the home page'), { url })] });
    }
    if (results.length > 0) return results;
    const found = [contactLink, aboutLink].filter((anchor): anchor is NonNullable<typeof anchor> => anchor !== undefined);
    return { outcome: 'pass', evidence: found.map(anchor => cite(context, 'html', evidenceLabel('trust page link on the home page'), { url, excerpt: `${anchor.text} -> ${anchor.href}`, line: anchor.line })) };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Freshness

const years = (text: string) => (text.match(/(?<![\d.,])(?:199\d|20\d\d)(?![\d.,]\d)/gu) ?? []).map(Number);
const asOf = /\b(?:as of|current as of|updated for|this year \(|a fecha de|actualizado (?:a|en|para)|en lo que va de|a data de|actualitzat (?:a|el|per a))\s*(?:[a-z]+\s+){0,2}((?:199\d|20\d\d))\b/giu;

export const staleContent: RuleImplementation = {
  id: 'content-stale-content',
  evaluate(context) {
    const page = context.page!;
    const served = servedAt(page);
    if (!served) return notEvaluated('no-served-date');
    const current = served.getUTCFullYear();
    const doc = docOf(page)!;
    const title = pageTitle(doc);
    const heading = firstH1(doc);
    const evidence: string[] = [];
    const old = (year: number) => year < current - 1;
    for (const [label, entry] of [[evidenceLabel('year in the title'), title], [evidenceLabel('year in the main heading'), heading]] as const) {
      if (entry && years(entry.text).length > 0 && years(entry.text).every(old)) evidence.push(cite(context, 'html', label, { excerpt: entry.text, line: entry.line }));
    }
    const text = contentText(doc);
    for (const match of text.matchAll(asOf)) {
      if (old(Number(match[1]))) evidence.push(cite(context, 'text', evidenceLabel('statement dated to a past year'), { excerpt: clip(text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40), 160) }));
      if (evidence.length >= 4) break;
    }
    if (evidence.length === 0) return { outcome: 'pass' };
    return { outcome: 'fail', severity: 'medium', needsJudgment: true, params: { year: current, count: evidence.length }, evidence: [...evidence, cite(context, 'header', evidenceLabel('Date header of the response'), { excerpt: served.toUTCString() })] };
  },
};
