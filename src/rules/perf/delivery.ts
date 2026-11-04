import { evidenceLabel, joinLabels, type EvidenceLabel, type EvidenceStore } from '../../core/evidence.ts';
import type { PageFacts } from '../../core/facts.ts';
import { headerValue, type Hop } from '../../fetch/http.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, directivesFor, documentBase, hreflangLinks, pageDocument, robotsDirectives, summarizeList } from '../helpers.ts';
import {
  auditEvidence, auditOf, auditRan, elements, firstParty, formatKib, formatMs, isConsentScript, labEvidence, labOf, networkRequests,
  notApplicable, notEvaluated, num, openingTag, originOf, rows, str, textContent,
} from './shared.ts';

function hopEvidence(evidence: EvidenceStore, hop: Hop): string {
  return evidence.add({ kind: 'redirect', url: hop.url, label: evidenceLabel('HTTP {status} redirect', { status: hop.status }), excerpt: `${hop.status} ${hop.url} -> ${hop.location ?? ''}` });
}

function headerEvidence(evidence: EvidenceStore, url: string, name: string, value: string | undefined, label: EvidenceLabel): string {
  return value === undefined
    ? evidence.add({ kind: 'header', url, label: joinLabels(label, evidenceLabel('(no {header} header)', { header: name })) })
    : evidence.add({ kind: 'header', url, label, excerpt: `${name}: ${value}` });
}

// Render-blocking resources.

const executableTypes = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript']);

export const renderBlocking: RuleImplementation = {
  id: 'perf-render-blocking',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!, 'raw')!;
    const blocking = doc.parsed.scripts.filter(script => script.inHead && script.attrs.src !== undefined && script.attrs.async === undefined
      && script.attrs.defer === undefined && script.attrs.nomodule === undefined
      && executableTypes.has((script.attrs.type ?? '').trim().toLowerCase()) && (script.attrs.type ?? '').trim().toLowerCase() !== 'module');
    const base = page!.fetch.finalUrl;
    const own = blocking.filter(script => !isConsentScript(script.attrs.src, base));
    const consent = blocking.filter(script => isConsentScript(script.attrs.src, base));
    const cite = (list: typeof blocking, label: EvidenceLabel) => list.slice(0, 5).map(script => evidence.add({ kind: 'html', url: page!.url, label, excerpt: openingTag(script), line: script.line }));
    if (own.length > 0) {
      return { outcome: 'fail', severity: 'medium', reason: 'parser-blocking-script', evidence: cite(own, evidenceLabel('parser-blocking script in the head')),
        params: { count: own.length, scripts: summarizeList(own.map(script => script.attrs.src!)) } };
    }
    if (consent.length > 0) {
      return { outcome: 'fail', severity: 'low', reason: 'consent-script', evidence: cite(consent, evidenceLabel('synchronous consent script in the head')),
        params: { count: consent.length, scripts: summarizeList(consent.map(script => script.attrs.src!)) } };
    }
    const summary = labOf(page);
    const insight = auditOf(summary, 'render-blocking-insight');
    // The insight fails on any render-blocking request; only an estimated saving makes it actionable.
    if (summary && insight?.score === 0 && (insight.numericValue ?? 0) > 0) {
      const items = rows(insight.details).filter(row => (num(row.wastedMs) ?? 0) > 0);
      const cited = [auditEvidence(evidence, page!, summary, 'render-blocking-insight', evidenceLabel('Lighthouse render-blocking requests')),
        ...items.slice(0, 5).map(row => labEvidence(evidence, page!, summary, 'render-blocking-insight', evidenceLabel('render-blocking request'), `${str(row.url)}: ${Math.round(num(row.wastedMs)!)} ms`))];
      return { outcome: 'fail', severity: 'low', reason: 'render-blocking-requests', evidence: cited,
        params: { savings: formatMs(insight.numericValue!), requests: summarizeList(items.map(row => str(row.url) ?? '')) } };
    }
    return { outcome: 'pass' };
  },
};

// Document redirects.

function canonicalizationHop(hop: Hop): boolean {
  if (!hop.location) return false;
  try {
    const from = new URL(hop.url);
    const to = new URL(hop.location);
    const host = (value: string) => value.replace(/^www\./u, '');
    const path = (value: string) => value.replace(/\/+$/u, '') || '/';
    return host(from.hostname) === host(to.hostname) && path(from.pathname) === path(to.pathname) && from.search === to.search;
  } catch {
    return false;
  }
}

/** Whether an audited page links to the exact redirecting URL; a link to its target is the fix, not the problem. */
function linkedInternally(requested: string, pages: Iterable<PageFacts>): boolean {
  const url = absoluteUrl(requested, requested);
  for (const entry of pages) {
    const doc = pageDocument(entry);
    if (doc?.parsed.anchors.some(anchor => absoluteUrl(anchor.attrs.href, entry.fetch.finalUrl)?.replace(/#.*$/u, '') === url)) return true;
  }
  return false;
}

/** Two URLs of the same document, ignoring a trailing slash and the fragment. */
function sameDocument(a: string, b: string): boolean {
  const key = (value: string) => {
    const url = absoluteUrl(value, value);
    return url === undefined ? value : url.replace(/#.*$/u, '').replace(/\/+(?=$|\?)/u, '');
  };
  return key(a) === key(b);
}

/** A root that sends visitors to a locale home page, when every locale URL in hreflang answers directly. */
function localeEntryPoint(page: PageFacts, pages: ReadonlyMap<string, PageFacts>): boolean {
  const requested = new URL(page.fetch.requestedUrl);
  const final = new URL(page.fetch.finalUrl);
  if (requested.pathname !== '/' || requested.search !== '' || final.pathname === '/' || page.fetch.status !== 200) return false;
  const doc = pageDocument(page);
  const cluster = hreflangLinks(doc, documentBase(doc, page.fetch.finalUrl)).filter(link => link.href !== undefined && link.hreflang.toLowerCase() !== 'x-default');
  if (cluster.length < 2 || !cluster.some(link => sameDocument(link.href!, page.fetch.finalUrl))) return false;
  return cluster.every(link => {
    const fetched = [...pages.values()].find(entry => sameDocument(entry.fetch.requestedUrl, link.href!));
    return !fetched || (fetched.fetch.status === 200 && fetched.fetch.hops.length === 1);
  });
}

export const documentRedirects: RuleImplementation = {
  id: 'perf-document-redirects',
  evaluate({ page, site, evidence }) {
    const redirects = page!.fetch.hops.filter(hop => hop.location !== undefined);
    if (redirects.length === 0) return { outcome: 'pass' };
    const cited = redirects.map(hop => hopEvidence(evidence, hop));
    if (localeEntryPoint(page!, site.pages)) return { outcome: 'pass', evidence: cited };
    const typed = !linkedInternally(page!.fetch.requestedUrl, site.pages.values());
    if (typed && redirects.every(canonicalizationHop)) return { outcome: 'pass', evidence: cited };
    const summary = labOf(page);
    const lab = summary && auditOf(summary, 'redirects')?.numericValue !== undefined ? [auditEvidence(evidence, page!, summary, 'redirects', evidenceLabel('Lighthouse lab redirect time'))] : [];
    return { outcome: 'fail', severity: 'medium', evidence: [...cited, ...lab], params: { hops: redirects.length, from: page!.fetch.requestedUrl, to: page!.fetch.finalUrl } };
  },
};

// Server response time.

/** Lighthouse's threshold for a slow document response. */
const slowServerMs = 600;

export const serverResponseTime: RuleImplementation = {
  id: 'perf-server-response-time',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const lab = auditOf(summary, 'server-response-time')?.numericValue;
    if (lab === undefined) return notEvaluated('no-lab-value');
    const cited = auditEvidence(evidence, page!, summary, 'server-response-time', evidenceLabel('Lighthouse lab document response time'));
    if (lab <= slowServerMs) return { outcome: 'pass', evidence: [cited] };
    const final = page!.fetch.hops.at(-1);
    const collector = final ? evidence.add({ kind: 'http', url: final.url, label: evidenceLabel('time to response headers measured by the collector, one sample from its location'), excerpt: formatMs(final.ttfbMs) }) : undefined;
    // Two independent slow measurements are stronger than one lab sample.
    const severity = final && final.ttfbMs > slowServerMs ? 'medium' : 'low';
    return { outcome: 'fail', severity, evidence: [cited, ...(collector ? [collector] : [])], params: { lab: formatMs(lab), collector: final ? formatMs(final.ttfbMs) : 'not measured' } };
  },
};

// Text compression.

const compressedEncodings = new Set(['gzip', 'br', 'zstd', 'deflate', 'x-gzip', 'compress']);
const textType = /^(text\/|application\/(javascript|json|ld\+json|xml|xhtml\+xml|rss\+xml|atom\+xml|manifest\+json)|image\/svg\+xml)/iu;
/** Below this size compression saves less than one network packet. */
const compressionMinBytes = 1400;

function uncompressed(contentType: string | undefined, encoding: string | undefined, size: number): boolean {
  if (size <= compressionMinBytes || !textType.test((contentType ?? '').trim())) return false;
  const encodings = (encoding ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
  return !encodings.some(value => compressedEncodings.has(value));
}

export const textCompression: RuleImplementation = {
  id: 'perf-text-compression',
  evaluate({ page, site, evidence }) {
    const results: RuleResult[] = [];
    const { fetch } = page!;
    const type = headerValue(fetch.headers, 'content-type');
    const encoding = headerValue(fetch.headers, 'content-encoding');
    if (fetch.status === 200 && !fetch.truncated && uncompressed(type, encoding, fetch.body.length)) {
      results.push({ outcome: 'fail', severity: 'medium', reason: 'document', params: { size: formatKib(fetch.body.length) },
        evidence: [headerEvidence(evidence, fetch.finalUrl, 'content-encoding', encoding, evidenceLabel('compression of the HTML response')),
          evidence.add({
            kind: 'http', url: fetch.finalUrl,
            label: type === undefined
              ? evidenceLabel('decoded size of the HTML response, served without a Content-Type header: {bytes} bytes', { bytes: fetch.body.length })
              : evidenceLabel('decoded size of the HTML response, served as {type}: {bytes} bytes', { type, bytes: fetch.body.length }),
          })] });
    }
    const assets: Array<{ url: string; label: EvidenceLabel }> = [];
    for (const resource of site.resources) {
      if (resource.referencedBy !== page!.url || resource.fetch.status !== 200) continue;
      const resourceType = headerValue(resource.fetch.headers, 'content-type');
      if (uncompressed(resourceType, headerValue(resource.fetch.headers, 'content-encoding'), resource.fetch.body.length)) {
        const bytes = resource.fetch.body.length;
        assets.push({
          url: resource.url,
          label: resourceType === undefined
            ? evidenceLabel('text resource served without Content-Type or Content-Encoding headers: {bytes} bytes', { bytes })
            : evidenceLabel('text resource served as {type} without a Content-Encoding header: {bytes} bytes', { type: resourceType, bytes }),
        });
      }
    }
    // A response that transfers more bytes than it decodes to was not compressed.
    for (const request of networkRequests(labOf(page))) {
      if (!['Script', 'Stylesheet', 'Document', 'XHR', 'Fetch'].includes(request.resourceType ?? '') || !firstParty(request.url, page!)) continue;
      if (request.url === page!.fetch.finalUrl || request.statusCode !== 200) continue;
      const size = request.resourceSize ?? 0;
      if (size > compressionMinBytes && (request.transferSize ?? 0) >= size && textType.test(request.mimeType ?? '')) {
        assets.push({ url: request.url, label: evidenceLabel('text resource the lab run transferred uncompressed: {transfer} bytes transferred for {size} bytes of content', { transfer: request.transferSize ?? 0, size }) });
      }
    }
    if (assets.length > 0) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'assets', params: { count: assets.length, urls: summarizeList(assets.map(asset => asset.url)) },
        evidence: assets.slice(0, 5).map(asset => evidence.add({ kind: 'http', url: asset.url, label: asset.label })) });
    }
    if (results.length > 0) return results;
    return { outcome: 'pass', evidence: [headerEvidence(evidence, fetch.finalUrl, 'content-encoding', encoding, evidenceLabel('compression of the HTML response'))] };
  },
};

// HTTP protocol.

const staticTypes = new Set(['Script', 'Stylesheet', 'Image', 'Font', 'Media']);
/** Browsers open about six connections per origin on HTTP/1.1, so six requests start to queue. */
const http1QueueRequests = 6;

export const httpProtocol: RuleImplementation = {
  id: 'perf-http-protocol',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const requests = networkRequests(summary).filter(request => staticTypes.has(request.resourceType ?? '') && request.protocol);
    if (requests.length === 0) return notEvaluated('no-network-requests');
    const byOrigin = new Map<string, typeof requests>();
    for (const request of requests) {
      const origin = originOf(request.url);
      if (origin) byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), request]);
    }
    const legacy = [...byOrigin.entries()].filter(([, list]) => list.length >= http1QueueRequests && list.some(request => /^http\/1\./iu.test(request.protocol!)));
    const describe = ([origin, list]: [string, typeof requests]) => labEvidence(evidence, page!, summary, 'network-requests', evidenceLabel('static requests per origin and protocol'),
      `${origin}: ${list.length} static requests; protocols ${[...new Set(list.map(request => request.protocol))].join(', ')}`);
    const own = legacy.filter(([origin]) => firstParty(origin, page!));
    const others = legacy.filter(([origin]) => !firstParty(origin, page!));
    const results: RuleResult[] = [];
    if (own.length > 0) results.push({ outcome: 'fail', severity: 'medium', evidence: own.map(describe), params: { origins: summarizeList(own.map(([origin]) => origin)) } });
    if (others.length > 0) results.push({ outcome: 'fail', severity: 'low', reason: 'third-party', evidence: others.map(describe), params: { origins: summarizeList(others.map(([origin]) => origin)) } });
    return results.length > 0 ? results : [{ outcome: 'pass' }];
  },
};

// Static asset caching.

/** A content hash in a file name, such as app.3f9a1c2e.js or main-B7xk29Qa.css. */
function fingerprinted(url: string): boolean {
  const token = /[._-]([A-Za-z0-9_-]{8,})\.(?:js|mjs|css|woff2?|png|jpe?g|webp|avif|svg|gif)$/u.exec(new URL(url).pathname)?.[1];
  return token !== undefined && /\d/u.test(token) && /[a-z]/iu.test(token);
}

export const staticCacheTtl: RuleImplementation = {
  id: 'perf-static-cache-ttl',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const insight = auditOf(summary, 'cache-insight');
    if (!auditRan(insight)) return notEvaluated('no-cache-insight');
    const items = rows(insight.details).filter(row => str(row.url) !== undefined && firstParty(str(row.url)!, page!));
    if (items.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'cache-insight', evidenceLabel('Lighthouse cache lifetime insight'))] };
    const ttl = (row: (typeof items)[number]) => {
      const lifetime = num(row.cacheLifetimeMs) ?? 0;
      return lifetime === 0 ? 'no TTL' : `TTL ${Math.round(lifetime / 3_600_000)} h`;
    };
    const hashed = items.filter(row => fingerprinted(str(row.url)!));
    const cited = items.slice(0, 5).map(row => labEvidence(evidence, page!, summary, 'cache-insight', evidenceLabel('first-party static resource with a short cache lifetime'), `${str(row.url)}: ${ttl(row)}`));
    return { outcome: 'fail', severity: 'low', ...(hashed.length > 0 ? { reason: 'fingerprinted' } : {}), evidence: cited,
      params: { count: items.length, urls: summarizeList(items.map(row => str(row.url)!)), hashed: hashed.length } };
  },
};

// HTML no-store.

function cacheDirectives(value: string | undefined): Set<string> {
  return new Set((value ?? '').toLowerCase().split(',').map(part => part.trim().split('=')[0]!).filter(Boolean));
}

export const htmlNoStore: RuleImplementation = {
  id: 'perf-html-no-store',
  evaluate({ page, evidence }) {
    const { fetch } = page!;
    if (fetch.status !== 200) return notApplicable('not-200');
    const cacheControl = headerValue(fetch.headers, 'cache-control');
    const directives = cacheDirectives(cacheControl);
    const cited = headerEvidence(evidence, fetch.finalUrl, 'cache-control', cacheControl, evidenceLabel('cache policy of the HTML response'));
    if (!directives.has('no-store')) return { outcome: 'pass', evidence: [cited] };
    const doc = pageDocument(page!);
    if (directivesFor(robotsDirectives(fetch.headers, doc)).has('noindex')) return notApplicable('noindex');
    // Declared private, or holding a login form: personalised HTML is meant to stay out of shared caches.
    if (directives.has('private')) return { outcome: 'pass', evidence: [cited] };
    const login = elements(doc).find(info => info.tag === 'input' && (info.attrs.type ?? '').toLowerCase() === 'password');
    if (login) return { outcome: 'pass', evidence: [cited, evidence.add({ kind: 'html', url: page!.url, label: evidenceLabel('password field on the page'), excerpt: openingTag(login), line: login.line })] };
    const cookie = headerValue(fetch.headers, 'set-cookie');
    if (cookie !== undefined) {
      const names = (fetch.headers['set-cookie'] ?? []).map(value => value.split('=')[0]!.trim()).join(', ');
      return { outcome: 'fail', severity: 'low', reason: 'sets-cookie', needsJudgment: true,
        evidence: [cited, evidence.add({ kind: 'header', url: fetch.finalUrl, label: evidenceLabel('cookie names set by the HTML response'), excerpt: `set-cookie: ${names}` })] };
    }
    return { outcome: 'fail', severity: 'low', evidence: [cited], params: { value: cacheControl ?? '' } };
  },
};

// Back/forward cache.

/** Reasons caused by the automated, headless run or by the browser itself, not by the page. */
const automationReasons = new Set([
  'BackForwardCacheDisabledByCommandLine', 'BackForwardCacheDisabledByLowMemory', 'BackForwardCacheDisabledForDelegate',
  'BackForwardCacheDisabledForPrerender', 'NotMostRecentNavigationEntry', 'InjectedJavascript', 'InjectedStyleSheet', 'ContentScriptExtension',
]);

export const bfcacheEligibility: RuleImplementation = {
  id: 'perf-bfcache-eligibility',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'bf-cache');
    if (!auditRan(audit) || audit.score === null) return notEvaluated('bfcache-not-tested');
    if (audit.score === 1) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'bf-cache', evidenceLabel('Lighthouse back/forward cache test'))] };
    const reasons = rows(audit.details).filter(row => {
      const type = str(row.failureType) ?? '';
      const code = str(row.protocolReason) ?? '';
      return (type === 'Actionable' || type === 'PageSupportNeeded') && !automationReasons.has(code);
    });
    if (reasons.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'bf-cache', evidenceLabel('Lighthouse back/forward cache test'))] };
    const cited = reasons.slice(0, 5).map(row => labEvidence(evidence, page!, summary, 'bf-cache', evidenceLabel('actionable back/forward cache failure'), `${str(row.reason) ?? ''} (${str(row.protocolReason) ?? ''})`));
    return { outcome: 'fail', severity: 'medium', evidence: cited, params: { count: reasons.length, reasons: summarizeList(reasons.map(row => str(row.reason) ?? str(row.protocolReason) ?? '')) } };
  },
};

// Unload listeners.

const unloadListener = /addEventListener\s*\(\s*['"`]unload['"`]|(?<![a-z])onunload\s*=/iu;

export const unloadHandlers: RuleImplementation = {
  id: 'perf-unload-handlers',
  evaluate({ page, evidence }) {
    const found: string[] = [];
    for (const doc of [page!.raw, page!.rendered?.result.error === undefined ? page!.rendered : undefined]) {
      for (const info of elements(doc)) {
        const source = info.tag === 'script' ? textContent(info.element) : info.tag === 'body' && info.attrs.onunload !== undefined ? `onunload=${info.attrs.onunload}` : '';
        const match = unloadListener.exec(source);
        if (!match) continue;
        found.push(evidence.add({ kind: 'html', url: page!.url, label: doc === page!.raw ? evidenceLabel('unload listener in the server HTML') : evidenceLabel('unload listener in the rendered page'),
          excerpt: source.slice(Math.max(0, match.index - 60), match.index + 80).trim(), line: info.line }));
      }
    }
    const summary = labOf(page);
    const lab = rows(auditOf(summary, 'bf-cache')?.details).filter(row => /^UnloadHandlerExists/u.test(str(row.protocolReason) ?? ''));
    if (summary && lab.length > 0) found.push(labEvidence(evidence, page!, summary, 'bf-cache', evidenceLabel('back/forward cache failure caused by an unload listener'), str(lab[0]!.reason) ?? ''));
    const unique = [...new Set(found)];
    if (unique.length === 0) return { outcome: 'pass' };
    return { outcome: 'fail', severity: 'low', evidence: unique, params: { count: unique.length } };
  },
};

// Speculation rules.

const stateChanging = /log-?out|sign-?out|log-?off|add[-_]to[-_]cart|\/cart(?:\/|$|\?)|\/basket|\/checkout|wp-login|action=logout|unsubscribe|\/delete/iu;

type Where = Readonly<Record<string, unknown>>;

/** Whether a document rule's condition matches a URL; undefined when the condition cannot be decided without the DOM. */
function matches(where: unknown, url: URL, base: string): boolean | undefined {
  if (where === undefined) return true;
  if (typeof where !== 'object' || where === null) return undefined;
  const condition = where as Where;
  if (Array.isArray(condition.and)) {
    const parts = condition.and.map(part => matches(part, url, base));
    return parts.includes(false) ? false : parts.includes(undefined) ? undefined : true;
  }
  if (Array.isArray(condition.or)) {
    const parts = condition.or.map(part => matches(part, url, base));
    return parts.includes(true) ? true : parts.includes(undefined) ? undefined : false;
  }
  if ('not' in condition) {
    const inner = matches(condition.not, url, base);
    return inner === undefined ? undefined : !inner;
  }
  const patterns = condition.href_matches;
  if (patterns === undefined) return undefined;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const Pattern = (globalThis as { URLPattern?: new (input: string, base: string) => { test(input: string): boolean } }).URLPattern;
  if (!Pattern) return undefined;
  try {
    return list.some(pattern => typeof pattern === 'string' && new Pattern(pattern, base).test(url.href));
  } catch {
    return undefined;
  }
}

interface SpeculationRule {
  readonly action: string;
  readonly source?: string;
  readonly urls?: readonly string[];
  readonly where?: unknown;
}

function speculationRules(json: unknown): SpeculationRule[] {
  if (typeof json !== 'object' || json === null) return [];
  return (['prefetch', 'prerender'] as const).flatMap(action => {
    const list = (json as Record<string, unknown>)[action];
    return Array.isArray(list) ? list.filter((rule): rule is Record<string, unknown> => typeof rule === 'object' && rule !== null).map(rule => ({
      action,
      ...(typeof rule.source === 'string' ? { source: rule.source } : {}),
      ...(Array.isArray(rule.urls) ? { urls: rule.urls.filter((url): url is string => typeof url === 'string') } : {}),
      ...('where' in rule ? { where: rule.where } : {}),
    })) : [];
  });
}

export const speculationRulesCheck: RuleImplementation = {
  id: 'perf-speculation-rules',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!, 'raw')!;
    const base = page!.fetch.finalUrl;
    const scripts = doc.parsed.scripts.filter(script => (script.attrs.type ?? '').trim().toLowerCase() === 'speculationrules');
    const header = headerValue(page!.fetch.headers, 'speculation-rules');
    if (scripts.length === 0 && header === undefined) return notApplicable('no-speculation-rules');
    const cited = [
      ...scripts.map(script => evidence.add({ kind: 'html', url: page!.url, label: evidenceLabel('speculation rules in the server HTML'), excerpt: script.text.trim(), line: script.line })),
      ...(header === undefined ? [] : [headerEvidence(evidence, page!.fetch.finalUrl, 'speculation-rules', header, evidenceLabel('speculation rules header'))]),
    ];
    const rules: SpeculationRule[] = [];
    for (const script of scripts) {
      try {
        rules.push(...speculationRules(JSON.parse(script.text)));
      } catch {
        return { outcome: 'fail', severity: 'info', reason: 'invalid-json', evidence: cited };
      }
    }
    const links = [...new Set(doc.parsed.anchors.map(anchor => absoluteUrl(anchor.attrs.href, base)).filter((href): href is string => href !== undefined))]
      .map(href => new URL(href)).filter(url => url.origin === new URL(base).origin && stateChanging.test(`${url.pathname}${url.search}`));
    const risky = new Set<string>();
    for (const rule of rules) {
      for (const url of rule.urls ?? []) {
        const absolute = absoluteUrl(url, base);
        if (absolute && stateChanging.test(new URL(absolute).pathname + new URL(absolute).search)) risky.add(absolute);
      }
      if (rule.source === 'document' || (rule.urls === undefined && rule.where !== undefined)) {
        for (const link of links) if (matches(rule.where, link, base) === true) risky.add(link.href);
      }
    }
    if (risky.size === 0) return { outcome: 'pass', evidence: cited };
    return { outcome: 'fail', severity: 'info', reason: 'state-changing-urls', evidence: cited, params: { urls: summarizeList([...risky]) } };
  },
};

// CDN markers.

const cdnHeaders = ['cf-cache-status', 'cf-ray', 'x-cache', 'x-served-by', 'x-amz-cf-id', 'x-amz-cf-pop', 'x-vercel-cache', 'x-vercel-id', 'x-nf-request-id',
  'x-fastly-request-id', 'fastly-debug-digest', 'akamai-grn', 'x-akamai-transformed', 'x-azure-ref', 'x-msedge-ref', 'cdn-cache', 'cdn-pullzone',
  'x-cdn', 'x-edge-location', 'x-github-request-id', 'cdn-cache-control', 'x-cache-status', 'x-proxy-cache', 'cf-mitigated'];
const cdnServer = /cloudflare|akamai|cloudfront|netlify|vercel|bunnycdn|keycdn|fastly|varnish|cdn77|gcore|stackpath|azure front door|edgio|sucuri/iu;

function cdnMarkers(page: PageFacts): string[] {
  const { headers } = page.fetch;
  const markers = cdnHeaders.filter(name => headers[name] !== undefined).map(name => `${name}: ${headerValue(headers, name)}`);
  for (const name of ['server', 'via']) {
    const value = headerValue(headers, name);
    if (value && cdnServer.test(value)) markers.push(`${name}: ${value}`);
  }
  return markers;
}

export const htmlCdn: RuleImplementation = {
  id: 'perf-html-cdn',
  evaluate({ site, evidence }) {
    const pages = [...site.pages.values()].filter(entry => entry.fetch.status !== undefined);
    if (pages.length === 0) return notEvaluated('no-response');
    for (const entry of pages) {
      const markers = cdnMarkers(entry);
      if (markers.length > 0) return { outcome: 'pass', evidence: [evidence.add({ kind: 'header', url: entry.fetch.finalUrl, label: evidenceLabel('CDN markers on the HTML response'), excerpt: markers.join('\n') })] };
    }
    const sample = pages[0]!;
    const names = Object.keys(sample.fetch.headers).sort().join(', ');
    return { outcome: 'fail', severity: 'info', evidence: [evidence.add({ kind: 'header', url: sample.fetch.finalUrl, label: evidenceLabel('response header names of the HTML response, none of them a known CDN marker'), excerpt: names })],
      params: { count: pages.length } };
  },
};


export const deliveryImplementations: readonly RuleImplementation[] = [
  renderBlocking, documentRedirects, serverResponseTime, textCompression, httpProtocol, staticCacheTtl, htmlNoStore, bfcacheEligibility, unloadHandlers,
  speculationRulesCheck, htmlCdn,
];
