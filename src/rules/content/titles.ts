import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts, SiteFacts } from '../../core/facts.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { documentBase, hreflangLinks, summarizeList } from '../helpers.ts';
import {
  cite, clip, contentWords, docOf, documentTitles, firstH1, fold, indexability, indexablePages, isHome, lineOf, mainLandmarks,
  normalizeText, notApplicable, pageTitle, siteNames, words,
} from './common.ts';
import { arialWidth, desktopTitleFontSize, desktopTitleWidth } from './width.ts';

/** Splits a title at the delimiters sites use between its parts (pipe, dash, colon, middle dot, guillemet). */
export function titleSegments(title: string): string[] {
  return title.split(/\s+[|–—\-:·•»/]\s+|\s*[|·•»]\s*/u).map(part => part.trim()).filter(Boolean);
}

/** The title without segments that only name the site. */
export function withoutBrand(title: string, names: readonly string[]): string {
  const brands = new Set(names.map(fold));
  return titleSegments(title).filter(segment => !brands.has(fold(segment))).join(' ');
}

export const titleMissing: RuleImplementation = {
  id: 'content-title-missing',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const titles = documentTitles(doc).filter(title => title.inHead);
    const present = titles.find(title => title.text !== '');
    const inRaw = doc === page.raw;
    if (present) return { outcome: 'pass', evidence: [cite(context, 'html', inRaw ? evidenceLabel('title element in the raw HTML') : evidenceLabel('title element in the rendered DOM'), { excerpt: present.text, line: lineOf(present.element) })] };
    const severity = indexability(page, doc).indexable ? 'high' : 'info';
    if (titles.length === 0) {
      return { outcome: 'fail', severity, reason: 'absent', evidence: [cite(context, 'html', inRaw ? evidenceLabel('no title element in the head of the raw HTML') : evidenceLabel('no title element in the head of the rendered DOM'))] };
    }
    return { outcome: 'fail', severity, reason: 'empty', evidence: [cite(context, 'html', inRaw ? evidenceLabel('empty title element in the raw HTML') : evidenceLabel('empty title element in the rendered DOM'), { excerpt: '<title></title>', line: lineOf(titles[0]!.element) })] };
  },
};

export const titleMultiple: RuleImplementation = {
  id: 'content-title-multiple',
  evaluate(context) {
    const page = context.page!;
    const titles = documentTitles(page.raw!);
    const inHead = titles.filter(title => title.inHead);
    const inBody = titles.filter(title => !title.inHead);
    if (inHead.length <= 1 && inBody.length === 0) return { outcome: 'pass' };
    const evidence = titles.map(title => cite(context, 'html', title.inHead ? evidenceLabel('title element in the head') : evidenceLabel('title element outside the head'),
      { excerpt: `<title>${title.text}</title>`, line: lineOf(title.element) }));
    return { outcome: 'fail', severity: 'medium', evidence, params: { count: titles.length } };
  },
};

const placeholderTitles = /^(react app|vite app|vite \+ [\w.]+|angular app|nuxt app|next\.js app|svelte app|vue app|loading( ?(\.\.\.|…))?|cargando( ?(\.\.\.|…))?|carregant( ?(\.\.\.|…))?|untitled|untitled document|document|index|home|welcome)$/u;

/** Strips a leading unread counter such as "(3) " that apps add at runtime. */
const comparable = (title: string) => normalizeText(title.replace(/^\(\d+\+?\)\s*/u, ''));

export const titleRawRenderedMismatch: RuleImplementation = {
  id: 'content-title-raw-rendered-mismatch',
  evaluate(context) {
    const page = context.page!;
    const rendered = pageTitle(page.rendered);
    if (!rendered) return notApplicable('no-rendered-title');
    const raw = pageTitle(page.raw);
    const renderedId = cite(context, 'render', evidenceLabel('title in the rendered DOM'), { excerpt: rendered.text, line: rendered.line });
    if (raw && comparable(raw.text) === comparable(rendered.text)) return { outcome: 'pass', evidence: [renderedId] };
    const rawId = cite(context, 'html', raw ? evidenceLabel('title in the raw HTML') : evidenceLabel('no non-empty title in the raw HTML'), raw ? { excerpt: raw.text, line: raw.line } : {});
    const params = { raw: raw?.text ?? '', rendered: rendered.text };
    if (!raw) return { outcome: 'fail', severity: 'medium', reason: 'raw-missing', evidence: [rawId, renderedId], params };
    const siteName = new Set(siteNames(context.site).map(normalizeText));
    const placeholder = placeholderTitles.test(normalizeText(raw.text)) || (siteName.has(normalizeText(raw.text)) && !isHome(context.site, page));
    if (placeholder) return { outcome: 'fail', severity: 'medium', reason: 'placeholder', evidence: [rawId, renderedId], params };
    return { outcome: 'fail', severity: 'low', reason: 'differs', evidence: [rawId, renderedId], params };
  },
};

/** Search shows a title only for a page it may index as its own canonical; on other pages its wording does not matter. */
function outOfResults(page: PageFacts): RuleResult | undefined {
  const state = indexability(page);
  return state.indexable ? undefined : notApplicable(`not-indexable-${state.reason}`);
}

export const titleWidth: RuleImplementation = {
  id: 'content-title-width',
  evaluate(context) {
    const unlisted = outOfResults(context.page!);
    if (unlisted) return unlisted;
    const title = pageTitle(docOf(context.page!));
    if (!title) return notApplicable('no-title');
    const characters = [...title.text].length;
    const width = arialWidth(title.text, desktopTitleFontSize);
    const evidence = [cite(context, 'html', evidenceLabel('title element'), { excerpt: title.text, line: title.line })];
    if (characters <= 20) return { outcome: 'fail', severity: 'low', reason: 'short', evidence, params: { characters } };
    if (width > desktopTitleWidth) return { outcome: 'fail', severity: 'info', reason: 'likely-truncated', evidence, params: { width, characters } };
    return { outcome: 'pass', evidence };
  },
};

/** Folds a word to a crude stem so that singular and plural forms count as one keyword. */
const stem = (word: string) => word.replace(/(es|s)$/u, '').slice(0, 7);

export const titleStuffing: RuleImplementation = {
  id: 'content-title-stuffing',
  evaluate(context) {
    const title = pageTitle(docOf(context.page!));
    if (!title) return notApplicable('no-title');
    const evidence = [cite(context, 'html', evidenceLabel('title element'), { excerpt: title.text, line: title.line })];
    const counts = new Map<string, { count: number; word: string }>();
    for (const word of contentWords(title.text).filter(entry => !/^\d+$/u.test(entry))) {
      const key = stem(word);
      counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, word: counts.get(key)?.word ?? word });
    }
    const repeated = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    if (repeated && repeated.count >= 3) {
      return { outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'repeated-token', evidence, params: { token: repeated.word, count: repeated.count } };
    }
    const segments = title.text.split(/\s*[,|/·•]\s*|\s+[-–—]\s+/u).map(part => part.trim()).filter(Boolean);
    const averageWords = segments.reduce((sum, segment) => sum + words(segment).length, 0) / Math.max(segments.length, 1);
    if (segments.length - 1 >= 4 && averageWords <= 3) {
      return { outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'list', evidence, params: { segments: segments.length } };
    }
    return { outcome: 'pass', evidence };
  },
};

export function mainHeading(context: RuleContext) {
  const doc = docOf(context.page!)!;
  const main = mainLandmarks(doc)[0];
  if (main) {
    const start = main.element.sourceCodeLocation?.startOffset ?? -1;
    const end = main.element.sourceCodeLocation?.endOffset ?? -1;
    const inside = doc.parsed.headings.find(heading => heading.level === 1 && heading.text !== '' && heading.offset >= start && heading.offset < end);
    if (inside) return { text: inside.text, line: inside.line };
  }
  return firstH1(doc);
}

const stems = (text: string) => new Set(contentWords(text).map(word => word.slice(0, 5)));
const capitalised = (text: string) => new Set((text.match(/\b\p{Lu}[\p{L}\p{N}]+/gu) ?? []).map(fold));

export const titleH1Mismatch: RuleImplementation = {
  id: 'content-title-h1-mismatch',
  evaluate(context) {
    const page = context.page!;
    if (isHome(context.site, page)) return notApplicable('home-page');
    const unlisted = outOfResults(page);
    if (unlisted) return unlisted;
    const title = pageTitle(docOf(page));
    if (!title) return notApplicable('no-title');
    const heading = mainHeading(context);
    if (!heading) return notApplicable('no-h1');
    const topic = withoutBrand(title.text, siteNames(context.site)) || title.text;
    const a = stems(topic);
    const b = stems(heading.text);
    const shared = [...a].filter(entry => b.has(entry)).length;
    const union = new Set([...a, ...b]).size;
    const jaccard = union === 0 ? 1 : shared / union;
    const entities = [...capitalised(topic)].some(entry => capitalised(heading.text).has(entry));
    const evidence = [
      cite(context, 'html', evidenceLabel('title element'), { excerpt: title.text, line: title.line }),
      cite(context, 'html', evidenceLabel('main h1 heading'), { excerpt: heading.text, line: heading.line }),
    ];
    if (jaccard >= 0.2 || entities) return { outcome: 'pass', evidence };
    return { outcome: 'fail', severity: 'low', needsJudgment: true, evidence, params: { title: title.text, heading: heading.text, overlap: Math.round(jaccard * 100) / 100 } };
  },
};

const years = (text: string) => (text.match(/(?<![\d.,])(?:199\d|20\d\d)(?![\d.,]\d)/gu) ?? []).map(Number);

export const titleObsoleteYear: RuleImplementation = {
  id: 'content-title-obsolete-year',
  evaluate(context) {
    const unlisted = outOfResults(context.page!);
    if (unlisted) return unlisted;
    const doc = docOf(context.page!)!;
    const title = pageTitle(doc);
    const titleYears = title ? years(title.text) : [];
    if (!title || titleYears.length === 0) return notApplicable('no-year-in-title');
    const heading = mainHeading(context);
    const headingYears = heading ? years(heading.text) : [];
    const titleYear = Math.max(...titleYears);
    const titleId = cite(context, 'html', evidenceLabel('title element'), { excerpt: title.text, line: title.line });
    if (!heading || headingYears.length === 0) return { outcome: 'pass', evidence: [titleId] };
    const headingYear = Math.max(...headingYears);
    // A heading that also names the title's year is about that period (a retrospective), not a newer edition.
    if (headingYear <= titleYear || headingYears.includes(titleYear)) return { outcome: 'pass', evidence: [titleId] };
    const headingId = cite(context, 'html', evidenceLabel('main h1 heading'), { excerpt: heading.text, line: heading.line });
    return { outcome: 'fail', severity: 'medium', evidence: [titleId, headingId], params: { titleYear, headingYear } };
  },
};

function occurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  const text = fold(haystack);
  const wanted = fold(needle);
  for (let index = text.indexOf(wanted); index !== -1; index = text.indexOf(wanted, index + wanted.length)) {
    const before = text[index - 1];
    const after = text[index + wanted.length];
    if ((before === undefined || !/[\p{L}\p{N}]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}]/u.test(after))) positions.push(index);
  }
  return positions;
}

/** Titles whose subject is the brand itself: "About Acme and its founder", "Sobre Altitud Studio". */
const aboutTheBrand = /^(?:about|sobre|acerca de|a propos de|uber|chi siamo|qui som|quienes somos)\s/u;

export const titleBranding: RuleImplementation = {
  id: 'content-title-branding',
  evaluate(context) {
    const page = context.page!;
    const unlisted = outOfResults(page);
    if (unlisted) return unlisted;
    const title = pageTitle(docOf(page));
    if (!title) return notApplicable('no-title');
    const names = siteNames(context.site).sort((a, b) => b.length - a.length);
    if (names.length === 0) return { outcome: 'not_evaluated', reason: 'no-site-name' };
    const evidence = [cite(context, 'html', evidenceLabel('title element'), { excerpt: title.text, line: title.line })];
    const brand = names.find(name => occurrences(title.text, name).length > 0);
    if (!brand) return { outcome: 'fail', severity: 'info', reason: 'brand-absent', evidence, params: { brand: names[0]! } };
    const found = occurrences(title.text, brand);
    if (found.length > 1) return { outcome: 'fail', severity: 'low', reason: 'repeated', evidence, params: { brand, count: found.length } };
    // A title that is only the brand is half-empty; content-title-boilerplate reports it.
    const rest = withoutBrand(title.text, [brand]);
    if (rest === '' || isHome(context.site, page)) return { outcome: 'pass', evidence };
    const share = arialWidth(brand, desktopTitleFontSize) / Math.max(arialWidth(title.text, desktopTitleFontSize), 1);
    if (share > 0.5) return { outcome: 'fail', severity: 'low', reason: 'brand-dominant', evidence, params: { brand, share: Math.round(share * 100) } };
    const segments = titleSegments(title.text).map(fold);
    const atEdge = segments[0] === fold(brand) || segments.at(-1) === fold(brand) || fold(title.text).startsWith(fold(brand)) || fold(title.text).endsWith(fold(brand));
    // On a page about the brand, the brand is the subject of the title rather than a label added to it.
    const subject = page.pageType === 'about' || aboutTheBrand.test(fold(title.text));
    if (!atEdge && !subject) return { outcome: 'fail', severity: 'low', reason: 'mid-title', evidence, params: { brand } };
    return { outcome: 'pass', evidence };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Site-wide title rules

interface TitledPage {
  readonly page: PageFacts;
  readonly doc: DocumentFacts;
  readonly title: { readonly text: string; readonly line: number };
}

function titledPages(site: SiteFacts): TitledPage[] {
  return indexablePages(site).flatMap(entry => {
    const title = pageTitle(entry.doc);
    return title ? [{ ...entry, title }] : [];
  });
}

/** True when every page of the group lists the others as hreflang alternates: translations sharing a brand title. */
function hreflangCluster(group: readonly TitledPage[]): boolean {
  return group.every(member => {
    const alternates = new Set(hreflangLinks(member.doc, documentBase(member.doc, member.page.fetch.finalUrl)).map(link => link.href));
    return group.every(other => other === member || alternates.has(other.page.fetch.finalUrl));
  });
}

function groupBy(pages: readonly TitledPage[], key: (page: TitledPage) => string): TitledPage[][] {
  const groups = new Map<string, TitledPage[]>();
  for (const page of pages) {
    const value = key(page);
    if (value === '') continue;
    groups.set(value, [...(groups.get(value) ?? []), page]);
  }
  return [...groups.values()].filter(group => group.length >= 2 && !hreflangCluster(group));
}

function citeGroup(context: RuleContext, group: readonly TitledPage[]): string[] {
  return group.map(member => cite(context, 'html', evidenceLabel('title element'), { url: member.page.fetch.finalUrl, excerpt: member.title.text, line: member.title.line }));
}

export const titleDuplicate: RuleImplementation = {
  id: 'content-title-duplicate',
  evaluate(context) {
    const pages = titledPages(context.site);
    if (pages.length < 2) return notApplicable('fewer-than-two-indexable-pages');
    const results: RuleResult[] = [];
    const exact = groupBy(pages, page => normalizeText(page.title.text));
    const grouped = new Set(exact.flat());
    for (const group of exact) {
      results.push({ outcome: 'fail', severity: 'medium', reason: 'identical', evidence: citeGroup(context, group),
        params: { title: group[0]!.title.text, count: group.length, urls: summarizeList(group.map(member => member.page.fetch.finalUrl)) } });
    }
    const names = siteNames(context.site);
    if (names.length > 0) {
      for (const group of groupBy(pages.filter(page => !grouped.has(page)), page => normalizeText(withoutBrand(page.title.text, names)))) {
        results.push({ outcome: 'fail', severity: 'medium', reason: 'same-without-brand', evidence: citeGroup(context, group),
          params: { title: withoutBrand(group[0]!.title.text, names), count: group.length, urls: summarizeList(group.map(member => member.page.fetch.finalUrl)) } });
      }
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

const leadingDelimiter = /^\s*[|–—\-:·•»]/u;

/** Delimited title parts shared as a prefix or suffix by at least 30% (and two) of the titles. */
function templateParts(titles: readonly string[]): { readonly prefixes: string[]; readonly suffixes: string[] } {
  const count = (pick: (segments: string[]) => string | undefined) => {
    const counts = new Map<string, number>();
    for (const title of titles) {
      const segments = titleSegments(title);
      if (segments.length < 2) continue;
      const value = pick(segments);
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].filter(([, total]) => total >= 2 && total / titles.length >= 0.3).map(([value]) => value);
  };
  return { prefixes: count(segments => segments[0]), suffixes: count(segments => segments.at(-1)) };
}

export const titleBoilerplate: RuleImplementation = {
  id: 'content-title-boilerplate',
  evaluate(context) {
    const pages = titledPages(context.site);
    if (pages.length === 0) return notApplicable('no-indexable-pages');
    const names = siteNames(context.site);
    const results: RuleResult[] = [];
    const flagged = new Set<TitledPage>();
    for (const entry of pages) {
      const bare = names.length > 0 && withoutBrand(entry.title.text, names).replace(/[\s|–—\-:·•»]/gu, '') === '';
      const halfEmpty = leadingDelimiter.test(entry.title.text) || (bare && !isHome(context.site, entry.page));
      if (!halfEmpty) continue;
      flagged.add(entry);
      results.push({ outcome: 'fail', severity: 'medium', reason: 'half-empty', params: { title: entry.title.text },
        evidence: [cite(context, 'html', evidenceLabel('title element'), { url: entry.page.fetch.finalUrl, excerpt: entry.title.text, line: entry.title.line })] });
    }
    if (pages.length >= 3) {
      const parts = templateParts(pages.map(entry => entry.title.text));
      for (const entry of pages) {
        if (flagged.has(entry)) continue;
        const segments = titleSegments(entry.title.text);
        if (segments.length < 2) continue;
        const template = [
          ...(parts.prefixes.includes(segments[0]!) ? [segments[0]!] : []),
          ...(parts.suffixes.includes(segments.at(-1)!) ? [segments.at(-1)!] : []),
        ];
        const templateText = template.join(' ');
        const unique = segments.filter((segment, index) => !((index === 0 && template.includes(segment)) || (index === segments.length - 1 && template.includes(segment)))).join(' ');
        if (unique === '' || words(templateText).length < 4) continue;
        if (arialWidth(templateText, desktopTitleFontSize) <= arialWidth(unique, desktopTitleFontSize)) continue;
        results.push({ outcome: 'fail', severity: 'low', reason: 'template-dominant', params: { title: entry.title.text, template: clip(templateText, 80) },
          evidence: [cite(context, 'html', evidenceLabel('title element'), { url: entry.page.fetch.finalUrl, excerpt: entry.title.text, line: entry.title.line })] });
      }
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};
