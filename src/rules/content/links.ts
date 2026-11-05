import type { DocumentFacts } from '../../core/facts.ts';
import { attribute, collapse } from '../../parse/html.ts';
import { absoluteUrl } from '../helpers.ts';
import { accessibleName, clip, elements, isExternal, isHtmlElement, lineOf, textContent, type Visit } from './common.ts';

export interface Anchor extends Visit {
  /** The href resolved against the page URL. */
  readonly href: string;
  readonly rel: ReadonlySet<string>;
  /** Visible text plus image alt and aria-label, as assistive technology names the link. */
  readonly name: string;
  /** Visible text only. */
  readonly text: string;
  readonly line: number;
  readonly external: boolean;
}

/** Every <a href> of the document; javascript: links and bare "#" are not links. */
export function anchorsOf(doc: DocumentFacts, base: string): Anchor[] {
  return elements(doc.parsed.document, element => isHtmlElement(element) && element.tagName === 'a' && attribute(element, 'href') !== undefined)
    .flatMap(visit => {
      const raw = attribute(visit.element, 'href')!.trim();
      if (raw === '' || raw === '#' || /^javascript:/iu.test(raw)) return [];
      const href = absoluteUrl(raw, base);
      if (!href) return [];
      return [{
        ...visit,
        href,
        rel: new Set((attribute(visit.element, 'rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean)),
        name: accessibleName(visit.element),
        text: textContent(visit.element),
        line: lineOf(visit.element),
        external: isExternal(href, base),
      }];
    });
}

/** True when the link passes ranking signals: no nofollow, sponsored or ugc qualifier. */
export const followed = (anchor: Anchor) => !['nofollow', 'sponsored', 'ugc'].some(token => anchor.rel.has(token));

export function anchorSource(doc: DocumentFacts, anchor: Anchor): string {
  const location = anchor.element.sourceCodeLocation;
  if (!location) return `<a href="${anchor.href}">`;
  return clip(collapse(doc.html.slice(location.startOffset, location.endOffset)), 240);
}

const affiliateHosts: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)amzn\.(to|eu|asia)$/u, 'Amazon'],
  [/(^|\.)awin1\.com$/u, 'Awin'],
  [/(^|\.)tradedoubler\.com$/u, 'Tradedoubler'],
  [/(^|\.)(anrdoezrs\.net|dpbolvw\.net|jdoqocy\.com|kqzyfj\.com|tkqlhce\.com)$/u, 'CJ'],
  [/(^|\.)(sjv\.io|pxf\.io|7eer\.net|ojrq\.net)$/u, 'Impact'],
  [/(^|\.)shareasale\.com$/u, 'ShareASale'],
  [/(^|\.)prf\.hn$/u, 'Partnerize'],
  [/(^|\.)(go\.skimresources\.com|skimresources\.com)$/u, 'Skimlinks'],
  [/(^|\.)click\.linksynergy\.com$/u, 'Rakuten'],
  [/(^|\.)rstyle\.me$/u, 'LTK'],
  [/(^|\.)avantlink\.com$/u, 'AvantLink'],
  [/(^|\.)(pjtra\.com|pjatr\.com|gopjn\.com)$/u, 'Pepperjam'],
  [/(^|\.)tidd\.ly$/u, 'Tradedoubler'],
  [/(^|\.)admitad\.com$/u, 'Admitad'],
];

/** The affiliate network a link goes through, from documented link formats; undefined for ordinary links. */
export function affiliateNetwork(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  for (const [pattern, name] of affiliateHosts) if (pattern.test(host)) return name;
  if (/(^|\.)amazon\.[a-z.]+$/u.test(host) && url.searchParams.has('tag')) return 'Amazon';
  if (['aff_id', 'affid', 'affiliate_id', 'aff'].some(name => url.searchParams.has(name))) return 'affiliate parameter';
  return undefined;
}

const socialHosts = /(^|\.)(facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|github\.com|threads\.net|bsky\.app|mastodon\.social|behance\.net|dribbble\.com|vimeo\.com|wa\.me|whatsapp\.com|t\.me|telegram\.me|spotify\.com|soundcloud\.com|medium\.com|discord\.gg|reddit\.com|tripadvisor\.[a-z.]+|google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl|apple\.com)$/u;

/** Profiles, maps and app stores the site links to about itself; never citations or link schemes. */
export function isProfileLink(href: string): boolean {
  try {
    return socialHosts.test(new URL(href).hostname.toLowerCase());
  } catch {
    return false;
  }
}
