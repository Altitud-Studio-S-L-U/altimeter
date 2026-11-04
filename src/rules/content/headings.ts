import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { RuleImplementation } from '../engine.ts';
import {
  accessibleName, cite, clip, docOf, elements, inOverlay, isHiddenByMarkup, isHtmlElement, lineOf, mainLandmarks, notApplicable, type Visit,
} from './common.ts';
import { blocksWithin, phoneViewportHeight, removedFromView } from './render.ts';

interface Heading extends Visit {
  readonly level: number;
  readonly name: string;
}

function headingsOf(doc: DocumentFacts): Heading[] {
  return elements(doc.parsed.document, element => isHtmlElement(element) && /^h[1-6]$/u.test(element.tagName))
    .map(visit => ({ ...visit, level: Number(visit.element.tagName[1]), name: accessibleName(visit.element) }));
}

/** The element's source, or only its start tag. */
function sourceOf(doc: DocumentFacts, visit: Visit, part: 'element' | 'start-tag' = 'element'): string {
  const location = part === 'element' ? visit.element.sourceCodeLocation : visit.element.sourceCodeLocation?.startTag;
  if (!location) return `<${visit.element.tagName}>`;
  return clip(doc.html.slice(location.startOffset, location.endOffset).replace(/\s+/gu, ' '), 240);
}

/**
 * Whether a heading is removed from view in the render (and, when it exists, in the scrolled user render too).
 * Unknown when no rendered text block can be matched to it.
 */
function removedHeading(page: PageFacts, heading: Heading): boolean | undefined {
  if (!page.rendered || heading.name === '') return undefined;
  const blocks = blocksWithin(page.rendered, heading.element.tagName, heading.name);
  if (blocks.length === 0) return undefined;
  const hidden = blocks.every(block => block.hidden !== undefined && removedFromView.has(block.hidden));
  if (!hidden || !page.userRender) return hidden;
  const userBlocks = blocksWithin(page.userRender, heading.element.tagName, heading.name);
  return userBlocks.length === 0 || userBlocks.every(block => block.hidden !== undefined && removedFromView.has(block.hidden));
}

export const h1Missing: RuleImplementation = {
  id: 'content-h1-missing',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const h1s = headingsOf(doc).filter(heading => heading.level === 1);
    if (h1s.length > 0) {
      return { outcome: 'pass', evidence: [cite(context, 'html', h1s.length === 1 ? evidenceLabel('h1 element') : evidenceLabel('first of {count} h1 elements (several are allowed)', { count: h1s.length }), { excerpt: h1s[0]!.name, line: lineOf(h1s[0]!.element) })] };
    }
    const dominant = dominantTitle(page);
    if (dominant) return { outcome: 'pass', evidence: [cite(context, 'render', evidenceLabel('large text in the first viewport serving as the visual title'), { excerpt: dominant.text, path: dominant.selector })] };
    return { outcome: 'fail', severity: 'low', evidence: [cite(context, 'html', evidenceLabel('no h1 element in the document'))] };
  },
};

/** A visible block in the first phone viewport set much larger than the page's usual text, as a visual title. */
function dominantTitle(page: PageFacts) {
  const blocks = page.rendered?.result.textBlocks.filter(block => block.hidden === undefined) ?? [];
  if (blocks.length === 0) return undefined;
  const sizes = blocks.map(block => block.fontSize).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)]!;
  return blocks.find(block => block.top < phoneViewportHeight && block.fontSize >= 28 && block.fontSize >= median * 1.6 && block.text.length >= 3);
}

export const h1EmptyOrImage: RuleImplementation = {
  id: 'content-h1-empty-or-image',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const h1s = headingsOf(doc).filter(heading => heading.level === 1 && !isHiddenByMarkup(heading.element) && !heading.ancestors.some(isHiddenByMarkup));
    if (h1s.length === 0) return notApplicable('no-h1');
    const empty = h1s.filter(heading => heading.name === '');
    if (empty.length > 0) {
      return { outcome: 'fail', severity: 'low', reason: 'empty', params: { count: empty.length },
        evidence: empty.slice(0, 3).map(heading => cite(context, 'html', evidenceLabel('h1 without an accessible name'), { excerpt: sourceOf(doc, heading), line: lineOf(heading.element) })) };
    }
    const states = h1s.map(heading => removedHeading(page, heading));
    if (states.every(state => state === true)) {
      return { outcome: 'fail', severity: 'low', reason: 'hidden', params: { count: h1s.length },
        evidence: h1s.slice(0, 3).map(heading => cite(context, 'render', evidenceLabel('h1 not displayed in the render'), { excerpt: heading.name, line: lineOf(heading.element) })) };
    }
    return { outcome: 'pass', evidence: [cite(context, 'html', evidenceLabel('h1 element'), { excerpt: h1s[0]!.name, line: lineOf(h1s[0]!.element) })] };
  },
};

const skippedRegion = (visit: Visit) => inOverlay(visit.ancestors) || visit.ancestors.some(isHiddenByMarkup) || isHiddenByMarkup(visit.element)
  || visit.ancestors.some(ancestor => ['nav', 'footer', 'aside'].includes(ancestor.tagName));

export const headingLevelSkips: RuleImplementation = {
  id: 'content-heading-level-skips',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const outline = headingsOf(doc).filter(heading => heading.name !== '' && !skippedRegion(heading) && removedHeading(page, heading) !== true);
    if (outline.length < 2) return notApplicable('fewer-than-two-headings');
    const skips: Array<{ from: Heading; to: Heading }> = [];
    for (let index = 1; index < outline.length; index += 1) {
      const from = outline[index - 1]!;
      const to = outline[index]!;
      if (to.level > from.level + 1) skips.push({ from, to });
    }
    if (skips.length === 0) return { outcome: 'pass' };
    const first = skips[0]!;
    return {
      outcome: 'fail', severity: 'low', params: { count: skips.length, from: `h${first.from.level}`, to: `h${first.to.level}`, heading: clip(first.to.name, 80) },
      evidence: skips.slice(0, 5).map(skip => cite(context, 'html', evidenceLabel('h{to} after h{from}', { to: skip.to.level, from: skip.from.level }), { excerpt: `<h${skip.to.level}>${clip(skip.to.name, 120)}`, line: lineOf(skip.to.element) })),
    };
  },
};

export const mainLandmark: RuleImplementation = {
  id: 'content-main-landmark',
  evaluate(context) {
    const doc = docOf(context.page!)!;
    const mains = mainLandmarks(doc);
    if (mains.length === 1) return { outcome: 'pass', evidence: [cite(context, 'html', evidenceLabel('main landmark'), { excerpt: sourceOf(doc, mains[0]!, 'start-tag'), line: lineOf(mains[0]!.element) })] };
    if (mains.length === 0) return { outcome: 'fail', severity: 'low', reason: 'none', evidence: [cite(context, 'html', evidenceLabel('no visible main or role=main element'))] };
    return { outcome: 'fail', severity: 'low', reason: 'multiple', params: { count: mains.length },
      evidence: mains.slice(0, 3).map(visit => cite(context, 'html', evidenceLabel('main landmark'), { excerpt: sourceOf(doc, visit, 'start-tag'), line: lineOf(visit.element) })) };
  },
};
