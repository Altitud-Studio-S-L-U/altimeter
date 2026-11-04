import { evidenceLabel, joinLabels } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import { headerValue } from '../../fetch/http.ts';
import { parseHtml, textOf, type ElementRef } from '../../parse/html.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, metaNamed, metaProperty, pageDocument, summarizeList } from '../helpers.ts';
import { attr, citer, elements, fail, hostOf, lineOf, notApplicable, pass, shorten, startTag, wordCount, type Cite } from './shared.ts';

interface TagGroup {
  readonly name: string;
  readonly entries: readonly { readonly value: string; readonly ref: ElementRef }[];
}

/** Head metadata that must be single-valued. Canonical and robots conflicts are counted by crawl rules. */
function tagGroups(doc: DocumentFacts): TagGroup[] {
  const content = (refs: readonly ElementRef[]) => refs.map(ref => ({ value: (ref.attrs.content ?? '').trim(), ref }));
  return [
    { name: 'meta description', entries: content(metaNamed(doc, 'description')) },
    { name: 'meta viewport', entries: content(metaNamed(doc, 'viewport')).map(entry => ({ ...entry, value: entry.value.replace(/\s+/gu, '').toLowerCase() })) },
    { name: 'og:title', entries: content(metaProperty(doc, 'og:title')) },
    { name: 'og:description', entries: content(metaProperty(doc, 'og:description')) },
    { name: 'og:url', entries: content(metaProperty(doc, 'og:url')) },
    { name: 'og:type', entries: content(metaProperty(doc, 'og:type')).map(entry => ({ ...entry, value: entry.value.toLowerCase() })) },
    { name: 'twitter:card', entries: content(metaNamed(doc, 'twitter:card')).map(entry => ({ ...entry, value: entry.value.toLowerCase() })) },
    { name: 'base href', entries: doc.parsed.bases.filter(base => base.attrs.href !== undefined).map(ref => ({ value: ref.attrs.href!.trim(), ref })) },
  ];
}

function tagExcerpt(ref: ElementRef): string {
  return `<${ref.tag} ${Object.entries(ref.attrs).map(([name, value]) => `${name}="${value}"`).join(' ')}>`;
}

export const duplicateConflictingHeadTags: RuleImplementation = {
  id: 'tech-duplicate-conflicting-head-tags',
  evaluate(context) {
    const page = context.page!;
    const cite = citer(context);
    const docs: Array<[DocumentFacts, string]> = [[page.raw!, 'raw HTML']];
    const rendered = pageDocument(page);
    if (rendered && rendered !== page.raw) docs.push([rendered, 'rendered DOM']);
    const conflicts: string[] = [];
    const evidence: string[] = [];
    for (const [doc, source] of docs) {
      for (const group of tagGroups(doc)) {
        const values = new Set(group.entries.map(entry => entry.value));
        if (values.size < 2 || conflicts.includes(group.name)) continue;
        conflicts.push(group.name);
        for (const entry of group.entries.slice(0, 4)) {
          evidence.push(cite({ kind: 'html', url: page.fetch.finalUrl, label: joinLabels(evidenceLabel('{name} declared more than once with different values', { name: group.name }), source === 'raw HTML' ? evidenceLabel('(raw HTML)') : evidenceLabel('(rendered DOM)')), excerpt: tagExcerpt(entry.ref), line: entry.ref.line }));
        }
      }
    }
    if (conflicts.length === 0) return pass();
    return fail('low', evidence, undefined, { tags: summarizeList(conflicts, 4), count: conflicts.length });
  },
};

export const doctypeStandardsMode: RuleImplementation = {
  id: 'tech-doctype-standards-mode',
  evaluate(context) {
    const page = context.page!;
    const raw = page.raw!;
    const contentType = (headerValue(page.fetch.headers, 'content-type') ?? '').toLowerCase();
    if (contentType.includes('xml')) return notApplicable('xml-document');
    const cite = citer(context);
    const node = raw.parsed.document.childNodes.find(child => child.nodeName === '#documentType') as { name?: string; publicId?: string; systemId?: string; sourceCodeLocation?: { startOffset: number; endOffset: number; startLine: number } } | undefined;
    const doctype = node?.sourceCodeLocation ? raw.html.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset) : undefined;
    const evidence = [doctype === undefined
      ? cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('no document type declaration, so the page is parsed in {mode} mode', { mode: raw.parsed.mode }) })
      : cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('document type declaration, parsed in {mode} mode', { mode: raw.parsed.mode }), excerpt: doctype, line: node?.sourceCodeLocation?.startLine })];
    if (!node) return fail('low', evidence, 'missing', { mode: raw.parsed.mode });
    if (raw.parsed.mode !== 'no-quirks') return fail('low', evidence, raw.parsed.mode, { doctype: doctype ?? '' });
    // Lighthouse also fails a legacy doctype that still yields standards mode, such as HTML 4.01 Strict.
    if ((node.name ?? '').toLowerCase() !== 'html' || (node.publicId ?? '') !== '' || (node.systemId ?? '') !== '') return fail('low', evidence, 'legacy-doctype', { doctype: doctype ?? '' });
    return pass(evidence);
  },
};

const utf8Labels = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8']);

function normalizeLabel(label: string): string {
  const value = label.trim().replace(/^["']|["']$/gu, '').toLowerCase();
  return utf8Labels.has(value) ? 'utf-8' : value;
}

interface MetaCharset {
  readonly label: string;
  readonly excerpt: string;
  readonly early: boolean;
}

/** Meta charset declarations the encoding prescan would see, and their position against the 1024-byte window. */
function metaCharsets(body: Buffer): MetaCharset[] {
  const source = body.toString('latin1');
  // Comments are skipped by the prescan, so blank them out without moving any byte offsets.
  const visible = source.replace(/<!--[\s\S]*?-->/gu, match => ' '.repeat(match.length));
  const found: MetaCharset[] = [];
  for (const match of visible.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const direct = /\bcharset\s*=\s*["']?\s*([\w.:-]+)/iu.exec(tag);
    const httpEquiv = /http-equiv\s*=\s*["']?content-type/iu.test(tag) ? /charset\s*=\s*([\w.:-]+)/iu.exec(tag) : null;
    const label = (direct ?? httpEquiv)?.[1];
    if (label) found.push({ label: normalizeLabel(label), excerpt: tag, early: match.index + tag.length <= 1024 });
  }
  return found;
}

function charsetResult(page: PageFacts, cite: Cite): RuleResult {
  const body = page.fetch.body;
  const url = page.fetch.finalUrl;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return pass([cite({ kind: 'http', url, label: evidenceLabel('UTF-8 byte order mark at the start of the response'), excerpt: 'EF BB BF' })]);
  }
  if (body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff))) {
    return fail('medium', [cite({ kind: 'http', url, label: evidenceLabel('UTF-16 byte order mark at the start of the response'), excerpt: body.subarray(0, 2).toString('hex').toUpperCase() })], 'not-utf8', { label: 'utf-16' });
  }
  const contentType = headerValue(page.fetch.headers, 'content-type') ?? '';
  const headerLabel = /charset\s*=\s*["']?([\w.:-]+)/iu.exec(contentType)?.[1];
  const header = headerLabel === undefined ? undefined : normalizeLabel(headerLabel);
  const metas = metaCharsets(body);
  const headerEvidence = contentType
    ? cite({ kind: 'header', url, label: evidenceLabel('Content-Type header of the HTML response'), excerpt: `Content-Type: ${contentType}` })
    : cite({ kind: 'header', url, label: evidenceLabel('HTML response without a Content-Type header') });
  const metaEvidence = metas.slice(0, 3).map(meta => cite({ kind: 'html', url, label: meta.early ? evidenceLabel('meta charset within the first 1024 bytes') : evidenceLabel('meta charset after the first 1024 bytes'), excerpt: meta.excerpt }));
  const evidence = [headerEvidence, ...metaEvidence];
  const metaLabels = [...new Set(metas.map(meta => meta.label))];
  if (header !== undefined && header !== 'utf-8') return fail('medium', evidence, 'not-utf8', { label: header });
  if (header !== undefined && metaLabels.some(label => label !== header)) return fail('medium', evidence, 'header-meta-conflict', { header, meta: metaLabels.join(', ') });
  if (metaLabels.length > 1) return fail('medium', evidence, 'conflicting-meta', { meta: metaLabels.join(', ') });
  if (header === 'utf-8') return pass(evidence);
  const early = metas.find(meta => meta.early);
  if (early) return early.label === 'utf-8' ? pass(evidence) : fail('medium', evidence, 'not-utf8', { label: early.label });
  if (metas.length > 0) return fail('medium', evidence, 'late-meta', { label: metas[0]!.label });
  return fail('medium', evidence, 'missing');
}

export const charsetDeclaredEarly: RuleImplementation = {
  id: 'tech-charset-declared-early',
  evaluate(context) {
    const page = context.page!;
    if ((headerValue(page.fetch.headers, 'content-type') ?? '').toLowerCase().includes('xml')) return notApplicable('xml-document');
    return charsetResult(page, citer(context));
  },
};

/** Embeds that are normal on content pages: maps, video, forms, payments, captchas and social widgets. */
const embedHosts = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|player\.vimeo\.com|google\.com|maps\.google\.[a-z.]+|googleusercontent\.com|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|stripe\.com|js\.stripe\.com|paypal\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|platform\.twitter\.com|linkedin\.com|tiktok\.com|spotify\.com|soundcloud\.com|calendly\.com|typeform\.com|hubspot\.com|hsforms\.com|openstreetmap\.org|wistia\.com|wistia\.net|loom\.com|dailymotion\.com|twitch\.tv|doubleclick\.net|googletagmanager\.com)$/u;

function hiddenFrame(element: Parameters<typeof attr>[0]): boolean {
  const width = attr(element, 'width');
  const height = attr(element, 'height');
  const style = (attr(element, 'style') ?? '').replace(/\s+/gu, '').toLowerCase();
  return attr(element, 'hidden') !== undefined
    || attr(element, 'aria-hidden') === 'true'
    || width === '0' || height === '0' || width === '1' || height === '1'
    || /display:none|visibility:hidden/u.test(style);
}

function frameName(element: Parameters<typeof attr>[0]): string {
  return [attr(element, 'title'), attr(element, 'aria-label'), attr(element, 'aria-labelledby')].map(value => (value ?? '').trim()).find(value => value !== '') ?? '';
}

export const iframeMainContent: RuleImplementation = {
  id: 'tech-iframe-main-content',
  evaluate(context) {
    const page = context.page!;
    const doc = pageDocument(page)!;
    const base = page.fetch.finalUrl;
    const frames = elements(doc, ['iframe']).filter(frame => !hiddenFrame(frame));
    if (frames.length === 0) return notApplicable('no-iframes');
    const cite = citer(context);
    const results: RuleResult[] = [];
    const untitled = frames.filter(frame => frameName(frame) === '');
    if (untitled.length > 0) {
      const evidence = untitled.slice(0, 10).map(frame => cite({ kind: 'html', url: base, label: evidenceLabel('iframe without a title, aria-label or aria-labelledby'), excerpt: startTag(doc, frame), line: lineOf(frame) }));
      results.push(fail('low', evidence, 'missing-title', { count: untitled.length }));
    }
    const words = wordCount(doc.parsed.bodyText);
    const content = frames.filter(frame => {
      const src = absoluteUrl(attr(frame, 'src'), base);
      const host = src ? hostOf(src) : undefined;
      return src !== undefined && /^https?:/u.test(src) && host !== undefined && !embedHosts.test(host);
    });
    // A page whose own text is short while a non-embed frame is present may deliver its main content in the frame.
    if (content.length > 0 && words < 150) {
      const evidence = [
        ...content.slice(0, 5).map(frame => cite({ kind: 'html', url: base, label: evidenceLabel('iframe that is not a common embed'), excerpt: startTag(doc, frame), line: lineOf(frame) })),
        cite({ kind: 'text', url: base, label: evidenceLabel('words of the page text outside frames: {words}', { words }) }),
      ];
      results.push(fail('low', evidence, 'content-in-iframe', { count: content.length, words }, true));
    }
    return results.length > 0 ? results : pass();
  },
};

const trackingOnly = /^(<img\b[^>]*>|<iframe\b[^>]*>(\s*<\/iframe>)?|\s)*$/iu;

export const noscriptContent: RuleImplementation = {
  id: 'tech-noscript-content',
  evaluate(context) {
    const page = context.page!;
    const raw = page.raw!;
    const blocks = elements(raw, ['noscript']).filter(element => element.sourceCodeLocation && !elementInHead(element));
    if (blocks.length === 0) return notApplicable('no-noscript');
    const renderedText = (page.rendered && page.rendered.result.error === undefined ? page.rendered.parsed.bodyText : '').toLowerCase();
    const cite = citer(context);
    const candidates: string[] = [];
    for (const block of blocks) {
      // With scripting enabled the parser keeps noscript content as text, so parse it on its own.
      const inner = block.childNodes.map(child => ('value' in child ? String(child.value) : '')).join('');
      if (trackingOnly.test(inner)) continue;
      const fragment = parseHtml(`<body>${inner}</body>`);
      const text = textOf(fragment.document);
      const links = fragment.anchors.filter(anchor => anchor.attrs.href).length;
      const words = wordCount(text);
      const sample = text.slice(0, 80).toLowerCase();
      const absent = renderedText === '' || (sample !== '' && !renderedText.includes(sample));
      if ((words >= 50 || links >= 3) && absent) {
        candidates.push(cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('noscript block with {words} words and {links} links not found in the rendered page', { words, links }), excerpt: shorten(inner.trim(), 600), line: lineOf(block) }));
      }
    }
    if (candidates.length === 0) return pass();
    return fail('info', candidates, undefined, { count: candidates.length }, true);
  },
};

function elementInHead(element: Parameters<typeof attr>[0]): boolean {
  for (let current: unknown = element.parentNode; current && typeof current === 'object'; current = (current as { parentNode?: unknown }).parentNode) {
    if ((current as { tagName?: string }).tagName === 'head') return true;
  }
  return false;
}
