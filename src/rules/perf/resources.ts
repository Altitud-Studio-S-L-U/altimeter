import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, pageDocument, summarizeList } from '../helpers.ts';
import {
  auditEvidence, auditOf, auditRan, comparableUrl, formatKib, isRecord, kib, labEvidence, labOf, lcpTarget, listParts, networkRequests,
  notApplicable, notEvaluated, num, openingTag, originOf, rows, str, type Row,
} from './shared.ts';

export const fontDisplay: RuleImplementation = {
  id: 'perf-font-display',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'font-display-insight');
    if (!auditRan(audit)) return notEvaluated('no-font-display-insight');
    const items = rows(audit.details).filter(row => (num(row.wastedMs) ?? 0) > 0);
    if (audit.score !== 0 || items.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'font-display-insight', evidenceLabel('Lighthouse font display insight'))] };
    const cited = items.slice(0, 5).map(row => labEvidence(evidence, page!, summary, 'font-display-insight', evidenceLabel('web font whose text stays invisible while it loads'), `${str(row.url)}: ${Math.round(num(row.wastedMs)!)} ms`));
    return { outcome: 'fail', severity: 'low', evidence: cited, params: { count: items.length, fonts: summarizeList(items.map(row => str(row.url) ?? '')) } };
  },
};

/** Origins that serve only font files, so a preconnect to them must be a CORS connection. */
const fontFileOrigin = /^https:\/\/(fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net)$/iu;

export const fontPreloadCrossorigin: RuleImplementation = {
  id: 'perf-font-preload-crossorigin',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!)!;
    const links = doc.parsed.links;
    const preloads = links.filter(link => link.rel.includes('preload') && (link.attrs.as ?? '').toLowerCase() === 'font');
    const base = page!.fetch.finalUrl;
    const preconnects = links.filter(link => link.rel.includes('preconnect') && fontFileOrigin.test(originOf(absoluteUrl(link.attrs.href, base) ?? '') ?? ''));
    if (preloads.length === 0 && preconnects.length === 0) return notApplicable('no-font-hints');
    const corsOrigins = new Set(preconnects.filter(link => link.attrs.crossorigin !== undefined).map(link => originOf(absoluteUrl(link.attrs.href, base) ?? '')));
    const missing = [
      ...preloads.filter(link => link.attrs.crossorigin === undefined),
      ...preconnects.filter(link => link.attrs.crossorigin === undefined && !corsOrigins.has(originOf(absoluteUrl(link.attrs.href, base) ?? ''))),
    ];
    if (missing.length === 0) return { outcome: 'pass' };
    const cited = missing.slice(0, 5).map(link => evidence.add({ kind: 'html', url: page!.url, label: evidenceLabel('font hint without the crossorigin attribute'), excerpt: openingTag(link), line: link.line }));
    return { outcome: 'fail', severity: 'low', evidence: cited, params: { count: missing.length } };
  },
};

/** More font files than this on one load is worth a look (tool heuristic). */
const fontFileLimit = 6;

export const fontFormat: RuleImplementation = {
  id: 'perf-font-format',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const fonts = networkRequests(summary).filter(request => request.resourceType === 'Font' && !request.url.startsWith('data:'));
    if (fonts.length === 0) return notApplicable('no-web-fonts');
    const results: RuleResult[] = [];
    const legacy = fonts.filter(font => !/woff2/iu.test(font.mimeType ?? '') && !/\.woff2(?:$|[?#])/iu.test(font.url));
    const describe = (font: (typeof fonts)[number]) => labEvidence(evidence, page!, summary, 'network-requests', font.mimeType ? evidenceLabel('web font request ({type}, {bytes} bytes)', { type: font.mimeType, bytes: font.transferSize ?? 0 }) : evidenceLabel('web font request with no type ({bytes} bytes)', { bytes: font.transferSize ?? 0 }), font.url);
    if (legacy.length > 0) results.push({ outcome: 'fail', severity: 'low', reason: 'not-woff2', evidence: legacy.slice(0, 5).map(describe), params: { count: legacy.length, fonts: summarizeList(legacy.map(font => font.url)) } });
    if (fonts.length > fontFileLimit) {
      const bytes = fonts.reduce((sum, font) => sum + (font.transferSize ?? 0), 0);
      results.push({ outcome: 'fail', severity: 'low', reason: 'many-files', evidence: fonts.slice(0, 5).map(describe), params: { count: fonts.length, size: formatKib(bytes) } });
    }
    return results.length > 0 ? results : [{ outcome: 'pass', evidence: fonts.slice(0, 3).map(describe) }];
  },
};

/** Lighthouse warns from more than four preconnects; no official limit exists (heuristic). */
const preconnectLimit = 4;
/** Browsers close an unused preconnected socket after about 10 seconds. */
const preconnectWindowMs = 10_000;

function preconnectCandidates(details: unknown): Row[] {
  return listParts(details).flatMap(section => (isRecord(section.value) ? rows(section.value) : []))
    .filter(row => str(row.origin) !== undefined && num(row.wastedMs) !== undefined && (num(row.wastedMs) ?? 0) > 0);
}

export const preconnectHints: RuleImplementation = {
  id: 'perf-preconnect-hints',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!)!;
    const base = page!.fetch.finalUrl;
    const preconnects = doc.parsed.links.filter(link => link.rel.includes('preconnect'));
    const cite = (link: (typeof preconnects)[number], label: EvidenceLabel) => evidence.add({ kind: 'html', url: page!.url, label, excerpt: openingTag(link), line: link.line });
    const results: RuleResult[] = [];
    if (preconnects.length > preconnectLimit) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'too-many', evidence: preconnects.slice(0, 6).map(link => cite(link, evidenceLabel('preconnect hint'))), params: { count: preconnects.length } });
    }
    const combined = preconnects.filter(link => link.rel.includes('dns-prefetch'));
    if (combined.length > 0) results.push({ outcome: 'fail', severity: 'low', reason: 'combined-rel', evidence: combined.map(link => cite(link, evidenceLabel('preconnect combined with dns-prefetch in one rel'))), params: { count: combined.length } });
    const summary = labOf(page);
    if (summary) {
      const requests = networkRequests(summary);
      const unused = preconnects.filter(link => {
        const origin = originOf(absoluteUrl(link.attrs.href, base) ?? '');
        return origin !== undefined && !requests.some(request => originOf(request.url) === origin && (request.networkRequestTime ?? 0) <= preconnectWindowMs);
      });
      if (unused.length > 0) results.push({ outcome: 'fail', severity: 'low', reason: 'unused', evidence: unused.map(link => cite(link, evidenceLabel('preconnected origin with no lab request in the first 10 s'))), params: { origins: summarizeList(unused.map(link => link.attrs.href ?? '')) } });
      const candidates = preconnectCandidates(auditOf(summary, 'network-dependency-tree-insight')?.details);
      if (candidates.length > 0) {
        const cited = candidates.slice(0, 3).map(row => labEvidence(evidence, page!, summary, 'network-dependency-tree-insight', evidenceLabel('origin Lighthouse estimates a preconnect would speed up'), `${str(row.origin)}: ${Math.round(num(row.wastedMs)!)} ms`));
        results.push({ outcome: 'fail', severity: 'low', reason: 'missing', evidence: cited, params: { origins: summarizeList(candidates.map(row => str(row.origin)!)) } });
      }
    }
    if (results.length > 0) return results;
    return preconnects.length === 0 ? [notApplicable('no-preconnect')] : [{ outcome: 'pass', evidence: preconnects.slice(0, 4).map(link => cite(link, evidenceLabel('preconnect hint'))) }];
  },
};

interface ChainNode {
  readonly url: string;
  readonly children: readonly ChainNode[];
}

function chainNodes(value: unknown): ChainNode[] {
  if (!isRecord(value)) return [];
  return Object.values(value).filter(isRecord).map(node => ({ url: str(node.url) ?? '', children: chainNodes(node.children) }));
}

function deepest(nodes: readonly ChainNode[]): ChainNode[] {
  let best: ChainNode[] = [];
  for (const node of nodes) {
    const path = [node, ...deepest(node.children)];
    if (path.length > best.length) best = path;
  }
  return best;
}

/** Requests chained after the document beyond which the critical path is worth flattening (tool heuristic). */
const chainDepthLimit = 3;

export const criticalRequestChains: RuleImplementation = {
  id: 'perf-critical-request-chains',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'network-dependency-tree-insight');
    if (!auditRan(audit)) return notEvaluated('no-dependency-tree');
    const tree = listParts(audit.details).map(section => section.value).find(value => isRecord(value) && value.type === 'network-tree');
    if (!isRecord(tree)) return notEvaluated('no-dependency-tree');
    const path = deepest(chainNodes(tree.chains));
    const depth = Math.max(0, path.length - 1);
    const longest = isRecord(tree.longestChain) ? num(tree.longestChain.duration) : undefined;
    const cited = labEvidence(evidence, page!, summary, 'network-dependency-tree-insight', longest === undefined ? evidenceLabel('deepest critical request chain') : evidenceLabel('deepest critical request chain (longest chain {duration} ms)', { duration: Math.round(longest) }),
      path.map(node => node.url).join(' -> '));
    if (depth <= chainDepthLimit) return { outcome: 'pass', evidence: [cited] };
    return { outcome: 'fail', severity: 'low', evidence: [cited], params: { depth, duration: longest === undefined ? 'unknown' : `${Math.round(longest)} ms` } };
  },
};

const lcpSavingsBytes = 10 * kib;
const totalSavingsBytes = 100 * kib;

export const imageDelivery: RuleImplementation = {
  id: 'perf-image-delivery',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'image-delivery-insight');
    if (!auditRan(audit)) return notEvaluated('no-image-delivery-insight');
    const items = rows(audit.details).filter(row => str(row.url) !== undefined && (num(row.wastedBytes) ?? 0) > 0);
    if (items.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'image-delivery-insight', evidenceLabel('Lighthouse image delivery insight'))] };
    const base = page!.fetch.finalUrl;
    const target = lcpTarget(page!);
    const lcp = target?.url === undefined ? undefined : comparableUrl(target.url, base);
    const describe = (row: Row, label: EvidenceLabel) => {
      const reasons = isRecord(row.subItems) && Array.isArray(row.subItems.items) ? row.subItems.items.filter(isRecord).map(item => str(item.reason)).filter(Boolean).join('; ') : '';
      return labEvidence(evidence, page!, summary, 'image-delivery-insight', label, `${str(row.url)}: estimated savings ${formatKib(num(row.wastedBytes)!)}${reasons ? ` (${reasons})` : ''}`);
    };
    const results: RuleResult[] = [];
    const lcpItem = lcp === undefined ? undefined : items.find(row => comparableUrl(str(row.url), base) === lcp);
    if (lcpItem && num(lcpItem.wastedBytes)! >= lcpSavingsBytes) {
      results.push({ outcome: 'fail', severity: 'medium', reason: 'lcp-image', evidence: [describe(lcpItem, evidenceLabel('LCP image with estimated byte savings'))], params: { url: str(lcpItem.url)!, savings: formatKib(num(lcpItem.wastedBytes)!) } });
    }
    const others = items.filter(row => row !== lcpItem);
    const total = others.reduce((sum, row) => sum + num(row.wastedBytes)!, 0);
    if (total >= totalSavingsBytes) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'images', evidence: others.slice(0, 5).map(row => describe(row, evidenceLabel('image with estimated byte savings'))), params: { count: others.length, savings: formatKib(total) } });
    }
    return results.length > 0 ? results : [{ outcome: 'pass', evidence: items.slice(0, 3).map(row => describe(row, evidenceLabel('image with estimated byte savings'))) }];
  },
};

export const resourceImplementations: readonly RuleImplementation[] = [fontDisplay, fontPreloadCrossorigin, fontFormat, preconnectHints, criticalRequestChains, imageDelivery];

