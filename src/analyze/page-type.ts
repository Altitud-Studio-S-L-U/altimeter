import type { DocumentFacts } from '../core/facts.ts';
import type { PageType } from '../core/types.ts';
import type { StructuredData, StructuredNode } from '../parse/structured-data.ts';
import { absoluteUrl, hreflangLinks } from '../rules/helpers.ts';
import { sameLanguage } from '../rules/intl/codes.ts';

export interface PageTypeInput {
  readonly url: string;
  readonly status: number | undefined;
  readonly title: string | undefined;
  readonly h1: string | undefined;
  readonly ogType: string | undefined;
  readonly data: StructuredData | undefined;
  /** True when the URL is the site's home page in any locale. */
  readonly isHome?: boolean;
  /**
   * The language tags the page gives itself, from `ownLanguages`. With them, a one-segment path such as /ca/ or
   * /en-us/ is a locale root only when one of them names that language or region; without them the path decides.
   */
  readonly languages?: readonly string[];
}

export interface PageTypeDecision {
  readonly type: PageType;
  readonly reason: string;
}

// Path segments and words in English, Spanish, Catalan and other common European languages.
const legal = /\b(privacy|privacidad|privacitat|cookies?|legal|aviso-legal|avis-legal|terms|terminos|termes|condiciones|condicions|imprint|impressum|gdpr|rgpd|lopd|mentions-legales)\b/iu;
const contact = /\b(contact|contacto|contacte|kontakt)\b/iu;
const about = /^(about|about-us|sobre|sobre-[a-z0-9-]+|quienes-somos|nosotros|qui-som|equipo|equip|team|empresa)$/iu;
const utility = /\b(search|buscar|cercar|cart|carrito|cistella|checkout|login|signin|sign-in|account|cuenta|compte|thank-you|gracias|gracies|unsubscribe)\b/iu;
const services = /^(services?|servicios?|serveis?|servei)$/iu;
const listing = /^(blog|news|noticias|noticies|category|categoria|tag|etiqueta|archive|archivo|arxiu)$/iu;
const localeSegment = /^\/([a-z]{2}(?:[-_][a-z]{2,4})?)\/?$/iu;

/**
 * Whether a locale-like path segment such as ca, pt-br or us-en names the language or the region of `tag`, with uk
 * standing for GB as sites write it. Two letters alone do not make a locale: /ai/, /go/ or /it/ are often topics.
 */
function namesLocale(segment: string, tag: string): boolean {
  const [language = '', ...subtags] = tag.trim().toLowerCase().replaceAll('_', '-').split('-');
  const regions = subtags.filter(subtag => subtag.length === 2);
  return segment.toLowerCase().split(/[-_]/u).some(part => sameLanguage(part, language) || regions.includes(part) || (part === 'uk' && regions.includes('gb')));
}

/** The language tags a page gives itself: its html lang and the hreflang values of the annotations that point to it. */
export function ownLanguages(doc: DocumentFacts, url: string): string[] {
  const base = absoluteUrl(doc.parsed.bases.find(element => element.attrs.href !== undefined)?.attrs.href, url) ?? url;
  const self = url.replace(/#.*$/su, '');
  const annotated = hreflangLinks(doc, base).filter(link => link.href?.replace(/#.*$/su, '') === self).map(link => link.hreflang);
  return [...(doc.parsed.htmlLang === undefined ? [] : [doc.parsed.htmlLang]), ...annotated];
}

/** Nodes that say what the page is: top-level ones and the main entity of another node, such as an ItemPage's Product. */
const describesPage = (node: StructuredNode) => !node.nested || /\.mainEntity(?:\[\d+\])?$/u.test(node.path);

function segments(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment).toLowerCase());
  } catch {
    return [];
  }
}

/** Classifies a page so rules only run where they are meaningful. Deterministic and explainable. */
export function classifyPage(input: PageTypeInput): PageTypeDecision {
  if (input.status === 404 || input.status === 410) return { type: 'error', reason: `HTTP ${input.status}` };
  let path = '/';
  let query = '';
  try {
    const parsed = new URL(input.url);
    path = parsed.pathname;
    query = parsed.search;
  } catch {
    // An unparseable URL falls through to content-based checks.
  }
  const locale = localeSegment.exec(path)?.[1];
  const localeRoot = locale !== undefined && (input.languages?.some(tag => namesLocale(locale, tag)) ?? true);
  if (input.isHome || path === '/' || localeRoot) return { type: 'home', reason: 'home page or locale root' };
  const parts = segments(input.url);
  const last = parts.at(-1) ?? '';
  const words = `${parts.join(' ')} ${input.title ?? ''} ${input.h1 ?? ''}`;
  if (/[?&](q|s|query|search)=/iu.test(query) || utility.test(parts.join(' '))) return { type: 'utility', reason: 'search, cart, account or confirmation URL' };
  if (legal.test(parts.join(' ')) || legal.test(input.h1 ?? '')) return { type: 'legal', reason: 'legal or policy page' };
  if (contact.test(last) || contact.test(input.h1 ?? '')) return { type: 'contact', reason: 'contact page' };
  if (about.test(last)) return { type: 'about', reason: 'about page' };
  const types = new Set(input.data?.nodes.filter(describesPage).flatMap(node => node.types) ?? []);
  if (['Product', 'ProductGroup'].some(type => types.has(type)) || input.ogType === 'product') return { type: 'product', reason: 'Product markup or og:type product' };
  if (['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'Recipe'].some(type => types.has(type)) || input.ogType === 'article') {
    return { type: 'article', reason: 'Article or Recipe markup or og:type article' };
  }
  if (['CollectionPage', 'ItemList', 'SearchResultsPage'].some(type => types.has(type)) || (parts.length === 1 && listing.test(last))) {
    return { type: 'listing', reason: 'collection markup or listing path' };
  }
  if (types.has('Service') || parts.some(part => services.test(part))) return { type: 'service', reason: 'Service markup or services path' };
  if (/\b(404|not found|no encontrada|no trobada)\b/iu.test(words)) return { type: 'error', reason: 'error wording in the title or heading' };
  return { type: 'other', reason: 'no specific signal' };
}
