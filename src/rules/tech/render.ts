import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import type { RuleImplementation } from '../engine.ts';
import { absoluteUrl, sameSite } from '../helpers.ts';
import { attr, citer, detailItems, elements, fail, isMeasurementUrl, lighthouseSummary, pass, shorten, summarizeUrls, wordCount, worst, type Cite } from './shared.ts';

const urlPattern = /\b(?:https?|wss?):\/\/[^\s'"<>)]+/giu;

function urlsIn(text: string): string[] {
  return [...text.matchAll(urlPattern)].map(match => match[0].replace(/[.,;:]+$/u, ''));
}

interface ConsoleError {
  readonly text: string;
  readonly kind: 'csp-first-party' | 'script';
}

/** JavaScript errors that can change what renders; failed resource loads are reported by tech-failed-render-requests. */
function scriptErrors(page: PageFacts): ConsoleError[] {
  const result = page.rendered!.result;
  const ignored = new Set([...result.blockedByRobots, ...result.failed.map(entry => entry.url)]);
  const errors: ConsoleError[] = [];
  for (const entry of result.console) {
    const text = entry.text.trim();
    if (text === '' || /^Failed to load resource\b/iu.test(text) || /ERR_BLOCKED_BY_CLIENT/u.test(text)) continue;
    const urls = urlsIn(text);
    const thirdParty = urls.filter(url => !sameSite(url, page.fetch.finalUrl));
    // Errors raised by measurement scripts, or by third-party scripts that were blocked or failed, leave the content alone.
    if (urls.some(url => isMeasurementUrl(url)) || thirdParty.some(url => ignored.has(url))) continue;
    if (/Content Security Policy/iu.test(text) && /^Refused to/iu.test(text)) {
      const blocked = urls.find(url => !/^https?:\/\/(www\.)?w3\.org\//u.test(url));
      if (blocked && sameSite(blocked, page.fetch.finalUrl)) {
        errors.push({ text, kind: 'csp-first-party' });
        continue;
      }
    }
    errors.push({ text, kind: 'script' });
  }
  return errors;
}

const appRoot = /^(root|app|__next|__nuxt|___gatsby|svelte|main-app)$/u;

/** Whether the render lost the content the served HTML has, or left an application root empty. */
function contentMissing(raw: DocumentFacts | undefined, rendered: DocumentFacts): { missing: boolean; excerpt: string } {
  const rawWords = raw ? wordCount(raw.parsed.bodyText) : 0;
  const renderedWords = wordCount(rendered.parsed.bodyText);
  const excerpt = `raw=${rawWords} rendered=${renderedWords}`;
  if (rawWords >= 100 && renderedWords < rawWords * 0.5) return { missing: true, excerpt };
  const emptyRoot = elements(rendered, ['div', 'main']).some(element => appRoot.test(attr(element, 'id') ?? '') && element.childNodes.length === 0);
  return { missing: renderedWords < 20 && emptyRoot, excerpt };
}

export const consoleErrors: RuleImplementation = {
  id: 'tech-console-errors',
  evaluate(context) {
    const page = context.page!;
    const errors = scriptErrors(page);
    if (errors.length === 0) return pass();
    const cite = citer(context);
    const url = page.fetch.finalUrl;
    const evidence = errors.slice(0, 10).map(error => cite({ kind: 'render', url, label: error.kind === 'csp-first-party' ? evidenceLabel('Content Security Policy refused a first-party resource during the render') : evidenceLabel('JavaScript error during the Googlebot-like render'), excerpt: shorten(error.text, 500) }));
    const lighthouse = detailItems(lighthouseSummary(page)?.audits['errors-in-console']);
    for (const item of lighthouse.slice(0, 3)) evidence.push(cite({ kind: 'lighthouse', url, label: evidenceLabel('error reported by the Lighthouse errors-in-console audit'), excerpt: shorten(String(item.description ?? ''), 500) }));
    const content = contentMissing(page.raw, page.rendered!);
    const params = { count: errors.length, first: shorten(errors[0]!.text, 160) };
    if (content.missing) {
      evidence.push(cite({ kind: 'text', url, label: evidenceLabel('body word count in the raw HTML and in the render'), excerpt: content.excerpt }));
      return fail('medium', evidence, 'content-missing', params);
    }
    if (errors.some(error => error.kind === 'csp-first-party')) return fail('medium', evidence, 'csp-blocks-first-party', params);
    return fail('low', evidence, undefined, params);
  },
};

type Role = 'stylesheet' | 'script' | 'fetch' | 'font' | 'image' | 'document' | 'other';

function roleFromType(type: string): Role | undefined {
  switch (type) {
    case 'Stylesheet': return 'stylesheet';
    case 'Script': return 'script';
    case 'XHR':
    case 'Fetch': return 'fetch';
    case 'Font': return 'font';
    case 'Image': return 'image';
    case 'Document': return 'document';
    default: return type === '' ? undefined : 'other';
  }
}

/** Roles of URLs the document references directly, so a failed request can be classified without a network log. */
function referencedRoles(doc: DocumentFacts, base: string): Map<string, Role> {
  const roles = new Map<string, Role>();
  for (const element of elements(doc, ['script', 'link'])) {
    if (element.tagName === 'script') {
      const src = absoluteUrl(attr(element, 'src'), base);
      if (src) roles.set(src, 'script');
      continue;
    }
    const rel = (attr(element, 'rel') ?? '').toLowerCase().split(/\s+/u);
    const href = absoluteUrl(attr(element, 'href'), base);
    if (!href) continue;
    if (rel.includes('stylesheet')) roles.set(href, 'stylesheet');
    else if (rel.includes('modulepreload')) roles.set(href, 'script');
    else if (rel.includes('preload')) {
      const as = (attr(element, 'as') ?? '').toLowerCase();
      roles.set(href, as === 'style' ? 'stylesheet' : as === 'script' ? 'script' : as === 'font' ? 'font' : as === 'image' ? 'image' : as === 'fetch' ? 'fetch' : 'other');
    }
  }
  return roles;
}

function roleFromPath(url: string): Role {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.css$/u.test(path)) return 'stylesheet';
  if (/\.(m?js)$/u.test(path)) return 'script';
  if (/\.(woff2?|ttf|otf|eot)$/u.test(path)) return 'font';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/u.test(path)) return 'image';
  return 'other';
}

function severityFor(role: Role, firstParty: boolean): Severity {
  if (role === 'stylesheet' || role === 'script') return firstParty ? 'high' : 'medium';
  if (role === 'fetch') return firstParty ? 'medium' : 'low';
  return 'low';
}

interface FailedRequest {
  readonly url: string;
  readonly error: string;
  readonly role: Role;
  readonly severity: Severity;
  readonly source: 'render' | 'lighthouse';
}

function failedRequests(page: PageFacts): FailedRequest[] {
  const base = page.fetch.finalUrl;
  const rendered = page.rendered!;
  const roles = referencedRoles(rendered, base);
  const found = new Map<string, FailedRequest>();
  const add = (url: string, error: string, type: string, source: FailedRequest['source'], status = 0) => {
    if (!/^https?:/u.test(url) || isMeasurementUrl(url) || found.has(url)) return;
    const role = roles.get(url) ?? roleFromType(type) ?? roleFromPath(url);
    // An API that answers 401 or 403 to an anonymous visitor is working as designed.
    if (role === 'fetch' && (status === 401 || status === 403)) return;
    found.set(url, { url, error, role, severity: severityFor(role, sameSite(url, base)), source });
  };
  for (const entry of rendered.result.failed) {
    // Aborted requests are cancelled by the page or the browser, such as superseded fetches or media, not failures.
    if (/ERR_ABORTED/u.test(entry.error)) continue;
    add(entry.url, entry.error, '', 'render');
  }
  for (const item of detailItems(lighthouseSummary(page)?.audits['network-requests'])) {
    const status = typeof item.statusCode === 'number' ? item.statusCode : 0;
    if (typeof item.url === 'string' && status >= 400 && item.url !== base) add(item.url, `HTTP ${status}`, typeof item.resourceType === 'string' ? item.resourceType : '', 'lighthouse', status);
  }
  return [...found.values()];
}

function citeRequest(cite: Cite, page: PageFacts, request: FailedRequest): string {
  return cite({
    kind: request.source === 'lighthouse' ? 'lighthouse' : 'render',
    url: page.fetch.finalUrl,
    label: request.source === 'lighthouse' ? evidenceLabel('{role} request that failed during the Lighthouse run', { role: request.role })
      : evidenceLabel('{role} request that failed during the Googlebot-like render', { role: request.role }),
    excerpt: `${request.url} (${request.error})`,
  });
}

export const failedRenderRequests: RuleImplementation = {
  id: 'tech-failed-render-requests',
  evaluate(context) {
    const page = context.page!;
    const requests = failedRequests(page);
    if (requests.length === 0) return pass();
    const cite = citer(context);
    const severity = worst(requests.map(request => request.severity));
    const ranked = [...requests].sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity));
    const evidence = ranked.slice(0, 15).map(request => citeRequest(cite, page, request));
    const critical = ranked.filter(request => request.severity === severity);
    return fail(severity, evidence, severity === 'low' ? 'non-critical' : undefined, { count: requests.length, urls: summarizeUrls(critical.map(request => request.url)) });
  },
};
