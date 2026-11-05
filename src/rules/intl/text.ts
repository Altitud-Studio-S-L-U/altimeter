import { closelyRelated, detectLanguage, languageNames, type LanguageGuess } from '../../analyze/language.ts';
import { evidenceLabel, type EvidenceStore } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import { attribute, collapse, isElement, type HtmlElement, type HtmlNode } from '../../parse/html.ts';
import { pageDocument } from '../helpers.ts';

const skipped = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head', 'iframe', 'object', 'code', 'pre', 'textarea', 'select']);
const chrome = new Set(['nav', 'header', 'footer', 'aside', 'dialog']);
const chromeRoles = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'dialog', 'alertdialog', 'search']);
// Consent banners and overlays are template text in whatever language the visitor chose, not page content.
const overlay = /cookie|consent|gdpr|rgpd|cmp-|onetrust|didomi|cookiebot|modal|popup|newsletter/iu;
const blockTags = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'blockquote', 'dd', 'dt', 'figcaption', 'caption', 'summary', 'label', 'button', 'a']);

function childrenOf(node: HtmlNode): readonly HtmlNode[] {
  if (node.nodeName === 'template') return [];
  return 'childNodes' in node ? (node as { childNodes: HtmlNode[] }).childNodes : [];
}

function isOverlay(element: HtmlElement): boolean {
  const role = attribute(element, 'role');
  if (role && chromeRoles.has(role)) return true;
  const marker = `${attribute(element, 'id') ?? ''} ${attribute(element, 'class') ?? ''}`;
  return overlay.test(marker) || attribute(element, 'aria-modal') === 'true';
}

function findMain(node: HtmlNode): HtmlElement | undefined {
  for (const child of childrenOf(node)) {
    if (!isElement(child)) continue;
    if (child.tagName === 'main' || attribute(child, 'role') === 'main') return child;
    const found = findMain(child);
    if (found) return found;
  }
  return undefined;
}

function body(doc: DocumentFacts): HtmlNode {
  const html = childrenOf(doc.parsed.document).find(node => isElement(node) && node.tagName === 'html');
  return (html && childrenOf(html).find(node => isElement(node) && node.tagName === 'body')) ?? doc.parsed.document;
}

/** The root of the main content: <main> or role=main, else the body. */
export function mainRoot(doc: DocumentFacts): { readonly node: HtmlNode; readonly fromMain: boolean } {
  const main = findMain(doc.parsed.document);
  return main ? { node: main, fromMain: true } : { node: body(doc), fromMain: false };
}

/** Text of the main content without navigation, header, footer, asides, dialogs and consent banners. */
export function mainText(doc: DocumentFacts): string {
  const { node, fromMain } = mainRoot(doc);
  const parts: string[] = [];
  const visit = (current: HtmlNode) => {
    if (current.nodeName === '#text') {
      parts.push((current as { value: string }).value);
      return;
    }
    if (isElement(current)) {
      if (skipped.has(current.tagName) || current.tagName === 'select') return;
      if (!fromMain && chrome.has(current.tagName)) return;
      if (isOverlay(current) && current !== node) return;
    }
    for (const child of childrenOf(current)) visit(child);
  };
  visit(node);
  return collapse(parts.join(' '));
}

export interface TextBlockRef {
  readonly text: string;
  readonly tag: string;
  readonly line: number;
}

/** Leaf text blocks of the main content (paragraphs, list items, headings, cells), in document order. */
export function mainBlocks(doc: DocumentFacts): TextBlockRef[] {
  const { node, fromMain } = mainRoot(doc);
  const blocks: TextBlockRef[] = [];
  const textIn = (element: HtmlNode): string => {
    const parts: string[] = [];
    const visit = (current: HtmlNode) => {
      if (current.nodeName === '#text') parts.push((current as { value: string }).value);
      else if (isElement(current) && skipped.has(current.tagName)) return;
      for (const child of childrenOf(current)) visit(child);
    };
    visit(element);
    return collapse(parts.join(' '));
  };
  const visit = (current: HtmlNode) => {
    if (!isElement(current)) return;
    if (skipped.has(current.tagName) || (!fromMain && chrome.has(current.tagName)) || (isOverlay(current) && current !== node)) return;
    if (blockTags.has(current.tagName)) {
      const text = textIn(current);
      if (text !== '') blocks.push({ text, tag: current.tagName, line: current.sourceCodeLocation?.startLine ?? 0 });
      return;
    }
    for (const child of childrenOf(current)) visit(child);
  };
  visit(node);
  return blocks;
}

export interface DocumentLanguage {
  readonly guess: LanguageGuess;
  readonly text: string;
  readonly doc: DocumentFacts;
}

const languages = new WeakMap<PageFacts, DocumentLanguage | undefined>();

/** Language of a page's main content, from the rendered DOM when present, else the raw HTML. */
export function pageLanguage(page: PageFacts): DocumentLanguage | undefined {
  if (languages.has(page)) return languages.get(page);
  const doc = pageDocument(page);
  const text = doc ? mainText(doc) : '';
  const result = doc ? { guess: detectLanguage(text), text, doc } : undefined;
  languages.set(page, result);
  return result;
}

/** Minimum evidence before a detected language may contradict a declared one. */
export const decisive = { words: 200, confidence: 0.9 } as const;

export function isDecisive(guess: LanguageGuess, words: number = decisive.words): boolean {
  return guess.language !== 'und' && guess.confidence >= decisive.confidence && guess.words >= words;
}

export function languageLabel(code: string): string {
  return (languageNames as Readonly<Record<string, string>>)[code] ?? code;
}

/** True when a detection between these languages should be confirmed by the analyst before it counts. */
export function needsConfirmation(detected: string, declared: string): boolean {
  return closelyRelated(detected, declared);
}

const excerptLength = 300;

export function languageEvidence(evidence: EvidenceStore, url: string, language: DocumentLanguage): string {
  const { guess } = language;
  const verdict = guess.language === 'und'
    ? evidenceLabel('language of the main content undetermined ({words, plural, one {# word} other {# words}})', { words: guess.words })
    : evidenceLabel('main content detected as {language} (confidence {confidence, number, ::.00}, {words} words)', { language: languageLabel(guess.language), confidence: guess.confidence, words: guess.words });
  return evidence.add({ kind: 'text', url, label: verdict, excerpt: language.text.slice(0, excerptLength) });
}

/** Word shingles of a text, for near-duplicate comparison across language versions. */
export function shingles(text: string, size = 3): Set<string> {
  const words = text.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const result = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) result.add(words.slice(index, index + size).join(' '));
  return result;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}
