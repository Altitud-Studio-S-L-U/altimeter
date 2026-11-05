import type { EvidenceLabel, NewEvidence } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts, SiteFacts } from '../../core/facts.ts';
import type { NotEvaluatedReason, Severity } from '../../core/types.ts';
import { headerValue, type HeaderMap } from '../../fetch/http.ts';
import { isElement, walk, type HtmlElement } from '../../parse/html.ts';
import type { LighthouseAudit, LighthouseSummary } from '../../render/lighthouse.ts';
import type { RuleContext, RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';

export type Cite = (entry: CiteEntry) => string;

export interface CiteEntry {
  readonly kind: NewEvidence['kind'];
  readonly label: EvidenceLabel;
  readonly url?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly line?: number | undefined;
  readonly path?: string | undefined;
}

/** Records evidence, leaving out members that are unknown so optional fields stay absent. */
export function citer(context: RuleContext): Cite {
  return entry => {
    const clean: Record<string, unknown> = { kind: entry.kind, label: entry.label };
    if (entry.url !== undefined) clean.url = entry.url;
    if (entry.excerpt !== undefined) clean.excerpt = entry.excerpt;
    if (entry.line !== undefined && entry.line > 0) clean.line = entry.line;
    if (entry.path !== undefined) clean.path = entry.path;
    return context.evidence.add(clean as unknown as NewEvidence);
  };
}

export function fail(severity: Severity, evidence: readonly string[], reason?: string, params?: Readonly<Record<string, string | number>>, needsJudgment = false): RuleResult {
  return {
    outcome: 'fail',
    severity,
    evidence,
    ...(reason === undefined ? {} : { reason }),
    ...(params === undefined ? {} : { params }),
    ...(needsJudgment ? { needsJudgment: true } : {}),
  };
}

export const pass = (evidence: readonly string[] = []): RuleResult => (evidence.length > 0 ? { outcome: 'pass', evidence } : { outcome: 'pass' });
export const notApplicable = (reason: string): RuleResult => ({ outcome: 'not_applicable', reason });
export const notEvaluated = (reason: NotEvaluatedReason): RuleResult => ({ outcome: 'not_evaluated', reason });

const order: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function worst(values: readonly Severity[]): Severity {
  return values.reduce<Severity>((current, value) => (order.indexOf(value) < order.indexOf(current) ? value : current), 'info');
}

export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Loopback hosts are potentially trustworthy origins, so requests to them are never mixed content. */
export function isLoopback(url: string): boolean {
  const host = hostOf(url);
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || (host?.endsWith('.localhost') ?? false);
}

export function firstHeader(headers: HeaderMap, name: string): string | undefined {
  return headerValue(headers, name);
}

/** Pages with a received response, in a stable order: the home page first. */
export function auditedPages(site: SiteFacts): PageFacts[] {
  const pages = [...site.pages.values()].filter(page => page.fetch.status !== undefined);
  return pages.sort((a, b) => Number(b.fetch.finalUrl === site.homeUrl) - Number(a.fetch.finalUrl === site.homeUrl));
}

export function homePage(site: SiteFacts): PageFacts | undefined {
  const pages = [...site.pages.values()];
  return pages.find(page => page.fetch.finalUrl === site.homeUrl) ?? pages.find(page => page.pageType === 'home');
}

/** Elements with a given tag anywhere in a parsed document, including inside templates. */
export function elements(doc: DocumentFacts, tags: readonly string[]): HtmlElement[] {
  const found: HtmlElement[] = [];
  walk(doc.parsed.document, node => {
    if (isElement(node) && tags.includes(node.tagName)) found.push(node);
  });
  return found;
}

export function attr(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find(entry => entry.name === name)?.value;
}

export function lineOf(element: HtmlElement): number | undefined {
  return element.sourceCodeLocation?.startLine;
}

/** The serialized start tag of an element as it appears in the source, for evidence. */
export function startTag(doc: DocumentFacts, element: HtmlElement): string {
  const location = element.sourceCodeLocation?.startTag;
  if (location && location.endOffset > location.startOffset) return doc.html.slice(location.startOffset, location.endOffset);
  return `<${element.tagName}${element.attrs.map(entry => ` ${entry.name}="${entry.value}"`).join('')}>`;
}

export function wordCount(text: string): number {
  return text.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}

export function lighthouseSummary(page: PageFacts): LighthouseSummary | undefined {
  return page.lighthouse?.ok === true ? page.lighthouse.summary : undefined;
}

export function auditFailed(audit: LighthouseAudit | undefined): boolean {
  return audit !== undefined && audit.score === 0 && (audit.scoreDisplayMode === 'binary' || audit.scoreDisplayMode === 'numeric' || audit.scoreDisplayMode === 'metricSavings');
}

export function detailItems(audit: LighthouseAudit | undefined): readonly Record<string, unknown>[] {
  const items = (audit?.details as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object') : [];
}

/** Parses `a=1, b=2` (commas or semicolons) into lowercase keys with trimmed values. */
export function keyValues(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of content.split(/[,;]/u)) {
    const [key, ...rest] = part.split('=');
    const name = (key ?? '').trim().toLowerCase();
    if (name !== '') result.set(name, rest.join('=').trim().toLowerCase());
  }
  return result;
}

/** Hosts whose requests only measure or advertise; their failures do not affect what a page shows. */
const measurementHosts = /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|facebook\.net|connect\.facebook\.net|hotjar\.com|hotjar\.io|clarity\.ms|bing\.com|bat\.bing\.com|linkedin\.com|licdn\.com|snap\.licdn\.com|tiktok\.com|analytics\.tiktok\.com|segment\.io|segment\.com|mixpanel\.com|amplitude\.com|plausible\.io|matomo\.cloud|newrelic\.com|nr-data\.net|sentry\.io|datadoghq\.com|criteo\.com|criteo\.net|taboola\.com|outbrain\.com|adsrvr\.org|quantserve\.com|scorecardresearch\.com|yandex\.ru|mc\.yandex\.ru)$/u;

export function isMeasurementUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === undefined) return false;
  if (measurementHosts.test(host)) return true;
  try {
    const path = new URL(url).pathname;
    return /\/(collect|g\/collect|gtag\/js|gtm\.js|analytics\.js|pixel|beacon)\b/u.test(path);
  } catch {
    return false;
  }
}

export function shorten(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

export function summarizeUrls(urls: readonly string[], max = 3): string {
  return summarizeList([...new Set(urls)], max);
}
