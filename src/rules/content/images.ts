import type { DocumentFacts, PageFacts, ResourceFacts } from '../../core/facts.ts';
import { headerValue } from '../../fetch/http.ts';
import { attribute, collapse } from '../../parse/html.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, metaProperty } from '../helpers.ts';
import {
  cite, clip, docOf, elements, firstString, fold, inMain, isHiddenByMarkup, isHtmlElement, lineOf, mainLandmarks, nodesOf, notApplicable, notEvaluated,
  type Visit,
} from './common.ts';
import { formatFromContentType, formatFromExtension, imageSize, indexableFormats, sniffImage } from './image-bytes.ts';

interface Image extends Visit {
  readonly src: string | undefined;
  readonly alt: string | undefined;
}

const trackingSource = /facebook\.com\/tr|google-analytics\.com|googletagmanager\.com|doubleclick\.net|bat\.bing\.com|analytics\.|\/pixel(\.|\/|\?|$)|\/beacon|\/1x1\.|spacer\.gif|blank\.gif/iu;

const dimension = (element: Image['element'], name: 'width' | 'height') => {
  const value = Number.parseFloat(attribute(element, name) ?? '');
  return Number.isFinite(value) ? value : undefined;
};

/** Images a person sees: <img> and <input type=image>, without tracking pixels or images hidden from assistive technology. */
function imagesOf(doc: DocumentFacts, base: string): Image[] {
  return elements(doc.parsed.document, element => isHtmlElement(element)
    && (element.tagName === 'img' || (element.tagName === 'input' && (attribute(element, 'type') ?? '').toLowerCase() === 'image')))
    .filter(visit => {
      const role = (attribute(visit.element, 'role') ?? '').toLowerCase();
      if (role === 'presentation' || role === 'none' || attribute(visit.element, 'aria-hidden') === 'true') return false;
      if (isHiddenByMarkup(visit.element) || visit.ancestors.some(ancestor => isHiddenByMarkup(ancestor) || attribute(ancestor, 'aria-hidden') === 'true')) return false;
      const width = dimension(visit.element, 'width');
      const height = dimension(visit.element, 'height');
      if ((width !== undefined && width <= 1) || (height !== undefined && height <= 1)) return false;
      return !trackingSource.test(attribute(visit.element, 'src') ?? '');
    })
    .map(visit => ({ ...visit, src: absoluteUrl(attribute(visit.element, 'src'), base), alt: attribute(visit.element, 'alt') }));
}

function imageSource(doc: DocumentFacts, image: Image): string {
  const location = image.element.sourceCodeLocation;
  return location ? clip(collapse(doc.html.slice(location.startOffset, location.endOffset)), 240) : `<img src="${image.src ?? ''}">`;
}

const citeImages = (context: RuleContext, doc: DocumentFacts, images: readonly Image[], label: string) =>
  images.slice(0, 5).map(image => cite(context, 'html', label, { excerpt: imageSource(doc, image), line: lineOf(image.element) }));

export const imgAltMissing: RuleImplementation = {
  id: 'content-img-alt-missing',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const images = imagesOf(doc, page.fetch.finalUrl);
    if (images.length === 0) return notApplicable('no-images');
    const missing = images.filter(image => image.alt === undefined);
    const emptyAlt = images.filter(image => image.alt !== undefined && image.alt.trim() === '').length;
    if (missing.length === 0) return { outcome: 'pass' };
    const hasMain = mainLandmarks(doc).length > 0;
    // A content image is in the main content and declared at least 100x100 CSS pixels; size is unknown without width and height.
    const content = missing.filter(image => (!hasMain || inMain(image.ancestors)) && (dimension(image.element, 'width') ?? 0) >= 100 && (dimension(image.element, 'height') ?? 0) >= 100);
    return {
      outcome: 'fail', severity: content.length > 0 ? 'medium' : 'low', reason: content.length > 0 ? 'content-image' : 'other-image',
      params: { count: missing.length, total: images.length, emptyAlt },
      evidence: citeImages(context, doc, content.length > 0 ? content : missing, 'image without an alt attribute'),
    };
  },
};

function basename(url: string): string {
  try {
    const parsed = new URL(url);
    const inner = parsed.searchParams.get('url');
    const path = inner && /\/_next\/image|\/_vercel\/image/u.test(parsed.pathname) ? new URL(inner, parsed).pathname : parsed.pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? '');
  } catch {
    return '';
  }
}

const stripExtension = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/iu, '');
const cameraOrHash = /^(?:img|dsc|dscn|dscf|dcim|pxl|mvimg|gopr|screenshot|screen[-_ ]?shot|captura(?:[-_ ]de[-_ ]pantalla)?|whatsapp[-_ ]image)[-_ ]?[\d_ .-]+[a-z]?$|^[a-f0-9]{16,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const genericName = /^(?:image|img|photo|foto|picture|pic|untitled|sin[-_ ]titulo|imagen|imatge|file|download)[-_ ]?\d*$/iu;

export function opaqueFilename(url: string): boolean {
  const name = stripExtension(basename(url));
  return name !== '' && (cameraOrHash.test(name) || genericName.test(name) || /^\d{3,}$/u.test(name));
}

const genericAlts = new Set(['image', 'img', 'photo', 'picture', 'pic', 'graphic', 'banner', 'imagen', 'foto', 'fotografia', 'imatge', 'grafico', 'logo']);

export const imgAltQuality: RuleImplementation = {
  id: 'content-img-alt-quality',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const images = imagesOf(doc, page.fetch.finalUrl).filter(image => (image.alt ?? '').trim() !== '');
    if (images.length === 0) return notApplicable('no-alt-text');
    const results: RuleResult[] = [];
    const filename = images.filter(image => {
      const alt = fold(image.alt!.trim());
      const name = fold(stripExtension(image.src ? basename(image.src) : '')).replace(/[-_]+/gu, ' ').trim();
      return cameraOrHash.test(image.alt!.trim()) || (name !== '' && (alt === name || alt === fold(basename(image.src ?? ''))));
    });
    if (filename.length > 0) results.push({ outcome: 'fail', severity: 'low', reason: 'filename', params: { count: filename.length }, evidence: citeImages(context, doc, filename, 'alt text that repeats the file name') });
    const generic = images.filter(image => genericAlts.has(fold(image.alt!.trim())));
    if (generic.length > 0) results.push({ outcome: 'fail', severity: 'low', needsJudgment: true, reason: 'generic', params: { count: generic.length }, evidence: citeImages(context, doc, generic, 'one-word generic alt text') });
    const lists = images.filter(image => {
      const parts = image.alt!.split(',').map(part => part.trim()).filter(Boolean);
      return parts.length >= 4 && parts.every(part => part.split(/\s+/u).length <= 3);
    });
    if (lists.length > 0) results.push({ outcome: 'fail', severity: 'low', needsJudgment: true, reason: 'keyword-list', params: { count: lists.length }, evidence: citeImages(context, doc, lists, 'alt text made of a comma-separated list') });
    const byAlt = new Map<string, Image[]>();
    for (const image of images) byAlt.set(fold(image.alt!.trim()), [...(byAlt.get(fold(image.alt!.trim())) ?? []), image]);
    // The same picture shown twice may share its alt text; only five or more different images count.
    const repeated = [...byAlt.values()].find(group => new Set(group.map(image => image.src)).size >= 5);
    if (repeated) results.push({ outcome: 'fail', severity: 'low', needsJudgment: true, reason: 'repeated', params: { count: new Set(repeated.map(image => image.src)).size, alt: clip(repeated[0]!.alt!, 80) }, evidence: citeImages(context, doc, repeated.slice(0, 3), 'alt text shared by different images') });
    const long = images.filter(image => image.alt!.length > 250);
    if (long.length > 0) results.push({ outcome: 'fail', severity: 'low', needsJudgment: true, reason: 'too-long', params: { count: long.length }, evidence: citeImages(context, doc, long, 'alt text over 250 characters') });
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

export const imgFilename: RuleImplementation = {
  id: 'content-img-filename',
  evaluate(context) {
    const results: RuleResult[] = [];
    let evaluated = 0;
    for (const page of context.site.pages.values()) {
      const doc = docOf(page);
      if (!doc) continue;
      const hasMain = mainLandmarks(doc).length > 0;
      const images = imagesOf(doc, page.fetch.finalUrl).filter(image => image.src && /^https?:/u.test(image.src) && formatFromExtension(image.src) !== 'svg'
        && (!hasMain || inMain(image.ancestors)));
      const distinct = [...new Map(images.map(image => [image.src!, image])).values()];
      if (distinct.length < 2) continue;
      evaluated += 1;
      const opaque = distinct.filter(image => opaqueFilename(image.src!));
      if (opaque.length / distinct.length < 0.5) continue;
      results.push({ outcome: 'fail', severity: 'low', params: { count: opaque.length, total: distinct.length, url: page.fetch.finalUrl },
        evidence: opaque.slice(0, 5).map(image => cite(context, 'html', 'content image with a non-descriptive file name', { url: page.fetch.finalUrl, excerpt: image.src!, line: lineOf(image.element) })) });
    }
    if (evaluated === 0) return notApplicable('fewer-than-two-content-images');
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

const sameAsset = (a: string, b: string) => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.host === right.host && left.pathname === right.pathname;
  } catch {
    return false;
  }
};

function imageUrls(doc: DocumentFacts, base: string): string[] {
  return elements(doc.parsed.document, element => ['img', 'source'].includes(element.tagName)).flatMap(visit => {
    const srcset = (attribute(visit.element, 'srcset') ?? '').split(',').map(part => part.trim().split(/\s+/u)[0] ?? '');
    return [attribute(visit.element, 'src'), ...srcset].map(value => absoluteUrl(value || undefined, base)).filter((value): value is string => value !== undefined);
  });
}

export const imgCssBackground: RuleImplementation = {
  id: 'content-img-css-background',
  evaluate(context) {
    const page = context.page!;
    const render = page.userRender && page.userRender.result.error === undefined ? page.userRender : page.rendered!;
    const lcp = render.result.lcp;
    if (!lcp) return notEvaluated('no-lcp-element');
    if (!lcp.url || ['img', 'image', 'video', 'picture', 'svg'].includes(lcp.tag ?? '')) return { outcome: 'pass' };
    if (imageUrls(render, page.fetch.finalUrl).some(url => sameAsset(url, lcp.url!))) return { outcome: 'pass' };
    return { outcome: 'fail', severity: 'medium', params: { url: lcp.url, element: lcp.tag ?? 'element' },
      evidence: [cite(context, 'render', 'largest image painted as a CSS background, with no img element for it', { excerpt: lcp.url, ...(lcp.selector ? { path: lcp.selector } : {}) })] };
  },
};

const unsupportedExtension = /\.(heic|heif|tiff?|jxl|jp2|jpx|psd|cr2|nef|dng|raw)(\?|#|$)/iu;

function resourcesFor(context: RuleContext, page: PageFacts, purposes: readonly ResourceFacts['purpose'][]): ResourceFacts[] {
  return context.site.resources.filter(resource => purposes.includes(resource.purpose) && (resource.referencedBy === page.fetch.finalUrl || resource.referencedBy === undefined));
}

export const imgFormat: RuleImplementation = {
  id: 'content-img-format',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const results: RuleResult[] = [];
    const images = imagesOf(doc, page.fetch.finalUrl).filter(image => image.src && unsupportedExtension.test(new URL(image.src).pathname));
    if (images.length > 0) {
      results.push({ outcome: 'fail', severity: 'medium', reason: 'unsupported-format', params: { count: images.length },
        evidence: citeImages(context, doc, images, 'image whose only source has a format Google Images does not index') });
    }
    const fetched = resourcesFor(context, page, ['og-image', 'logo']).filter(resource => resource.fetch.status === 200 && resource.fetch.body.length > 0);
    for (const resource of fetched) {
      const actual = sniffImage(resource.fetch.body);
      const declared = formatFromContentType(headerValue(resource.fetch.headers, 'content-type'));
      const format = actual === 'unknown' ? declared : actual;
      const evidence = [cite(context, 'http', `${resource.purpose} response`, { url: resource.url, excerpt: `content-type: ${headerValue(resource.fetch.headers, 'content-type') ?? '(none)'}; bytes: ${actual}` })];
      if (format !== undefined && format !== 'unknown' && !indexableFormats.has(format)) {
        results.push({ outcome: 'fail', severity: 'medium', reason: 'unsupported-format', params: { count: 1, url: resource.url }, evidence });
        continue;
      }
      const byExtension = formatFromExtension(resource.url);
      if (byExtension !== undefined && actual !== 'unknown' && byExtension !== actual) {
        results.push({ outcome: 'fail', severity: 'low', reason: 'extension-mismatch', params: { url: resource.url, extension: byExtension, actual }, evidence });
      }
    }
    if (results.length > 0) return results;
    if (imagesOf(doc, page.fetch.finalUrl).length === 0 && fetched.length === 0) return notApplicable('no-images');
    return { outcome: 'pass' };
  },
};

const placeholderSource = /^data:|placeholder|blank|spacer|lazy|loading|transparent|1x1|pixel|grey|gray/iu;
const deferredAttributes = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-srcset'] as const;

function deferredImages(doc: DocumentFacts, base: string) {
  return elements(doc.parsed.document, element => element.tagName === 'img' && deferredAttributes.some(name => attribute(element, name) !== undefined))
    .map(visit => {
      const name = deferredAttributes.find(entry => attribute(visit.element, entry) !== undefined)!;
      const real = (attribute(visit.element, name) ?? '').split(',')[0]!.trim().split(/\s+/u)[0] ?? '';
      const src = attribute(visit.element, 'src') ?? '';
      const resolved = absoluteUrl(src || undefined, base);
      const target = absoluteUrl(real || undefined, base);
      return { visit, real: target, src, waiting: src === '' || placeholderSource.test(src) || (resolved !== undefined && target !== undefined && resolved !== target && !sameAsset(resolved, target) && placeholderSource.test(resolved)) };
    });
}

export const imgLazyMisuse: RuleImplementation = {
  id: 'content-img-lazy-misuse',
  evaluate(context) {
    const page = context.page!;
    const base = page.fetch.finalUrl;
    const tall = deferredImages(page.rendered!, base);
    if (tall.length === 0) return notApplicable('no-deferred-images');
    const scrolled = deferredImages(page.userRender!, base);
    const late = tall.filter(image => image.waiting && image.real !== undefined
      && scrolled.some(other => other.real === image.real && !other.waiting));
    if (late.length === 0) return { outcome: 'pass' };
    return { outcome: 'fail', severity: 'medium', params: { count: late.length },
      evidence: late.slice(0, 5).map(image => cite(context, 'render', 'image still showing its placeholder in the tall-viewport render; it loaded only after scrolling', { excerpt: `src="${clip(image.src, 80)}" -> ${image.real}`, line: lineOf(image.visit.element) })) };
  },
};

export const preferredImage: RuleImplementation = {
  id: 'content-preferred-image',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const contentPage = page.pageType === 'article' || page.pageType === 'product';
    const og = metaProperty(doc, 'og:image')[0];
    const primary = nodesOf(doc, ['WebPage', 'Article', 'NewsArticle', 'BlogPosting', 'ItemPage', 'CollectionPage', 'AboutPage', 'ContactPage'])
      .map(node => firstString(node.properties.primaryImageOfPage)).find(value => value !== undefined);
    const raw = primary ?? og?.attrs.content;
    const url = absoluteUrl(raw, page.fetch.finalUrl);
    if (!url) {
      if (!contentPage) return notApplicable('not-a-content-page');
      return { outcome: 'fail', severity: 'low', reason: 'missing', evidence: [cite(context, 'html', 'no og:image or primaryImageOfPage')] };
    }
    const evidence = [cite(context, primary ? 'structured-data' : 'html', primary ? 'primaryImageOfPage' : 'og:image meta tag', { excerpt: url, ...(og && !primary ? { line: og.line } : {}) })];
    const results: RuleResult[] = [];
    const logos = context.site.resources.filter(resource => resource.purpose === 'logo').map(resource => resource.url);
    if (contentPage && (/logo/iu.test(basename(url)) || logos.some(logo => sameAsset(logo, url)))) results.push({ outcome: 'fail', severity: 'low', reason: 'logo', evidence, params: { url } });
    const resource = context.site.resources.find(entry => (entry.purpose === 'og-image' || entry.purpose === 'logo') && sameAsset(entry.url, url));
    if (resource && (resource.fetch.error || resource.fetch.status !== 200)) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'unreachable', params: { url, status: resource.fetch.status ?? resource.fetch.error?.code ?? 'error' },
        evidence: [...evidence, cite(context, 'http', 'preferred image response', { url: resource.url, excerpt: `HTTP ${resource.fetch.status ?? resource.fetch.error?.code ?? 'error'}` })] });
    } else if (resource && page.pageType === 'article') {
      if (sniffImage(resource.fetch.body) === 'svg') return results.length > 0 ? results : notEvaluated('svg-size-not-measurable');
      const size = imageSize(resource.fetch.body);
      if (size && size.width < 1200) results.push({ outcome: 'fail', severity: 'info', reason: 'narrow', params: { url, width: size.width }, evidence });
    }
    return results.length > 0 ? results : { outcome: 'pass', evidence };
  },
};
