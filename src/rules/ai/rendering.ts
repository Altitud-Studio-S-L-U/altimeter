import { evidenceLabel } from '../../core/evidence.ts';
import type { RuleImplementation } from '../engine.ts';
import { mainText, normalizeText, textBlocks } from './main-text.ts';
import { clip, words } from './support.ts';

/** Below this many rendered words a ratio says little, so short pages are judged only on their h1. */
const minimumRenderedWords = 20;

const withoutHash = (url: string) => url.replace(/#.*$/u, '');

const jsOnlyContent: RuleImplementation = {
  id: 'ai-js-only-content',
  evaluate({ page, evidence }) {
    const raw = page!.raw!;
    const rendered = page!.rendered!;
    if (page!.fetch.status !== 200) return { outcome: 'not_applicable', reason: 'not-200' };
    // A render that ended on another URL (a script redirect, a locale switch) is not the same document.
    if (withoutHash(rendered.result.finalUrl) !== withoutHash(page!.fetch.finalUrl)) return { outcome: 'not_evaluated', reason: 'render-url-differs' };
    const rawMain = mainText(raw);
    const renderedMain = mainText(rendered);
    const rawH1 = raw.parsed.headings.filter(heading => heading.level === 1 && heading.text !== '');
    const renderedH1 = rendered.parsed.headings.find(heading => heading.level === 1 && heading.text !== '');
    const h1Missing = rawH1.length === 0 && renderedH1 !== undefined;
    if (renderedMain.words < minimumRenderedWords && !h1Missing) return { outcome: 'not_applicable', reason: 'little-rendered-text' };
    const ratio = renderedMain.words === 0 ? 1 : Math.min(1, rawMain.words / renderedMain.words);
    const params = { rawWords: rawMain.words, renderedWords: renderedMain.words, ratio };
    const counts = evidence.add({
      kind: 'render', url: page!.fetch.finalUrl,
      label: evidenceLabel('main text in the raw HTML: {rawWords, plural, one {# word} other {# words}} ({rawScope}); after rendering: {renderedWords, plural, one {# word} other {# words}} ({renderedScope})', { rawWords: rawMain.words, rawScope: rawMain.scope, renderedWords: renderedMain.words, renderedScope: renderedMain.scope }),
    });
    const rawText = normalizeText(raw.parsed.bodyText);
    const missing = textBlocks(renderedMain).find(block => words(block).length >= 5 && !rawText.includes(normalizeText(block)));
    const ids = [counts];
    if (missing) ids.push(evidence.add({ kind: 'render', url: page!.fetch.finalUrl, label: evidenceLabel('rendered main text that the raw HTML does not contain'), excerpt: clip(missing) }));
    if (ratio < 0.5 && renderedMain.words >= minimumRenderedWords) return { outcome: 'fail', severity: 'high', reason: 'mostly-rendered', evidence: ids, params };
    if (h1Missing) {
      ids.push(evidence.add({ kind: 'render', url: page!.fetch.finalUrl, label: evidenceLabel('h1 that exists only after rendering; the raw HTML has no h1'), excerpt: clip(renderedH1.text), path: 'h1' }));
      return { outcome: 'fail', severity: 'high', reason: 'h1-missing', evidence: ids, params };
    }
    if (ratio < 0.8) return { outcome: 'fail', severity: 'medium', reason: 'partly-rendered', evidence: ids, params };
    return { outcome: 'pass', evidence: [counts] };
  },
};

export const renderingRules: readonly RuleImplementation[] = [jsOnlyContent];
