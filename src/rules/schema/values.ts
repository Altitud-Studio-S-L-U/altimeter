import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, linksWithRel } from '../helpers.ts';
import { isExternalTerm, text, topLevel, type GraphNode, type PageGraph } from './graph.ts';
import { documentedFor } from './features.ts';
import { certainlyBefore, cite, fetchTime, hostOf, isResult, pageGraph, parseIsoDate, report, sameHost, type Problem } from './support.ts';
import { isA } from './vocabulary.ts';

function overNodes(context: RuleContext, check: (graph: PageGraph, node: GraphNode) => Problem[], none = 'no-schema-org-markup'): RuleResult[] | RuleResult {
  const graph = pageGraph(context);
  if (isResult(graph)) return graph;
  const nodes = graph.nodes.filter(node => node.schemaOrg);
  if (nodes.length === 0) return { outcome: 'not_applicable', reason: none };
  return report(nodes.flatMap(node => check(graph, node)));
}

/** Text values written on the node itself, per property. */
function ownTexts(node: GraphNode, property: string): string[] {
  return (node.properties.get(property) ?? []).flatMap(value => (value.kind === 'text' ? [value.value] : value.kind === 'number' ? [String(value.value)] : []));
}

const urlProperties = ['url', 'image', 'logo', 'sameAs', 'item', 'contentUrl', 'embedUrl', 'thumbnailUrl', 'acquireLicensePage', 'license', 'menu',
  'mainEntityOfPage', 'target'];
const stagingLabel = /^(?:staging|stage|stg|dev|develop|development|test|testing|preprod|pre-prod|qa|uat|sandbox)\d*$|-(?:staging|dev|preprod)$|^(?:staging|dev|preprod)-/u;

function isStagingHost(host: string): boolean {
  if (host === 'localhost' || /\.(?:local|localhost|internal|lan)$/u.test(host)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.startsWith('[')) return true;
  return host.split('.').slice(0, -2).some(label => stagingLabel.test(label));
}

const sameDocument = (a: string, b: string) => {
  const strip = (value: string) => value.replace(/#.*$/u, '').replace(/\/$/u, '');
  return strip(a) === strip(b);
};

export const urlValues: RuleImplementation = {
  id: 'schema-url-values',
  evaluate(context) {
    const pageHost = hostOf(context.page!.fetch.finalUrl)!;
    const https = context.page!.fetch.finalUrl.startsWith('https:');
    return overNodes(context, (graph, node) => {
      const problems: Problem[] = [];
      const add = (reason: string, severity: Problem['severity'], property: string, value: string, label: EvidenceLabel) =>
        problems.push({ reason, severity, subject: `${property}: ${value}`, evidence: cite(context, graph, node, label, property, value) });
      if (node.id !== undefined && /^https?:/iu.test(node.id)) {
        const host = hostOf(node.id);
        if (host && host !== pageHost && isStagingHost(host)) add('staging-host', 'medium', '@id', node.id, evidenceLabel('@id on a local, staging or IP host'));
      }
      for (const property of urlProperties) {
        for (const raw of ownTexts(node, property)) {
          const value = raw.trim();
          if (value === '' || value.startsWith('#')) continue;
          // license and menu also take free text such as a licence name.
          if ((property === 'license' || property === 'menu') && /\s/u.test(value)) continue;
          const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
          if (value.startsWith('//')) { add('relative', 'low', property, value, evidenceLabel('protocol-relative URL')); continue; }
          if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
            add('unsupported-scheme', 'medium', property, value.slice(0, 80), evidenceLabel('URL with a {scheme}: scheme', { scheme }));
            continue;
          }
          const resolved = absoluteUrl(value, graph.base);
          if (resolved === undefined || (scheme !== undefined && !URL.canParse(value))) { add('invalid', 'medium', property, value, evidenceLabel('value that is not a valid URL')); continue; }
          // Microdata URL properties resolve to absolute URLs by the HTML standard, so only JSON-LD values are fragile.
          if (scheme === undefined) { if (node.syntax === 'json-ld') add('relative', 'low', property, value, evidenceLabel('relative URL')); continue; }
          const host = hostOf(resolved)!;
          if (host !== pageHost && isStagingHost(host)) add('staging-host', 'medium', property, value, evidenceLabel('URL on a local, staging or IP host'));
          else if (https && scheme === 'http' && sameHost(host, pageHost)) add('insecure', 'medium', property, value, evidenceLabel('http URL on an https site'));
        }
      }
      if (node.parent === undefined && isA(node.types, 'WebPage') && topLevel(graph).filter(entry => isA(entry.types, 'WebPage')).length === 1) {
        const canonical = absoluteUrl(linksWithRel(graph.doc, 'canonical')[0]?.attrs.href, graph.base);
        const url = text(graph, node, 'url');
        const resolved = absoluteUrl(url, graph.base);
        if (canonical && resolved && !sameDocument(resolved, canonical)) add('not-canonical', 'medium', 'url', url!, evidenceLabel('WebPage url that differs from the canonical {url}', { url: canonical }));
      }
      return problems;
    });
  },
};

const dateProperties = ['datePublished', 'dateModified', 'dateCreated', 'uploadDate', 'startDate', 'endDate', 'validFrom', 'validThrough',
  'priceValidUntil', 'datePosted', 'foundingDate', 'dissolutionDate', 'expires', 'previousStartDate', 'doorTime'];
const durationProperties = ['duration', 'prepTime', 'cookTime', 'totalTime', 'timeRequired'];
const timeProperties = ['opens', 'closes'];
const durationPattern = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/u;
const timePattern = /^([01]\d|2[0-4]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/u;

export const iso8601Values: RuleImplementation = {
  id: 'schema-iso8601-values',
  evaluate: context => overNodes(context, (graph, node) => {
    const problems: Problem[] = [];
    const severity = (property: string) => (documentedFor(node.types, property) ? 'medium' : 'low');
    const add = (reason: string, level: Problem['severity'], property: string, value: string, label: EvidenceLabel) =>
      problems.push({ reason, severity: level, subject: `${property}: ${value}`, evidence: cite(context, graph, node, label, property, value) });
    for (const property of dateProperties) {
      for (const value of (node.properties.get(property) ?? [])) {
        if (value.kind === 'number') { add('invalid-date', severity(property), property, String(value.value), evidenceLabel('date written as a number')); continue; }
        if (value.kind !== 'text' || value.value.trim() === '') continue;
        const parsed = parseIsoDate(value.value);
        if (!parsed) add('invalid-date', severity(property), property, value.value, evidenceLabel('date that is not ISO 8601'));
        else if (parsed.precision === 'time' && !parsed.offset) add('missing-offset', 'low', property, value.value, evidenceLabel('date-time without a time zone offset'));
      }
    }
    for (const property of durationProperties) {
      for (const value of ownTexts(node, property)) {
        if (!durationPattern.test(value.trim())) add('invalid-duration', severity(property), property, value, evidenceLabel('duration that is not ISO 8601'));
      }
    }
    for (const property of timeProperties) {
      for (const value of ownTexts(node, property)) {
        if (!timePattern.test(value.trim())) add('invalid-time', severity(property), property, value, evidenceLabel('time that is not hh:mm[:ss]'));
      }
    }
    return problems;
  }, 'no-schema-org-markup'),
};

const day = 86_400_000;
const zoneSpread = 14 * 3_600_000;

export const dateLogic: RuleImplementation = {
  id: 'schema-date-logic',
  evaluate(context) {
    const now = fetchTime(context.page!);
    const graph = pageGraph(context);
    if (isResult(graph)) return graph;
    const nodes = graph.nodes.filter(node => node.schemaOrg && [...dateProperties].some(property => node.properties.has(property)));
    if (nodes.length === 0) return { outcome: 'not_applicable', reason: 'no-dates' };
    const problems: Problem[] = [];
    for (const node of nodes) {
      const date = (property: string) => {
        const value = ownTexts(node, property)[0];
        const parsed = value === undefined ? undefined : parseIsoDate(value);
        return parsed ? { value: value!, parsed } : undefined;
      };
      const add = (reason: string, property: string, value: string, label: EvidenceLabel) =>
        problems.push({ reason, severity: 'medium', subject: `${property}: ${value}`, evidence: cite(context, graph, node, label, property, value) });
      for (const [later, earlier, reason] of [['dateModified', 'datePublished', 'modified-before-published'], ['endDate', 'startDate', 'end-before-start'],
        ['validThrough', 'validFrom', 'valid-through-before-valid-from']] as const) {
        const a = date(later);
        const b = date(earlier);
        if (a && b && certainlyBefore(a.parsed, b.parsed)) add(reason, later, a.value, evidenceLabel('{later} earlier than {earlier} {value}', { later, earlier, value: b.value }));
      }
      if (now === undefined) continue;
      for (const property of ['datePublished', 'uploadDate']) {
        const entry = date(property);
        if (!entry) continue;
        const earliest = entry.parsed.time - (entry.parsed.precision === 'time' && entry.parsed.offset ? 0 : zoneSpread);
        if (earliest > now + day) add('published-in-future', property, entry.value, evidenceLabel('publication date more than a day after the fetch'));
      }
      const expiry = (property: string, reason: string, label: EvidenceLabel) => {
        const entry = date(property);
        if (!entry) return;
        const latest = entry.parsed.time + (entry.parsed.precision === 'time' ? (entry.parsed.offset ? 0 : zoneSpread) : day + zoneSpread);
        if (latest < now) add(reason, property, entry.value, label);
      };
      if (isA(node.types, 'Offer') || node.parent?.property === 'offers') expiry('priceValidUntil', 'price-valid-until-past', evidenceLabel('priceValidUntil before the fetch date'));
      if (isA(node.types, 'VideoObject')) expiry('expires', 'video-expired', evidenceLabel('video expiry before the fetch date'));
    }
    return report(problems);
  },
};

const templateLeak = /^(?:null|undefined|nan|\[object object\])$/iu;
const templateToken = /\{\{[^}]*\}\}|\{%[^%]*%\}|\$\{[^}]*\}|%s\b|^\[[A-Za-z_ ]{2,30}\]$/u;
const placeholderText = /^(?:your (?:company|business|brand|name)(?: name)?|company name|business name|todo|tbd|xxx+)$|^todo\b[:\s]/iu;
const exampleHost = /(?:^|\.)example\.(?:com|org|net)$/u;
const htmlTag = /<\/?(?:p|br|div|span|strong|em|b|i|a|ul|ol|li|h[1-6])\b[^>]*>|&(?:amp|nbsp|quot|lt|gt|#\d+);/iu;
const shortTextProperties = new Set(['name', 'headline', 'alternateName', 'description']);

function placeholderPhone(value: string): boolean {
  const digits = value.replace(/\D/gu, '');
  return digits.length >= 6 && (/^0+$/u.test(digits) || /^(?:1234567890|0123456789|123456789)$/u.test(digits));
}

export const placeholderJunkValues: RuleImplementation = {
  id: 'schema-placeholder-junk-values',
  evaluate(context) {
    const pageHost = hostOf(context.page!.fetch.finalUrl) ?? '';
    return overNodes(context, (graph, node) => {
      const problems: Problem[] = [];
      const add = (reason: string, severity: Problem['severity'], property: string, value: string, label: EvidenceLabel) =>
        problems.push({ reason, severity, subject: `${property}: ${value.slice(0, 60)}`, evidence: cite(context, graph, node, label, property, value) });
      for (const [property, entries] of node.properties) {
        if (isExternalTerm(property)) continue;
        for (const entry of entries) {
          if (entry.kind === 'null') { add('empty-value', 'medium', property, 'null', evidenceLabel('property emitted as null')); continue; }
          if (entry.kind !== 'text') continue;
          const value = entry.value;
          const trimmed = value.trim();
          // An empty Microdata element is usually layout; an empty JSON-LD string is a template that emitted a field without data.
          if (trimmed === '') { if (node.syntax === 'json-ld') add('empty-value', 'medium', property, value, evidenceLabel('property emitted empty')); }
          else if (templateLeak.test(trimmed)) add('template-leak', 'high', property, value, evidenceLabel('value printed from an unset variable'));
          else if (templateToken.test(trimmed)) add('template-token', 'high', property, value, evidenceLabel('unrendered template token'));
          else if (/lorem ipsum/iu.test(trimmed)) add('placeholder-text', 'high', property, value, evidenceLabel('filler text'));
          else if (placeholderText.test(trimmed)) add('placeholder-text', 'medium', property, value, evidenceLabel('placeholder text'));
          else if ((property === 'telephone' || property === 'faxNumber') && placeholderPhone(trimmed)) add('placeholder-phone', 'medium', property, value, evidenceLabel('placeholder phone number'));
          else {
            const host = /^(?:https?:)?\/\//iu.test(trimmed) ? hostOf(trimmed) : /^[^\s@]+@([^\s@]+)$/u.exec(trimmed.replace(/^mailto:/iu, ''))?.[1]?.toLowerCase();
            if (host && exampleHost.test(host) && !exampleHost.test(pageHost)) add('example-domain', 'high', property, value, evidenceLabel('example domain left in the markup'));
            else if (shortTextProperties.has(property) && !(property === 'description' && isA(node.types, 'JobPosting')) && htmlTag.test(trimmed)) {
              add('html-in-text', 'low', property, value, evidenceLabel('HTML tags or entities inside a text value'));
            }
          }
        }
      }
      return problems;
    });
  },
};
