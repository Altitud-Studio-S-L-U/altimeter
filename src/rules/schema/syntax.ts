import type { DefaultTreeAdapterTypes } from 'parse5';
import type { DocumentFacts } from '../../core/facts.ts';
import { attribute, isElement, type HtmlNode } from '../../parse/html.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { pageDocument } from '../helpers.ts';
import { bareTerm, buildGraph, isExternalTerm, topLevel } from './graph.ts';
import { cite, report, type Problem } from './support.ts';
import { featureTypes } from './features.ts';
import { isType } from './vocabulary.ts';

function signature(types: readonly string[], id: string | undefined, path: string): string {
  return `${[...types].sort().join('+')}|${id ?? path}`;
}

/** Lists every top-level item in the raw HTML and the rendered DOM, recording where each one was found. */
export const extractInventory: RuleImplementation = {
  id: 'schema-extract-inventory',
  evaluate(context) {
    const page = context.page!;
    const raw = page.raw ? buildGraph(page.raw, page.fetch.finalUrl, 'raw') : undefined;
    const rendered = page.rendered && page.rendered.result.error === undefined ? buildGraph(page.rendered, page.fetch.finalUrl, 'rendered') : undefined;
    const rawKeys = new Set(raw ? topLevel(raw).map(node => signature(node.types, node.id, node.path)) : []);
    const renderedKeys = new Set(rendered ? topLevel(rendered).map(node => signature(node.types, node.id, node.path)) : []);
    const evidence: string[] = [];
    for (const graph of [raw, rendered]) {
      if (!graph) continue;
      for (const node of topLevel(graph)) {
        const key = signature(node.types, node.id, node.path);
        if (graph === rendered && rawKeys.has(key)) continue;
        const where = graph === raw ? (renderedKeys.has(key) || !rendered ? 'raw' : 'raw only') : 'rendered only';
        evidence.push(cite(context, graph, node, `${node.syntax} item ${node.types.join(', ') || '(untyped)'}, ${where}`, undefined, node.path));
      }
    }
    const blocks = (raw?.data.jsonLd.length ?? 0) + (rendered?.data.jsonLd.length ?? 0);
    if (evidence.length === 0 && blocks === 0 && !raw?.data.rdfa && !rendered?.data.rdfa) return { outcome: 'not_applicable', reason: 'no-structured-data' };
    return { outcome: 'pass', evidence: evidence.slice(0, 40) };
  },
};

/** Documents to read for syntax checks: the raw HTML and, when it differs, the rendered DOM. */
function documents(context: RuleContext): Array<{ doc: DocumentFacts; source: 'raw' | 'rendered' }> {
  const page = context.page!;
  const result: Array<{ doc: DocumentFacts; source: 'raw' | 'rendered' }> = [];
  if (page.raw) result.push({ doc: page.raw, source: 'raw' });
  const rendered = pageDocument(page);
  if (rendered && rendered !== page.raw) result.push({ doc: rendered, source: 'rendered' });
  return result;
}

export const jsonLdSyntaxError: RuleImplementation = {
  id: 'schema-jsonld-syntax-error',
  evaluate(context) {
    const seen = new Set<string>();
    const broken: Array<{ source: string; line: number; raw: string; error: string; index: number }> = [];
    let blocks = 0;
    for (const { doc, source } of documents(context)) {
      for (const block of doc.data.jsonLd) {
        blocks += 1;
        if (block.error === undefined || seen.has(block.raw)) continue;
        seen.add(block.raw);
        broken.push({ source, line: block.line, raw: block.raw, error: block.error, index: block.index });
      }
    }
    if (blocks === 0) return { outcome: 'not_applicable', reason: 'no-jsonld' };
    if (broken.length === 0) return { outcome: 'pass' };
    const evidence = broken.map(entry => context.evidence.add({
      kind: 'structured-data', url: context.page!.fetch.finalUrl, label: `JSON-LD block that does not parse as JSON (${entry.source === 'raw' ? 'raw HTML' : 'rendered DOM'})`,
      excerpt: entry.raw, line: entry.line, path: `jsonld[${entry.index}]`,
    }));
    return { outcome: 'fail', severity: 'high', evidence, params: { count: broken.length, error: broken[0]!.error.slice(0, 160) } };
  },
};

export const jsonLdContext: RuleImplementation = {
  id: 'schema-jsonld-context',
  evaluate(context) {
    const page = context.page!;
    const doc = pageDocument(page);
    if (!doc || doc.data.jsonLd.every(block => block.value === undefined)) return { outcome: 'not_applicable', reason: 'no-jsonld' };
    const graph = buildGraph(doc, page.fetch.finalUrl, doc === page.raw ? 'raw' : 'rendered');
    const problems: Problem[] = [];
    for (const node of topLevel(graph).filter(entry => entry.syntax === 'json-ld' && entry.types.length > 0 && !entry.schemaOrg)) {
      if (node.types.every(isExternalTerm)) continue;
      const declared = node.blockText !== undefined && /"@context"/u.test(node.blockText);
      const contextValue = /"@context"\s*:\s*("[^"]*"|\[[^\]]*\]|\{[^}]*\})/u.exec(node.blockText ?? '')?.[1];
      problems.push({
        reason: declared ? 'not-schema-org' : 'missing-context',
        severity: 'high',
        subject: node.types.join(', '),
        evidence: cite(context, graph, node, declared ? 'JSON-LD item whose @context is not schema.org' : 'JSON-LD item without @context', undefined,
          contextValue ?? JSON.stringify(node.raw)),
      });
    }
    return report(problems);
  },
};

type Element = DefaultTreeAdapterTypes.Element;

function childNodes(node: HtmlNode): readonly HtmlNode[] {
  return 'childNodes' in node ? (node as DefaultTreeAdapterTypes.ParentNode).childNodes : [];
}

function elementLabel(element: Element): string {
  const attrs = element.attrs.filter(attr => /^(itemscope|itemtype|itemprop|itemref|typeof|vocab|id)$/u.test(attr.name))
    .map(attr => (attr.value === '' ? attr.name : `${attr.name}="${attr.value}"`));
  return `<${element.tagName}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
}

interface MicrodataIssue {
  readonly reason: 'orphan-itemprop' | 'invalid-itemtype' | 'missing-itemtype' | 'missing-itemref' | 'unresolved-typeof';
  readonly element: Element;
  readonly subject: string;
  readonly featureType: boolean;
}

function scanAttributes(root: HtmlNode): { issues: MicrodataIssue[]; found: boolean } {
  const ids = new Set<string>();
  const referenced = new Set<string>();
  const collect = (node: HtmlNode) => {
    if (isElement(node)) {
      const id = attribute(node, 'id');
      if (id) ids.add(id);
      for (const ref of (attribute(node, 'itemref') ?? '').split(/\s+/u).filter(Boolean)) referenced.add(ref);
    }
    for (const child of childNodes(node)) collect(child);
  };
  collect(root);
  const issues: MicrodataIssue[] = [];
  let found = false;
  const visit = (node: HtmlNode, inScope: boolean, inReference: boolean, vocab: boolean) => {
    if (!isElement(node)) {
      for (const child of childNodes(node)) visit(child, inScope, inReference, vocab);
      return;
    }
    const itemscope = attribute(node, 'itemscope') !== undefined;
    const itemprop = attribute(node, 'itemprop');
    const itemtype = attribute(node, 'itemtype');
    const typeOf = attribute(node, 'typeof');
    const id = attribute(node, 'id');
    const hasVocab = vocab || attribute(node, 'vocab') !== undefined;
    if (itemscope || itemprop !== undefined || itemtype !== undefined || typeOf !== undefined) found = true;
    const referencedHere = inReference || (id !== undefined && referenced.has(id));
    if (itemprop !== undefined && !inScope && !referencedHere) {
      issues.push({ reason: 'orphan-itemprop', element: node, subject: itemprop, featureType: false });
    }
    if (itemscope && itemtype === undefined && !inScope && itemprop === undefined) {
      issues.push({ reason: 'missing-itemtype', element: node, subject: elementLabel(node), featureType: false });
    }
    for (const type of (itemtype ?? '').split(/\s+/u).filter(Boolean)) {
      if (/^https?:\/\//iu.test(type)) continue;
      issues.push({ reason: 'invalid-itemtype', element: node, subject: type, featureType: featureTypes.has(bareTerm(type)) });
    }
    for (const ref of (attribute(node, 'itemref') ?? '').split(/\s+/u).filter(Boolean)) {
      if (!ids.has(ref)) issues.push({ reason: 'missing-itemref', element: node, subject: ref, featureType: false });
    }
    for (const type of (typeOf ?? '').split(/\s+/u).filter(Boolean)) {
      // Prefixed names (schema:Product) and absolute IRIs resolve through RDFa's initial context.
      if (hasVocab || type.includes(':')) continue;
      issues.push({ reason: 'unresolved-typeof', element: node, subject: type, featureType: featureTypes.has(type) && isType(type) });
    }
    for (const child of childNodes(node)) visit(child, inScope || itemscope, referencedHere, hasVocab);
  };
  visit(root, false, false, false);
  return { issues, found };
}

export const microdataRdfaStructure: RuleImplementation = {
  id: 'schema-microdata-rdfa-structure',
  evaluate(context): RuleResult[] | RuleResult {
    const page = context.page!;
    const doc = pageDocument(page)!;
    const { issues, found } = scanAttributes(doc.parsed.document);
    if (!found) return { outcome: 'not_applicable', reason: 'no-microdata-or-rdfa' };
    const where = doc === page.raw ? 'raw HTML' : 'rendered DOM';
    const labels: Record<MicrodataIssue['reason'], string> = {
      'orphan-itemprop': 'itemprop outside any itemscope',
      'invalid-itemtype': 'itemtype that is not an absolute URL',
      'missing-itemtype': 'top-level itemscope without itemtype',
      'missing-itemref': 'itemref naming an id that is not in the document',
      'unresolved-typeof': 'RDFa typeof with no vocab in scope',
    };
    return report(issues.map(issue => ({
      reason: issue.reason,
      severity: issue.featureType ? 'medium' : 'low',
      subject: issue.subject,
      evidence: context.evidence.add({
        kind: 'html', url: page.fetch.finalUrl, label: `${labels[issue.reason]} (${where})`, excerpt: elementLabel(issue.element),
        line: issue.element.sourceCodeLocation?.startLine ?? 0,
      }),
    })));
  },
};
