import { evidenceLabel, labelText, type EvidenceLabel, type EvidenceStore } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import { collapse } from '../../parse/html.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { pageDocument } from '../helpers.ts';
import { flaggedSubparts, lcpMetric, type Shares } from './field.ts';
import {
  auditEvidence, auditOf, checklistOf, comparableUrl, elements, fieldRecord, labEvidence, labFormFactor, labOf, lcpTarget, notApplicable,
  notEvaluated, num, openingTag, p75, rows, srcsetUrls, str, textContent, type ElementInfo, type LcpTarget,
} from './shared.ts';

const lazyDataAttributes = ['data-src', 'data-srcset', 'data-lazy-src', 'data-lazy-srcset', 'data-original'];

interface DiscoveryPoint {
  readonly info: ElementInfo;
  readonly urls: readonly string[];
}

/** Places where the preload scanner finds an image URL in the server HTML. */
function discoveryPoints(doc: DocumentFacts, base: string): DiscoveryPoint[] {
  const points: DiscoveryPoint[] = [];
  for (const info of elements(doc)) {
    const { tag, attrs } = info;
    let raw: string[] = [];
    if (tag === 'img') raw = [...(attrs.src === undefined ? [] : [attrs.src]), ...srcsetUrls(attrs.srcset)];
    else if (tag === 'source') raw = [...srcsetUrls(attrs.srcset), ...(attrs.src === undefined ? [] : [attrs.src])];
    else if (tag === 'link' && (attrs.rel ?? '').toLowerCase().split(/\s+/u).includes('preload') && (attrs.as ?? '').toLowerCase() === 'image') {
      raw = [...(attrs.href === undefined ? [] : [attrs.href]), ...srcsetUrls(attrs.imagesrcset)];
    }
    const urls = raw.map(href => comparableUrl(href, base)).filter((url): url is string => url !== undefined);
    if (urls.length > 0) points.push({ info, urls });
  }
  return points;
}

/** An <img> that names the LCP URL only in a lazy-loading data attribute, for a script to swap in later. */
function scriptLazyImage(doc: DocumentFacts, base: string, target: string): ElementInfo | undefined {
  return elements(doc).find(info => {
    if (info.tag !== 'img') return false;
    const lazy = lazyDataAttributes.flatMap(name => srcsetUrls(info.attrs[name])).map(href => comparableUrl(href, base));
    if (!lazy.includes(target)) return false;
    const eager = [...(info.attrs.src === undefined ? [] : [info.attrs.src]), ...srcsetUrls(info.attrs.srcset)].map(href => comparableUrl(href, base));
    return !eager.includes(target);
  });
}

function targetEvidence(evidence: EvidenceStore, page: PageFacts, target: LcpTarget): string {
  return evidence.add({
    kind: target.source === 'lighthouse' ? 'lighthouse' : 'render',
    url: page.url,
    label: target.source === 'lighthouse' ? evidenceLabel('lab LCP element reported by Lighthouse') : evidenceLabel('LCP element observed in the rendered page'),
    excerpt: target.snippet ?? target.url ?? target.selector ?? target.tag ?? '',
    ...(target.selector === undefined ? {} : { path: target.selector }),
  });
}

function elementEvidence(evidence: EvidenceStore, page: PageFacts, label: EvidenceLabel, info: ElementInfo): string {
  return evidence.add({ kind: 'html', url: page.url, label, excerpt: openingTag(info), line: info.line });
}

function lcpUrl(page: PageFacts, target: LcpTarget | undefined): string | undefined {
  return target?.url === undefined ? undefined : comparableUrl(target.url, page.fetch.finalUrl);
}

function discovery(page: PageFacts) {
  const summary = labOf(page)!;
  const audit = auditOf(summary, 'lcp-discovery-insight');
  return { summary, checklist: checklistOf(audit?.details) };
}

/**
 * Chrome requests a lazy-loaded image only after layout, so Lighthouse may or may not count one that the server HTML
 * names as found by the parser, from run to run. perf-lcp-lazy-loaded reports that image; the discovery check says
 * nothing more about it.
 */
const lazyLoaded = (checklist: ReturnType<typeof checklistOf>) => checklist?.eagerlyLoaded?.value === false;

/** The server HTML element that names the LCP image URL, where the preload scanner can find it. */
function serverReference(page: PageFacts): DiscoveryPoint | undefined {
  const url = lcpUrl(page, lcpTarget(page));
  return url && page.raw ? discoveryPoints(page.raw, page.fetch.finalUrl).find(entry => entry.urls.includes(url)) : undefined;
}

function checklistEvidence(evidence: EvidenceStore, page: PageFacts, key: string, entry: { label: string; value: boolean }): string {
  const summary = labOf(page)!;
  return labEvidence(evidence, page, summary, 'lcp-discovery-insight', evidenceLabel('Lighthouse LCP request discovery check'), `${key}=${entry.value}: ${entry.label}`, `audits.lcp-discovery-insight.details.checklist.${key}`);
}

export const lcpLazyLoaded: RuleImplementation = {
  id: 'perf-lcp-lazy-loaded',
  evaluate({ page, evidence }) {
    const { checklist } = discovery(page!);
    const target = lcpTarget(page!);
    const eager = checklist?.eagerlyLoaded;
    if (eager && !eager.value) {
      const cited = [checklistEvidence(evidence, page!, 'eagerlyLoaded', eager), ...(target ? [targetEvidence(evidence, page!, target)] : [])];
      return { outcome: 'fail', severity: 'high', reason: 'loading-lazy', evidence: cited };
    }
    const url = lcpUrl(page!, target);
    const raw = page!.raw;
    if (url && raw) {
      const lazy = scriptLazyImage(raw, page!.fetch.finalUrl, url);
      if (lazy) {
        const cited = [elementEvidence(evidence, page!, evidenceLabel('LCP image whose URL is only in a lazy-loading data attribute'), lazy), targetEvidence(evidence, page!, target!)];
        return { outcome: 'fail', severity: 'high', reason: 'script-lazy-load', evidence: cited };
      }
    }
    if (!checklist && !url) return notApplicable('no-image-lcp');
    return { outcome: 'pass', evidence: eager ? [checklistEvidence(evidence, page!, 'eagerlyLoaded', eager)] : target ? [targetEvidence(evidence, page!, target)] : [] };
  },
};

export const lcpNotDiscoverable: RuleImplementation = {
  id: 'perf-lcp-not-discoverable',
  evaluate({ page, evidence }) {
    const { checklist } = discovery(page!);
    const discoverable = checklist?.requestDiscoverable;
    if (!discoverable) return notApplicable('no-image-lcp');
    const cited = checklistEvidence(evidence, page!, 'requestDiscoverable', discoverable);
    if (discoverable.value) return { outcome: 'pass', evidence: [cited] };
    const target = lcpTarget(page!);
    const url = lcpUrl(page!, target);
    const raw = page!.raw;
    if (url && raw) {
      // The data-src pattern is reported once, by perf-lcp-lazy-loaded.
      if (scriptLazyImage(raw, page!.fetch.finalUrl, url)) return notApplicable('script-lazy-load');
      const point = discoveryPoints(raw, page!.fetch.finalUrl).find(entry => entry.urls.includes(url));
      if (point && lazyLoaded(checklist)) return notApplicable('lcp-lazy-loaded');
      if (point) {
        const html = elementEvidence(evidence, page!, evidenceLabel('server HTML element that references the LCP image'), point.info);
        return { outcome: 'fail', severity: 'medium', reason: 'conflicting-signals', evidence: [cited, html, targetEvidence(evidence, page!, target!)], params: { url: target!.url! } };
      }
    }
    const extra = target ? [targetEvidence(evidence, page!, target)] : [];
    return { outcome: 'fail', severity: 'high', evidence: [cited, ...extra], params: { url: target?.url ?? 'unknown' } };
  },
};

/** More than two high-priority images compete for bandwidth with the LCP image. */
const fetchpriorityLimit = 2;

export const lcpFetchpriority: RuleImplementation = {
  id: 'perf-lcp-fetchpriority',
  evaluate({ page, evidence }) {
    const { checklist } = discovery(page!);
    const results: RuleResult[] = [];
    const hinted = checklist?.priorityHinted;
    const raw = page!.raw;
    const high = elements(raw).filter(info => (info.tag === 'img' || (info.tag === 'link' && (info.attrs.as ?? '').toLowerCase() === 'image'))
      && (info.attrs.fetchpriority ?? '').toLowerCase() === 'high');
    if (high.length > fetchpriorityLimit) {
      const cited = high.slice(0, 5).map(info => elementEvidence(evidence, page!, evidenceLabel('image with fetchpriority=high in the server HTML'), info));
      results.push({ outcome: 'fail', severity: 'low', reason: 'overuse', evidence: cited, params: { count: high.length } });
    }
    if (!hinted) return results.length > 0 ? results : [notApplicable('no-image-lcp')];
    // An undiscoverable LCP request is reported once, by perf-lcp-not-discoverable; a lazy image the server HTML names is not.
    const undiscoverable = checklist?.requestDiscoverable?.value === false && !(lazyLoaded(checklist) && serverReference(page!));
    if (undiscoverable) return results.length > 0 ? results : [notApplicable('lcp-not-discoverable')];
    const cited = checklistEvidence(evidence, page!, 'priorityHinted', hinted);
    if (!hinted.value) {
      const target = lcpTarget(page!);
      results.unshift({ outcome: 'fail', severity: 'medium', evidence: [cited, ...(target ? [targetEvidence(evidence, page!, target)] : [])] });
    } else if (results.length === 0) {
      results.push({ outcome: 'pass', evidence: [cited] });
    }
    return results;
  },
};

interface LabBreakdown {
  readonly ttfb: number;
  readonly loadDelay: number;
  readonly loadDuration: number;
  readonly renderDelay: number;
  readonly total: number;
}

export function labBreakdown(page: PageFacts): LabBreakdown | undefined {
  const items = rows(auditOf(labOf(page), 'lcp-breakdown-insight')?.details);
  const value = (subpart: string) => num(items.find(item => str(item.subpart) === subpart)?.duration);
  const ttfb = value('timeToFirstByte');
  const renderDelay = value('elementRenderDelay');
  if (ttfb === undefined || renderDelay === undefined) return undefined;
  const loadDelay = value('resourceLoadDelay') ?? 0;
  const loadDuration = value('resourceLoadDuration') ?? 0;
  return { ttfb, loadDelay, loadDuration, renderDelay, total: ttfb + loadDelay + loadDuration + renderDelay };
}

const fieldSubparts = ['largest_contentful_paint_image_time_to_first_byte', 'largest_contentful_paint_image_element_render_delay'];

export const lcpBreakdownLab: RuleImplementation = {
  id: 'perf-lcp-breakdown-lab',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const lcp = auditOf(summary, 'largest-contentful-paint')?.numericValue;
    if (lcp === undefined) return notEvaluated('no-lab-value');
    if (lcp <= lcpMetric.good) return notApplicable('lab-lcp-good');
    const field = fieldRecord(page, labFormFactor(summary));
    if (fieldSubparts.every(metric => p75(field, metric) !== undefined)) return notApplicable('field-subparts-available');
    const breakdown = labBreakdown(page!);
    if (!breakdown || breakdown.total <= 0) return notEvaluated('no-lcp-breakdown');
    const shares: Shares = {
      ttfb: breakdown.ttfb / breakdown.total,
      loadDelay: breakdown.loadDelay / breakdown.total,
      loadDuration: breakdown.loadDuration / breakdown.total,
      renderDelay: breakdown.renderDelay / breakdown.total,
    };
    const excerpt = `timeToFirstByte=${Math.round(breakdown.ttfb)} ms; resourceLoadDelay=${Math.round(breakdown.loadDelay)} ms; resourceLoadDuration=${Math.round(breakdown.loadDuration)} ms; elementRenderDelay=${Math.round(breakdown.renderDelay)} ms`;
    const cited = [
      auditEvidence(evidence, page!, summary, 'largest-contentful-paint', evidenceLabel('Lighthouse lab Largest Contentful Paint')),
      labEvidence(evidence, page!, summary, 'lcp-breakdown-insight', evidenceLabel('Lighthouse lab LCP subparts'), excerpt),
    ];
    const flagged = flaggedSubparts(shares);
    if (flagged.length === 0) return { outcome: 'pass', evidence: cited };
    return { outcome: 'fail', severity: 'medium', evidence: cited, params: { lcp: `${Math.round(lcp)} ms`, subparts: flagged.join(', ') } };
  },
};

function normalizedText(text: string): string {
  return collapse(text).toLowerCase();
}

/** LCP render delay beyond FCP that marks content painted only after scripts ran (tool heuristic). */
const csrGapMs = 500;

export const lcpClientSideRendered: RuleImplementation = {
  id: 'perf-lcp-client-side-rendered',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const rendered = page!.rendered!;
    const lcp = rendered.result.lcp ?? page!.userRender?.result.lcp;
    if (!lcp) return notEvaluated('no-lcp-element');
    const raw = page!.raw!;
    let found: boolean;
    let observed: string;
    if (lcp.url) {
      const target = comparableUrl(lcp.url, page!.fetch.finalUrl);
      const path = target ? new URL(target).pathname : lcp.url;
      found = raw.html.includes(lcp.url) || raw.html.includes(path) || discoveryPoints(raw, page!.fetch.finalUrl).some(point => target !== undefined && point.urls.includes(target));
      observed = lcp.url;
    } else {
      const block = [...rendered.result.textBlocks, ...(page!.userRender?.result.textBlocks ?? [])].find(entry => entry.selector === lcp.selector);
      if (!block) return notEvaluated('no-lcp-text');
      const needle = normalizedText(block.text).slice(0, 80);
      found = normalizedText(raw.parsed.bodyText).includes(needle);
      observed = block.text;
    }
    const element = evidence.add({ kind: 'render', url: page!.url, label: evidenceLabel('LCP content in the rendered page'), excerpt: observed, ...(lcp.selector ? { path: lcp.selector } : {}) });
    if (found) return { outcome: 'pass', evidence: [element] };
    const lab = auditOf(summary, 'largest-contentful-paint')?.numericValue;
    const fcp = auditOf(summary, 'first-contentful-paint')?.numericValue;
    if (lab === undefined || fcp === undefined) return notEvaluated('no-lab-value');
    const timing = labEvidence(evidence, page!, summary, 'largest-contentful-paint', evidenceLabel('Lighthouse lab LCP and FCP'), `LCP=${Math.round(lab)} ms; FCP=${Math.round(fcp)} ms`);
    if (lab - fcp <= csrGapMs) return { outcome: 'pass', evidence: [element, timing] };
    const absent = evidence.add({ kind: 'html', url: page!.url, label: evidenceLabel('LCP content searched in the server HTML and not found'), excerpt: observed });
    const params = { gap: `${Math.round(lab - fcp)} ms` };
    // An empty server body cannot be explained by personalisation; anything else needs the analyst.
    if (raw.parsed.bodyText === '') return { outcome: 'fail', severity: 'high', reason: 'app-shell', evidence: [element, absent, timing], params };
    return { outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'content-differs', evidence: [element, absent, timing], params };
  },
};

const hidingRule = /(?:^|[},])\s*(?:html|body|\.async-hide)(?:[.#:\[][^{,\s]*)?\s*\{[^}]*(?:opacity\s*:\s*0(?:\.0*)?(?![.\d])|visibility\s*:\s*hidden)/iu;
const vendorSnippets: ReadonlyArray<readonly [EvidenceLabel, RegExp]> = [
  [evidenceLabel('async-hide class'), /async-hide/u],
  [evidenceLabel('VWO SmartCode'), /_vwo_code[\s\S]*settings_tolerance/u],
  [evidenceLabel('Adobe Target pre-hiding snippet'), /at-body-style/u],
  [evidenceLabel('Kameleoon loading style sheet'), /kameleoonLoadingStyleSheet/u],
];

interface HidingSnippet {
  readonly label: EvidenceLabel;
  readonly info: ElementInfo;
  readonly excerpt: string;
}

/** Anti-flicker snippets that hide the whole page (html or body), never section-level reveal styles. */
function hidingSnippets(doc: DocumentFacts): HidingSnippet[] {
  const found: HidingSnippet[] = [];
  for (const info of elements(doc)) {
    if (info.tag === 'style' && info.inHead) {
      const css = textContent(info.element);
      const match = hidingRule.exec(css);
      if (match) found.push({ label: evidenceLabel('style rule that hides the page'), info, excerpt: match[0].trim().replace(/^[},]\s*/u, '').slice(0, 200) });
    } else if (info.tag === 'script' && info.inHead) {
      const code = textContent(info.element);
      for (const [label, pattern] of vendorSnippets) {
        const match = pattern.exec(code);
        if (match) {
          found.push({ label, info, excerpt: code.slice(Math.max(0, match.index - 60), match.index + 140).trim() });
          break;
        }
      }
    } else if ((info.tag === 'html' || info.tag === 'body') && (/\basync-hide\b/u.test(info.attrs.class ?? '') || /opacity\s*:\s*0(?:\.0*)?(?![.\d])|visibility\s*:\s*hidden/iu.test(info.attrs.style ?? ''))) {
      found.push({ label: evidenceLabel('{tag} element hidden in the server HTML', { tag: info.tag }), info, excerpt: openingTag(info) });
    }
  }
  return found;
}

/** Element render delay that marks hiding as costly (tool heuristic). */
const antiflickerDelayMs = 500;

export const lcpAntiflicker: RuleImplementation = {
  id: 'perf-lcp-antiflicker-hiding',
  evaluate({ page, evidence }) {
    const snippets = hidingSnippets(pageDocument(page!, 'raw')!);
    if (snippets.length === 0) return { outcome: 'pass' };
    const cited = snippets.slice(0, 3).map(snippet => evidence.add({ kind: 'html', url: page!.url, label: snippet.label, excerpt: snippet.excerpt, line: snippet.info.line }));
    const breakdown = labBreakdown(page!);
    if (!breakdown) return notEvaluated('no-lcp-breakdown');
    const summary = labOf(page)!;
    const delay = labEvidence(evidence, page!, summary, 'lcp-breakdown-insight', evidenceLabel('Lighthouse lab LCP element render delay'), `elementRenderDelay=${Math.round(breakdown.renderDelay)} ms`);
    if (breakdown.renderDelay <= antiflickerDelayMs) return { outcome: 'pass', evidence: [...cited, delay] };
    return { outcome: 'fail', severity: 'medium', evidence: [...cited, delay], params: { snippet: labelText(snippets[0]!.label), delay: `${Math.round(breakdown.renderDelay)} ms` } };
  },
};

export const lcpImplementations: readonly RuleImplementation[] = [lcpLazyLoaded, lcpNotDiscoverable, lcpFetchpriority, lcpBreakdownLab, lcpClientSideRendered, lcpAntiflicker];
