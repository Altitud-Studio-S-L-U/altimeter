import type { DefaultTreeAdapterTypes } from 'parse5';
import type { EvidenceKind, EvidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts, SiteFacts } from '../../core/facts.ts';
import { headerValue } from '../../fetch/http.ts';
import { attribute, collapse, isElement, type HtmlElement, type HtmlNode } from '../../parse/html.ts';
import type { StructuredNode } from '../../parse/structured-data.ts';
import type { RuleContext } from '../engine.ts';
import { absoluteUrl, directivesFor, documentBase, linksWithRel, metaProperty, pageDocument, robotsDirectives } from '../helpers.ts';

export interface CiteDetails {
  readonly excerpt?: string | undefined;
  readonly line?: number | undefined;
  readonly path?: string | undefined;
  readonly url?: string | undefined;
}

/** Records one observation for the page (or site) under evaluation and returns its evidence id. */
export function cite(context: RuleContext, kind: EvidenceKind, label: EvidenceLabel, details: CiteDetails = {}): string {
  const url = details.url ?? context.page?.fetch.finalUrl ?? context.site.origin;
  return context.evidence.add({
    kind,
    url,
    label,
    ...(details.excerpt === undefined ? {} : { excerpt: details.excerpt }),
    ...(details.line === undefined || details.line <= 0 ? {} : { line: details.line }),
    ...(details.path === undefined ? {} : { path: details.path }),
  });
}

export const notApplicable = (reason: string) => ({ outcome: 'not_applicable', reason }) as const;
export const notEvaluated = (reason: string) => ({ outcome: 'not_evaluated', reason }) as const;

export function normalizeText(text: string): string {
  return collapse(text.normalize('NFC')).toLowerCase();
}

/** Lowercase, accent-free text, for comparing words across spellings. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? [];
}

const stopwordList = `a an and are as at be by for from has have in is it its of on or that the this to was were will with your you our we
  how what why when where which who can more not all into about than then also
  el la los las un una unos unas y o de del al en con por para que se su sus es son lo como mas más muy sin sobre entre
  per amb els les uns i o d l que es són com més molt sense sobre entre al als dels des pel pels`;
export const stopwords: ReadonlySet<string> = new Set(fold(stopwordList).split(/\s+/u).filter(Boolean));

/** Content words (folded, without stopwords or one-character tokens). */
export function contentWords(text: string): string[] {
  return words(fold(text)).filter(word => word.length > 1 && !stopwords.has(word));
}

// ---------------------------------------------------------------------------------------------------------------
// Document structure

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;

function childNodes(node: HtmlNode): readonly HtmlNode[] {
  if (isElement(node) && node.tagName === 'template') return [];
  return 'childNodes' in node ? (node as ParentNode).childNodes : [];
}

export interface Visit {
  readonly element: HtmlElement;
  readonly ancestors: readonly HtmlElement[];
}

const htmlNamespace = 'http://www.w3.org/1999/xhtml';

/** Elements in document order with their ancestors; template contents are skipped. */
export function elements(root: HtmlNode, keep: (element: HtmlElement, ancestors: readonly HtmlElement[]) => boolean): Visit[] {
  const found: Visit[] = [];
  const visit = (node: HtmlNode, ancestors: HtmlElement[]) => {
    for (const child of childNodes(node)) {
      if (!isElement(child)) continue;
      if (keep(child, ancestors)) found.push({ element: child, ancestors: [...ancestors] });
      ancestors.push(child);
      visit(child, ancestors);
      ancestors.pop();
    }
  };
  visit(root, []);
  return found;
}

export const isHtmlElement = (element: HtmlElement) => element.namespaceURI === htmlNamespace;
export const lineOf = (element: HtmlElement) => element.sourceCodeLocation?.startLine ?? 0;

const overlayPattern = /cookie|consent|gdpr|onetrust|cookiebot|didomi|iubenda|usercentrics|cmp-banner|cc-window/iu;

/** A cookie banner, consent dialog or modal: never part of the page's own content. */
export function isOverlay(element: HtmlElement): boolean {
  const role = (attribute(element, 'role') ?? '').toLowerCase();
  if (element.tagName === 'dialog' || role === 'dialog' || role === 'alertdialog' || attribute(element, 'aria-modal') === 'true') return true;
  return overlayPattern.test(`${attribute(element, 'id') ?? ''} ${attribute(element, 'class') ?? ''}`);
}

/** Site-wide template regions: navigation, header, footer and sidebars. */
export function isTemplateRegion(element: HtmlElement): boolean {
  const role = (attribute(element, 'role') ?? '').toLowerCase();
  return ['nav', 'header', 'footer', 'aside'].includes(element.tagName) || ['navigation', 'banner', 'contentinfo', 'complementary'].includes(role);
}

export function isMainElement(element: HtmlElement): boolean {
  return element.tagName === 'main' || (attribute(element, 'role') ?? '').toLowerCase() === 'main';
}

export function isHiddenByMarkup(element: HtmlElement): boolean {
  return attribute(element, 'hidden') !== undefined || /display\s*:\s*none/iu.test(attribute(element, 'style') ?? '');
}

export const inMain = (ancestors: readonly HtmlElement[]) => ancestors.some(isMainElement);
export const inOverlay = (ancestors: readonly HtmlElement[]) => ancestors.some(isOverlay);
export const inTemplate = (ancestors: readonly HtmlElement[]) => ancestors.some(isTemplateRegion);

export function body(doc: DocumentFacts): HtmlElement | undefined {
  return elements(doc.parsed.document, element => element.tagName === 'body')[0]?.element;
}

/** Visible main landmarks: <main> or role=main elements without the hidden attribute. */
export function mainLandmarks(doc: DocumentFacts): Visit[] {
  return elements(doc.parsed.document, (element, ancestors) => isMainElement(element) && !isHiddenByMarkup(element)
    && !ancestors.some(ancestor => isMainElement(ancestor) || isHiddenByMarkup(ancestor)));
}

const skippedTags = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head', 'iframe', 'object', 'select', 'option']);
const interactiveTags = new Set(['a', 'button', 'label', 'input', 'select', 'option', 'summary']);
const codeTags = new Set(['code', 'pre', 'kbd', 'samp', 'blockquote', 'q', 'textarea']);
const blockTags = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'tr', 'table', 'section', 'article', 'blockquote',
  'pre', 'dd', 'dt', 'dl', 'figcaption', 'figure', 'header', 'footer', 'nav', 'main', 'aside', 'form', 'address', 'details', 'summary']);

export interface TextOptions {
  /** Leave out quotations and code samples. */
  readonly skipCode?: boolean;
  /** Leave out link, button and form-control text, which repeats in card grids by design. */
  readonly skipInteractive?: boolean;
  /** Read the whole body instead of the main content. */
  readonly wholeBody?: boolean;
}

/**
 * Text blocks of the page's own content: inside <main> when the page has one, otherwise the body without
 * navigation, header, footer and sidebars. Cookie banners, dialogs and hidden elements are always left out.
 */
export function contentBlocks(doc: DocumentFacts, options: TextOptions = {}): string[] {
  const root = body(doc);
  if (!root) return [];
  const mains = options.wholeBody ? [] : mainLandmarks(doc).map(visit => visit.element);
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = collapse(current.join(' '));
    if (text !== '') blocks.push(text);
    current = [];
  };
  const visit = (node: HtmlNode) => {
    if (node.nodeName === '#text') {
      current.push((node as TextNode).value);
      return;
    }
    if (!isElement(node)) return;
    if (skippedTags.has(node.tagName) || isOverlay(node) || isHiddenByMarkup(node)) return;
    if (options.skipCode && codeTags.has(node.tagName)) return;
    if (options.skipInteractive && interactiveTags.has(node.tagName)) return;
    if (mains.length === 0 && !options.wholeBody && isTemplateRegion(node)) return;
    const block = blockTags.has(node.tagName);
    if (block) flush();
    for (const child of childNodes(node)) visit(child);
    if (block) flush();
  };
  for (const start of mains.length > 0 ? mains : [root]) {
    visit(start);
    flush();
  }
  return blocks;
}

export function contentText(doc: DocumentFacts, options: TextOptions = {}): string {
  return contentBlocks(doc, options).join(' ');
}

/** Text of an element as a screen reader would name it: text, image alt, aria-label and SVG titles. */
export function accessibleName(element: HtmlElement): string {
  const label = attribute(element, 'aria-label')?.trim();
  if (label) return label;
  const parts: string[] = [];
  const visit = (node: HtmlNode) => {
    if (node.nodeName === '#text') parts.push((node as TextNode).value);
    if (!isElement(node)) return;
    if (node !== element && attribute(node, 'aria-hidden') === 'true') return;
    if (node !== element && attribute(node, 'aria-label')?.trim()) {
      parts.push(attribute(node, 'aria-label')!);
      return;
    }
    if (node.tagName === 'img' || (node.tagName === 'input' && (attribute(node, 'type') ?? '').toLowerCase() === 'image')) parts.push(attribute(node, 'alt') ?? '');
    if (node.tagName === 'svg') {
      const title = elements(node, child => child.tagName === 'title')[0]?.element;
      if (title) parts.push(textContent(title));
      return;
    }
    if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) return;
    for (const child of childNodes(node)) visit(child);
  };
  visit(element);
  return collapse(parts.join(' '));
}

export function textContent(element: HtmlElement): string {
  const parts: string[] = [];
  const visit = (node: HtmlNode) => {
    if (node.nodeName === '#text') parts.push((node as TextNode).value);
    for (const child of childNodes(node)) visit(child);
  };
  visit(element);
  return collapse(parts.join(' '));
}

/** Document <title> elements in the HTML namespace; titles inside inline SVG are accessible names, not titles. */
export function documentTitles(doc: DocumentFacts): Array<Visit & { readonly text: string; readonly inHead: boolean }> {
  return elements(doc.parsed.document, (element, ancestors) => element.tagName === 'title' && isHtmlElement(element)
    && !ancestors.some(ancestor => ancestor.tagName === 'svg'))
    .map(visit => ({ ...visit, text: collapse(textContent(visit.element)), inHead: visit.ancestors.some(ancestor => ancestor.tagName === 'head') }));
}

/** The title Google reads: the first non-empty document title. */
export function pageTitle(doc: DocumentFacts | undefined): { readonly text: string; readonly line: number } | undefined {
  const title = doc ? documentTitles(doc).find(entry => entry.text !== '') : undefined;
  return title ? { text: title.text, line: lineOf(title.element) } : undefined;
}

export function metaDescription(doc: DocumentFacts | undefined): { readonly text: string; readonly line: number } | undefined {
  const meta = doc?.parsed.metas.find(entry => (entry.attrs.name ?? '').toLowerCase() === 'description');
  return meta ? { text: collapse(meta.attrs.content ?? ''), line: meta.line } : undefined;
}

export function firstH1(doc: DocumentFacts | undefined): { readonly text: string; readonly line: number } | undefined {
  const heading = doc?.parsed.headings.find(entry => entry.level === 1 && entry.text !== '');
  return heading ? { text: heading.text, line: heading.line } : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Pages and the site

export function docOf(page: PageFacts): DocumentFacts | undefined {
  return pageDocument(page);
}

export type Indexability = { readonly indexable: true } | { readonly indexable: false; readonly reason: 'non-200' | 'noindex' | 'canonicalised' };

function withoutHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

/** Whether Google may index the page as its own canonical: 200, no noindex for Googlebot, self-canonical or none. */
export function indexability(page: PageFacts, doc: DocumentFacts | undefined = docOf(page)): Indexability {
  if (page.fetch.status !== 200) return { indexable: false, reason: 'non-200' };
  if (directivesFor(robotsDirectives(page.fetch.headers, doc)).has('noindex')) return { indexable: false, reason: 'noindex' };
  const canonical = absoluteUrl(linksWithRel(doc, 'canonical')[0]?.attrs.href, documentBase(doc, page.fetch.finalUrl));
  if (canonical && withoutHash(canonical) !== withoutHash(page.fetch.finalUrl)) return { indexable: false, reason: 'canonicalised' };
  return { indexable: true };
}

/** Audited pages Google may index, each with the document rules read. */
export function indexablePages(site: SiteFacts): Array<{ readonly page: PageFacts; readonly doc: DocumentFacts }> {
  const seen = new Set<string>();
  const result: Array<{ page: PageFacts; doc: DocumentFacts }> = [];
  for (const page of site.pages.values()) {
    const doc = docOf(page);
    if (!doc || seen.has(page.fetch.finalUrl) || !indexability(page, doc).indexable) continue;
    seen.add(page.fetch.finalUrl);
    result.push({ page, doc });
  }
  return result;
}

export function isHome(site: SiteFacts, page: PageFacts): boolean {
  if (page.pageType === 'home') return true;
  return site.homeUrl !== undefined && (page.url === site.homeUrl || page.fetch.finalUrl === site.homeUrl);
}

export function homePage(site: SiteFacts): PageFacts | undefined {
  const pages = [...site.pages.values()];
  return pages.find(page => site.homeUrl !== undefined && (page.url === site.homeUrl || page.fetch.finalUrl === site.homeUrl))
    ?? pages.find(page => page.pageType === 'home');
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  return [];
}

/** Names the site declares for itself: WebSite name and alternateName, then og:site_name. */
export function siteNames(site: SiteFacts): string[] {
  const names: string[] = [];
  for (const page of site.pages.values()) {
    const doc = docOf(page);
    if (!doc) continue;
    for (const node of doc.data.nodes.filter(entry => entry.types.includes('WebSite'))) {
      names.push(...stringValues(node.properties.name), ...stringValues(node.properties.alternateName));
    }
    for (const meta of metaProperty(doc, 'og:site_name')) names.push(meta.attrs.content ?? '');
  }
  return [...new Set(names.map(name => collapse(name)).filter(name => name.length >= 2))];
}

/** The moment the page was served, from its Date header; rules never read the local clock. */
export function servedAt(page: PageFacts): Date | undefined {
  const value = headerValue(page.fetch.headers, 'date');
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time);
}

export function nodesOf(doc: DocumentFacts, types: readonly string[]): StructuredNode[] {
  return doc.data.nodes.filter(node => node.types.some(type => types.includes(type)));
}

export function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(firstString).find(entry => entry !== undefined);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstString(record['@value'] ?? record.url ?? record['@id']);
  }
  return undefined;
}

/** Registrable domain, approximated without a public-suffix list: two labels, three under a short second level. */
export function registrableDomain(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (/^[\d.]+$/u.test(host) || host.includes(':')) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const second = labels.at(-2)!;
  const shortSecond = labels.at(-1)!.length === 2 && ['co', 'com', 'net', 'org', 'gov', 'gob', 'edu', 'ac', 'nom', 'or', 'ne'].includes(second);
  return labels.slice(shortSecond ? -3 : -2).join('.');
}

export function isExternal(href: string, base: string): boolean {
  const target = registrableDomain(href);
  return target !== undefined && /^https?:/u.test(href) && target !== registrableDomain(base);
}

/** Quotes a value for a message or excerpt, cut at a readable length. */
export function clip(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
