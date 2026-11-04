import type { RuleImplementation } from '../engine.ts';
import { absoluteUrl, pageDocument, summarizeList } from '../helpers.ts';
import {
  asNode, auditEvidence, auditOf, auditRan, consentMarker, elements, isRecord, labEvidence, labOf, lcpTarget, markerOf, notApplicable,
  notEvaluated, num, openingTag, rows, str, type ElementInfo, type Row,
} from './shared.ts';

function viewportHeight(screenEmulation: unknown): number {
  return isRecord(screenEmulation) ? num(screenEmulation.height) ?? 823 : 823;
}

export const unsizedImages: RuleImplementation = {
  id: 'perf-unsized-images',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'unsized-images');
    if (!auditRan(audit)) return notEvaluated('no-unsized-images-audit');
    const items = rows(audit.details);
    if (audit.score === 1 || items.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'unsized-images', 'Lighthouse unsized images audit')] };
    const fold = viewportHeight(summary.settings.screenEmulation);
    const aboveFold = items.filter(item => (asNode(item.node)?.top ?? Number.POSITIVE_INFINITY) < fold);
    const shown = [...aboveFold, ...items.filter(item => !aboveFold.includes(item))].slice(0, 5);
    const cited = shown.map(item => labEvidence(evidence, page!, summary, 'unsized-images', aboveFold.includes(item) ? 'unsized image in the first viewport' : 'unsized image below the first viewport',
      asNode(item.node)?.snippet ?? str(item.url) ?? ''));
    return { outcome: 'fail', severity: aboveFold.length > 0 ? 'medium' : 'low', ...(aboveFold.length > 0 ? {} : { reason: 'below-fold' }), evidence: cited,
      params: { count: items.length, aboveFold: aboveFold.length } };
  },
};

interface Cluster {
  readonly score: number;
  readonly shifts: readonly Row[];
  readonly causes: readonly string[];
}

function subItems(row: Row): Row[] {
  return isRecord(row.subItems) && Array.isArray(row.subItems.items) ? row.subItems.items.filter(isRecord) : [];
}

function cause(item: Row): string {
  const extra = isRecord(item.extra) ? str(item.extra.value) ?? asNode(item.extra)?.snippet : undefined;
  return `${str(item.cause) ?? 'unknown cause'}${extra ? `: ${extra}` : ''}`;
}

/** Shift clusters of the cls-culprits insight; each table starts with the cluster total. */
function clusters(details: unknown): Cluster[] {
  if (!isRecord(details) || !Array.isArray(details.items)) return [];
  return details.items.filter(isRecord).filter(table => table.type === 'table' && Array.isArray(table.items)).map(table => {
    const items = (table.items as unknown[]).filter(isRecord);
    const total = items.find(item => isRecord(item.node) && item.node.type === 'text');
    const shifts = items.filter(item => item !== total);
    return { score: num(total?.score) ?? 0, shifts, causes: [...new Set(shifts.flatMap(subItems).map(cause))] };
  });
}

/** Cluster score from which a shift cluster is worth reporting (tool heuristic). */
const clusterCandidate = 0.05;

export const clsCulprits: RuleImplementation = {
  id: 'perf-cls-culprits',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'cls-culprits-insight');
    if (!auditRan(audit)) return notEvaluated('no-cls-culprits');
    const candidates = clusters(audit.details).filter(cluster => cluster.score > clusterCandidate).sort((a, b) => b.score - a.score);
    if (candidates.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'cumulative-layout-shift', 'Lighthouse lab Cumulative Layout Shift')] };
    const worst = candidates[0]!;
    const causes = [...new Set(candidates.flatMap(cluster => cluster.causes))];
    const cited = [
      labEvidence(evidence, page!, summary, 'cls-culprits-insight', 'worst layout shift cluster', `cluster score=${worst.score.toFixed(3)}`),
      ...worst.shifts.slice(0, 3).map(shift => labEvidence(evidence, page!, summary, 'cls-culprits-insight', 'element moved by a layout shift',
        `${asNode(shift.node)?.snippet ?? asNode(shift.node)?.selector ?? 'unknown element'} (score ${(num(shift.score) ?? 0).toFixed(3)})`)),
      ...causes.slice(0, 5).map(entry => labEvidence(evidence, page!, summary, 'cls-culprits-insight', 'layout shift root cause attributed by Lighthouse', entry)),
    ];
    const severity = worst.score >= 0.1 ? 'medium' : 'low';
    const params = { score: worst.score.toFixed(3), clusters: candidates.length, causes: causes.length > 0 ? summarizeList(causes) : 'none attributed' };
    // Without an attributed root cause the moved element is not the culprit; the analyst has to name it.
    if (causes.length === 0) return { outcome: 'fail', severity, reason: 'no-root-cause', needsJudgment: true, evidence: cited, params };
    return { outcome: 'fail', severity, evidence: cited, params };
  },
};

const embedSource = /youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|google\.com\/maps\/embed|maps\.google\.|twitter\.com|platform\.x\.com|instagram\.com\/p\/|facebook\.com\/plugins|tiktok\.com\/embed|spotify\.com\/embed|soundcloud\.com\/player|doubleclick\.net|googlesyndication\.com|calendly\.com/iu;
const adContainer = /^div-gpt-ad|adsbygoogle|ad-slot|adslot/iu;

function reservesSpace(info: ElementInfo): boolean {
  const style = (info.attrs.style ?? '').toLowerCase();
  if (/aspect-ratio|(^|;|\s)(min-)?height\s*:/u.test(style)) return true;
  return info.attrs.width !== undefined && info.attrs.height !== undefined;
}

export const embedReservedSpace: RuleImplementation = {
  id: 'perf-embed-reserved-space',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!)!;
    const base = page!.fetch.finalUrl;
    const embeds = elements(doc).filter(info => (info.tag === 'iframe' && embedSource.test(absoluteUrl(info.attrs.src, base) ?? info.attrs['data-src'] ?? ''))
      || (info.tag === 'ins' && /adsbygoogle/u.test(info.attrs.class ?? '')) || (info.tag === 'div' && adContainer.test(markerOf(info).trim())));
    if (embeds.length === 0) return notApplicable('no-embeds');
    const unsized = embeds.filter(info => !reservesSpace(info));
    if (unsized.length === 0) return { outcome: 'pass' };
    const summary = labOf(page);
    const shifted = clusters(auditOf(summary, 'cls-culprits-insight')?.details).flatMap(cluster => cluster.causes).filter(entry => /^Injected iframe/u.test(entry));
    const cited = unsized.slice(0, 5).map(info => evidence.add({ kind: 'html', url: page!.url, label: 'embed without width and height or a reserved height', excerpt: openingTag(info), line: info.line }));
    if (summary && shifted.length > 0) {
      const lab = shifted.slice(0, 3).map(entry => labEvidence(evidence, page!, summary, 'cls-culprits-insight', 'layout shift attributed to an injected iframe', entry));
      return { outcome: 'fail', severity: 'medium', reason: 'attributed-shift', evidence: [...cited, ...lab], params: { count: unsized.length } };
    }
    // Space may still be reserved by a stylesheet or the container, which the HTML does not show.
    return { outcome: 'fail', severity: 'low', reason: 'unsized-embed', needsJudgment: true, evidence: cited, params: { count: unsized.length } };
  },
};

export const nonCompositedAnimations: RuleImplementation = {
  id: 'perf-non-composited-animations',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'non-composited-animations');
    if (!auditRan(audit)) return notEvaluated('no-animations-audit');
    const items = rows(audit.details);
    if (audit.score === 1 || items.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'non-composited-animations', 'Lighthouse non-composited animations audit')] };
    const reasons = [...new Set(items.flatMap(subItems).map(item => str(item.failureReason)).filter((reason): reason is string => reason !== undefined))];
    const cited = items.slice(0, 5).map(item => labEvidence(evidence, page!, summary, 'non-composited-animations', 'element with a non-composited animation',
      `${asNode(item.node)?.snippet ?? asNode(item.node)?.selector ?? ''}${subItems(item).length > 0 ? `: ${subItems(item).map(sub => str(sub.failureReason) ?? '').join('; ')}` : ''}`));
    return { outcome: 'fail', severity: 'low', evidence: cited, params: { count: items.length, reasons: reasons.length > 0 ? summarizeList(reasons) : 'not stated' } };
  },
};

export const consentLabBias: RuleImplementation = {
  id: 'perf-consent-lab-bias',
  evaluate({ page, evidence }) {
    const doc = page!.rendered!;
    const dialog = elements(doc).find(info => consentMarker.test(markerOf(info)) || ((info.attrs.role === 'dialog' || info.attrs.role === 'alertdialog') && /cookie|consent/iu.test(info.attrs['aria-label'] ?? '')));
    if (!dialog) return notApplicable('no-consent-ui');
    const target = lcpTarget(page!);
    if (!target) return notEvaluated('no-lcp-element');
    const ui = evidence.add({ kind: 'render', url: page!.url, label: 'consent dialog in the rendered page', excerpt: openingTag(dialog) });
    const lcp = evidence.add({ kind: target.source === 'lighthouse' ? 'lighthouse' : 'render', url: page!.url, label: 'lab LCP element', excerpt: target.snippet ?? target.selector ?? target.url ?? '' });
    const inside = consentMarker.test(`${target.selector ?? ''} ${target.snippet ?? ''}`);
    if (!inside) return { outcome: 'pass', evidence: [ui, lcp] };
    return { outcome: 'fail', severity: 'info', evidence: [ui, lcp], params: { element: target.selector ?? target.snippet ?? '' } };
  },
};

export const layoutImplementations: readonly RuleImplementation[] = [unsizedImages, clsCulprits, embedReservedSpace, nonCompositedAnimations, consentLabBias];

