import type { PageFacts, SiteFacts } from '../../core/facts.ts';
import { severities, type Severity } from '../../core/types.ts';
import { headerValue } from '../../fetch/http.ts';
import { isAllowed } from '../../fetch/robots.ts';
import type { RuleContext, RuleResult } from '../engine.ts';
import { absoluteUrl, summarizeList } from '../helpers.ts';
import { excerptOf, graphOf, propertyPath, texts, topLevel, values, type GraphNode, type PageGraph } from './graph.ts';
import { isA } from './vocabulary.ts';

/** Records a structured data observation and returns its evidence id. */
export function cite(context: RuleContext, graph: PageGraph, node: GraphNode, label: string, property?: string, excerpt?: string): string {
  const where = graph.source === 'rendered' ? 'rendered DOM' : 'raw HTML';
  return context.evidence.add({
    kind: 'structured-data',
    url: graph.base,
    label: `${label} (${where})`,
    excerpt: excerpt ?? excerptOf(node, property),
    line: node.line,
    path: property === undefined ? node.path : propertyPath(node, property),
  });
}

export function worst(values: readonly Severity[]): Severity {
  return [...values].sort((a, b) => severities.indexOf(a) - severities.indexOf(b))[0] ?? 'info';
}

export interface Problem {
  readonly reason: string;
  readonly severity: Severity;
  readonly evidence: string;
  /** What the problem is about, for the message: a type, property or value. */
  readonly subject: string;
  readonly needsJudgment?: boolean;
  /** Further evidence for the same problem, such as the other side of a conflict. */
  readonly also?: readonly string[];
}

/**
 * Groups problems into one failure per reason, each carrying the count and a short list of subjects.
 * No problems means the rule passed.
 */
export function report(problems: readonly Problem[], passEvidence: readonly string[] = []): RuleResult[] {
  if (problems.length === 0) return [{ outcome: 'pass', evidence: passEvidence }];
  const byReason = new Map<string, Problem[]>();
  for (const problem of problems) byReason.set(problem.reason, [...(byReason.get(problem.reason) ?? []), problem]);
  return [...byReason].map(([reason, group]) => ({
    outcome: 'fail' as const,
    reason,
    severity: worst(group.map(problem => problem.severity)),
    evidence: [...new Set(group.flatMap(problem => [problem.evidence, ...(problem.also ?? [])]))].slice(0, 20),
    params: { count: group.length, items: summarizeList([...new Set(group.map(problem => problem.subject))]) },
    ...(group.every(problem => problem.needsJudgment) ? { needsJudgment: true } : {}),
  }));
}

/** The graph of the page under evaluation, or a not-applicable result when the page carries no markup at all. */
export function pageGraph(context: RuleContext): PageGraph | RuleResult {
  const graph = graphOf(context.page!);
  if (!graph) return { outcome: 'not_evaluated', reason: 'no-document' };
  return graph;
}

export function isResult(value: unknown): value is RuleResult {
  return typeof value === 'object' && value !== null && 'outcome' in value;
}

/** Nodes of a type (or a subtype) whose context is schema.org. */
export function nodesOfType(graph: PageGraph, type: string, options: { readonly topOnly?: boolean } = {}): GraphNode[] {
  return (options.topOnly ? topLevel(graph) : graph.nodes).filter(node => node.schemaOrg && isA(node.types, type));
}

/**
 * A rule over every node of a type: not applicable when the page has none, otherwise the grouped problems that
 * `check` finds in each node.
 */
export function perNode(context: RuleContext, type: string | readonly string[], reasonWhenNone: string,
  check: (graph: PageGraph, node: GraphNode) => Problem[],
  options: { readonly topOnly?: boolean; readonly select?: (graph: PageGraph, node: GraphNode) => boolean } = {}): RuleResult[] | RuleResult {
  const graph = pageGraph(context);
  if (isResult(graph)) return graph;
  const wanted = [type].flat();
  const nodes = [...new Set(wanted.flatMap(entry => nodesOfType(graph, entry, options)))].filter(node => options.select?.(graph, node) ?? true);
  if (nodes.length === 0) return { outcome: 'not_applicable', reason: reasonWhenNone };
  return report(nodes.flatMap(node => check(graph, node)), nodes.slice(0, 3).map(node => cite(context, graph, node, `${node.types.join(', ')} node`)));
}

/** A parsed ISO 8601 date or date-time, with how precise it is. */
export interface IsoDate {
  readonly time: number;
  readonly precision: 'year' | 'month' | 'day' | 'time';
  readonly offset: boolean;
  /** YYYY-MM-DD as written, for day-level comparisons. */
  readonly day: string | undefined;
}

const datePattern = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?)?)?$/u;

function validCalendar(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Parses the ISO 8601 forms structured data uses: YYYY, YYYY-MM, YYYY-MM-DD and date-times with an optional offset. */
export function parseIsoDate(value: string): IsoDate | undefined {
  const match = datePattern.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, zone] = match;
  const year = Number(y);
  const month = mo === undefined ? 1 : Number(mo);
  const day = d === undefined ? 1 : Number(d);
  if (month < 1 || month > 12 || !validCalendar(year, month, day)) return undefined;
  if (h !== undefined && (Number(h) > 24 || Number(mi) > 59 || Number(s ?? 0) > 60)) return undefined;
  const precision = d === undefined ? (mo === undefined ? 'year' : 'month') : h === undefined ? 'day' : 'time';
  let time = Date.UTC(year, month - 1, day, Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    time -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0)) * 60_000;
  }
  return { time, precision, offset: zone !== undefined, day: d === undefined ? undefined : `${y}-${mo}-${d}` };
}

/**
 * Whether `later` is certainly before `earlier`. Dates of different precision compare at the coarser one, and a
 * value without an offset is allowed the widest time zone spread, so the order is only reported when it holds in
 * every reading.
 */
export function certainlyBefore(later: IsoDate, earlier: IsoDate): boolean {
  if (later.precision !== 'time' || earlier.precision !== 'time') {
    if (later.day === undefined || earlier.day === undefined) return false;
    return later.day < earlier.day;
  }
  const slack = later.offset && earlier.offset ? 0 : 26 * 3_600_000;
  return later.time + slack < earlier.time;
}

/** The time the page was fetched, from the server's Date header, so date rules never read the local clock. */
export function fetchTime(page: PageFacts): number | undefined {
  const value = headerValue(page.fetch.headers, 'date');
  const time = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

export function hostOf(url: string | undefined, base?: string): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url.trim(), base).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Host comparison that treats www and m as the same site, as Google's site-name documentation does. */
export function sameHost(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const strip = (host: string) => host.replace(/^(?:www|m)\./u, '');
  return strip(a) === strip(b);
}

/** Parses a JSON number or a plain decimal string; anything with symbols, spaces or separators is rejected. */
export function plainNumber(value: string): number | undefined {
  const trimmed = value.trim();
  return /^-?\d+(?:\.\d+)?$/u.test(trimmed) ? Number(trimmed) : undefined;
}

/** Every page the collector parsed, audited pages first, then the siblings fetched for template comparison. */
export function sitePages(site: SiteFacts): PageFacts[] {
  const seen = new Set<string>();
  return [...site.pages.values(), ...site.siblings].filter(page => {
    if (seen.has(page.fetch.finalUrl)) return false;
    seen.add(page.fetch.finalUrl);
    return page.raw !== undefined;
  });
}

/** The home page Googlebot reaches: the final URL of the root after redirects. */
export function homePage(site: SiteFacts): PageFacts | undefined {
  const pages = sitePages(site);
  if (site.homeUrl) {
    const match = pages.find(page => page.fetch.finalUrl === site.homeUrl || page.url === site.homeUrl);
    if (match) return match;
  }
  return pages.find(page => page.pageType === 'home');
}

export const normalizeName = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** URLs an image property points to: text values, or the url/contentUrl of ImageObject nodes. */
export function imageUrls(graph: PageGraph, node: GraphNode, property: string): string[] {
  return values(graph, node, property).flatMap(value => {
    if (value.kind === 'text') return [value.value];
    if (value.kind === 'node') return [...texts(graph, value.node, 'contentUrl'), ...texts(graph, value.node, 'url')];
    return [];
  }).map(url => absoluteUrl(url, graph.base)).filter((url): url is string => url !== undefined);
}

/** The robots.txt rule that blocks an image for Googlebot-Image, for images on the audited origin. */
export function blockedForImages(site: SiteFacts, url: string): string | undefined {
  const robots = site.robots?.availability;
  if (robots?.kind !== 'parsed') return undefined;
  const parsed = new URL(url);
  if (parsed.origin !== site.origin) return undefined;
  const decision = isAllowed(robots.file, ['googlebot-image', 'googlebot'], `${parsed.pathname}${parsed.search}`);
  return decision.allowed ? undefined : `${decision.rule?.type ?? 'disallow'}: ${decision.rule?.pattern ?? ''} (line ${decision.rule?.line ?? 0})`;
}

