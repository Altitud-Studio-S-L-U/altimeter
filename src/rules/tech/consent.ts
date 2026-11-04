import { evidenceLabel } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts } from '../../core/facts.ts';
import type { Hop } from '../../fetch/http.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { attr, auditedPages, citer, elements, fail, notApplicable, pass, shorten, startTag, wordCount, type Cite } from './shared.ts';

/** Containers of common consent platforms, plus generic cookie or consent containers. */
const knownContainers = ['onetrust-banner-sdk', 'onetrust-consent-sdk', 'cybotcookiebotdialog', 'didomi-host', 'usercentrics-root', 'cookie-law-info-bar', 'cmplz-cookiebanner', 'qc-cmp2-container', 'truste-consent-track', 'iubenda-cs-banner', 'cookiescript_injected', 'axeptio_overlay', 'tarteaucitronroot', 'klaro'];

function consentContainer(doc: DocumentFacts): string | undefined {
  for (const element of elements(doc, ['div', 'section', 'aside', 'dialog', 'form'])) {
    const id = (attr(element, 'id') ?? '').toLowerCase();
    const classes = (attr(element, 'class') ?? '').toLowerCase();
    if (knownContainers.some(name => id === name || classes.split(/\s+/u).includes(name))) return startTag(doc, element);
    if (/(^|[-_])(cookie|consent|gdpr|cmp)([-_]|$)/u.test(id) || /(^|[\s_-])(cookie|consent)[-_]?(banner|wall|notice|modal|dialog|bar)\b/u.test(classes)) return startTag(doc, element);
  }
  return undefined;
}

const returnParameter = /[?&](continue|redirect|redirect_uri|redirect_url|return|returnurl|return_to|returnto|url|destination|dest|target|next|origin|done)=/iu;

/** A redirect to a consent wall: a consent host or path that carries the requested URL so it can send the visitor back. */
function consentRedirect(hops: readonly Hop[]): Hop | undefined {
  return hops.find(hop => {
    if (!hop.location) return false;
    const target = new URL(hop.location);
    const consentLike = /^consent\./u.test(target.hostname) || /(^|\/)(consent|cookie-?consent|cookie-?wall|gdpr-consent)(\/|$)/iu.test(target.pathname);
    return consentLike && returnParameter.test(target.search);
  });
}

export const cmpBlocksContent: RuleImplementation = {
  id: 'tech-cmp-blocks-content',
  evaluate(context): RuleResult {
    const page = context.page!;
    const cite = citer(context);
    const redirect = consentRedirect(page.fetch.hops);
    if (redirect) {
      return fail('high', [cite({ kind: 'redirect', url: page.url, label: evidenceLabel('redirect to a consent page before the content'), excerpt: `${redirect.status} ${redirect.url} -> ${redirect.location}` })], 'consent-redirect', { target: redirect.location! });
    }
    const rendered = page.rendered!;
    const container = consentContainer(rendered);
    if (!container) return pass();
    const raw = page.raw;
    const rawWords = raw ? wordCount(raw.parsed.bodyText) : 0;
    const renderedWords = wordCount(rendered.parsed.bodyText);
    const evidence = [cite({ kind: 'render', url: page.fetch.finalUrl, label: evidenceLabel('consent container in the render without interaction'), excerpt: shorten(container, 300) })];
    // The served HTML stands in for the content after consent; a pre-consent render with less than half of it withholds content.
    if (rawWords >= 100 && renderedWords < rawWords * 0.5) {
      evidence.push(cite({ kind: 'text', url: page.fetch.finalUrl, label: evidenceLabel('body words in the raw HTML ({raw}) and in the render before consent ({rendered})', { raw: rawWords, rendered: renderedWords }) }));
      return fail('high', evidence, 'content-withheld', { rawWords, renderedWords });
    }
    return pass(evidence);
  },
};

interface TagOrder {
  readonly googleTag: { readonly offset: number; readonly excerpt: string } | undefined;
  readonly consentDefault: { readonly offset: number; readonly excerpt: string } | undefined;
}

/** Whether a script URL loads Google's tag, gtag.js or gtm.js, from googletagmanager.com. */
function googleTagSrc(src: string): boolean {
  try {
    const url = new URL(src, 'https://site.invalid/');
    return /(?:^|\.)googletagmanager\.com$/u.test(url.hostname) && /^\/(?:gtag\/js|gtm\.js)$/u.test(url.pathname);
  } catch {
    return false;
  }
}
const inlineGoogleTag = /gtag\(\s*['"]config['"]|googletagmanager\.com\/gtm\.js|['"]gtm\.start['"]/u;
const consentDefault = /(gtag|dataLayer\.push)\(\s*\[?\s*['"]consent['"]\s*,\s*['"]default['"]/u;

function tagOrder(doc: DocumentFacts): TagOrder {
  let googleTag: TagOrder['googleTag'];
  let consent: TagOrder['consentDefault'];
  for (const script of doc.parsed.scripts) {
    const src = script.attrs.src ?? '';
    const excerpt = src !== '' ? `<script src="${src}">` : shorten(script.text.trim(), 240);
    if (!consent && consentDefault.test(script.text)) consent = { offset: script.offset, excerpt };
    if (!googleTag && (googleTagSrc(src) || inlineGoogleTag.test(script.text))) googleTag = { offset: script.offset, excerpt };
  }
  return { googleTag, consentDefault: consent };
}

function orderingResult(page: PageFacts, doc: DocumentFacts, cite: Cite): RuleResult | undefined {
  const order = tagOrder(doc);
  if (!order.googleTag) return undefined;
  const url = page.fetch.finalUrl;
  const tag = cite({ kind: 'html', url, label: evidenceLabel('first Google tag in the HTML'), excerpt: order.googleTag.excerpt });
  if (!order.consentDefault) return fail('info', [tag], 'no-consent-default');
  const defaults = cite({ kind: 'html', url, label: evidenceLabel('consent mode default command'), excerpt: order.consentDefault.excerpt });
  if (order.consentDefault.offset > order.googleTag.offset) return fail('info', [tag, defaults], 'default-after-tags');
  return pass([tag, defaults]);
}

export const consentModeOrdering: RuleImplementation = {
  id: 'tech-consent-mode-ordering',
  evaluate(context) {
    const cite = citer(context);
    const results: RuleResult[] = [];
    for (const page of auditedPages(context.site)) {
      if (!page.raw) continue;
      // Script order is only meaningful in the served HTML; the rendered DOM also holds scripts injected later.
      const result = orderingResult(page, page.raw, cite);
      if (result) results.push(result);
    }
    if (results.length === 0) return notApplicable('no-google-tags');
    const fails = results.filter(result => result.outcome === 'fail');
    return fails.length > 0 ? fails : results[0]!;
  },
};

