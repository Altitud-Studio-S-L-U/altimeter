import { evidenceLabel, joinLabels } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { HtmlElement } from '../../parse/html.ts';
import type { RuleImplementation } from '../engine.ts';
import { absoluteUrl, pageDocument, sameSite } from '../helpers.ts';
import { attr, auditedPages, citer, detailItems, elements, fail, firstHeader, isHttps, isLoopback, lighthouseSummary, lineOf, notApplicable, pass, startTag, summarizeUrls, type Cite } from './shared.ts';

interface Insecure {
  readonly url: string;
  readonly kind: string;
  readonly source: string;
  readonly excerpt: string;
  readonly line?: number | undefined;
}

function insecure(url: string | undefined): url is string {
  return url !== undefined && /^(http|ws):/iu.test(url) && !isLoopback(url);
}

function srcsetUrls(value: string | undefined, base: string): string[] {
  if (!value) return [];
  return value.split(',').map(part => absoluteUrl(part.trim().split(/\s+/u)[0], base)).filter((url): url is string => url !== undefined);
}

function upgradesInsecureRequests(page: PageFacts, doc: DocumentFacts | undefined): boolean {
  const header = firstHeader(page.fetch.headers, 'content-security-policy') ?? '';
  if (/upgrade-insecure-requests/iu.test(header)) return true;
  return (doc?.parsed.metas ?? []).some(meta => (meta.attrs['http-equiv'] ?? '').toLowerCase() === 'content-security-policy' && /upgrade-insecure-requests/iu.test(meta.attrs.content ?? ''));
}

const activeTags = ['script', 'link', 'iframe', 'frame', 'object', 'embed', 'form'] as const;

function activeReference(element: HtmlElement, base: string): { url: string; kind: string } | undefined {
  const tag = element.tagName;
  if (tag === 'script') return { url: absoluteUrl(attr(element, 'src'), base) ?? '', kind: 'script' };
  if (tag === 'link') {
    const rel = (attr(element, 'rel') ?? '').toLowerCase().split(/\s+/u);
    const as = (attr(element, 'as') ?? '').toLowerCase();
    const blockable = rel.includes('stylesheet') || rel.includes('modulepreload') || (rel.includes('preload') && ['script', 'style', 'font', 'fetch', 'worker'].includes(as));
    return blockable ? { url: absoluteUrl(attr(element, 'href'), base) ?? '', kind: rel.includes('stylesheet') ? 'stylesheet' : `preload ${as || 'module'}` } : undefined;
  }
  if (tag === 'iframe' || tag === 'frame') return { url: absoluteUrl(attr(element, 'src'), base) ?? '', kind: 'frame' };
  if (tag === 'object') return { url: absoluteUrl(attr(element, 'data'), base) ?? '', kind: 'object' };
  if (tag === 'embed') return { url: absoluteUrl(attr(element, 'src'), base) ?? '', kind: 'embed' };
  if (tag === 'form') return { url: absoluteUrl(attr(element, 'action'), base) ?? '', kind: 'form' };
  return undefined;
}

const blockableTypes = new Set(['Script', 'Stylesheet', 'Document', 'XHR', 'Fetch', 'Font', 'WebSocket', 'EventSource', 'Manifest', 'Other']);

function activeMixedContent(page: PageFacts, doc: DocumentFacts, source: string): Insecure[] {
  const base = page.fetch.finalUrl;
  const found: Insecure[] = [];
  for (const element of elements(doc, [...activeTags])) {
    const reference = activeReference(element, base);
    // Insecure forms on the site's own hosts are counted by tech-internal-links-to-http.
    if (reference?.kind === 'form' && sameSite(reference.url, base)) continue;
    if (reference && insecure(reference.url)) found.push({ url: reference.url, kind: reference.kind, source, excerpt: startTag(doc, element), line: lineOf(element) });
  }
  const summary = lighthouseSummary(page);
  for (const item of detailItems(summary?.audits['network-requests'])) {
    const url = typeof item.url === 'string' ? item.url : undefined;
    const type = typeof item.resourceType === 'string' ? item.resourceType : '';
    if (insecure(url) && blockableTypes.has(type) && !found.some(entry => entry.url === url)) {
      found.push({ url, kind: type.toLowerCase(), source: 'Lighthouse network request', excerpt: `${type} ${url}` });
    }
  }
  return found;
}

function report(cite: Cite, page: PageFacts, found: readonly Insecure[]): string[] {
  return found.slice(0, 20).map(entry => cite({
    kind: entry.source === 'Lighthouse network request' ? 'lighthouse' : 'html',
    url: page.fetch.finalUrl,
    label: joinLabels(evidenceLabel('{resource} loaded over an insecure scheme on an HTTPS page', { resource: entry.kind }),
      entry.source === 'raw HTML' ? evidenceLabel('(raw HTML)') : entry.source === 'rendered DOM' ? evidenceLabel('(rendered DOM)') : evidenceLabel('(Lighthouse network request)')),
    excerpt: entry.excerpt,
    line: entry.line,
  }));
}

export const mixedContentActive: RuleImplementation = {
  id: 'tech-mixed-content-active',
  evaluate(context) {
    const page = context.page!;
    if (!isHttps(page.fetch.finalUrl)) return notApplicable('not-https');
    const raw = page.raw!;
    const rendered = pageDocument(page);
    const cite = citer(context);
    const found = activeMixedContent(page, raw, 'raw HTML');
    if (rendered && rendered !== raw) {
      for (const entry of activeMixedContent(page, rendered, 'rendered DOM')) if (!found.some(existing => existing.url === entry.url)) found.push(entry);
    }
    if (found.length === 0) return pass();
    if (upgradesInsecureRequests(page, rendered ?? raw)) {
      return pass([cite({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('Content-Security-Policy upgrades insecure requests'), excerpt: 'upgrade-insecure-requests' })]);
    }
    const evidence = report(cite, page, found);
    const blocked = found.filter(entry => entry.kind !== 'form');
    const params = { count: found.length, urls: summarizeUrls(found.map(entry => entry.url)) };
    if (blocked.length === 0) return fail('medium', evidence, 'insecure-form', params);
    return fail('high', evidence, undefined, { ...params, count: blocked.length, urls: summarizeUrls(blocked.map(entry => entry.url)) });
  },
};

const mediaTags = ['img', 'source', 'audio', 'video', 'track', 'input'] as const;

function passiveMixedContent(page: PageFacts, doc: DocumentFacts, source: string): Insecure[] {
  const base = page.fetch.finalUrl;
  const found: Insecure[] = [];
  for (const element of elements(doc, [...mediaTags])) {
    if (element.tagName === 'input' && (attr(element, 'type') ?? '').toLowerCase() !== 'image') continue;
    const urls = [
      absoluteUrl(attr(element, 'src'), base),
      ...srcsetUrls(attr(element, 'srcset'), base),
      ...(element.tagName === 'video' ? [absoluteUrl(attr(element, 'poster'), base)] : []),
    ];
    for (const url of urls) {
      if (insecure(url) && !found.some(entry => entry.url === url)) found.push({ url, kind: element.tagName, source, excerpt: startTag(doc, element), line: lineOf(element) });
    }
  }
  return found;
}

export const mixedContentPassive: RuleImplementation = {
  id: 'tech-mixed-content-passive',
  evaluate(context) {
    const page = context.page!;
    if (!isHttps(page.fetch.finalUrl)) return notApplicable('not-https');
    const raw = page.raw!;
    const rendered = pageDocument(page);
    const found = passiveMixedContent(page, raw, 'raw HTML');
    if (rendered && rendered !== raw) {
      for (const entry of passiveMixedContent(page, rendered, 'rendered DOM')) if (!found.some(existing => existing.url === entry.url)) found.push(entry);
    }
    if (found.length === 0) return pass();
    const cite = citer(context);
    if (upgradesInsecureRequests(page, rendered ?? raw)) {
      return pass([cite({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('Content-Security-Policy upgrades insecure requests'), excerpt: 'upgrade-insecure-requests' })]);
    }
    const failedUpgrades = new Set((page.rendered?.result.failed ?? []).map(entry => entry.url.replace(/^https:/u, 'http:')));
    const missing = found.filter(entry => failedUpgrades.has(entry.url));
    return fail('low', report(cite, page, found), missing.length > 0 ? 'upgrade-failed' : undefined, { count: found.length, urls: summarizeUrls(found.map(entry => entry.url)) });
  },
};

export const internalLinksToHttp: RuleImplementation = {
  id: 'tech-internal-links-to-http',
  evaluate(context) {
    const cite = citer(context);
    const pages = auditedPages(context.site).filter(page => isHttps(page.fetch.finalUrl) && (page.raw ?? page.rendered));
    if (pages.length === 0) return notApplicable('not-https');
    const found: Insecure[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      const doc = pageDocument(page)!;
      const base = page.fetch.finalUrl;
      for (const element of elements(doc, ['a', 'area', 'form'])) {
        const url = absoluteUrl(attr(element, element.tagName === 'form' ? 'action' : 'href'), base);
        if (!url || !url.startsWith('http:') || !sameSite(url, base) || seen.has(`${base} ${url}`)) continue;
        seen.add(`${base} ${url}`);
        found.push({ url, kind: element.tagName, source: base, excerpt: startTag(doc, element), line: lineOf(element) });
      }
    }
    if (found.length === 0) return pass();
    const evidence = found.slice(0, 20).map(entry => cite({ kind: 'html', url: entry.source, label: entry.kind === 'form' ? evidenceLabel('internal form action that uses http://') : evidenceLabel('internal link that uses http://'), excerpt: entry.excerpt, line: entry.line }));
    return fail('medium', evidence, undefined, { count: found.length, urls: summarizeUrls([...new Set(found.map(entry => entry.url))]) });
  },
};
