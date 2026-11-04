import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { hreflangLinks, summarizeList } from '../helpers.ts';
import { cite, clip, contentBlocks, contentText, fold, indexability, indexablePages, normalizeText, notApplicable, words } from './common.ts';
import { designHiddenSelector } from './render.ts';

/** Page types whose purpose is met with little text; Google sets no minimum word count. */
const shortByDesign = new Set(['about', 'contact', 'product', 'utility', 'legal', 'error']);

export const boilerplateRatio: RuleImplementation = {
  id: 'content-boilerplate-ratio',
  evaluate(context) {
    const pages = indexablePages(context.site);
    if (pages.length < 3) return notApplicable('fewer-than-three-indexable-pages');
    const seenOn = new Map<string, number>();
    const bodies = pages.map(entry => new Set(contentBlocks(entry.doc, { wholeBody: true }).map(normalizeText)));
    for (const blocks of bodies) for (const block of blocks) seenOn.set(block, (seenOn.get(block) ?? 0) + 1);
    const boilerplate = new Set([...seenOn].filter(([, count]) => count / pages.length >= 0.5).map(([block]) => block));
    const results: RuleResult[] = [];
    pages.forEach((entry, index) => {
      if (shortByDesign.has(entry.page.pageType)) return;
      const total = [...bodies[index]!].reduce((sum, block) => sum + words(block).length, 0);
      const unique = contentBlocks(entry.doc).map(normalizeText).filter(block => !boilerplate.has(block));
      const uniqueWords = unique.reduce((sum, block) => sum + words(block).length, 0);
      const share = total === 0 ? 1 : 1 - uniqueWords / total;
      if (uniqueWords >= 100 && share <= 0.8) return;
      results.push({ outcome: 'fail', severity: 'medium', needsJudgment: true, params: { url: entry.page.fetch.finalUrl, uniqueWords, share },
        evidence: [cite(context, 'crawl', evidenceLabel('{words, plural, one {# word} other {# words}} of page-specific text; {share, number, percent} of the text repeats on at least half of the pages', { words: uniqueWords, share }),
          { url: entry.page.fetch.finalUrl, excerpt: clip(unique.join(' ') || '(no page-specific text)', 200) })] });
    });
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

export const fillerBeforeMc: RuleImplementation = {
  id: 'content-filler-before-mc',
  evaluate(context) {
    const render = context.page!.userRender!;
    const blocks = render.result.textBlocks.filter(block => block.hidden === undefined && !designHiddenSelector.test(block.selector) && block.text.length >= 120);
    const scoped = blocks.some(block => block.inMain) ? blocks.filter(block => block.inMain) : blocks;
    if (scoped.length === 0) return notApplicable('no-paragraph-text');
    const first = scoped.reduce((best, block) => (block.top < best.top ? block : best));
    const viewports = first.top / render.result.viewport.height;
    const evidence = [cite(context, 'render', evidenceLabel('first paragraph of main content, {top}px from the top of the phone render', { top: Math.round(first.top) }), { excerpt: clip(first.text, 160), path: first.selector })];
    if (viewports <= 2) return { outcome: 'pass', evidence };
    return { outcome: 'fail', severity: 'medium', needsJudgment: true, params: { top: Math.round(first.top), viewports: Math.round(viewports * 10) / 10 }, evidence };
  },
};

function shingles(text: string, size = 5): Set<string> {
  const tokens = words(fold(text));
  const result = new Set<string>();
  for (let index = 0; index + size <= tokens.length; index += 1) result.add(tokens.slice(index, index + size).join(' '));
  return result;
}

/** Final URLs a page names as its hreflang alternates; translations are expected to share structure. */
function alternatesOf(page: PageFacts, doc: DocumentFacts): Set<string> {
  return new Set(hreflangLinks(doc, page.fetch.finalUrl).map(link => link.href).filter((href): href is string => href !== undefined));
}

export const originality: RuleImplementation = {
  id: 'content-originality',
  evaluate(context) {
    const page = context.page!;
    const self = indexablePages(context.site).find(entry => entry.page.fetch.finalUrl === page.fetch.finalUrl);
    if (!self) return notApplicable(indexability(page).indexable ? 'no-document' : 'not-indexable');
    const mine = shingles(contentText(self.doc));
    if (mine.size < 30) return notApplicable('too-little-text');
    const alternates = alternatesOf(page, self.doc);
    let best: { url: string; overlap: number } | undefined;
    for (const other of indexablePages(context.site)) {
      if (other.page.fetch.finalUrl === page.fetch.finalUrl || alternates.has(other.page.fetch.finalUrl)) continue;
      const theirs = shingles(contentText(other.doc));
      let shared = 0;
      for (const shingle of mine) if (theirs.has(shingle)) shared += 1;
      const overlap = shared / mine.size;
      if (!best || overlap > best.overlap) best = { url: other.page.fetch.finalUrl, overlap };
    }
    if (!best) return notApplicable('no-other-indexable-pages');
    if (best.overlap < 0.8) return { outcome: 'pass' };
    return { outcome: 'fail', severity: 'medium', needsJudgment: true, params: { other: best.url, overlap: best.overlap },
      evidence: [
        cite(context, 'crawl', evidenceLabel("{overlap, number, percent} of this page's five-word sequences also appear on another crawled page", { overlap: best.overlap }), { excerpt: best.url }),
        cite(context, 'text', evidenceLabel('opening of the main content'), { excerpt: clip(contentText(self.doc), 200) }),
      ] };
  },
};

/** Token multiset difference: the share of tokens that would have to change to turn one text into the other. */
function difference(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of b) {
    const left = counts.get(token) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(token, left - 1);
    }
  }
  return 1 - shared / Math.max(a.length, b.length, 1);
}

export const scaledDoorway: RuleImplementation = {
  id: 'content-scaled-doorway',
  evaluate(context) {
    const pages = indexablePages(context.site).map(entry => ({ ...entry, tokens: words(fold(contentText(entry.doc))) })).filter(entry => entry.tokens.length >= 50);
    if (pages.length < 10) return notApplicable('fewer-than-ten-pages-with-text');
    const parent = pages.map((_, index) => index);
    const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index]!)));
    for (let i = 0; i < pages.length; i += 1) {
      for (let j = i + 1; j < pages.length; j += 1) {
        const ratio = Math.min(pages[i]!.tokens.length, pages[j]!.tokens.length) / Math.max(pages[i]!.tokens.length, pages[j]!.tokens.length);
        if (ratio < 0.95) continue;
        if (difference(pages[i]!.tokens, pages[j]!.tokens) <= 0.05) parent[root(i)] = root(j);
      }
    }
    const clusters = new Map<number, typeof pages>();
    pages.forEach((entry, index) => clusters.set(root(index), [...(clusters.get(root(index)) ?? []), entry]));
    const results: RuleResult[] = [...clusters.values()].filter(cluster => cluster.length >= 10).map(cluster => ({
      outcome: 'fail', severity: 'medium', needsJudgment: true, params: { count: cluster.length, urls: summarizeList(cluster.map(entry => entry.page.fetch.finalUrl)) },
      evidence: cluster.slice(0, 3).map(entry => cite(context, 'crawl', evidenceLabel('one of {count} pages whose main text differs by at most 5% of its words', { count: cluster.length }), { url: entry.page.fetch.finalUrl, excerpt: clip(entry.tokens.join(' '), 200) })),
    }));
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};
