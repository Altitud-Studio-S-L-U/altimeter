import { evidenceLabel, joinLabels, type EvidenceLabel, type EvidenceStore } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { CruxFormFactor, CruxRecord } from '../../data/crux.ts';
import { isElement, walk, type HtmlElement } from '../../parse/html.ts';
import type { LighthouseAudit, LighthouseSummary } from '../../render/lighthouse.ts';
import type { RuleResult } from '../engine.ts';
import { absoluteUrl, sameSite } from '../helpers.ts';

export type Row = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export const kib = 1024;

export function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

export function formatKib(bytes: number): string {
  return `${Math.round(bytes / kib)} KiB`;
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function notEvaluated(reason: string): RuleResult {
  return { outcome: 'not_evaluated', reason };
}

export function notApplicable(reason: string): RuleResult {
  return { outcome: 'not_applicable', reason };
}

// Lighthouse lab data.

export function labOf(page: PageFacts | undefined): LighthouseSummary | undefined {
  return page?.lighthouse?.ok ? page.lighthouse.summary : undefined;
}

export function auditOf(summary: LighthouseSummary | undefined, id: string): LighthouseAudit | undefined {
  return summary?.audits[id];
}

/** Whether an audit ran and produced a result, as opposed to being not applicable or erroring. */
export function auditRan(audit: LighthouseAudit | undefined): audit is LighthouseAudit {
  return audit !== undefined && audit.scoreDisplayMode !== 'notApplicable' && audit.scoreDisplayMode !== 'error';
}

/** The rows of a table or opportunity, or of every table inside a list. */
export function rows(details: unknown): Row[] {
  if (!isRecord(details) || !Array.isArray(details.items)) return [];
  if (details.type === 'list') return details.items.flatMap(item => (isRecord(item) && item.type === 'table' ? rows(item) : []));
  return details.items.filter(isRecord);
}

/** The parts of a list detail (tables, checklists, nodes, sections). */
export function listParts(details: unknown): Row[] {
  if (!isRecord(details) || details.type !== 'list' || !Array.isArray(details.items)) return [];
  return details.items.filter(isRecord);
}

export interface ChecklistEntry {
  readonly label: string;
  readonly value: boolean;
}

export function checklistOf(details: unknown): Readonly<Record<string, ChecklistEntry>> | undefined {
  const holder = isRecord(details) && details.type === 'checklist' ? details : listParts(details).find(part => part.type === 'checklist');
  if (!holder || !isRecord(holder.items)) return undefined;
  const entries: Record<string, ChecklistEntry> = {};
  for (const [key, entry] of Object.entries(holder.items)) {
    if (isRecord(entry) && typeof entry.value === 'boolean') entries[key] = { label: str(entry.label) ?? key, value: entry.value };
  }
  return entries;
}

export interface NodeItem {
  readonly selector?: string;
  readonly snippet?: string;
  readonly nodeLabel?: string;
  readonly top?: number;
}

export function asNode(value: unknown): NodeItem | undefined {
  if (!isRecord(value) || value.type !== 'node') return undefined;
  const rect = isRecord(value.boundingRect) ? num(value.boundingRect.top) : undefined;
  const selector = str(value.selector);
  const snippet = str(value.snippet);
  const nodeLabel = str(value.nodeLabel);
  return {
    ...(selector === undefined ? {} : { selector }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(nodeLabel === undefined ? {} : { nodeLabel }),
    ...(rect === undefined ? {} : { top: rect }),
  };
}

export function nodeOf(details: unknown): NodeItem | undefined {
  for (const part of listParts(details)) {
    const node = asNode(part);
    if (node) return node;
  }
  return undefined;
}

export function labFormFactor(summary: LighthouseSummary): CruxFormFactor {
  return summary.settings.formFactor === 'desktop' ? 'DESKTOP' : 'PHONE';
}

/** How the lab value was produced, for messages: lab values are never presented as field data. */
export function labConditions(summary: LighthouseSummary): string {
  return `lab, Lighthouse ${summary.lighthouseVersion}, ${summary.settings.formFactor}, ${summary.settings.throttlingMethod} throttling`;
}

export function labEvidence(evidence: EvidenceStore, page: PageFacts, summary: LighthouseSummary, auditId: string, label: EvidenceLabel, excerpt?: string, path?: string): string {
  const conditions = { version: summary.lighthouseVersion, formFactor: summary.settings.formFactor, throttling: summary.settings.throttlingMethod };
  return evidence.add({
    kind: 'lighthouse',
    url: page.url,
    label: joinLabels(label, evidenceLabel('(lab, Lighthouse {version}, {formFactor}, {throttling} throttling)', conditions)),
    ...(excerpt === undefined ? {} : { excerpt }),
    path: path ?? `audits.${auditId}`,
  });
}

/** Evidence for a lab audit's headline value. */
export function auditEvidence(evidence: EvidenceStore, page: PageFacts, summary: LighthouseSummary, auditId: string, label: EvidenceLabel): string {
  const audit = auditOf(summary, auditId);
  const parts = [
    audit?.numericValue === undefined ? undefined : `numericValue=${Math.round(audit.numericValue * 1000) / 1000}${audit.numericUnit ? ` ${audit.numericUnit}` : ''}`,
    audit?.displayValue === undefined ? undefined : `displayValue=${audit.displayValue}`,
    audit ? `score=${audit.score ?? 'null'}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return labEvidence(evidence, page, summary, auditId, label, parts.join('; '));
}

export interface NetworkRequest {
  readonly url: string;
  readonly protocol?: string;
  readonly resourceType?: string;
  readonly mimeType?: string;
  readonly transferSize?: number;
  readonly resourceSize?: number;
  readonly statusCode?: number;
  readonly networkRequestTime?: number;
  readonly entity?: string;
}

export function networkRequests(summary: LighthouseSummary | undefined): NetworkRequest[] {
  return rows(auditOf(summary, 'network-requests')?.details).flatMap(row => {
    const url = str(row.url);
    if (!url) return [];
    const fields: Record<string, string | number> = { url };
    for (const key of ['protocol', 'resourceType', 'mimeType', 'entity'] as const) {
      const value = str(row[key]);
      if (value !== undefined) fields[key] = value;
    }
    for (const key of ['transferSize', 'resourceSize', 'statusCode', 'networkRequestTime'] as const) {
      const value = num(row[key]);
      if (value !== undefined) fields[key] = value;
    }
    return [fields as unknown as NetworkRequest];
  });
}

export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

const secondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gob', 'nom']);

/** Approximates the registrable domain, so a site's own subdomains (static., cdn.) count as first party. */
function siteKey(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (/^[\d.]+$|:/u.test(host)) return host;
  const labels = host.split('.');
  const keep = labels.length >= 3 && labels.at(-1)!.length === 2 && secondLevel.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export function firstParty(url: string, page: PageFacts): boolean {
  if (sameSite(url, page.url) || sameSite(url, page.fetch.finalUrl)) return true;
  const key = siteKey(url);
  return key !== undefined && (key === siteKey(page.url) || key === siteKey(page.fetch.finalUrl));
}

// CrUX field data.

export const formFactors: readonly CruxFormFactor[] = ['PHONE', 'DESKTOP'];

export interface FieldRecord {
  readonly record: CruxRecord;
  readonly scope: 'url' | 'origin';
}

/** URL-level data when CrUX has it, otherwise origin-level data, for one form factor. */
export function fieldRecord(page: PageFacts | undefined, form: CruxFormFactor): FieldRecord | undefined {
  const byUrl = page?.crux?.url[form];
  if (byUrl?.status === 'ok') return { record: byUrl.record, scope: 'url' };
  const byOrigin = page?.crux?.origin[form];
  if (byOrigin?.status === 'ok') return { record: byOrigin.record, scope: 'origin' };
  return undefined;
}

/** Why no field value was found: every query failed, or CrUX answered without data. */
export function missingFieldReason(page: PageFacts | undefined, fallback = 'no-field-data'): string {
  const outcomes = [...Object.values(page?.crux?.url ?? {}), ...Object.values(page?.crux?.origin ?? {})];
  const answered = outcomes.some(outcome => outcome?.status === 'ok' || outcome?.status === 'no-data');
  return !answered && outcomes.some(outcome => outcome?.status === 'error') ? 'crux-error' : fallback;
}

export function p75(field: FieldRecord | undefined, metric: string): number | undefined {
  return field?.record.metrics[metric]?.p75;
}

export type Band = 'good' | 'needs-improvement' | 'poor';

export function band(value: number, good: number, poor: number): Band {
  if (value <= good) return 'good';
  return value <= poor ? 'needs-improvement' : 'poor';
}

export function bandLabel(value: Band): string {
  return value === 'needs-improvement' ? 'needs improvement' : value;
}

export function scopeLabel(field: FieldRecord): string {
  return field.scope === 'url' ? 'URL-level' : 'origin-level';
}

export function fieldEvidence(evidence: EvidenceStore, field: FieldRecord, metric: string, excerpt: string): string {
  const { record } = field;
  const { first, last } = record.collectionPeriod;
  const facts = { metric, formFactor: record.formFactor, scope: scopeLabel(field) };
  return evidence.add({
    kind: 'crux',
    url: record.key,
    label: first && last ? evidenceLabel('CrUX {metric}, {formFactor}, {scope}, {first} to {last}', { ...facts, first, last }) : evidenceLabel('CrUX {metric}, {formFactor}, {scope}', facts),
    excerpt: record.normalizedUrl && record.normalizedUrl !== record.key ? `${excerpt} (CrUX matched ${record.normalizedUrl})` : excerpt,
    path: `metrics.${metric}`,
  });
}

// Documents.

export interface ElementInfo {
  readonly element: HtmlElement;
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly line: number;
  readonly inHead: boolean;
}

/** Every element of a parsed document, in document order. */
export function elements(doc: DocumentFacts | undefined): ElementInfo[] {
  const found: ElementInfo[] = [];
  if (!doc) return found;
  walk(doc.parsed.document, (node, inHead) => {
    if (!isElement(node)) return;
    const attrs: Record<string, string> = {};
    for (const attr of node.attrs) if (!(attr.name in attrs)) attrs[attr.name] = attr.value;
    found.push({ element: node, tag: node.tagName, attrs, line: node.sourceCodeLocation?.startLine ?? 0, inHead });
  });
  return found;
}

export function textContent(element: HtmlElement): string {
  return element.childNodes.map(child => (child.nodeName === '#text' ? (child as unknown as { value: string }).value : '')).join('');
}

/** Opening tag of an element as written, for evidence excerpts. */
export function openingTag(info: Pick<ElementInfo, 'tag' | 'attrs'>): string {
  const attrs = Object.entries(info.attrs).map(([name, value]) => (value === '' ? name : `${name}="${value}"`));
  return `<${[info.tag, ...attrs].join(' ')}>`;
}

const sizeParams = new Set(['w', 'width', 'h', 'height', 'q', 'quality', 'dpr', 'fit', 'auto', 'fm', 'format', 'crop', 'resize']);

/** A URL compared without fragment and without image-CDN size parameters, so srcset variants match. */
export function comparableUrl(href: string | undefined, base: string): string | undefined {
  const absolute = absoluteUrl(href, base);
  if (!absolute) return undefined;
  const url = new URL(absolute);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (sizeParams.has(key.toLowerCase())) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

/** URLs of a srcset, parsed as HTML does: a URL never ends in a comma, and descriptors run to the next comma. */
export function srcsetUrls(srcset: string | undefined): string[] {
  const urls: string[] = [];
  let rest = srcset ?? '';
  while (rest.length > 0) {
    rest = rest.replace(/^[\s,]+/u, '');
    const url = /^\S+/u.exec(rest)?.[0];
    if (!url) break;
    rest = rest.slice(url.length);
    const trimmed = url.replace(/,+$/u, '');
    if (trimmed.length < url.length) {
      urls.push(trimmed);
      continue;
    }
    urls.push(url);
    const comma = rest.indexOf(',');
    rest = comma === -1 ? '' : rest.slice(comma + 1);
  }
  return urls.filter(Boolean);
}

export interface LcpTarget {
  readonly source: 'lighthouse' | 'user-render' | 'rendered';
  readonly selector?: string;
  readonly snippet?: string;
  readonly url?: string;
  readonly tag?: string;
}

/**
 * The lab LCP element: Lighthouse's node when it reported one, completed with the URL and tag that the phone-sized
 * user render observed, which match Lighthouse's mobile viewport better than the tall Googlebot render.
 */
export function lcpTarget(page: PageFacts): LcpTarget | undefined {
  const summary = labOf(page);
  const node = nodeOf(auditOf(summary, 'lcp-breakdown-insight')?.details) ?? nodeOf(auditOf(summary, 'lcp-discovery-insight')?.details);
  const observed = page.userRender?.result.error === undefined ? page.userRender?.result.lcp : undefined;
  const fallback = page.rendered?.result.error === undefined ? page.rendered?.result.lcp : undefined;
  const render = observed ?? fallback;
  const source = node ? 'lighthouse' : observed ? 'user-render' : fallback ? 'rendered' : undefined;
  if (!source) return undefined;
  const snippetTag = node?.snippet ? /^<([a-z][a-z0-9-]*)/iu.exec(node.snippet)?.[1]?.toLowerCase() : undefined;
  const tag = snippetTag ?? render?.tag;
  const selector = node?.selector ?? render?.selector;
  return {
    source,
    ...(selector === undefined ? {} : { selector }),
    ...(node?.snippet === undefined ? {} : { snippet: node.snippet }),
    ...(render?.url === undefined ? {} : { url: render.url }),
    ...(tag === undefined ? {} : { tag }),
  };
}

// Consent and third-party markers.

/** Hosts of consent management platforms whose loader scripts are often synchronous by design. */
export const consentScriptHost = /(^|\.)(cookiebot\.com|cookielaw\.org|onetrust\.com|usercentrics\.eu|didomi\.io|privacy-center\.org|quantcast\.com|iubenda\.com|trustarc\.com|truste\.com|consensu\.org|cookieyes\.com|termly\.io|osano\.com|axept\.io|sourcepoint\.com|privacymanager\.io|cookie-script\.com|cookiefirst\.com|cookiehub\.net|consentmanager\.net|klaro\.org)$/iu;

export const consentEntity = /onetrust|cookiebot|usercentrics|didomi|quantcast|iubenda|trustarc|truste|cookieyes|termly|osano|axeptio|sourcepoint|consentmanager|cookiehub|cookiefirst|cookie-script|complianz|klaro/iu;

/** Ids and classes of consent dialogs injected by common platforms or written by hand. */
export const consentMarker = /onetrust|cybotcookiebot|cookiebot|usercentrics|didomi|qc-cmp|cmpbox|cookie-law-info|cky-consent|iubenda|termly|osano|truste|consent-banner|cookie-banner|cookie-consent|cookie-notice|cookies-banner|cookie-bar|cc-window|gdpr|sp_message_container|axeptio|cmp-container/iu;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isConsentScript(src: string | undefined, base: string): boolean {
  const absolute = absoluteUrl(src, base);
  return absolute !== undefined && consentScriptHost.test(hostOf(absolute));
}

export function markerOf(info: Pick<ElementInfo, 'attrs'>): string {
  return `${info.attrs.id ?? ''} ${info.attrs.class ?? ''}`;
}
