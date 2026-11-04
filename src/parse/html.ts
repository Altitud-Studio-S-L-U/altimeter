import { parse, type DefaultTreeAdapterTypes } from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export type { Element as HtmlElement, Node as HtmlNode };

export interface ElementRef {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  /** One-based source line; 0 when the element was created by the parser and has no source position. */
  readonly line: number;
  readonly offset: number;
  readonly inHead: boolean;
}

export interface TextElementRef extends ElementRef {
  readonly text: string;
}

export interface LinkRef extends ElementRef {
  /** Lowercase link types from the rel attribute. */
  readonly rel: readonly string[];
}

export interface AnchorRef extends LinkRef {
  readonly text: string;
  /** alt text of images inside the link, which search engines also read as anchor text. */
  readonly imageAlt: string;
}

export interface HeadingRef extends TextElementRef {
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface HeadClosure {
  /** The element or text that implicitly ended the head, after which metadata lands in the body. */
  readonly cause: { readonly kind: 'element'; readonly tag: string; readonly line: number } | { readonly kind: 'text'; readonly text: string; readonly line: number };
  /** Metadata elements written for the head that the parser placed in the body. */
  readonly displaced: readonly ElementRef[];
}

export interface ParsedHtml {
  readonly document: DefaultTreeAdapterTypes.Document;
  readonly mode: 'no-quirks' | 'quirks' | 'limited-quirks';
  readonly doctype: string | undefined;
  readonly htmlLang: string | undefined;
  readonly titles: readonly TextElementRef[];
  readonly metas: readonly ElementRef[];
  readonly links: readonly LinkRef[];
  readonly scripts: readonly TextElementRef[];
  readonly bases: readonly ElementRef[];
  readonly headClosure: HeadClosure | undefined;
  readonly headings: readonly HeadingRef[];
  readonly anchors: readonly AnchorRef[];
  readonly images: readonly ElementRef[];
  readonly iframes: readonly ElementRef[];
  /** Body text outside script, style, template, noscript and svg, with whitespace collapsed. */
  readonly bodyText: string;
  /** UTF-8 byte offset of the first charset declaration in a meta element. */
  readonly charsetByteOffset: number | undefined;
}

const skippedText = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head']);
const headMetadata = new Set(['title', 'meta', 'link', 'base']);

export function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

export function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find(attr => attr.name === name)?.value;
}

export function attributes(element: Element): Record<string, string> {
  const result: Record<string, string> = {};
  for (const attr of element.attrs) if (!(attr.name in result)) result[attr.name] = attr.value;
  return result;
}

function children(node: Node): readonly Node[] {
  if ('content' in node && node.nodeName === 'template') return (node as DefaultTreeAdapterTypes.Template).content.childNodes;
  return 'childNodes' in node ? (node as ParentNode).childNodes : [];
}

/** Visits nodes in document order; return false from the visitor to skip a node's children. */
export function walk(node: Node, visit: (node: Node, inHead: boolean) => boolean | void, inHead = false): void {
  for (const child of children(node)) {
    const childInHead = inHead || (isElement(child) && child.tagName === 'head');
    if (visit(child, childInHead) === false) continue;
    walk(child, visit, childInHead);
  }
}

export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Text content of a node, skipping non-rendered subtrees, with whitespace collapsed. */
export function textOf(node: Node): string {
  const parts: string[] = [];
  const collect = (current: Node) => {
    if (current.nodeName === '#text') parts.push((current as DefaultTreeAdapterTypes.TextNode).value);
    if (isElement(current) && skippedText.has(current.tagName)) return;
    for (const child of children(current)) collect(child);
  };
  collect(node);
  return collapse(parts.join(' '));
}

function ref(element: Element, inHead: boolean): ElementRef {
  const location = element.sourceCodeLocation;
  return {
    tag: element.tagName,
    attrs: attributes(element),
    line: location?.startLine ?? 0,
    offset: location?.startOffset ?? -1,
    inHead,
  };
}

function relTokens(element: Element): string[] {
  return (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
}

function findChild(parent: Node, tag: string): Element | undefined {
  return children(parent).find((node): node is Element => isElement(node) && node.tagName === tag);
}

function detectHeadClosure(html: string, root: Element | undefined, metadata: readonly ElementRef[]): HeadClosure | undefined {
  const body = root ? findChild(root, 'body') : undefined;
  if (!body) return undefined;
  const bodyStart = body.sourceCodeLocation?.startTag?.startOffset;
  const headEnd = /<\/head\s*>/iu.exec(html)?.index;
  const limit = bodyStart ?? headEnd;
  if (limit === undefined) return undefined;
  const displaced = metadata.filter(entry => !entry.inHead && entry.offset >= 0 && entry.offset < limit);
  if (displaced.length === 0) return undefined;
  let cause: HeadClosure['cause'] | undefined;
  walk(body, node => {
    if (cause) return false;
    if (node.nodeName === '#text') {
      const value = (node as DefaultTreeAdapterTypes.TextNode).value.trim();
      if (value !== '') cause = { kind: 'text', text: value.slice(0, 60), line: node.sourceCodeLocation?.startLine ?? 0 };
      return false;
    }
    if (isElement(node)) {
      cause = { kind: 'element', tag: node.tagName, line: node.sourceCodeLocation?.startLine ?? 0 };
      return false;
    }
    return false;
  });
  return cause ? { cause, displaced } : undefined;
}

export function parseHtml(html: string): ParsedHtml {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = children(document).find((node): node is Element => isElement(node) && node.tagName === 'html');
  const doctypeNode = children(document).find(node => node.nodeName === '#documentType') as DefaultTreeAdapterTypes.DocumentType | undefined;
  const titles: TextElementRef[] = [];
  const metas: ElementRef[] = [];
  const links: LinkRef[] = [];
  const scripts: TextElementRef[] = [];
  const bases: ElementRef[] = [];
  const headings: HeadingRef[] = [];
  const anchors: AnchorRef[] = [];
  const images: ElementRef[] = [];
  const iframes: ElementRef[] = [];
  let charsetOffset: number | undefined;

  walk(document, (node, inHead) => {
    if (!isElement(node)) return;
    const tag = node.tagName;
    if (tag === 'title') titles.push({ ...ref(node, inHead), text: textOfRaw(node) });
    else if (tag === 'meta') {
      const entry = ref(node, inHead);
      metas.push(entry);
      const declaresCharset = entry.attrs.charset !== undefined
        || (entry.attrs['http-equiv']?.toLowerCase() === 'content-type' && /charset=/iu.test(entry.attrs.content ?? ''));
      if (declaresCharset && charsetOffset === undefined && entry.offset >= 0) charsetOffset = entry.offset;
    } else if (tag === 'link') links.push({ ...ref(node, inHead), rel: relTokens(node) });
    else if (tag === 'script') scripts.push({ ...ref(node, inHead), text: textOfRaw(node) });
    else if (tag === 'base') bases.push(ref(node, inHead));
    else if (/^h[1-6]$/u.test(tag)) headings.push({ ...ref(node, inHead), text: textOf(node), level: Number(tag[1]) as HeadingRef['level'] });
    else if (tag === 'a') {
      const alts: string[] = [];
      walk(node, child => {
        if (isElement(child) && child.tagName === 'img') alts.push(attribute(child, 'alt') ?? '');
      });
      anchors.push({ ...ref(node, inHead), rel: relTokens(node), text: textOf(node), imageAlt: collapse(alts.join(' ')) });
    } else if (tag === 'img') images.push(ref(node, inHead));
    else if (tag === 'iframe') iframes.push(ref(node, inHead));
  });

  const metadata = [...titles, ...metas, ...links, ...bases].filter(entry => headMetadata.has(entry.tag));
  const body = root ? findChild(root, 'body') : undefined;
  return {
    document,
    mode: document.mode as ParsedHtml['mode'],
    doctype: doctypeNode?.name,
    htmlLang: root ? attribute(root, 'lang') : undefined,
    titles,
    metas,
    links,
    scripts,
    bases,
    headClosure: detectHeadClosure(html, root, metadata),
    headings,
    anchors,
    images,
    iframes,
    bodyText: body ? textOf(body) : '',
    charsetByteOffset: charsetOffset === undefined ? undefined : Buffer.byteLength(html.slice(0, charsetOffset), 'utf8'),
  };
}

/** Raw text of an element whose content the parser keeps as text (title, script). */
function textOfRaw(element: Element): string {
  return children(element).map(child => (child.nodeName === '#text' ? (child as DefaultTreeAdapterTypes.TextNode).value : '')).join('');
}

/** Meta elements whose name or property matches, case-insensitively. */
export function metaContent(parsed: ParsedHtml, key: string): ElementRef[] {
  const wanted = key.toLowerCase();
  return parsed.metas.filter(meta => (meta.attrs.name ?? meta.attrs.property ?? '').toLowerCase() === wanted);
}
