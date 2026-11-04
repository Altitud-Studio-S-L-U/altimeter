import type { DefaultTreeAdapterTypes } from 'parse5';
import type { DocumentFacts } from '../../core/facts.ts';
import { attribute, collapse, isElement, textOf, walk, type HtmlElement, type HtmlNode } from '../../parse/html.ts';
import { words } from './support.ts';

const neverText = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head']);
const pageChrome = new Set(['header', 'nav', 'footer', 'aside']);
const consentLike = /cookie|consent|gdpr|onetrust|didomi|cookiebot|\bcmp\b/iu;
const blockTags = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'dd', 'blockquote', 'figcaption']);

/** Dialogs and consent banners carry interface text, not page content, whether or not they are injected by script. */
export function isInterfaceOverlay(element: HtmlElement): boolean {
  const role = attribute(element, 'role');
  if (role === 'dialog' || role === 'alertdialog' || attribute(element, 'aria-modal') === 'true' || element.tagName === 'dialog') return true;
  return consentLike.test(`${attribute(element, 'id') ?? ''} ${attribute(element, 'class') ?? ''}`);
}

function find(node: HtmlNode, test: (element: HtmlElement) => boolean): HtmlElement | undefined {
  let found: HtmlElement | undefined;
  walk(node, child => {
    if (found) return false;
    if (isElement(child) && test(child)) {
      found = child;
      return false;
    }
    return undefined;
  });
  return found;
}

export interface MainText {
  readonly scope: 'main' | 'body';
  readonly root: HtmlElement | undefined;
  readonly text: string;
  readonly words: number;
}

/** The main content text: the main landmark when there is one, else the body without header, navigation, footer and asides. */
export function mainText(doc: DocumentFacts): MainText {
  const document = doc.parsed.document;
  const main = find(document, element => element.tagName === 'main' || attribute(element, 'role') === 'main');
  const root = main ?? find(document, element => element.tagName === 'body');
  const scope = main ? 'main' : 'body';
  const parts: string[] = [];
  if (root) {
    walk(root, node => {
      if (isElement(node)) {
        if (neverText.has(node.tagName) || isInterfaceOverlay(node)) return false;
        if (scope === 'body' && pageChrome.has(node.tagName)) return false;
        return undefined;
      }
      if (node.nodeName === '#text') parts.push((node as DefaultTreeAdapterTypes.TextNode).value);
      return undefined;
    });
  }
  const text = collapse(parts.join(' '));
  return { scope, root, text, words: words(text).length };
}

/** Text of block elements (paragraphs, list items, headings, cells) under the main content root, in document order. */
export function textBlocks(main: MainText): string[] {
  const blocks: string[] = [];
  if (!main.root) return blocks;
  walk(main.root, node => {
    if (!isElement(node)) return undefined;
    if (neverText.has(node.tagName) || isInterfaceOverlay(node)) return false;
    if (main.scope === 'body' && pageChrome.has(node.tagName)) return false;
    if (blockTags.has(node.tagName)) {
      const text = textOf(node);
      if (text !== '') blocks.push(text);
      return false;
    }
    return undefined;
  });
  return blocks;
}

export function normalizeText(text: string): string {
  return collapse(text.toLowerCase());
}
