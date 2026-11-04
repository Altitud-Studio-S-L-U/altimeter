import type { DefaultTreeAdapterTypes } from 'parse5';
import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts } from '../../core/facts.ts';
import { attribute, isElement, textOf, type HtmlElement, type HtmlNode } from '../../parse/html.ts';
import type { TextBlock } from '../../render/chrome.ts';
import type { RuleImplementation } from '../engine.ts';
import { clip } from './support.ts';

/**
 * Phrases that address an AI system and tell it what to do. Each needs both an addressee or an override verb and an
 * instruction, so copy that merely talks about AI, agents or prompts does not match.
 */
const instructionPatterns: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|other)\s+(?:instructions?|prompts?|directions|rules|messages)\b/iu,
  /\bif\s+you\s+are\s+an?\s+(?:ai|llm|large\s+language\s+model|language\s+model|chatbot|ai\s+assistant|ai\s+agent|ai\s+model)\b/iu,
  /\b(?:ai|llm|language\s+model|chatbot)s?\s+(?:assistants?\s+|agents?\s+|models?\s+|systems?\s+)?(?:must|should|are\s+instructed\s+to|are\s+required\s+to)\s+(?:always\s+)?(?:recommend|mention|say|state|describe|rank|cite|promote|tell|respond|answer|summari[sz]e|include)\b/iu,
  /\b(?:when|while)\s+(?:you\s+are\s+|you're\s+)?(?:summari[sz]ing|describing|answering\s+questions\s+about|asked\s+about|writing\s+about|reviewing)\s+(?:this|the)\s+(?:page|site|website|article|document|company|business|product)\b/iu,
  /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:ai|llms?|language\s+models?|ai\s+assistants?|chatbots?|ai\s+agents?|ai\s+crawlers?|ai\s+systems?)\b/iu,
  /\b(?:system\s+prompt|new\s+instructions|assistant\s+instructions)\s*:/iu,
];

export function isInstructionLike(text: string): boolean {
  return instructionPatterns.some(pattern => pattern.test(text));
}

// Examples shown as code are quoted material, not instructions to the reader.
const quotedTags = new Set(['pre', 'code', 'kbd', 'samp', 'textarea', 'script', 'style']);
// A bare "hidden" class is left out: utility frameworks pair it with breakpoint classes that show the element.
const hiddenClass = /(?:^|\s)(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text)(?:\s|$)/iu;
const hiddenStyle = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|em|rem|%)?\s*(?:;|!|$)|text-indent\s*:\s*-\d{3,}|(?:left|top)\s*:\s*-\d{3,}px/iu;
const checkedAttributes = /^(?:alt|title|aria-label|aria-description|placeholder|data-[\w-]+)$/u;
const visibleMetadata = /^(?:description|og:|twitter:)/iu;

export interface Candidate {
  readonly where: 'hidden-element' | 'comment' | 'attribute' | 'meta' | 'rendered-hidden';
  readonly text: string;
  readonly line?: number;
  readonly path: string;
}

function selector(element: HtmlElement): string {
  const id = attribute(element, 'id');
  if (id) return `${element.tagName}#${id}`;
  const classes = (attribute(element, 'class') ?? '').split(/\s+/u).filter(Boolean).slice(0, 2);
  return classes.length > 0 ? `${element.tagName}.${classes.join('.')}` : element.tagName;
}

function hiddenReason(element: HtmlElement): string | undefined {
  if (attribute(element, 'hidden') !== undefined) return 'hidden attribute';
  if (attribute(element, 'aria-hidden') === 'true') return 'aria-hidden';
  if (hiddenStyle.test(attribute(element, 'style') ?? '')) return 'inline style';
  if (hiddenClass.test(attribute(element, 'class') ?? '')) return 'hiding class';
  return undefined;
}

function childNodes(node: HtmlNode): readonly HtmlNode[] {
  if (isElement(node) && node.tagName === 'template') return (node as DefaultTreeAdapterTypes.Template).content.childNodes;
  return 'childNodes' in node ? (node as DefaultTreeAdapterTypes.ParentNode).childNodes : [];
}

/** Instruction-like text in hidden elements, comments and attributes of the served HTML. */
export function rawCandidates(doc: DocumentFacts): Candidate[] {
  const found: Candidate[] = [];
  const visit = (node: HtmlNode, hidden: boolean) => {
    if (node.nodeName === '#comment') {
      const text = (node as DefaultTreeAdapterTypes.CommentNode).data.trim();
      if (isInstructionLike(text)) found.push({ where: 'comment', text, line: node.sourceCodeLocation?.startLine ?? 0, path: '<!-- -->' });
      return;
    }
    if (!isElement(node)) return;
    if (quotedTags.has(node.tagName)) return;
    const line = node.sourceCodeLocation?.startLine ?? 0;
    if (node.tagName === 'meta') {
      const name = attribute(node, 'name') ?? attribute(node, 'property') ?? '';
      const content = attribute(node, 'content') ?? '';
      if (!visibleMetadata.test(name) && isInstructionLike(content)) found.push({ where: 'meta', text: content, line, path: `meta[name="${name}"]` });
      return;
    }
    for (const attr of node.attrs) {
      if (checkedAttributes.test(attr.name) && isInstructionLike(attr.value)) found.push({ where: 'attribute', text: attr.value, line, path: `${selector(node)}[${attr.name}]` });
    }
    const becomesHidden = !hidden && hiddenReason(node) !== undefined;
    if (becomesHidden) {
      const text = textOf(node);
      if (isInstructionLike(text)) found.push({ where: 'hidden-element', text, line, path: `${selector(node)} (${hiddenReason(node)})` });
    }
    for (const child of childNodes(node)) visit(child, hidden || becomesHidden);
  };
  for (const child of childNodes(doc.parsed.document)) visit(child, false);
  return found;
}

/**
 * Rendered text blocks that are hidden and instruction-like. Scroll-reveal sections waiting at opacity 0 and slides
 * of a sideways scroller are skipped: readers reach both.
 */
export function renderedCandidates(blocks: readonly TextBlock[]): Candidate[] {
  return blocks
    .filter(block => block.hidden !== undefined && !block.revealOnScroll && !block.inScroller && !/(?:^|[\s>])(?:pre|code)(?:[.#\s>]|$)/u.test(block.selector))
    .filter(block => isInstructionLike(block.text))
    .map(block => ({ where: 'rendered-hidden' as const, text: block.text, path: `${block.selector} (${block.hidden})` }));
}

const hiddenInstructions: RuleImplementation = {
  id: 'ai-hidden-llm-instructions',
  evaluate({ page, evidence }) {
    const url = page!.fetch.finalUrl;
    const candidates = [...rawCandidates(page!.raw!)];
    const rendered = page!.rendered;
    if (rendered && rendered.result.error === undefined) {
      // Scripts can inject hidden elements, comments and attributes, so the rendered document is scanned as well.
      const known = new Set(candidates.map(candidate => candidate.text));
      for (const candidate of [...rawCandidates(rendered), ...renderedCandidates(rendered.result.textBlocks)]) {
        if (known.has(candidate.text)) continue;
        known.add(candidate.text);
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) return { outcome: 'pass' };
    const ids = candidates.slice(0, 10).map(candidate => evidence.add({
      kind: candidate.where === 'rendered-hidden' ? 'render' : 'html', url,
      label: evidenceLabel('instruction-like text aimed at AI systems in {location}', { location: candidate.where.replace('-', ' ') }),
      excerpt: clip(candidate.text, 500), path: candidate.path, ...(candidate.line ? { line: candidate.line } : {}),
    }));
    // Intent decides whether this is manipulation or a quoted example, so the analyst confirms it.
    return { outcome: 'fail', severity: 'medium', reason: 'hidden-instructions', needsJudgment: true, evidence: ids, params: { count: candidates.length } };
  },
};

export const hiddenInstructionRules: readonly RuleImplementation[] = [hiddenInstructions];
