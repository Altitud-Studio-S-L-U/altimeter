import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts, SiteFacts } from '../../core/facts.ts';
import { metaContent, type ElementRef } from '../../parse/html.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, documentBase, hreflangLinks, linksWithRel, pageDocument, summarizeList } from '../helpers.ts';
import { describeImage, imageInfo } from './image.ts';
import { citer, fail, firstHeader, isHttps, notApplicable, notEvaluated, pass, worst } from './shared.ts';

const requiredTags = ['og:title', 'og:type', 'og:image', 'og:url', 'og:description'] as const;

/** Object types of the Open Graph protocol and the global types Facebook documents. */
const ogTypes = new Set([
  'website', 'article', 'book', 'profile', 'music.song', 'music.album', 'music.playlist', 'music.radio_station', 'video.movie', 'video.episode',
  'video.tv_show', 'video.other', 'books.author', 'books.book', 'books.genre', 'business.business', 'fitness.course', 'game.achievement', 'place',
  'product', 'product.group', 'product.item', 'restaurant.menu', 'restaurant.menu_item', 'restaurant.menu_section', 'restaurant.restaurant',
]);

function firstValue(doc: DocumentFacts | undefined, key: string): { value: string; ref: ElementRef } | undefined {
  if (!doc) return undefined;
  const ref = metaContent(doc.parsed, key).find(meta => (meta.attrs.content ?? '').trim() !== '');
  return ref ? { value: ref.attrs.content!.trim(), ref } : undefined;
}

function metaExcerpt(ref: ElementRef): string {
  return `<meta ${Object.entries(ref.attrs).map(([name, value]) => `${name}="${value}"`).join(' ')}>`;
}

/** Byte offset where the head ends in the served HTML, or where the body starts when no end tag is written. */
function headEndBytes(html: string): number | undefined {
  const match = /<\/head\s*>|<body[\s>]/iu.exec(html);
  return match ? Buffer.byteLength(html.slice(0, match.index), 'utf8') : undefined;
}

const headLimit = 300 * 1024;

export const socialOgRequired: RuleImplementation = {
  id: 'tech-social-og-required',
  evaluate(context) {
    const page = context.page!;
    const raw = page.raw!;
    const rendered = pageDocument(page);
    const cite = citer(context);
    const url = page.fetch.finalUrl;
    const missing = requiredTags.filter(tag => !firstValue(raw, tag));
    const renderedOnly = missing.filter(tag => rendered !== raw && firstValue(rendered, tag));
    const results: Array<{ severity: 'low' | 'info'; reason: string; evidence: string[]; params: Record<string, string | number> }> = [];
    const absent = missing.filter(tag => !renderedOnly.includes(tag));
    if (absent.length > 0) {
      results.push({ severity: 'low', reason: 'missing', evidence: [cite({ kind: 'html', url, label: evidenceLabel('Open Graph tags absent or empty in the raw HTML'), excerpt: absent.join(', ') })], params: { tags: absent.join(', ') } });
    }
    if (renderedOnly.length > 0) {
      const evidence = renderedOnly.map(tag => cite({ kind: 'render', url, label: evidenceLabel('Open Graph tag present only after rendering'), excerpt: metaExcerpt(firstValue(rendered, tag)!.ref) }));
      results.push({ severity: 'low', reason: 'rendered-only', evidence, params: { tags: renderedOnly.join(', ') } });
    }
    const type = firstValue(raw, 'og:type');
    if (type && !ogTypes.has(type.value.toLowerCase()) && !type.value.includes(':')) {
      results.push({ severity: 'low', reason: 'invalid-type', evidence: [cite({ kind: 'html', url, label: evidenceLabel('og:type value'), excerpt: metaExcerpt(type.ref), line: type.ref.line })], params: { value: type.value } });
    }
    const relative = (['og:image', 'og:url'] as const).map(tag => firstValue(raw, tag)).filter(entry => entry && !/^https?:\/\//iu.test(entry.value));
    for (const entry of relative) {
      results.push({ severity: 'low', reason: 'relative-url', evidence: [cite({ kind: 'html', url, label: evidenceLabel('Open Graph URL that is not absolute'), excerpt: metaExcerpt(entry!.ref), line: entry!.ref.line })], params: { value: entry!.value } });
    }
    const headEnd = headEndBytes(raw.html);
    if (headEnd !== undefined && headEnd > headLimit) {
      results.push({ severity: 'info', reason: 'late-head', evidence: [cite({ kind: 'html', url, label: evidenceLabel('byte offset where the head ends in the raw HTML'), excerpt: String(headEnd) })], params: { bytes: headEnd } });
    }
    if (results.length === 0) return pass([cite({ kind: 'html', url, label: evidenceLabel('Open Graph tags in the raw HTML'), excerpt: requiredTags.map(tag => `${tag}=${firstValue(raw, tag)!.value}`).join('\n') })]);
    return results.map(result => fail(result.severity, result.evidence, result.reason, result.params));
  },
};

function ogImageResource(site: SiteFacts, imageUrl: string) {
  return site.resources.find(resource => resource.purpose === 'og-image' && resource.url === imageUrl);
}

function firstOgImage(page: PageFacts): { url: string; ref: ElementRef } | undefined {
  const entry = firstValue(page.raw, 'og:image') ?? firstValue(page.raw, 'og:image:url');
  const url = entry ? absoluteUrl(entry.value, documentBase(page.raw, page.fetch.finalUrl)) : undefined;
  return entry && url ? { url, ref: entry.ref } : undefined;
}

export const socialOgImage: RuleImplementation = {
  id: 'tech-social-og-image',
  evaluate(context): RuleResult | RuleResult[] {
    const page = context.page!;
    const image = firstOgImage(page);
    if (!image) return notApplicable('no-og-image');
    const resource = ogImageResource(context.site, image.url);
    if (!resource) return notEvaluated('og-image-not-fetched');
    const cite = citer(context);
    const { fetch } = resource;
    const info = fetch.status === 200 ? imageInfo(fetch.body) : { format: undefined };
    const bytes = fetch.body.length;
    const evidence = [cite({ kind: 'http', url: image.url, label: evidenceLabel('og:image response'), excerpt: `${fetch.status ?? fetch.error?.code ?? 'no response'} ${firstHeader(fetch.headers, 'content-type') ?? ''} ${describeImage(info)} ${bytes} bytes${fetch.truncated ? ' (truncated)' : ''}`.replace(/\s+/gu, ' ').trim() })];
    const problems: Array<{ severity: 'low' | 'info'; reason: string }> = [];
    if (!isHttps(image.url)) problems.push({ severity: 'low', reason: 'not-https' });
    if (fetch.status !== 200) problems.push({ severity: 'low', reason: 'not-200' });
    else if (info.format === 'svg') problems.push({ severity: 'low', reason: 'svg' });
    else if (info.format === undefined || !['jpeg', 'png', 'webp', 'gif'].includes(info.format)) problems.push({ severity: 'low', reason: 'unsupported-format' });
    else {
      const { width, height } = info;
      if (bytes > 5 * 1024 * 1024 || fetch.truncated) problems.push({ severity: 'low', reason: 'too-large' });
      else if (bytes > 600 * 1024) problems.push({ severity: 'info', reason: 'over-600kb' });
      if (width !== undefined && height !== undefined) {
        if (width < 200 || height < 200) problems.push({ severity: 'low', reason: 'too-small' });
        else if (width < 1200 || height < 630) problems.push({ severity: 'info', reason: 'below-recommended' });
        const ratio = width / height;
        if (ratio < 1.85 || ratio > 1.97) problems.push({ severity: 'info', reason: 'aspect-ratio' });
      }
    }
    if (problems.length === 0) return pass(evidence);
    const params = { url: image.url, size: info.width !== undefined ? `${info.width}x${info.height}` : 'unknown', bytes, status: fetch.status ?? 0 };
    const severity = worst(problems.map(problem => problem.severity));
    const primary = problems.find(problem => problem.severity === severity)!;
    return fail(severity, evidence, primary.reason, { ...params, problems: problems.map(problem => problem.reason).join(', ') });
  },
};

/** Structured properties belong to the most recent og:image before them. */
function imageGroup(doc: DocumentFacts): Map<string, ElementRef> | undefined {
  const group = new Map<string, ElementRef>();
  let started = false;
  for (const meta of doc.parsed.metas) {
    const key = (meta.attrs.property ?? meta.attrs.name ?? '').toLowerCase();
    if (key === 'og:image' || key === 'og:image:url') {
      if (started) break;
      started = true;
      continue;
    }
    if (started && key.startsWith('og:image:') && !group.has(key)) group.set(key, meta);
  }
  return started ? group : undefined;
}

export const socialOgImageMeta: RuleImplementation = {
  id: 'tech-social-og-image-meta',
  evaluate(context) {
    const page = context.page!;
    const raw = page.raw!;
    const group = imageGroup(raw);
    if (!group) return notApplicable('no-og-image');
    const cite = citer(context);
    const url = page.fetch.finalUrl;
    const declared = [...group.values()].map(ref => cite({ kind: 'html', url, label: evidenceLabel('og:image structured property'), excerpt: metaExcerpt(ref), line: ref.line }));
    const missing = ['og:image:alt', 'og:image:width', 'og:image:height'].filter(key => (group.get(key)?.attrs.content ?? '').trim() === '');
    const image = firstOgImage(page);
    const resource = image ? ogImageResource(context.site, image.url) : undefined;
    const info = resource?.fetch.status === 200 ? imageInfo(resource.fetch.body) : undefined;
    const width = Number(group.get('og:image:width')?.attrs.content);
    const height = Number(group.get('og:image:height')?.attrs.content);
    if (info?.width !== undefined && info.height !== undefined && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      && (Math.abs(info.width - width) > 1 || Math.abs(info.height - height) > 1)) {
      const actual = cite({ kind: 'http', url: resource!.url, label: evidenceLabel('decoded size of the og:image file'), excerpt: describeImage(info) });
      return fail('low', [...declared, actual], 'dimension-mismatch', { declared: `${width}x${height}`, actual: `${info.width}x${info.height}` });
    }
    if (missing.length > 0) {
      const evidence = declared.length > 0 ? declared : [cite({ kind: 'html', url, label: evidenceLabel('og:image without structured properties'), excerpt: image ? metaExcerpt(image.ref) : 'og:image' })];
      return fail('info', evidence, 'missing', { tags: summarizeList(missing, 3) });
    }
    return pass(declared);
  },
};

/** Lowercase scheme and host, no default port and no fragment; path case and query are kept. */
function normalizeUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value.trim(), base);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/** The exempt locale entry point: og:url names the root, which redirects by locale, and this page is a locale home in a hreflang cluster. */
function rootLocaleRedirect(site: SiteFacts, page: PageFacts, ogUrl: string): boolean {
  const og = new URL(ogUrl);
  const final = new URL(page.fetch.finalUrl);
  if (og.pathname !== '/' || final.pathname === '/' || og.origin !== final.origin || page.pageType !== 'home') return false;
  const root = `${og.origin}/`;
  const probes = [...site.localeProbes.filter(probe => probe.url === root).map(probe => probe.fetch), ...[...site.pages.values()].filter(entry => entry.url === root).map(entry => entry.fetch)];
  const redirects = probes.some(fetch => fetch.hops.length > 1 && fetch.finalUrl !== root);
  const cluster = hreflangLinks(pageDocument(page), page.fetch.finalUrl).length > 0;
  return redirects && cluster;
}

export const socialOgUrlCanonical: RuleImplementation = {
  id: 'tech-social-og-url-canonical',
  evaluate(context) {
    const page = context.page!;
    const raw = page.raw!;
    const og = firstValue(raw, 'og:url');
    if (!og) return notApplicable('no-og-url');
    const base = page.fetch.finalUrl;
    const ogUrl = normalizeUrl(og.value, base);
    if (!ogUrl) return notEvaluated('invalid-og-url');
    const canonicalLink = linksWithRel(raw, 'canonical').find(link => link.attrs.href);
    const target = normalizeUrl(canonicalLink?.attrs.href ?? base, base) ?? base;
    const cite = citer(context);
    const evidence = [
      cite({ kind: 'html', url: base, label: evidenceLabel('og:url in the raw HTML'), excerpt: metaExcerpt(og.ref), line: og.ref.line }),
      canonicalLink
        ? cite({ kind: 'html', url: base, label: evidenceLabel('canonical link in the raw HTML'), excerpt: `<link rel="canonical" href="${canonicalLink.attrs.href}">`, line: canonicalLink.line })
        : cite({ kind: 'http', url: page.url, label: evidenceLabel('final URL of the page, which has no canonical link'), excerpt: base }),
    ];
    if (ogUrl === target) return pass(evidence);
    if (rootLocaleRedirect(context.site, page, ogUrl)) return pass(evidence);
    return fail('low', evidence, undefined, { ogUrl, canonical: target });
  },
};
