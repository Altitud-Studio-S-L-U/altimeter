import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import { attribute } from '../../parse/html.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';
import {
  cite, clip, docOf, elements, fold, inMain, inOverlay, inTemplate, indexablePages, mainLandmarks, notApplicable, textContent, words,
} from './common.ts';
import { affiliateNetwork, anchorSource, anchorsOf, followed, isProfileLink, type Anchor } from './links.ts';

const qualified = (anchor: Anchor) => anchor.rel.has('sponsored') || anchor.rel.has('nofollow');

function citeLinks(context: RuleContext, doc: DocumentFacts, anchors: readonly Anchor[], label: string, url?: string): string[] {
  return anchors.slice(0, 5).map(anchor => cite(context, 'html', label, { excerpt: anchorSource(doc, anchor), line: anchor.line, ...(url ? { url } : {}) }));
}

/** The page's own content links: inside <main> when there is one, otherwise outside navigation, header and footer. */
function contentLinks(doc: DocumentFacts, anchors: readonly Anchor[]): Anchor[] {
  const hasMain = mainLandmarks(doc).length > 0;
  return anchors.filter(anchor => !inOverlay(anchor.ancestors) && (hasMain ? inMain(anchor.ancestors) : !inTemplate(anchor.ancestors)));
}

export const thinAffiliate: RuleImplementation = {
  id: 'content-thin-affiliate',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const affiliate = anchorsOf(doc, page.fetch.finalUrl).filter(anchor => anchor.external && affiliateNetwork(anchor.href) !== undefined);
    if (affiliate.length === 0) return { outcome: 'pass' };
    const networks = [...new Set(affiliate.map(anchor => affiliateNetwork(anchor.href)!))];
    return { outcome: 'fail', severity: 'medium', needsJudgment: true, params: { count: affiliate.length, networks: summarizeList(networks) },
      evidence: citeLinks(context, doc, affiliate, 'affiliate link') };
  },
};

const sponsoredContainer = /sponsor|advertorial|patrocinad|patrocinat|publirreportaje|publireportatge|paid-?post|publicidad|publicitat/iu;

function inSponsoredBlock(anchor: Anchor): boolean {
  return anchor.ancestors.some(ancestor => sponsoredContainer.test(`${attribute(ancestor, 'class') ?? ''} ${attribute(ancestor, 'id') ?? ''} ${attribute(ancestor, 'data-type') ?? ''}`));
}

export const paidLinksUnqualified: RuleImplementation = {
  id: 'content-paid-links-unqualified',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const paid = anchorsOf(doc, page.fetch.finalUrl).filter(anchor => anchor.external && (affiliateNetwork(anchor.href) !== undefined || inSponsoredBlock(anchor)));
    if (paid.length === 0) return notApplicable('no-paid-links');
    const bare = paid.filter(anchor => !qualified(anchor));
    if (bare.length === 0) return { outcome: 'pass', evidence: citeLinks(context, doc, paid.slice(0, 2), 'qualified paid or affiliate link') };
    return { outcome: 'fail', severity: 'medium', params: { count: bare.length, total: paid.length }, evidence: citeLinks(context, doc, bare, 'paid or affiliate link without rel=sponsored or nofollow') };
  },
};

const ugcTokens = new Set(['comment', 'comments', 'comment-content', 'comment-body', 'comment-text', 'commentlist', 'comment-list', 'comments-area',
  'reply', 'replies', 'forum-post', 'bbp-reply-content', 'bbp-topic-content', 'disqus_thread', 'user-review', 'review-content', 'ugc']);
const ugcTypes = /schema\.org\/(Comment|DiscussionForumPosting|Answer|UserComments)\b/u;

function ugcRegion(element: Parameters<typeof attribute>[0]): boolean {
  const tokens = `${attribute(element, 'class') ?? ''} ${attribute(element, 'id') ?? ''}`.toLowerCase().split(/\s+/u);
  return tokens.some(token => ugcTokens.has(token)) || ugcTypes.test(attribute(element, 'itemtype') ?? '');
}

export const ugcLinkQualifiers: RuleImplementation = {
  id: 'content-ugc-link-qualifiers',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    if (elements(doc.parsed.document, element => ugcRegion(element)).length === 0) return notApplicable('no-ugc-region');
    const links = anchorsOf(doc, page.fetch.finalUrl).filter(anchor => anchor.external && anchor.ancestors.some(ugcRegion));
    const bare = links.filter(anchor => !['ugc', 'nofollow', 'sponsored'].some(token => anchor.rel.has(token)));
    if (bare.length === 0) return { outcome: 'pass' };
    return { outcome: 'fail', severity: 'medium', params: { count: bare.length }, evidence: citeLinks(context, doc, bare, 'external link in user-generated content without rel=ugc or nofollow') };
  },
};

const creditPattern = /\b(design|designed|diseño|disseny|disseño|desarrollo|development|developed|made|hecho|fet|creado|creat|created|powered|hosting|web|site|website)\b.*\b(by|por|per)\b/iu;

export const linkSchemesVisible: RuleImplementation = {
  id: 'content-link-schemes-visible',
  evaluate(context) {
    const pages = [...context.site.pages.values()].map(page => ({ page, doc: docOf(page) })).filter((entry): entry is { page: PageFacts; doc: DocumentFacts } => entry.doc !== undefined);
    if (pages.length < 3) return notApplicable('fewer-than-three-pages');
    const seen = new Map<string, { anchor: Anchor; doc: DocumentFacts; page: PageFacts; pages: Set<string> }>();
    for (const { page, doc } of pages) {
      for (const anchor of anchorsOf(doc, page.fetch.finalUrl)) {
        if (!anchor.external || !followed(anchor) || !inTemplate(anchor.ancestors) || isProfileLink(anchor.href)) continue;
        if (words(anchor.text).length < 3 || creditPattern.test(anchor.text)) continue;
        const key = `${anchor.href}|${fold(anchor.text)}`;
        const entry = seen.get(key) ?? { anchor, doc, page, pages: new Set<string>() };
        entry.pages.add(page.fetch.finalUrl);
        seen.set(key, entry);
      }
    }
    const sitewide = [...seen.values()].filter(entry => entry.pages.size / pages.length >= 0.5 && entry.pages.size >= 3);
    if (sitewide.length === 0) return { outcome: 'pass' };
    return sitewide.slice(0, 10).map((entry): RuleResult => ({
      outcome: 'fail', severity: 'medium', needsJudgment: true, params: { anchor: clip(entry.anchor.text, 80), target: entry.anchor.href, pages: entry.pages.size },
      evidence: [cite(context, 'crawl', `followed keyword link in the template of ${entry.pages.size} of ${pages.length} pages`, { url: entry.page.fetch.finalUrl, excerpt: anchorSource(entry.doc, entry.anchor), line: entry.anchor.line })],
    }));
  },
};

function labelledBy(doc: DocumentFacts, anchor: Anchor): string {
  const ids = (attribute(anchor.element, 'aria-labelledby') ?? '').split(/\s+/u).filter(Boolean);
  if (ids.length === 0) return '';
  const wanted = new Set(ids);
  return elements(doc.parsed.document, element => wanted.has(attribute(element, 'id') ?? '')).map(visit => textContent(visit.element)).join(' ').trim();
}

export const anchorTextEmpty: RuleImplementation = {
  id: 'content-anchor-text-empty',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const anchors = anchorsOf(doc, page.fetch.finalUrl).filter(anchor => /^https?:/u.test(anchor.href)
      && attribute(anchor.element, 'aria-hidden') !== 'true' && !anchor.ancestors.some(ancestor => attribute(ancestor, 'aria-hidden') === 'true' || attribute(ancestor, 'hidden') !== undefined));
    if (anchors.length === 0) return notApplicable('no-links');
    const empty = anchors.filter(anchor => anchor.name === '' && (attribute(anchor.element, 'title') ?? '').trim() === '' && labelledBy(doc, anchor) === '');
    if (empty.length === 0) return { outcome: 'pass' };
    const internal = empty.filter(anchor => !anchor.external);
    return { outcome: 'fail', severity: internal.length > 0 ? 'medium' : 'low', reason: internal.length > 0 ? 'internal' : 'external',
      params: { count: empty.length, internal: internal.length }, evidence: citeLinks(context, doc, internal.length > 0 ? internal : empty, 'link without text, image alt or label') };
  },
};

const genericAnchors = new Set([
  'click here', 'click', 'here', 'read more', 'more', 'link', 'website', 'article', 'learn more', 'this', 'details', 'continue', 'continue reading',
  'see more', 'view more', 'more info', 'more information', 'haz clic aqui', 'haga clic aqui', 'clic aqui', 'click aqui', 'pincha aqui', 'aqui',
  'leer mas', 'mas informacion', 'mas info', 'ver mas', 'saber mas', 'mas', 'clica aqui', 'fes clic aqui', 'llegir mes', 'mes informacio', 'veure mes',
  'saber-ne mes', 'mes',
]);
const blockChildren = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'ul', 'ol', 'figure', 'article', 'section', 'img', 'picture']);
const anchorKey = (text: string) => fold(text).replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/gu, ' ').trim();

export const anchorTextQuality: RuleImplementation = {
  id: 'content-anchor-text-quality',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const all = anchorsOf(doc, page.fetch.finalUrl).filter(anchor => /^https?:/u.test(anchor.href));
    const anchors = contentLinks(doc, all);
    if (anchors.length === 0) return notApplicable('no-content-links');
    const target = (anchor: Anchor) => anchor.href.replace(/#.*$/u, '');
    const described = new Set(all.filter(anchor => anchor.text !== '' && !genericAnchors.has(anchorKey(anchor.text))).map(target));
    const results: RuleResult[] = [];
    // "Read more" next to a descriptive link to the same page is the card pattern; the descriptive link carries the context.
    const generic = anchors.filter(anchor => genericAnchors.has(anchorKey(anchor.text)) && !attribute(anchor.element, 'aria-label') && !described.has(target(anchor)));
    if (generic.length > 0) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'generic', params: { count: generic.length, examples: summarizeList([...new Set(generic.map(anchor => anchor.text))]) },
        evidence: citeLinks(context, doc, generic, 'generic anchor text') });
    }
    const long = anchors.filter(anchor => anchor.text.length > 100 && !elements(anchor.element, element => blockChildren.has(element.tagName)).length);
    if (long.length > 0) results.push({ outcome: 'fail', severity: 'low', reason: 'too-long', params: { count: long.length }, evidence: citeLinks(context, doc, long, 'anchor text over 100 characters') });
    const repeats = new Map<string, Anchor[]>();
    for (const anchor of all.filter(entry => !entry.external && words(entry.text).length >= 2)) {
      const key = `${target(anchor)}|${anchorKey(anchor.text)}`;
      repeats.set(key, [...(repeats.get(key) ?? []), anchor]);
    }
    const repeated = [...repeats.values()].filter(group => group.length >= 10).sort((a, b) => b.length - a.length)[0];
    if (repeated) {
      results.push({ outcome: 'fail', severity: 'low', reason: 'repeated', params: { count: repeated.length, anchor: clip(repeated[0]!.text, 80) },
        evidence: citeLinks(context, doc, repeated.slice(0, 2), `same anchor text to the same page ${repeated.length} times`) });
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

export const outboundCitations: RuleImplementation = {
  id: 'content-outbound-citations',
  evaluate(context) {
    const editorial: Array<{ anchor: Anchor; doc: DocumentFacts; url: string }> = [];
    for (const { page, doc } of indexablePages(context.site)) {
      for (const anchor of contentLinks(doc, anchorsOf(doc, page.fetch.finalUrl))) {
        if (!anchor.external || isProfileLink(anchor.href) || affiliateNetwork(anchor.href) || anchor.rel.has('sponsored') || anchor.rel.has('ugc') || inSponsoredBlock(anchor)) continue;
        editorial.push({ anchor, doc, url: page.fetch.finalUrl });
      }
    }
    if (editorial.length < 3) return notApplicable('fewer-than-three-editorial-links');
    const nofollow = editorial.filter(entry => entry.anchor.rel.has('nofollow'));
    if (nofollow.length < editorial.length) return { outcome: 'pass' };
    return { outcome: 'fail', severity: 'low', params: { count: editorial.length },
      evidence: editorial.slice(0, 3).map(entry => cite(context, 'html', 'editorial external link with rel=nofollow', { url: entry.url, excerpt: anchorSource(entry.doc, entry.anchor), line: entry.anchor.line })) };
  },
};
