import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import { attribute } from '../../parse/html.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { directivesFor, robotsDirectives, summarizeList } from '../helpers.ts';
import {
  cite, clip, docOf, elements, indexability, indexablePages, inMain, isHtmlElement, isMainElement, isTemplateRegion, lineOf, mainLandmarks,
  metaDescription, normalizeText, notApplicable, pageTitle, textContent, words, type Visit,
} from './common.ts';

function headDescription(doc: DocumentFacts | undefined) {
  const meta = doc?.parsed.metas.find(entry => entry.inHead && (entry.attrs.name ?? '').toLowerCase() === 'description');
  return meta ? { text: (meta.attrs.content ?? '').trim(), line: meta.line } : undefined;
}

export const metaDescriptionMissing: RuleImplementation = {
  id: 'content-meta-description-missing',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const state = indexability(page, doc);
    if (!state.indexable) return notApplicable(`not-indexable-${state.reason}`);
    const description = headDescription(doc);
    if (description && description.text !== '') {
      return { outcome: 'pass', evidence: [cite(context, 'html', 'meta description', { excerpt: description.text, line: description.line })] };
    }
    if (description) {
      return { outcome: 'fail', severity: 'low', reason: 'empty', evidence: [cite(context, 'html', 'empty meta description', { excerpt: '<meta name="description" content="">', line: description.line })] };
    }
    return { outcome: 'fail', severity: 'low', reason: 'absent', evidence: [cite(context, 'html', 'no meta description in the head')] };
  },
};

const paginated = (url: string) => /[?&](page|p|pg|paged)=\d+|\/page\/\d+\/?$/iu.test(url);

export const metaDescriptionDuplicate: RuleImplementation = {
  id: 'content-meta-description-duplicate',
  evaluate(context) {
    const pages = indexablePages(context.site).filter(entry => !paginated(entry.page.fetch.finalUrl));
    if (pages.length < 2) return notApplicable('fewer-than-two-indexable-pages');
    const groups = new Map<string, Array<{ page: PageFacts; text: string; line: number }>>();
    for (const entry of pages) {
      const description = headDescription(entry.doc);
      if (!description || description.text === '') continue;
      const key = normalizeText(description.text);
      groups.set(key, [...(groups.get(key) ?? []), { page: entry.page, ...description }]);
    }
    const results: RuleResult[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      results.push({
        outcome: 'fail', severity: 'medium',
        evidence: group.map(member => cite(context, 'html', 'meta description', { url: member.page.fetch.finalUrl, excerpt: member.text, line: member.line })),
        params: { description: clip(group[0]!.text, 120), count: group.length, urls: summarizeList(group.map(member => member.page.fetch.finalUrl)) },
      });
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

const placeholderPattern = /\{\{|\}\}|(^|[\s(])%s([\s).,]|$)|\blorem ipsum\b|\[(insert|inserte|insereix)\b/iu;

export const metaDescriptionQuality: RuleImplementation = {
  id: 'content-meta-description-quality',
  evaluate(context) {
    const doc = docOf(context.page!);
    const description = metaDescription(doc);
    if (!description || description.text === '') return notApplicable('no-description');
    const evidence = [cite(context, 'html', 'meta description', { excerpt: description.text, line: description.line })];
    if (placeholderPattern.test(description.text)) return { outcome: 'fail', severity: 'low', reason: 'placeholder', evidence };
    const title = pageTitle(doc);
    if (title && normalizeText(title.text) === normalizeText(description.text)) return { outcome: 'fail', severity: 'low', reason: 'same-as-title', evidence };
    const count = words(description.text).length;
    const segments = description.text.split(/\s*[,;|]\s*/u).filter(Boolean);
    const averageWords = segments.reduce((sum, segment) => sum + words(segment).length, 0) / Math.max(segments.length, 1);
    if (segments.length >= 4 && averageWords <= 3 && !/[.!?]\s+\p{Lu}/u.test(description.text)) {
      return { outcome: 'fail', severity: 'low', needsJudgment: true, reason: 'keyword-list', evidence, params: { segments: segments.length } };
    }
    if (count < 8) return { outcome: 'fail', severity: 'low', needsJudgment: true, reason: 'short', evidence, params: { words: count } };
    return { outcome: 'pass', evidence };
  },
};

const supportedNosnippet = new Set(['span', 'div', 'section']);

function nosnippetElements(doc: DocumentFacts): Visit[] {
  return elements(doc.parsed.document, element => isHtmlElement(element) && attribute(element, 'data-nosnippet') !== undefined);
}

function sourceOf(doc: DocumentFacts, visit: Visit): string {
  const location = visit.element.sourceCodeLocation?.startTag;
  return location ? clip(doc.html.slice(location.startOffset, location.endOffset), 200) : `<${visit.element.tagName} data-nosnippet>`;
}

export const dataNosnippetInvalid: RuleImplementation = {
  id: 'content-data-nosnippet-invalid',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const marked = nosnippetElements(doc);
    if (marked.length === 0) return notApplicable('no-data-nosnippet');
    const results: RuleResult[] = [];
    const unsupported = marked.filter(visit => !supportedNosnippet.has(visit.element.tagName));
    if (unsupported.length > 0) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'unsupported-element', params: { count: unsupported.length, tags: summarizeList([...new Set(unsupported.map(visit => visit.element.tagName))]) },
        evidence: unsupported.slice(0, 5).map(visit => cite(context, 'html', 'data-nosnippet on an unsupported element', { excerpt: sourceOf(doc, visit), line: lineOf(visit.element) })) });
    }
    if (page.raw && page.rendered && doc === page.rendered) {
      const rawIds = new Map(elements(page.raw.parsed.document, element => attribute(element, 'id') !== undefined).map(visit => [attribute(visit.element, 'id')!, visit]));
      const added = marked.filter(visit => {
        const id = attribute(visit.element, 'id');
        const before = id === undefined ? undefined : rawIds.get(id);
        return before !== undefined && attribute(before.element, 'data-nosnippet') === undefined;
      });
      if (added.length > 0) {
        results.push({ outcome: 'fail', severity: 'low', reason: 'added-by-javascript', params: { count: added.length },
          evidence: added.slice(0, 5).map(visit => cite(context, 'render', 'data-nosnippet present only after rendering', { excerpt: sourceOf(doc, visit), path: `#${attribute(visit.element, 'id')}` })) });
      }
    }
    const coverage = mainCoverage(doc, marked);
    if (coverage !== undefined && coverage >= 0.5) {
      results.push({ outcome: 'fail', severity: 'info', reason: 'covers-main-content', params: { share: Math.round(coverage * 100) },
        evidence: marked.slice(0, 3).map(visit => cite(context, 'html', 'data-nosnippet element', { excerpt: sourceOf(doc, visit), line: lineOf(visit.element) })) });
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

/** Share of the main content's text inside data-nosnippet elements, or undefined when there is too little text. */
function mainCoverage(doc: DocumentFacts, marked: readonly Visit[]): number | undefined {
  const mains = mainLandmarks(doc);
  const mainText = mains.map(visit => textContent(visit.element)).join(' ');
  if (mainText.length < 200) return undefined;
  const covered = marked
    .filter(visit => supportedNosnippet.has(visit.element.tagName) && (inMain(visit.ancestors) || isMainElement(visit.element))
      && !visit.ancestors.some(ancestor => attribute(ancestor, 'data-nosnippet') !== undefined) && !visit.ancestors.some(isTemplateRegion))
    .reduce((sum, visit) => sum + textContent(visit.element).length, 0);
  return Math.min(covered / mainText.length, 1);
}

export const imagePreviewLarge: RuleImplementation = {
  id: 'content-image-preview-large',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page);
    const all = robotsDirectives(page.fetch.headers, doc);
    const directives = directivesFor(all);
    const preview = [...directives].find(directive => directive.startsWith('max-image-preview:'));
    const source = all.find(entry => entry.directives.some(directive => directive.startsWith('max-image-preview:')));
    if (!preview || !source) return { outcome: 'fail', severity: 'low', reason: 'absent', evidence: [cite(context, 'html', 'no max-image-preview directive in robots meta tags or X-Robots-Tag')] };
    const value = preview.slice('max-image-preview:'.length);
    const evidence = [cite(context, source.source === 'meta' ? 'html' : 'header', source.source === 'meta' ? 'robots meta tag' : 'X-Robots-Tag header', { excerpt: source.raw, line: source.line })];
    if (value === 'large') return { outcome: 'pass', evidence };
    return { outcome: 'fail', severity: 'low', reason: 'restricted', evidence, params: { value } };
  },
};
