import type { DefaultTreeAdapterTypes } from 'parse5';
import { linkGraph } from '../analyze/graph.ts';
import { tagText } from '../analyze/tag-text.ts';
import { maxExcerptLength, type EvidenceItem, type EvidenceKind } from '../core/evidence.ts';
import type { DocumentFacts, PageFacts, SiteFacts } from '../core/facts.ts';
import type { PageType } from '../core/types.ts';
import { isElement } from '../parse/html.ts';
import { absoluteUrl, hreflangLinks, linksWithRel, metaNamed, metaProperty, pageDocument, sameSite } from '../rules/helpers.ts';
import { cleanText } from '../report/sanitize.ts';
import { cleanDisplay, factIndex, fold, middleDot, normalizeText, type FactIndex } from './text.ts';
import type { InjectionCandidate } from './types.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export type SliceName = 'metadata' | 'headings' | 'text' | 'hidden-text' | 'images' | 'links' | 'structured-data' | 'hreflang' | 'http';

/** One string copied from the site, with an id the model cites. Ids start with A so they never collide with E ids. */
export interface SiteItem {
  readonly id: string;
  readonly page: string;
  readonly slice: SliceName;
  readonly kind: EvidenceKind;
  /** Neutral description written by Altimeter. */
  readonly label: string;
  /** Exactly what the site returned, for the injection rules and the report. */
  readonly original: string;
  /** What the model sees: control characters and invisible format characters removed, bounded. */
  readonly text: string;
  readonly url: string;
  readonly href?: string;
  readonly path?: string;
  readonly line?: number;
  readonly hidden?: string;
  readonly complete: boolean;
  /** Whether people see the text on the page; alt text, JSON-LD and hidden elements are not seen. */
  readonly visible: boolean;
}

export interface SiteSlice {
  /** Cited by claims that something is absent from the slice. */
  readonly id: string;
  readonly page: string;
  readonly name: SliceName;
  readonly items: readonly string[];
  /** False when items were left out or cut, so the slice cannot support a claim that something is absent. */
  readonly complete: boolean;
}

export type PageRole = 'audited' | 'home' | 'important' | 'context';

export interface PageInfo {
  /** The page's key in the collected facts (the requested URL). */
  readonly key: string;
  /** P1, P2 and so on, so trusted text can refer to a page without repeating its URL. */
  readonly label: string;
  readonly url: string;
  readonly finalUrl: string;
  readonly pageType: PageType;
  readonly pageTypeReason: string;
  readonly role: PageRole;
  /** The html lang attribute, kept only when it is a well-formed language tag. */
  readonly language?: string;
}

export interface SiteStrings {
  /** Analysed pages first, then context pages that only contribute their metadata. */
  readonly pages: readonly PageInfo[];
  readonly items: ReadonlyMap<string, SiteItem>;
  readonly slices: readonly SiteSlice[];
}

const sliceLimits: Readonly<Record<SliceName, number>> = {
  metadata: 20, headings: 80, text: 150, 'hidden-text': 40, images: 40, links: 100, 'structured-data': 10, hreflang: 60, http: 10,
};

const languageTag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

function auditable(page: PageFacts): boolean {
  const status = page.fetch.status;
  return !page.notAuditable && page.raw !== undefined && status !== undefined && status >= 200 && status < 300;
}

/**
 * The pages worth a model's time, at most `count`: the audited page, the home page, then the pages most linked
 * from the other audited pages (ties go to the shallower page, then to URL order).
 */
export function selectPages(site: SiteFacts, count: number): PageFacts[] {
  const all = [...site.pages.values()];
  const chosen: PageFacts[] = [];
  const add = (page: PageFacts | undefined) => {
    if (page && auditable(page) && !chosen.includes(page) && chosen.length < count) chosen.push(page);
  };
  add(all[0]);
  const isRoot = (url: string) => {
    try {
      return new URL(url).pathname === '/';
    } catch {
      return false;
    }
  };
  add(all.find(page => site.homeUrl !== undefined && (page.fetch.finalUrl === site.homeUrl || page.url === site.homeUrl)) ?? all.find(page => isRoot(page.url)));
  const graph = linkGraph(site);
  const ranked = all.filter(page => !chosen.includes(page)).map(page => ({
    page,
    inlinks: new Set((graph.inlinks.get(page.fetch.finalUrl) ?? []).map(edge => edge.from)).size,
    depth: graph.depth.get(page.fetch.finalUrl) ?? Number.POSITIVE_INFINITY,
  }));
  ranked.sort((a, b) => b.inlinks - a.inlinks || a.depth - b.depth || a.page.url.localeCompare(b.page.url));
  for (const entry of ranked) add(entry.page);
  return chosen;
}

const skippedTags = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head', 'iframe', 'object', 'canvas', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const inlineTags = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark',
  'meter', 'nobr', 'output', 'picture', 'progress', 'q', 's', 'samp', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);

function childNodes(node: Node): readonly Node[] {
  return 'childNodes' in node ? (node as DefaultTreeAdapterTypes.ParentNode).childNodes : [];
}

/** Paragraph-level text: each block element with the text of its inline content, in document order. */
function blockTexts(doc: DocumentFacts): Array<{ tag: string; text: string; line: number }> {
  const parts = new Map<Element, string[]>();
  const visit = (node: Node, block: Element | undefined) => {
    for (const child of childNodes(node)) {
      if (child.nodeName === '#text') {
        if (block) parts.get(block)!.push((child as DefaultTreeAdapterTypes.TextNode).value);
        continue;
      }
      if (!isElement(child) || skippedTags.has(child.tagName)) continue;
      if (child.tagName === 'br' && block) parts.get(block)!.push(' ');
      const next = inlineTags.has(child.tagName) && block ? block : child;
      if (!parts.has(next)) parts.set(next, []);
      visit(child, next);
    }
  };
  visit(doc.parsed.document, undefined);
  return [...parts].map(([element, texts]) => ({ tag: element.tagName, text: texts.join('').replace(/\s+/gu, ' ').trim(), line: element.sourceCodeLocation?.startLine ?? 0 }))
    .filter(entry => entry.text.length >= 2);
}

interface ItemSpec {
  readonly slice: SliceName;
  readonly kind: EvidenceKind;
  readonly label: string;
  readonly original: string;
  readonly href?: string;
  readonly path?: string;
  readonly line?: number;
  readonly hidden?: string;
  readonly visible: boolean;
  readonly maxLength?: number;
}

class Registry {
  readonly items = new Map<string, SiteItem>();
  readonly slices: SiteSlice[] = [];
  #next = 1;

  addSlice(page: PageInfo, name: SliceName, specs: readonly ItemSpec[]): void {
    const limit = sliceLimits[name];
    const sliceId = `A${this.#next++}`;
    const ids: string[] = [];
    let complete = specs.length <= limit;
    for (const spec of specs.slice(0, limit)) {
      const maxLength = spec.maxLength ?? maxExcerptLength;
      const cleaned = cleanText(spec.original, Number.MAX_SAFE_INTEGER);
      const cut = cleaned.length > maxLength;
      if (cut) complete = false;
      const id = `A${this.#next++}`;
      this.items.set(id, {
        id,
        page: page.key,
        slice: name,
        kind: spec.kind,
        label: spec.label,
        original: spec.original,
        text: cut ? cleaned.slice(0, maxLength) : cleaned,
        url: page.finalUrl,
        ...(spec.href === undefined ? {} : { href: cleanText(spec.href, 2000) }),
        ...(spec.path === undefined ? {} : { path: cleanText(spec.path, 300) }),
        ...(spec.line ? { line: spec.line } : {}),
        ...(spec.hidden ? { hidden: spec.hidden } : {}),
        complete: !cut,
        visible: spec.visible,
      });
      ids.push(id);
    }
    this.slices.push({ id: sliceId, page: page.key, name, items: ids, complete });
  }
}

function metadataSpecs(doc: DocumentFacts | undefined, base: string): ItemSpec[] {
  if (!doc) return [];
  const specs: ItemSpec[] = [];
  for (const title of doc.parsed.titles) specs.push({ slice: 'metadata', kind: 'html', label: title.inHead ? 'title element' : 'title element outside the head', original: title.text, line: title.line, visible: true });
  for (const meta of metaNamed(doc, 'description')) specs.push({ slice: 'metadata', kind: 'html', label: 'meta description', original: meta.attrs.content ?? '', line: meta.line, visible: false });
  for (const property of ['og:title', 'og:description', 'og:site_name', 'og:locale']) {
    for (const meta of metaProperty(doc, property)) specs.push({ slice: 'metadata', kind: 'html', label: `${property} meta property`, original: meta.attrs.content ?? '', line: meta.line, visible: false });
  }
  if (doc.parsed.htmlLang !== undefined) specs.push({ slice: 'metadata', kind: 'html', label: 'html lang attribute', original: doc.parsed.htmlLang, visible: false });
  const canonical = linksWithRel(doc, 'canonical')[0];
  if (canonical?.attrs.href !== undefined) {
    specs.push({ slice: 'metadata', kind: 'html', label: 'canonical link', original: canonical.attrs.href, href: absoluteUrl(canonical.attrs.href, base) ?? canonical.attrs.href, line: canonical.line, visible: false });
  }
  return specs;
}

function textSpecs(doc: DocumentFacts, page: PageFacts): { text: ItemSpec[]; hidden: ItemSpec[] } {
  const rendered = page.rendered && page.rendered.result.error === undefined ? page.rendered.result.textBlocks : [];
  const hiddenBlocks = rendered.filter(block => block.hidden !== undefined);
  const shown = new Set(rendered.filter(block => block.hidden === undefined).map(block => fold(block.text)));
  const hiddenOnly = new Set(hiddenBlocks.map(block => fold(block.text)).filter(text => !shown.has(text)));
  const text = blockTexts(doc).map(block => ({
    slice: 'text' as const, kind: 'text' as const, label: `${block.tag} text`, original: block.text, path: block.tag, line: block.line,
    visible: !hiddenOnly.has(fold(block.text)),
  }));
  const hidden = hiddenBlocks.map(block => ({
    slice: 'hidden-text' as const, kind: 'render' as const, label: `text hidden by ${block.hidden}${block.inMain ? ' inside main' : ''}`,
    original: block.text, path: block.selector, hidden: block.hidden!, visible: false,
  }));
  return { text, hidden };
}

function imageSpecs(doc: DocumentFacts, base: string): ItemSpec[] {
  return doc.parsed.images.map(image => {
    const alt = image.attrs.alt;
    const label = alt === undefined ? 'img without an alt attribute' : alt.trim() === '' ? 'img with empty alt (decorative)' : 'img alt text';
    const src = image.attrs.src ?? image.attrs['data-src'];
    return { slice: 'images' as const, kind: 'html' as const, label, original: alt ?? '', ...(src ? { href: absoluteUrl(src, base) ?? src } : {}), line: image.line, visible: false };
  });
}

function linkSpecs(doc: DocumentFacts, base: string): ItemSpec[] {
  const specs: ItemSpec[] = [];
  for (const anchor of doc.parsed.anchors) {
    const href = absoluteUrl(anchor.attrs.href, base);
    if (!href || !/^(?:https?|mailto|tel):/iu.test(href)) continue;
    const where = /^https?:/iu.test(href) && sameSite(href, base) ? 'internal' : 'outbound';
    const rel = anchor.rel.filter(entry => ['nofollow', 'sponsored', 'ugc'].includes(entry));
    specs.push({ slice: 'links', kind: 'html', label: `${where} link${rel.length ? ` (rel ${rel.join(' ')})` : ''}`, original: anchor.text || anchor.imageAlt, href, line: anchor.line, visible: true });
  }
  return specs;
}

function structuredSpecs(doc: DocumentFacts): ItemSpec[] {
  const specs: ItemSpec[] = doc.data.jsonLd.map(block => ({
    slice: 'structured-data' as const, kind: 'structured-data' as const, label: block.error ? 'JSON-LD block that does not parse' : 'JSON-LD block',
    original: block.value === undefined ? block.raw : JSON.stringify(block.value), path: `jsonld[${block.index}]`, line: block.line, visible: false, maxLength: 6000,
  }));
  for (const node of doc.data.nodes.filter(entry => entry.syntax === 'microdata' && !entry.nested)) {
    specs.push({ slice: 'structured-data', kind: 'structured-data', label: 'microdata item', original: JSON.stringify({ '@type': node.types, ...node.properties }), path: node.path, line: node.line, visible: false, maxLength: 6000 });
  }
  return specs;
}

function httpSpecs(page: PageFacts): ItemSpec[] {
  const specs: ItemSpec[] = [];
  for (const name of ['content-language', 'content-type', 'x-robots-tag', 'link']) {
    for (const value of page.fetch.headers[name] ?? []) specs.push({ slice: 'http', kind: 'header', label: `response header ${name}`, original: value, visible: false });
  }
  return specs;
}

function pageInfo(page: PageFacts, label: string, role: PageRole): PageInfo {
  const lang = (pageDocument(page) ?? page.raw)?.parsed.htmlLang?.trim();
  return {
    key: page.url,
    label,
    url: page.url,
    finalUrl: page.fetch.finalUrl,
    pageType: page.pageType,
    pageTypeReason: page.pageTypeReason,
    role,
    ...(lang && languageTag.test(lang) ? { language: lang } : {}),
  };
}

/**
 * Every page the collector fetched: the audited pages, the siblings and the audited page's hreflang alternates.
 * All of them count for title uniqueness and known links, and the alternates a page lists can be compared with it.
 * Owner data (site.owner) is deliberately never read by the analysis.
 */
export function fetchedPages(site: SiteFacts): PageFacts[] {
  const seen = new Set<string>();
  const result: PageFacts[] = [];
  for (const page of [...site.pages.values(), ...site.siblings, ...(site.alternates ?? [])]) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    result.push(page);
  }
  return result;
}

/**
 * Copies every site string the analysis may show a model into one registry: metadata, headings, block text,
 * hidden text, image alt text, links, structured data, hreflang annotations and language headers for the
 * analysed pages, and the metadata of every other collected page for uniqueness checks.
 */
export function collectSiteStrings(site: SiteFacts, analysed: readonly PageFacts[]): SiteStrings {
  const registry = new Registry();
  const pages: PageInfo[] = [];
  const homeUrl = site.homeUrl;
  analysed.forEach((page, index) => {
    const role: PageRole = index === 0 ? 'audited' : page.fetch.finalUrl === homeUrl || page.url === homeUrl ? 'home' : 'important';
    const info = pageInfo(page, `P${pages.length + 1}`, role);
    pages.push(info);
    const doc = pageDocument(page);
    const base = page.fetch.finalUrl;
    registry.addSlice(info, 'metadata', metadataSpecs(doc, base));
    if (!doc) return;
    registry.addSlice(info, 'headings', doc.parsed.headings.map(heading => ({ slice: 'headings', kind: 'html', label: `h${heading.level} heading`, original: heading.text, line: heading.line, visible: true })));
    const { text, hidden } = textSpecs(doc, page);
    registry.addSlice(info, 'text', text);
    if (hidden.length > 0) registry.addSlice(info, 'hidden-text', hidden);
    registry.addSlice(info, 'images', imageSpecs(doc, base));
    registry.addSlice(info, 'links', linkSpecs(doc, base));
    registry.addSlice(info, 'structured-data', structuredSpecs(doc));
    const hreflang = hreflangLinks(page.raw, base).map(entry => ({ slice: 'hreflang' as const, kind: 'html' as const, label: 'hreflang link', original: `${entry.hreflang} ${entry.link.attrs.href ?? ''}`, ...(entry.href ? { href: entry.href } : {}), line: entry.link.line, visible: false }));
    registry.addSlice(info, 'hreflang', hreflang);
    registry.addSlice(info, 'http', httpSpecs(page));
  });
  for (const page of fetchedPages(site)) {
    if (analysed.includes(page) || !page.raw || pages.some(entry => entry.key === page.url)) continue;
    const info = pageInfo(page, `P${pages.length + 1}`, 'context');
    pages.push(info);
    registry.addSlice(info, 'metadata', metadataSpecs(pageDocument(page), page.fetch.finalUrl));
  }
  return { pages, items: registry.items, slices: registry.slices };
}

export function sliceOf(strings: SiteStrings, page: string, name: SliceName): SiteSlice | undefined {
  return strings.slices.find(slice => slice.page === page && slice.name === name);
}

export function itemsOf(strings: SiteStrings, page: string, name: SliceName): SiteItem[] {
  return (sliceOf(strings, page, name)?.items ?? []).map(id => strings.items.get(id)!);
}

/** A site item as report evidence. The excerpt keeps the original text, bounded; renderers clean it. */
export function toEvidence(item: SiteItem): EvidenceItem {
  const excerpt = item.original.slice(0, maxExcerptLength);
  return {
    id: item.id,
    kind: item.kind,
    url: item.url,
    label: item.label,
    excerpt,
    ...(item.line ? { line: item.line } : {}),
    ...(item.path ? { path: item.path } : {}),
    complete: item.complete && excerpt.length === item.original.length,
  };
}

/** A slice as report evidence, for claims that cite the slice as a whole. */
export function sliceEvidence(slice: SiteSlice, page: PageInfo | undefined): EvidenceItem {
  return {
    id: slice.id,
    kind: slice.name === 'structured-data' ? 'structured-data' : slice.name === 'http' ? 'header' : 'html',
    ...(page ? { url: page.finalUrl } : {}),
    label: `${slice.name} of the page: ${slice.items.length} items${slice.complete ? '' : ', not all collected'}`,
    complete: slice.complete,
  };
}

export function normalizeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href.replace(/\/$/u, '');
  } catch {
    return undefined;
  }
}

export interface PageCorpus {
  /** Visible text: title, headings and text people see. */
  readonly facts: FactIndex;
  readonly title?: string;
  readonly description?: string;
  readonly language?: string;
}

export interface FactCorpus {
  readonly pages: ReadonlyMap<string, PageCorpus>;
  /** Every URL referenced by a collected page (links, images, canonical and alternates, structured data) or fetched as one. */
  readonly links: ReadonlySet<string>;
  /** The site's name as the site writes it, when it can be told apart. Untrusted: used by code checks only. */
  readonly brand?: string;
}

function urlStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//iu.test(value.trim())) out.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const entry of value) urlStrings(entry, out);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) urlStrings(entry, out);
  }
}

function referencedUrls(page: PageFacts): string[] {
  const urls = [page.url, page.fetch.finalUrl];
  for (const doc of [page.raw, pageDocument(page)]) {
    if (!doc) continue;
    const base = page.fetch.finalUrl;
    for (const anchor of doc.parsed.anchors) urls.push(absoluteUrl(anchor.attrs.href, base) ?? '');
    for (const link of doc.parsed.links) urls.push(absoluteUrl(link.attrs.href, base) ?? '');
    for (const image of doc.parsed.images) urls.push(absoluteUrl(image.attrs.src, base) ?? '');
    for (const block of doc.data.jsonLd) urlStrings(block.value, urls);
    for (const node of doc.data.nodes) urlStrings(node.properties, urls);
  }
  return urls;
}

const titleSeparator = new RegExp(`\\s+[|:${middleDot}-]\\s+`, 'u');

function detectBrand(site: SiteFacts, strings: SiteStrings): string | undefined {
  const home = strings.pages.find(page => page.role === 'home') ?? strings.pages[0];
  for (const page of [home, strings.pages[0]]) {
    if (!page) continue;
    const name = itemsOf(strings, page.key, 'metadata').find(item => item.label === 'og:site_name meta property');
    if (name && name.text.trim() !== '') return cleanDisplay(name.text, 120);
  }
  for (const page of [home, strings.pages[0]]) {
    const facts = page ? site.pages.get(page.key) : undefined;
    const doc = facts ? pageDocument(facts) : undefined;
    const node = doc?.data.nodes.find(entry => entry.types.includes('WebSite') && typeof entry.properties.name === 'string')
      ?? doc?.data.nodes.find(entry => entry.types.includes('Organization') && typeof entry.properties.name === 'string');
    if (node) return cleanDisplay(node.properties.name as string, 120);
  }
  const counts = new Map<string, { text: string; pages: Set<string> }>();
  for (const page of strings.pages) {
    const title = itemsOf(strings, page.key, 'metadata').find(item => item.label === 'title element');
    if (!title) continue;
    const parts = normalizeText(title.text).split(titleSeparator);
    if (parts.length < 2) continue;
    for (const part of [parts[0]!, parts.at(-1)!]) {
      const key = fold(part);
      if (key.length < 2) continue;
      const entry = counts.get(key) ?? { text: part, pages: new Set<string>() };
      entry.pages.add(page.key);
      counts.set(key, entry);
    }
  }
  const shared = [...counts.values()].filter(entry => entry.pages.size >= 2).sort((a, b) => b.pages.size - a.pages.size);
  return shared[0] ? cleanDisplay(shared[0].text, 120) : undefined;
}

/** What proposals are checked against: each page's visible text, every referenced URL and the brand. */
export function buildCorpus(site: SiteFacts, strings: SiteStrings): FactCorpus {
  const pages = new Map<string, PageCorpus>();
  const fetched = fetchedPages(site);
  const byUrl = new Map(fetched.map(page => [page.url, page]));
  for (const info of strings.pages) {
    const facts = byUrl.get(info.key);
    const rendered = facts?.rendered && facts.rendered.result.error === undefined ? facts.rendered.result.textBlocks : [];
    const metadata = itemsOf(strings, info.key, 'metadata');
    const title = metadata.find(item => item.label === 'title element')?.text;
    const description = metadata.find(item => item.label === 'meta description')?.text;
    const visible = [
      title ?? '',
      ...itemsOf(strings, info.key, 'headings').map(item => item.text),
      ...(rendered.length > 0 ? rendered.filter(block => block.hidden === undefined).map(block => block.text) : itemsOf(strings, info.key, 'text').map(item => item.text)),
    ].join('\n');
    pages.set(info.key, {
      facts: factIndex(visible),
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(info.language ? { language: info.language } : {}),
    });
  }
  const links = new Set<string>();
  for (const page of fetched) {
    for (const url of referencedUrls(page)) {
      const normalized = normalizeUrl(url);
      if (normalized) links.add(normalized);
    }
  }
  const brand = detectBrand(site, strings);
  return { pages, links, ...(brand ? { brand } : {}) };
}

const aiAddressee = /\b(?:ai|llm|large language model|language model|chatbot|ai assistant|ai agent|gpt|chatgpt|claude|gemini)\b/u;

// Folded text (lower case, no accents). Each pattern needs the shape of an instruction to a model, so ordinary
// copy such as "don't forget the pool rules" or "our staff act as your assistant" is not a candidate.
const injectionPatterns: ReadonlyArray<{ readonly id: string; readonly test: (text: string) => boolean }> = [
  {
    id: 'ignore-instructions',
    test: text => /\b(?:ignore|disregard|forget|override)\b(?:\s+\w+){0,2}\s+(?:previous|prior|above|earlier|preceding|all|any|your|system|these|those)\b(?:\s+\w+){0,2}\s+(?:instructions?|prompts?|rules|directions|guidelines)\b/u.test(text)
      || /\b(?:ignor|olvid|oblid|descart)\w*\b[^.\n]{0,40}\b(?:instruc\w*|indicacion\w*|indicacions)\s+(?:anteriores|previas|anteriors|previes|del sistema|de sistema)\b/u.test(text),
  },
  { id: 'role-reassignment', test: text => /\b(?:you are now|from now on,? you are|ahora eres|a partir de ahora eres|ara ets|a partir d'ara ets)\b[^.\n]{0,40}\b(?:ai|assistant|asistente|assistent|model|llm|chatbot|gpt|claude)\b/u.test(text) },
  { id: 'system-prompt', test: text => /\b(?:new|updated|real|actual|true|hidden)\s+system\s+(?:prompt|instructions?)\b|\bsystem\s+prompt\s*:/u.test(text) },
  { id: 'chat-markup', test: text => /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?inst\]|<<\/?sys>>/u.test(text) },
  {
    id: 'addressed-to-ai',
    test: text => /\b(?:if you are|you are|attention|note to|dear|hey|hello)\s+(?:an?\s+|the\s+)?(?:ai|llm|large language model|language model|chatbot|ai assistant|ai agent|gpt|chatgpt|claude|gemini)\b/u.test(text)
      || /\b(?:ai|llm|language model|chatbot|ai assistant)s?\b[^.\n]{0,30}\b(?:reading|parsing|crawling|summari[sz]ing|analy[sz]ing|processing) this\b/u.test(text),
  },
  {
    id: 'grading-request',
    test: text => aiAddressee.test(text) && /\b(?:rate|score|rank|grade|recommend|describe|present)\b[^.\n]{0,40}\b(?:this|our)\b[^.\n]{0,20}\b(?:site|page|website|business|company|hotel|product|brand)\b/u.test(text),
  },
];

/**
 * Site text that addresses AI systems. It is reported for the ai-hidden-llm-instructions rule to judge and
 * never changes how answers are validated, because validation only compares quotes and facts with the evidence.
 * Words written in Unicode tag characters are a candidate whatever they say: no reader sees them, and models
 * never receive them either, because site text is cleaned of them.
 */
export function injectionCandidates(strings: SiteStrings): InjectionCandidate[] {
  const candidates: InjectionCandidate[] = [];
  for (const item of strings.items.values()) {
    const hidden = tagText(item.original);
    if (hidden.length > 0) {
      candidates.push({ ruleId: 'ai-hidden-llm-instructions', page: item.page, evidenceId: item.id, where: item.label, pattern: 'invisible-text', excerpt: cleanDisplay(hidden.join(' '), 200), visible: false });
      continue;
    }
    const text = fold(item.original);
    for (const { id, test } of injectionPatterns) {
      if (!test(text)) continue;
      candidates.push({ ruleId: 'ai-hidden-llm-instructions', page: item.page, evidenceId: item.id, where: item.label, pattern: id, excerpt: cleanDisplay(item.original, 200), visible: item.visible });
      break;
    }
  }
  return candidates;
}
