import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import { isAllowed } from '../../fetch/robots.ts';
import { attribute, isElement, type HtmlNode } from '../../parse/html.ts';
import type { RuleImplementation } from '../engine.ts';
import { directivesFor, robotsDirectives } from '../helpers.ts';
import { texts, topLevel, type GraphNode, type PageGraph } from './graph.ts';
import { pageFeatureTypes } from './features.ts';
import { blockedForImages, cite, imageUrls, isResult, nodesOfType, pageGraph, plainNumber, report, type Problem } from './support.ts';
import { isA } from './vocabulary.ts';

export const mainEntityPageFit: RuleImplementation = {
  id: 'schema-main-entity-page-fit',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const top = topLevel(graph).filter(node => node.schemaOrg);
    if (top.length === 0) return { outcome: 'not_applicable', reason: 'no-schema-org-markup' };
    const page = context.page!;
    const problems: Problem[] = [];
    const candidate = (reason: string, subject: string, node: GraphNode, label: EvidenceLabel) =>
      problems.push({ reason, severity: 'medium', subject, needsJudgment: true, evidence: cite(context, graph, node, label) });
    const products = top.filter(node => isA(node.types, 'Product') && !isA(node.types, 'ProductGroup'));
    if (products.length >= 3) candidate('several-products', `${products.length} Product`, products[0]!, evidenceLabel('{count} top-level Product items on one page', { count: products.length }));
    if (page.pageType === 'home') {
      for (const node of top.filter(entry => isA(entry.types, 'Article'))) candidate('article-on-home', node.types.join('+'), node, evidenceLabel('Article markup on the home page'));
      for (const node of top.filter(entry => isA(entry.types, 'ProfilePage'))) candidate('profile-page-on-home', 'ProfilePage', node, evidenceLabel('ProfilePage markup on the home page'));
    }
    return report(problems);
  },
};

function attributeText(root: HtmlNode): string[] {
  const found: string[] = [];
  const visit = (node: HtmlNode) => {
    if (isElement(node)) for (const name of ['alt', 'aria-label', 'title', 'content', 'value']) {
      const value = attribute(node, name);
      if (value) found.push(value);
    }
    for (const child of 'childNodes' in node ? (node as { childNodes: HtmlNode[] }).childNodes : []) visit(child);
  };
  visit(root);
  return found;
}

/** Every number written in the text, read with a decimal point and with a decimal comma. */
function numbersIn(haystack: string): number[] {
  const numbers: number[] = [];
  for (const match of haystack.matchAll(/\d[\d.,\u00A0\u202F ]*\d|\d/gu)) {
    const token = match[0].replace(/[\u00A0\u202F ]/gu, '');
    const point = Number(token.replace(/,/gu, ''));
    const comma = Number(token.replace(/\./gu, '').replace(',', '.'));
    for (const value of [point, comma, Number(token.replace(/[.,]/gu, ''))]) if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

function visibleText(graph: PageGraph, blocks: readonly string[]): string {
  return [graph.doc.parsed.bodyText, ...blocks, ...attributeText(graph.doc.parsed.document)].join(' \n ');
}

export const visibleContentParity: RuleImplementation = {
  id: 'schema-visible-content-parity',
  evaluate(context) {
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const checked: Array<{ node: GraphNode; property: string; value: string }> = [];
    for (const offer of nodesOfType(graph, 'Offer')) for (const value of texts(graph, offer, 'price')) checked.push({ node: offer, property: 'price', value });
    for (const rating of nodesOfType(graph, 'AggregateRating')) {
      for (const property of ['ratingValue', 'reviewCount', 'ratingCount']) for (const value of texts(graph, rating, property)) checked.push({ node: rating, property, value });
    }
    const numeric = checked.filter(entry => plainNumber(entry.value) !== undefined);
    if (numeric.length === 0) return { outcome: 'not_applicable', reason: 'no-checked-values' };
    // Hidden render blocks count as present: tabs, accordions and reveal-on-scroll sections are visible to users.
    const blocks = context.page!.rendered?.result.textBlocks.map(block => block.text) ?? [];
    const numbers = numbersIn(visibleText(graph, blocks));
    const problems: Problem[] = numeric.filter(entry => !numbers.some(number => Math.abs(number - plainNumber(entry.value)!) < 0.005)).map(entry => ({
      reason: 'value-not-on-page', severity: 'medium', subject: `${entry.property}: ${entry.value}`, needsJudgment: true,
      evidence: cite(context, graph, entry.node, evidenceLabel('{property} not found in the page text', { property: entry.property }), entry.property, entry.value),
    }));
    return report(problems);
  },
};

const isFeatureNode = (node: GraphNode) => pageFeatureTypes.some(type => isA(node.types, type))
  && (node.parent === undefined || node.parent.property === 'mainEntity');

export const blockedOrNonindexableCarrier: RuleImplementation = {
  id: 'schema-blocked-or-nonindexable-carrier',
  evaluate(context) {
    const page = context.page!;
    if (page.pageType === 'legal') return { outcome: 'not_applicable', reason: 'legal-page' };
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const features = graph.nodes.filter(node => node.schemaOrg && isFeatureNode(node));
    if (features.length === 0) return { outcome: 'not_applicable', reason: 'no-feature-markup' };
    const first = features[0]!;
    const problems: Problem[] = [];
    const subject = first.types.join('+');
    if (page.fetch.status !== 200) {
      problems.push({ reason: 'not-200', severity: 'medium', subject, also: [cite(context, graph, first, evidenceLabel('feature markup on the page'))],
        evidence: context.evidence.add({ kind: 'http', url: page.fetch.finalUrl, label: evidenceLabel('final HTTP status of the page'), excerpt: String(page.fetch.status ?? 'no response') }) });
    }
    const directives = robotsDirectives(page.fetch.headers, graph.doc);
    if (directivesFor(directives).has('noindex')) {
      const source = directives.find(entry => entry.directives.includes('noindex') || entry.directives.includes('none'));
      problems.push({ reason: 'noindex', severity: 'medium', subject, also: [cite(context, graph, first, evidenceLabel('feature markup on the page'))],
        evidence: context.evidence.add({ kind: source?.source === 'header' ? 'header' : 'html', url: page.fetch.finalUrl, label: evidenceLabel('noindex directive for Googlebot'),
          excerpt: source?.raw ?? 'noindex', ...(source?.line ? { line: source.line } : {}) }) });
    }
    const robots = context.site.robots?.availability;
    const url = new URL(page.fetch.finalUrl);
    if (robots?.kind === 'parsed' && url.origin === context.site.origin) {
      const decision = isAllowed(robots.file, ['googlebot'], `${url.pathname}${url.search}`);
      if (!decision.allowed) {
        problems.push({ reason: 'disallowed', severity: 'medium', subject, also: [cite(context, graph, first, evidenceLabel('feature markup on the page'))],
          evidence: context.evidence.add({ kind: 'robots', url: context.site.robots!.url, label: evidenceLabel('robots.txt rule that disallows the page for Googlebot'),
            excerpt: `${decision.rule?.type}: ${decision.rule?.pattern}`, ...(decision.rule ? { line: decision.rule.line } : {}) }) });
      }
    }
    for (const node of features) {
      const property = isA(node.types, 'VideoObject') ? 'thumbnailUrl' : 'image';
      for (const image of imageUrls(graph, node, property)) {
        const rule = blockedForImages(context.site, image);
        if (rule) {
          problems.push({ reason: 'image-blocked', severity: 'high', subject: image, also: [cite(context, graph, node, evidenceLabel('{property} of a feature item', { property }), property, image)],
            evidence: context.evidence.add({ kind: 'robots', url: context.site.robots!.url, label: evidenceLabel('robots.txt rule that disallows the image for Googlebot-Image'), excerpt: rule }) });
        }
        const fetched = context.site.resources.find(resource => resource.url === image);
        if (fetched && (fetched.fetch.status !== 200 || !/^image\//iu.test(fetched.fetch.headers['content-type']?.[0] ?? 'image/'))) {
          problems.push({ reason: 'image-unavailable', severity: 'high', subject: image, also: [cite(context, graph, node, evidenceLabel('{property} of a feature item', { property }), property, image)],
            evidence: context.evidence.add({ kind: 'http', url: image, label: evidenceLabel('response for the image'), excerpt: `${fetched.fetch.status ?? 'no response'} ${fetched.fetch.headers['content-type']?.[0] ?? ''}`.trim() }) });
        }
      }
    }
    return report(problems, [cite(context, graph, first, evidenceLabel('feature markup on the page'))]);
  },
};
