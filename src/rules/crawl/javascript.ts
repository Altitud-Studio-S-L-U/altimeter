import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import { attribute, isElement, parseHtml, walk } from '../../parse/html.ts';
import { contentText } from '../content/common.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, linksWithRel, metaNamed, pageDocument, sameSite, summarizeList } from '../helpers.ts';
import {
  documentBase, effectiveDirectives, failure, internalLinks, missingShare, normalizeUrl, notApplicable, notEvaluated, passed, sitemapLocs, words,
} from './shared.ts';

/** A value seen in two documents, cited once: both values when both have one, or the one that has it. */
function comparedValue(first: string, second: string, labels: { readonly both: EvidenceLabel; readonly onlyFirst: EvidenceLabel; readonly onlySecond: EvidenceLabel }): { label: EvidenceLabel; excerpt: string } {
  if (first && second) return { label: labels.both, excerpt: `${first} | ${second}` };
  return first ? { label: labels.onlyFirst, excerpt: first } : { label: labels.onlySecond, excerpt: second };
}

function inTemplateRegion(html: string, offset: number): boolean {
  if (offset < 0) return false;
  const before = html.slice(0, offset).toLowerCase();
  return ['nav', 'header', 'footer'].some(tag => {
    const opened = before.lastIndexOf(`<${tag}`);
    return opened !== -1 && opened > before.lastIndexOf(`</${tag}`);
  });
}

function canonicalOf(doc: DocumentFacts, url: string): string | undefined {
  return normalizeUrl(absoluteUrl(linksWithRel(doc, 'canonical')[0]?.attrs.href, documentBase(doc, url)));
}

function signals(page: PageFacts, doc: DocumentFacts) {
  return {
    title: doc.parsed.titles[0]?.text.trim() ?? '',
    canonical: canonicalOf(doc, page.fetch.finalUrl) ?? '',
    robots: [...effectiveDirectives(page, doc)].sort().join(', '),
    h1: doc.parsed.headings.find(heading => heading.level === 1)?.text ?? '',
  };
}

const robotsBlocksRenderResources: RuleImplementation = {
  id: 'crawl-robots-blocks-render-resources',
  evaluate({ page, evidence }) {
    const target = page!;
    const blocked = target.rendered!.result.blockedByRobots;
    if (blocked.length === 0) return notApplicable('nothing-blocked');
    const unblocked = target.unblockedRender?.result.error === undefined ? target.unblockedRender : undefined;
    if (!unblocked) return notEvaluated('no-unblocked-render');
    const rendered = target.rendered!;
    const url = target.fetch.finalUrl;
    const blockedIds = blocked.slice(0, 5).map(resource => evidence.add({ kind: 'render', url, label: evidenceLabel('request not loaded because robots.txt disallows it for Googlebot'), excerpt: resource }));
    const before = signals(target, unblocked);
    const after = signals(target, rendered);
    const changed = (Object.keys(before) as (keyof typeof before)[]).filter(key => before[key] !== after[key]);
    const params = { url, count: blocked.length, resources: summarizeList(blocked, 2) };
    if (changed.length > 0) {
      const ids = changed.map(key => evidence.add({
        kind: 'render', url,
        ...comparedValue(after[key], before[key], {
          both: evidenceLabel('{signal} without the blocked requests and with them', { signal: key }),
          onlyFirst: evidenceLabel('{signal}: only without the blocked requests', { signal: key }),
          onlySecond: evidenceLabel('{signal}: only when the blocked requests load', { signal: key }),
        }),
      }));
      return failure({ severity: 'high', evidence: [...blockedIds, ...ids], reason: 'metadata-changed', params });
    }
    const fullText = contentText(unblocked);
    const textLoss = missingShare(fullText, rendered.parsed.bodyText);
    const fullLinks = internalLinks(unblocked, url);
    const kept = new Set(internalLinks(rendered, url));
    const lostLinks = fullLinks.filter(link => !kept.has(link));
    if (words(fullText).length >= 30 && textLoss >= 0.2) {
      const id = evidence.add({ kind: 'render', url, label: evidenceLabel('share of the main text that renders only when the blocked requests load: {share, number, percent}', { share: textLoss }) });
      return failure({ severity: 'high', evidence: [...blockedIds, id], reason: 'content-missing', params });
    }
    if (lostLinks.length >= 3 && lostLinks.length / fullLinks.length >= 0.2) {
      const id = evidence.add({ kind: 'render', url, label: evidenceLabel('internal links that render only when the blocked requests load: {count}', { count: lostLinks.length }), excerpt: lostLinks.slice(0, 5).join('\n') });
      return failure({ severity: 'high', evidence: [...blockedIds, id], reason: 'links-missing', params });
    }
    const overflows = (render: typeof rendered) => render.result.clientWidth > 0 && render.result.scrollWidth > render.result.clientWidth + 1;
    if (overflows(rendered) && !overflows(unblocked)) {
      const id = evidence.add({ kind: 'render', url, label: evidenceLabel('page width without the blocked requests: {width} px, wider than the {viewport} px viewport', { width: rendered.result.scrollWidth, viewport: rendered.result.clientWidth }) });
      return failure({ severity: 'high', evidence: [...blockedIds, id], reason: 'layout-break', params });
    }
    if (textLoss >= 0.05) {
      const id = evidence.add({ kind: 'render', url, label: evidenceLabel('share of the main text that renders only when the blocked requests load: {share, number, percent}', { share: textLoss }) });
      return failure({ severity: 'medium', evidence: [...blockedIds, id], reason: 'minor-differences', params, needsJudgment: true });
    }
    return passed(blockedIds);
  },
};

const scriptOnlyHref = /^(?:#|javascript:|\s*$)/iu;

const jsLinksCrawlable: RuleImplementation = {
  id: 'crawl-js-links-crawlable',
  evaluate({ page, evidence }) {
    const target = page!;
    const doc = target.rendered!;
    const url = target.fetch.finalUrl;
    const candidates: { excerpt: string; line: number; template: boolean }[] = [];
    for (const anchor of doc.parsed.anchors) {
      const href = anchor.attrs.href;
      const label = anchor.text || anchor.imageAlt;
      if (label === '' || (href !== undefined && !scriptOnlyHref.test(href))) continue;
      if (href !== undefined && href.startsWith('#') && href.length > 1) continue;
      candidates.push({ excerpt: `<a${href === undefined ? '' : ` href="${href}"`}>${label.slice(0, 60)}`, line: anchor.line, template: inTemplateRegion(doc.html, anchor.offset) });
    }
    walk(doc.parsed.document, node => {
      if (!isElement(node) || node.tagName === 'a') return;
      const role = attribute(node, 'role');
      const handler = attribute(node, 'onclick') ?? '';
      if (role !== 'link' && !/location|navigate|router|href/iu.test(handler) && attribute(node, 'routerlink') === undefined) return;
      const offset = node.sourceCodeLocation?.startOffset ?? -1;
      candidates.push({ excerpt: `<${node.tagName}${role ? ` role="${role}"` : ''}${handler ? ` onclick="${handler.slice(0, 60)}"` : ''}>`, line: node.sourceCodeLocation?.startLine ?? 0, template: inTemplateRegion(doc.html, offset) });
    });
    if (candidates.length === 0) return passed();
    const navigation = candidates.filter(item => item.template);
    const ids = (navigation.length >= 3 ? navigation : candidates).slice(0, 6).map(item => evidence.add({ kind: 'render', url, label: evidenceLabel('clickable element without a crawlable href'), excerpt: item.excerpt, line: item.line }));
    if (navigation.length >= 3) return failure({ severity: 'medium', evidence: ids, reason: 'navigation', params: { url, count: navigation.length }, needsJudgment: true });
    return failure({ severity: 'low', evidence: ids, reason: 'isolated', params: { url, count: candidates.length }, needsJudgment: true });
  },
};

const hashRoute = /#[!/]/u;

const jsFragmentRouting: RuleImplementation = {
  id: 'crawl-js-fragment-routing',
  evaluate({ site, evidence }) {
    const documents = [...site.pages.values()].map(page => ({ page, doc: pageDocument(page) })).filter(item => item.doc !== undefined);
    if (documents.length === 0) return notApplicable('no-documents');
    const routes = new Map<string, { url: string; line: number; href: string }>();
    for (const { page, doc } of documents) {
      const base = documentBase(doc, page.fetch.finalUrl);
      for (const anchor of doc!.parsed.anchors) {
        const href = anchor.attrs.href ?? '';
        if (!hashRoute.test(href)) continue;
        const target = absoluteUrl(href, base);
        if (!target || !/^https?:/u.test(target) || !sameSite(target, page.fetch.finalUrl)) continue;
        const fragment = href.slice(href.indexOf('#'));
        if (!routes.has(fragment)) routes.set(fragment, { url: page.fetch.finalUrl, line: anchor.line, href });
      }
    }
    if (routes.size === 0) return passed();
    const ids = [...routes.values()].slice(0, 5).map(item => evidence.add({ kind: 'html', url: item.url, label: evidenceLabel('internal link whose route lives in the fragment'), excerpt: item.href, line: item.line }));
    return failure({ severity: routes.size >= 2 ? 'high' : 'low', evidence: ids, reason: routes.size >= 2 ? 'hash-routes' : 'single-hash-route', params: { count: routes.size, routes: summarizeList([...routes.keys()]) } });
  },
};

function jsonLdTypes(doc: DocumentFacts): string {
  return [...new Set(doc.data.nodes.filter(node => !node.nested).flatMap(node => node.types))].sort().join(', ');
}

const jsContentDependency: RuleImplementation = {
  id: 'crawl-js-content-dependency',
  evaluate({ page, evidence }) {
    const target = page!;
    const raw = target.raw!;
    const rendered = target.rendered!;
    const url = target.fetch.finalUrl;
    const renderedMain = contentText(rendered);
    if (words(renderedMain).length < 30) return notApplicable('little-rendered-text');
    const share = missingShare(renderedMain, raw.parsed.bodyText);
    if (share > 0.5) {
      const id = evidence.add({ kind: 'render', url, label: evidenceLabel('share of the rendered main text that the raw HTML lacks: {share, number, percent}', { share }) });
      return failure({ severity: 'medium', evidence: [id], reason: 'content-after-js', params: { url, share } });
    }
    const renderedLinks = internalLinks(rendered, url);
    const rawLinks = new Set(internalLinks(raw, url));
    const added = renderedLinks.filter(link => !rawLinks.has(link));
    if (renderedLinks.length >= 5 && added.length / renderedLinks.length > 0.5) {
      const id = evidence.add({ kind: 'render', url, label: evidenceLabel('internal links present only in the rendered DOM: {count}', { count: added.length }), excerpt: added.slice(0, 5).join('\n') });
      return failure({ severity: 'medium', evidence: [id], reason: 'links-after-js', params: { url, share: added.length / renderedLinks.length } });
    }
    const pairs: [string, EvidenceLabel, string, string][] = [
      ['title', evidenceLabel('title in the raw HTML and in the rendered DOM'), raw.parsed.titles[0]?.text.trim() ?? '', rendered.parsed.titles[0]?.text.trim() ?? ''],
      ['meta description', evidenceLabel('meta description in the raw HTML and in the rendered DOM'), metaNamed(raw, 'description')[0]?.attrs.content?.trim() ?? '', metaNamed(rendered, 'description')[0]?.attrs.content?.trim() ?? ''],
      ['structured data types', evidenceLabel('structured data types in the raw HTML and in the rendered DOM'), jsonLdTypes(raw), jsonLdTypes(rendered)],
    ];
    const differing = pairs.filter(([, , before, after]) => before !== after);
    if (differing.length > 0) {
      const ids = differing.map(([field, label, before, after]) => evidence.add({
        kind: 'render', url,
        ...comparedValue(before, after, { both: label, onlyFirst: evidenceLabel('{field} only in the raw HTML', { field }), onlySecond: evidenceLabel('{field} only in the rendered DOM', { field }) }),
      }));
      return failure({ severity: 'medium', evidence: ids, reason: 'metadata-differs', params: { url, fields: differing.map(([name]) => name).join(', ') } });
    }
    return passed();
  },
};

const lazyAttributes = ['data-src', 'data-lazy-src', 'data-original', 'data-srcset'];

const jsLazyContent: RuleImplementation = {
  id: 'crawl-js-lazy-content',
  evaluate({ page, evidence }) {
    const target = page!;
    const rendered = target.rendered!;
    const scrolled = target.userRender!;
    const url = target.fetch.finalUrl;
    const results: RuleResult[] = [];
    const share = missingShare(scrolled.parsed.bodyText, rendered.parsed.bodyText);
    if (words(scrolled.parsed.bodyText).length >= 50 && share >= 0.2) {
      const id = evidence.add({ kind: 'render', url, label: evidenceLabel('share of the text that appears only after scrolling: {share, number, percent}', { share }) });
      results.push(failure({ severity: 'medium', evidence: [id], reason: 'content-after-scroll', params: { url, share }, needsJudgment: true }));
    } else {
      const seen = new Set(internalLinks(rendered, url));
      const later = internalLinks(scrolled, url).filter(link => !seen.has(link));
      if (later.length >= 5 && later.length / Math.max(1, internalLinks(scrolled, url).length) >= 0.2) {
        const id = evidence.add({ kind: 'render', url, label: evidenceLabel('internal links that appear only after scrolling: {count}', { count: later.length }), excerpt: later.slice(0, 5).join('\n') });
        results.push(failure({ severity: 'medium', evidence: [id], reason: 'links-after-scroll', params: { url, count: later.length }, needsJudgment: true }));
      }
    }
    const lazy = rendered.parsed.images.filter(image => lazyAttributes.some(name => image.attrs[name] !== undefined) && (image.attrs.src === undefined || image.attrs.src.trim() === '' || image.attrs.src.startsWith('data:')));
    if (lazy.length > 0) {
      const ids = lazy.slice(0, 5).map(image => evidence.add({ kind: 'render', url, label: evidenceLabel('image without a loaded src in the Googlebot-like render'), excerpt: `<img ${lazyAttributes.filter(name => image.attrs[name] !== undefined).map(name => `${name}="${image.attrs[name]}"`).join(' ')}>`, line: image.line }));
      results.push(failure({ severity: 'low', evidence: ids, reason: 'images-without-src', params: { url, count: lazy.length } }));
    }
    return results.length > 0 ? results : passed();
  },
};

const challengeMarkers = /just a moment\.\.\.|cf-chl-|challenge-platform|attention required|g-recaptcha|h-captcha|captcha-delivery|px-captcha/iu;

const dynamicRendering: RuleImplementation = {
  id: 'crawl-dynamic-rendering',
  evaluate({ site, evidence }) {
    const bot = site.agentProbes.find(probe => probe.agent.token === 'googlebot');
    const browser = site.agentProbes.find(probe => probe.agent.purpose === 'baseline');
    if (!bot || !browser) return notEvaluated('missing-probe');
    if (bot.fetch.status !== 200 || browser.fetch.status !== 200) return notEvaluated('probe-not-200');
    if (bot.fetch.body.equals(browser.fetch.body)) return passed();
    // A challenge served to a spoofed crawler user agent says nothing about what the verified crawler receives.
    if (challengeMarkers.test(bot.fetch.body.subarray(0, 64 * 1024).toString('utf8'))) return notEvaluated('challenge-page');
    const botText = parseHtml(bot.fetch.body.toString('utf8')).bodyText;
    const browserText = parseHtml(browser.fetch.body.toString('utf8')).bodyText;
    const botMissing = missingShare(browserText, botText);
    const browserMissing = missingShare(botText, browserText);
    if (botMissing < 0.1 && browserMissing < 0.1) return passed();
    const ids = [
      evidence.add({ kind: 'probe', url: bot.url, label: evidenceLabel('words in the HTML served to {bot} and to {browser}: {botWords} and {browserWords}', { bot: bot.agent.name, botWords: words(botText).length, browser: browser.agent.name, browserWords: words(browserText).length }) }),
      evidence.add({ kind: 'probe', url: bot.url, label: evidenceLabel('share of the {bot} text missing for {browser}, and the reverse: {missing, number, percent} and {reverse, number, percent}', { bot: bot.agent.name, browser: browser.agent.name, missing: browserMissing, reverse: botMissing }) }),
    ];
    if (botMissing < 0.1 && browserMissing > 0.5) return failure({ severity: 'low', evidence: ids, reason: 'prerendered-for-bots', params: { url: bot.url } });
    return failure({ severity: 'low', evidence: ids, reason: 'different-content', params: { url: bot.url }, needsJudgment: true });
  },
};

const sessionKey = /^(?:sessionid|session_id|sid|phpsessid|jsessionid|aspsessionid|sessid|cfid|cftoken)$/iu;
const trackingKey = /^(?:utm_[a-z]+|gclid|fbclid|msclkid|dclid|yclid|mc_cid|mc_eid|_hsenc|_hsmi)$/iu;

function queryKeys(url: string): string[] {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    if (/;jsessionid=/iu.test(parsed.pathname)) keys.push('jsessionid');
    return keys;
  } catch {
    return [];
  }
}

const parameterUrls: RuleImplementation = {
  id: 'crawl-parameter-urls',
  evaluate({ site, evidence }) {
    const sources = [
      ...[...site.pages.values()].flatMap(page => internalLinks(pageDocument(page), page.fetch.finalUrl).map(url => ({ url, where: page.fetch.finalUrl, kind: 'html' as const }))),
      ...sitemapLocs(site).map(entry => ({ url: entry.loc, where: entry.sitemap, kind: 'sitemap' as const })),
    ];
    const session = sources.filter(item => queryKeys(item.url).some(key => sessionKey.test(key)));
    const tracking = sources.filter(item => queryKeys(item.url).some(key => trackingKey.test(key)));
    const cite = (items: typeof sources, label: EvidenceLabel) => [...new Map(items.map(item => [item.url, item])).values()].slice(0, 5)
      .map(item => evidence.add({ kind: item.kind, url: item.where, label, excerpt: item.url }));
    if (session.length > 0) return failure({ severity: 'medium', evidence: cite(session, evidenceLabel('internal link or sitemap URL with a session parameter')), reason: 'session-id', params: { count: session.length } });
    if (tracking.length > 0) return failure({ severity: 'medium', evidence: cite(tracking, evidenceLabel('internal link or sitemap URL with a tracking parameter')), reason: 'tracking-parameter', params: { count: tracking.length } });
    const variant = site.variants.find(entry => entry.label === 'tracking-parameter' && entry.fetch.status === 200 && entry.fetch.hops.length === 1);
    if (variant) {
      const clean = new URL(variant.url);
      for (const key of [...clean.searchParams.keys()]) if (trackingKey.test(key)) clean.searchParams.delete(key);
      const canonical = normalizeUrl(absoluteUrl(parseHtml(variant.fetch.body.toString('utf8')).links.find(link => link.rel.includes('canonical'))?.attrs.href, variant.url));
      if (canonical !== normalizeUrl(clean.href)) {
        const id = canonical
          ? evidence.add({ kind: 'probe', url: variant.url, label: evidenceLabel('canonical of the URL with a tracking parameter, which answers 200'), excerpt: canonical })
          : evidence.add({ kind: 'probe', url: variant.url, label: evidenceLabel('URL with a tracking parameter that answers 200 and declares no canonical') });
        return failure({ severity: 'medium', evidence: [id], reason: 'parameter-duplicate', params: { count: 1 } });
      }
    }
    return passed();
  },
};

const urlHygiene: RuleImplementation = {
  id: 'crawl-url-hygiene',
  evaluate({ site, evidence }) {
    const hrefs: { value: string; where: string; line: number; kind: 'html' | 'sitemap' }[] = [];
    for (const page of site.pages.values()) {
      const doc = pageDocument(page);
      const host = new URL(page.fetch.finalUrl).hostname.replace(/^www\./u, '');
      for (const anchor of doc?.parsed.anchors ?? []) {
        const href = anchor.attrs.href;
        const resolved = absoluteUrl(href, documentBase(doc, page.fetch.finalUrl));
        if (!href || !resolved || !/^https?:/u.test(resolved) || new URL(resolved).hostname.replace(/^www\./u, '') !== host) continue;
        hrefs.push({ value: href.trim(), where: page.fetch.finalUrl, line: anchor.line, kind: 'html' });
      }
    }
    for (const entry of sitemapLocs(site)) hrefs.push({ value: entry.loc, where: entry.sitemap, line: entry.line, kind: 'sitemap' });
    if (hrefs.length === 0) return notApplicable('no-urls');
    const checks: [string, EvidenceLabel, (value: string) => boolean][] = [
      ['too-long', evidenceLabel('internal URL flagged as too-long'), value => value.length > 2048],
      ['unencoded-characters', evidenceLabel('internal URL flagged as unencoded-characters'), value => /[\s\\]/u.test(value)],
      ['double-slash', evidenceLabel('internal URL flagged as double-slash'), value => /^(?:[a-z]+:)?\/\/[^/]+\/.*\/\//iu.test(value.split(/[?#]/u)[0]!) || /^\/[^/].*\/\//u.test(value.split(/[?#]/u)[0]!)],
      ['duplicate-parameters', evidenceLabel('internal URL flagged as duplicate-parameters'), value => { const keys = queryKeys(absoluteUrl(value, site.origin) ?? ''); return new Set(keys).size !== keys.length; }],
    ];
    for (const [reason, label, test] of checks) {
      const found = hrefs.filter(item => test(item.value));
      if (found.length === 0) continue;
      const ids = found.slice(0, 5).map(item => evidence.add({ kind: item.kind, url: item.where, label, excerpt: item.value.slice(0, 300), line: item.line }));
      return failure({ severity: 'low', evidence: ids, reason, params: { count: found.length } });
    }
    return passed();
  },
};

const duplicateClusters: RuleImplementation = {
  id: 'crawl-duplicate-clusters',
  evaluate({ site, evidence }) {
    const clusters = new Map<string, PageFacts[]>();
    for (const page of site.pages.values()) {
      const doc = pageDocument(page);
      if (page.fetch.status !== 200 || !doc) continue;
      const text = doc.parsed.bodyText.toLowerCase();
      if (text.length < 200) continue;
      const key = `${(doc.parsed.htmlLang ?? '').toLowerCase()}|${text}`;
      clusters.set(key, [...(clusters.get(key) ?? []), page]);
    }
    const duplicated = [...clusters.values()].filter(members => members.length > 1);
    if (clusters.size === 0) return notApplicable('no-comparable-pages');
    const results: RuleResult[] = [];
    for (const members of duplicated) {
      const targets = new Set(members.map(member => canonicalOf(pageDocument(member)!, member.fetch.finalUrl) ?? normalizeUrl(member.fetch.finalUrl)));
      if (targets.size === 1) continue;
      const ids = members.slice(0, 5).map(member => {
        const canonical = canonicalOf(pageDocument(member)!, member.fetch.finalUrl);
        return canonical
          ? evidence.add({ kind: 'crawl', url: member.fetch.finalUrl, label: evidenceLabel('page with the same main text as others, and its canonical'), excerpt: canonical })
          : evidence.add({ kind: 'crawl', url: member.fetch.finalUrl, label: evidenceLabel('page with the same main text as others, without a canonical') });
      });
      results.push(failure({ severity: 'medium', evidence: ids, reason: 'not-consolidated', params: { count: members.length, urls: summarizeList(members.map(member => member.fetch.finalUrl)) }, needsJudgment: true }));
    }
    return results.length > 0 ? results : passed();
  },
};

export const javascriptRules: readonly RuleImplementation[] = [
  robotsBlocksRenderResources, jsLinksCrawlable, jsFragmentRouting, jsContentDependency, jsLazyContent, dynamicRendering, parameterUrls, urlHygiene,
  duplicateClusters,
];
