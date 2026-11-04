import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { ElementRef } from '../../parse/html.ts';
import type { RuleImplementation } from '../engine.ts';
import { metaNamed, pageDocument } from '../helpers.ts';
import { auditFailed, citer, detailItems, fail, keyValues, lighthouseSummary, notApplicable, notEvaluated, pass, shorten, type Cite } from './shared.ts';

interface Viewport {
  readonly meta: ElementRef;
  readonly doc: DocumentFacts;
  readonly source: 'raw HTML' | 'rendered DOM';
  readonly values: Map<string, string>;
}

/** The viewport the browser applies: the last viewport meta element, from the raw HTML or else the rendered DOM. */
export function viewportOf(page: PageFacts): Viewport | undefined {
  for (const [doc, source] of [[page.raw, 'raw HTML'], [pageDocument(page), 'rendered DOM']] as const) {
    const meta = metaNamed(doc, 'viewport').filter(entry => entry.attrs.content !== undefined).at(-1);
    if (doc && meta) return { meta, doc, source, values: keyValues(meta.attrs.content!) };
  }
  return undefined;
}

/** Chrome treats a page as mobile-optimized when the viewport has width=device-width or an initial scale of at least 1. */
export function mobileOptimized(viewport: Viewport | undefined): boolean {
  if (!viewport) return false;
  const scale = Number.parseFloat(viewport.values.get('initial-scale') ?? '');
  return viewport.values.get('width') === 'device-width' || (Number.isFinite(scale) && scale >= 1);
}

function citeViewport(cite: Cite, page: PageFacts, viewport: Viewport): string {
  return cite({ kind: 'html', url: page.fetch.finalUrl, label: viewport.source === 'raw HTML' ? evidenceLabel('viewport meta element (raw HTML)') : evidenceLabel('viewport meta element (rendered DOM)'), excerpt: `<meta name="viewport" content="${viewport.meta.attrs.content}">`, line: viewport.meta.line });
}

export const viewportMeta: RuleImplementation = {
  id: 'tech-viewport-meta',
  evaluate(context) {
    const page = context.page!;
    const cite = citer(context);
    const viewport = viewportOf(page);
    const insight = lighthouseSummary(page)?.audits['viewport-insight'];
    const lighthouse = insight && insight.score !== null
      ? [cite({ kind: 'lighthouse', url: page.fetch.finalUrl, label: evidenceLabel('Lighthouse viewport insight'), excerpt: `viewport-insight score=${insight.score}` })]
      : [];
    if (!viewport) {
      const evidence = [cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('no viewport meta element in the raw HTML or rendered DOM'), excerpt: '<meta name="viewport"> (absent)' }), ...lighthouse];
      return fail('high', evidence, 'missing');
    }
    const evidence = [citeViewport(cite, page, viewport), ...lighthouse];
    if (mobileOptimized(viewport)) return pass(evidence);
    const width = viewport.values.get('width');
    if (width !== undefined && width !== 'device-width') return fail('high', evidence, 'fixed-width', { content: viewport.meta.attrs.content! });
    return fail('high', evidence, 'not-mobile-optimized', { content: viewport.meta.attrs.content! });
  },
};

export const viewportZoomAllowed: RuleImplementation = {
  id: 'tech-viewport-zoom-allowed',
  evaluate(context) {
    const page = context.page!;
    const viewport = viewportOf(page);
    if (!viewport) return notApplicable('no-viewport');
    const cite = citer(context);
    const evidence = [citeViewport(cite, page, viewport)];
    const scalable = viewport.values.get('user-scalable');
    const scalableNumber = Number.parseFloat(scalable ?? '');
    // axe meta-viewport: "no" disables zoom, and so does a numeric value between -1 and 1.
    if (scalable === 'no' || (Number.isFinite(scalableNumber) && scalableNumber > -1 && scalableNumber < 1)) {
      return fail('low', evidence, 'user-scalable-no', { content: viewport.meta.attrs.content! });
    }
    const maximum = Number.parseFloat(viewport.values.get('maximum-scale') ?? '');
    if (Number.isFinite(maximum) && maximum >= 0) {
      if (maximum < 2) return fail('low', evidence, 'maximum-scale', { content: viewport.meta.attrs.content!, maximum });
      if (maximum < 5) return fail('info', evidence, 'maximum-scale-below-5', { content: viewport.meta.attrs.content!, maximum });
    }
    return pass(evidence);
  },
};

export const contentFitsViewport: RuleImplementation = {
  id: 'tech-content-fits-viewport',
  evaluate(context) {
    const page = context.page!;
    const result = page.userRender!.result;
    if (result.innerWidth <= 0) return notEvaluated('no-layout-metrics');
    const cite = citer(context);
    const evidence = [cite({ kind: 'render', url: page.fetch.finalUrl, label: evidenceLabel('document width in the phone-sized render'), excerpt: `scrollWidth=${result.scrollWidth} innerWidth=${result.innerWidth}` })];
    if (result.scrollWidth > result.innerWidth + 1) {
      return fail('low', evidence, undefined, { scrollWidth: result.scrollWidth, innerWidth: result.innerWidth, overflow: result.scrollWidth - result.innerWidth });
    }
    return pass(evidence);
  },
};

const legibleSize = 12;
const minimumCharacters = 200;

export const legibleFontSize: RuleImplementation = {
  id: 'tech-legible-font-size',
  evaluate(context) {
    const page = context.page!;
    // Without a mobile viewport every font is scaled down; tech-viewport-meta reports that first.
    if ((page.raw || page.rendered) && !mobileOptimized(viewportOf(page))) return notApplicable('viewport-not-mobile-optimized');
    const blocks = page.userRender!.result.textBlocks.filter(block => block.hidden === undefined && block.fontSize > 0);
    const total = blocks.reduce((sum, block) => sum + block.text.length, 0);
    if (total < minimumCharacters) return notApplicable('too-little-text');
    const small = blocks.filter(block => block.fontSize < legibleSize);
    const smallCharacters = small.reduce((sum, block) => sum + block.text.length, 0);
    const legibleShare = Math.round(((total - smallCharacters) / total) * 100);
    const cite = citer(context);
    const examples = small.sort((a, b) => b.text.length - a.text.length).slice(0, 3)
      .map(block => cite({ kind: 'render', url: page.fetch.finalUrl, label: evidenceLabel('text rendered at {size}px in the phone-sized render', { size: block.fontSize }), excerpt: shorten(block.text, 160), path: block.selector }));
    const summary = cite({ kind: 'render', url: page.fetch.finalUrl, label: evidenceLabel('share of visible text at 12px or larger'), excerpt: `${legibleShare}% of ${total} characters` });
    if (legibleShare < 60) return fail('low', [summary, ...examples], undefined, { share: legibleShare });
    return pass([summary]);
  },
};

export const tapTargetSize: RuleImplementation = {
  id: 'tech-tap-target-size',
  evaluate(context) {
    const page = context.page!;
    const audit = lighthouseSummary(page)!.audits['target-size'];
    if (!audit || audit.scoreDisplayMode === 'notApplicable' || audit.score === null) return notApplicable('no-targets-audited');
    const cite = citer(context);
    if (!auditFailed(audit)) return pass([cite({ kind: 'lighthouse', url: page.fetch.finalUrl, label: evidenceLabel('Lighthouse target-size audit'), excerpt: `target-size score=${audit.score}` })]);
    const items = detailItems(audit);
    const evidence = items.slice(0, 10).map(item => {
      const node = (item.node ?? {}) as Record<string, unknown>;
      return cite({ kind: 'lighthouse', url: page.fetch.finalUrl, label: evidenceLabel('touch target smaller than 24x24 CSS px reported by Lighthouse target-size'), excerpt: String(node.snippet ?? node.nodeLabel ?? 'target'), path: typeof node.selector === 'string' ? node.selector : undefined });
    });
    if (evidence.length === 0) evidence.push(cite({ kind: 'lighthouse', url: page.fetch.finalUrl, label: evidenceLabel('Lighthouse target-size audit'), excerpt: `target-size score=${audit.score}` }));
    return fail('low', evidence, undefined, { count: items.length || 1 });
  },
};
