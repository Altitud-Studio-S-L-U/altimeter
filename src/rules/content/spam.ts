import { createHash } from 'node:crypto';
import { decodeHtml, documentFacts, isHtmlResponse } from '../../collect/page.ts';
import type { AgentProbe, DocumentFacts, PageFacts } from '../../core/facts.ts';
import { attribute } from '../../parse/html.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, summarizeList } from '../helpers.ts';
import {
  cite, clip, contentBlocks, contentText, docOf, elements, firstH1, fold, homePage, isHtmlElement, metaDescription, normalizeText, notApplicable, notEvaluated,
  pageTitle, registrableDomain, siteNames, stopwords, words,
} from './common.ts';
import { anchorsOf, followed } from './links.ts';
import { designHiddenSelector, shownIn } from './render.ts';

// ---------------------------------------------------------------------------------------------------------------
// Leftover generation and template artifacts

const assistantPhrases = [
  /\bas an ai(?: language)? model\b/iu, /\bi (?:cannot|can't|am unable to) browse\b/iu, /\bcertainly! here (?:is|are)\b/iu,
  /\bregenerate response\b/iu, /\bas of my (?:last )?knowledge (?:cutoff|update)\b/iu, /\bcomo (?:un )?modelo de lenguaje\b/iu,
  /\bcom a (?:un )?model de llenguatge\b/iu,
];
const templateTokens = [
  /\[(?:insert|inserte|insereix)\b[^\]]{0,60}\]/iu, /\[(?:your|tu|su|el teu|la teva) (?:name|nombre|nom|company|empresa|business|negocio)\]/iu,
  /\blorem ipsum\b/iu, /(?:^|[\s(])%s(?=[\s).,;:]|$)/u,
];
const unrenderedVariable = /\{\{\s*[\w.$-]+\s*\}\}/u;
const aboutAi = /\b(?:ai|ia|llms?|chatgpt|gpt-?\d|openai|anthropic|claude|codex|gemini|copilot|chatbots?|prompts?|language models?|modelos? de lenguaje|models? de llenguatge|inteligencia artificial|intel·ligència artificial|artificial intelligence)\b/iu;

interface Match {
  readonly where: string;
  readonly excerpt: string;
  readonly kind: 'assistant' | 'template';
}

function around(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  return clip(`${start > 0 ? '…' : ''}${text.slice(start, index + length + 60)}`, 200);
}

function scan(where: string, text: string, rendered: boolean): Match[] {
  const found: Match[] = [];
  const patterns: Array<[RegExp, Match['kind']]> = [
    ...assistantPhrases.map(pattern => [pattern, 'assistant'] as [RegExp, Match['kind']]),
    ...templateTokens.map(pattern => [pattern, 'template'] as [RegExp, Match['kind']]),
    // Client-side templates are legitimately unrendered in the raw HTML, so only the rendered DOM is checked.
    ...(rendered ? [[unrenderedVariable, 'template'] as [RegExp, Match['kind']]] : []),
  ];
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(text);
    if (match) found.push({ where, kind, excerpt: around(text, match.index, match[0].length) });
  }
  return found;
}

export const aiArtifacts: RuleImplementation = {
  id: 'content-ai-artifacts',
  evaluate(context) {
    const page = context.page!;
    const doc = docOf(page)!;
    const rendered = doc === page.rendered;
    const text = contentText(doc, { skipCode: true, wholeBody: true });
    const alts = elements(doc.parsed.document, (element, ancestors) => isHtmlElement(element) && element.tagName === 'img'
      && !ancestors.some(ancestor => ['code', 'pre', 'blockquote'].includes(ancestor.tagName)))
      .map(visit => attribute(visit.element, 'alt') ?? '').filter(Boolean).join(' | ');
    const matches = [
      ...scan('title', pageTitle(doc)?.text ?? '', rendered),
      ...scan('meta description', metaDescription(doc)?.text ?? '', rendered),
      ...scan('page text', text, rendered),
      ...scan('image alt text', alts, rendered),
    ];
    if (matches.length === 0) return { outcome: 'pass' };
    const evidence = matches.slice(0, 5).map(match => cite(context, 'text', `${match.kind === 'assistant' ? 'assistant phrase' : 'unfilled template token'} in the ${match.where}`, { excerpt: match.excerpt }));
    const template = matches.some(match => match.kind === 'template');
    // On a page about AI an assistant phrase may be quoted as an example; the analyst decides.
    const needsJudgment = !template && aboutAi.test(text.replace(new RegExp(assistantPhrases.map(pattern => pattern.source).join('|'), 'giu'), ''));
    return {
      outcome: 'fail', severity: 'medium', reason: template ? 'template-token' : 'assistant-phrase', evidence,
      params: { count: matches.length, where: summarizeList([...new Set(matches.map(match => match.where))]) },
      ...(needsJudgment ? { needsJudgment: true } : {}),
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Hidden text and links

const concealing = new Set(['same-color', 'tiny-font', 'offscreen', 'opacity-zero']);
const interactiveTag = /(^|> )(a|button|label|option|summary|select|input)([.#][^>]*)?$/u;

export const hiddenText: RuleImplementation = {
  id: 'content-hidden-text',
  evaluate(context) {
    const page = context.page!;
    const blocks = page.rendered!.result.textBlocks.filter(block => {
      if (!block.hidden || !concealing.has(block.hidden) || designHiddenSelector.test(block.selector) || interactiveTag.test(block.selector)) return false;
      if (words(block.text).length < 3) return false;
      // Reveal-on-scroll sections sit at opacity 0 until an observer fires; only the scrolled user render can tell.
      if (block.hidden === 'opacity-zero' && (!page.userRender || block.revealOnScroll)) return false;
      // Google lists sliders among the patterns that are not hidden text: the other slides are a swipe away.
      if (block.inScroller) return false;
      return !shownIn(page.userRender, block.text);
    });
    if (blocks.length === 0) return { outcome: 'pass' };
    const hiddenWords = blocks.flatMap(block => words(fold(block.text)));
    const counts = new Map<string, number>();
    for (const word of hiddenWords.filter(entry => entry.length > 2 && !stopwords.has(entry))) counts.set(word, (counts.get(word) ?? 0) + 1);
    const repeated = [...counts].filter(([, count]) => count >= 3).map(([word]) => word);
    if (hiddenWords.length < 20 && repeated.length === 0) return { outcome: 'pass' };
    return {
      outcome: 'fail', severity: 'medium', needsJudgment: true,
      params: { words: hiddenWords.length, blocks: blocks.length, reasons: summarizeList([...new Set(blocks.map(block => block.hidden!))]) },
      evidence: blocks.slice(0, 5).map(block => cite(context, 'render', `text hidden by ${block.hidden}`, { excerpt: block.text, path: block.selector })),
    };
  },
};

const hidingReasons = new Set(['same-color', 'tiny-font', 'offscreen', 'opacity-zero', 'zero-size', 'display-none', 'visibility-hidden']);
const iconCharacter = /^[→←↗↘›‹»«▸▾•·×✕☰⋯…+\-*]$/u;

export const hiddenLinks: RuleImplementation = {
  id: 'content-hidden-links',
  evaluate(context) {
    const page = context.page!;
    const rendered = page.rendered!;
    const candidates: Array<{ href: string; text: string; why: string; selector?: string }> = [];
    for (const anchor of anchorsOf(rendered, page.fetch.finalUrl)) {
      if (!anchor.external || !followed(anchor) || attribute(anchor.element, 'aria-label')) continue;
      const text = anchor.text;
      if (text.length === 1 && !iconCharacter.test(text) && !anchor.element.childNodes.some(child => 'tagName' in child && ['img', 'svg'].includes(child.tagName))) {
        candidates.push({ href: anchor.href, text, why: 'single-character anchor' });
        continue;
      }
      if (text === '' || shownIn(page.userRender, text)) continue;
      const blocks = rendered.result.textBlocks.filter(block => /(^|> )a([.#][^>]*)?$/u.test(block.selector) && normalizeText(block.text) === normalizeText(text));
      if (blocks.length === 0 || !blocks.every(block => block.hidden !== undefined && hidingReasons.has(block.hidden) && !designHiddenSelector.test(block.selector))) continue;
      if (blocks.every(block => block.hidden === 'opacity-zero') && !page.userRender) continue;
      candidates.push({ href: anchor.href, text, why: `link hidden by ${blocks[0]!.hidden}`, selector: blocks[0]!.selector });
    }
    if (candidates.length === 0) return { outcome: 'pass' };
    const hosts = [...new Set(candidates.map(candidate => new URL(candidate.href).hostname))];
    return {
      outcome: 'fail', severity: 'medium', needsJudgment: true, params: { count: candidates.length, hosts: summarizeList(hosts) },
      evidence: candidates.slice(0, 5).map(candidate => cite(context, 'render', candidate.why, { excerpt: `${candidate.text} -> ${candidate.href}`, ...(candidate.selector ? { path: candidate.selector } : {}) })),
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Keyword stuffing

const phonePattern = /(?<![\d/.-])\+?\d[\d\s().-]{7,18}\d(?![\d/.-])/gu;

export const keywordStuffing: RuleImplementation = {
  id: 'content-keyword-stuffing',
  evaluate(context) {
    const doc = docOf(context.page!)!;
    const blocks = contentBlocks(doc, { skipInteractive: true });
    const text = blocks.join(' ');
    const tokens = words(fold(text));
    if (tokens.length < 30) return notApplicable('too-little-text');
    // Repetition is counted inside prose; card titles and list items repeat product or place names by design.
    const prose = blocks.map(entry => words(fold(entry))).filter(entry => entry.length >= 12);
    const brands = new Set(siteNames(context.site).map(name => words(fold(name)).join(' ')));
    const threshold = Math.max(8, Math.ceil((tokens.length / 500) * 8));
    let best: { phrase: string; count: number } | undefined;
    for (let size = 4; size >= 2 && !best; size -= 1) {
      const counts = new Map<string, number>();
      for (const run of prose) for (let index = 0; index + size <= run.length; index += 1) {
        const gram = run.slice(index, index + size);
        if (stopwords.has(gram[0]!) || stopwords.has(gram.at(-1)!) || gram.some(token => /^\d+$/u.test(token))) continue;
        const phrase = gram.join(' ');
        if (!brands.has(phrase)) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
      }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= threshold) best = { phrase: top[0], count: top[1] };
    }
    if (best) {
      return { outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'repeated-phrase', params: { phrase: best.phrase, count: best.count, words: tokens.length },
        evidence: [cite(context, 'text', `phrase repeated ${best.count} times in ${tokens.length} words of main content`, { excerpt: best.phrase })] };
    }
    const phones = [...new Set((text.match(phonePattern) ?? []).map(value => value.replace(/\D/gu, '')).filter(digits => digits.length >= 9 && digits.length <= 15))];
    if (phones.length >= 5 && tokens.length < phones.length * 25) {
      return { outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'number-list', params: { count: phones.length, words: tokens.length },
        evidence: [cite(context, 'text', `${phones.length} phone numbers in ${tokens.length} words of main content`, { excerpt: clip(phones.join(', '), 200) })] };
    }
    return { outcome: 'pass' };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// User-agent cloaking and sneaky redirects

interface ProbeView {
  readonly probe: AgentProbe;
  readonly doc: DocumentFacts | undefined;
}

function probeView(page: PageFacts, which: 'googlebot' | 'browser'): ProbeView | undefined {
  const probe = page.uaProbes?.find(entry => (which === 'googlebot' ? entry.agent.token === 'googlebot' : entry.agent.purpose === 'baseline'));
  if (!probe) return undefined;
  const html = probe.fetch.status === 200 && !probe.fetch.error && isHtmlResponse(probe.fetch.headers, probe.fetch.body);
  return { probe, doc: html ? documentFacts(decodeHtml(probe.fetch.headers, probe.fetch.body)) : undefined };
}

function simhash(text: string): bigint {
  const weights = new Array<number>(64).fill(0);
  for (const word of words(fold(text))) {
    const hash = createHash('md5').update(word).digest().readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit += 1) weights[bit]! += (hash >> BigInt(bit)) & 1n ? 1 : -1;
  }
  return weights.reduce((value, weight, bit) => (weight > 0 ? value | (1n << BigInt(bit)) : value), 0n);
}

function hamming(a: bigint, b: bigint): number {
  let value = a ^ b;
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

const challengeOrConsent = /captcha|challenge|just a moment|attention required|access denied|verify you are human|checking your browser|cookie|consent|gdpr/iu;

export const cloakingUa: RuleImplementation = {
  id: 'content-cloaking-ua',
  evaluate(context) {
    const page = context.page!;
    const googlebot = probeView(page, 'googlebot');
    const browser = probeView(page, 'browser');
    if (!googlebot || !browser) return notEvaluated('missing-probe');
    if (!googlebot.doc || !browser.doc) return notEvaluated('probe-not-comparable');
    const browserTitle = pageTitle(browser.doc)?.text ?? '';
    const googlebotTitle = pageTitle(googlebot.doc)?.text ?? '';
    if (challengeOrConsent.test(browserTitle) || challengeOrConsent.test(googlebotTitle)) return notEvaluated('consent-or-challenge');
    const base = page.fetch.finalUrl;
    // Dynamic rendering serves crawlers prerendered HTML and browsers an app shell; compare with what the shell renders to.
    const browserWords = words(contentText(browser.doc, { wholeBody: true })).length;
    const shell = browserWords < 20 && words(contentText(googlebot.doc, { wholeBody: true })).length >= 2 * browserWords + 10;
    if (shell && !page.rendered) return notEvaluated('browser-shell-without-render');
    const userView = shell && page.rendered ? page.rendered : browser.doc;
    const hosts = (doc: DocumentFacts) => new Set(anchorsOf(doc, base).filter(anchor => anchor.external && followed(anchor)).map(anchor => registrableDomain(anchor.href)!));
    const browserHosts = hosts(userView);
    const googlebotOnly = [...hosts(googlebot.doc)].filter(host => !browserHosts.has(host));
    const headingDiffers = normalizeText(googlebotTitle) !== normalizeText(browserTitle)
      || normalizeText(firstH1(googlebot.doc)?.text ?? '') !== normalizeText(firstH1(userView)?.text ?? '');
    const distance = hamming(simhash(contentText(googlebot.doc, { wholeBody: true })), simhash(contentText(userView, { wholeBody: true })));
    const evidence = [
      cite(context, 'probe', 'title served to the Googlebot user agent', { url: googlebot.probe.fetch.finalUrl, excerpt: googlebotTitle }),
      cite(context, 'probe', 'title served to a browser user agent', { url: browser.probe.fetch.finalUrl, excerpt: browserTitle }),
    ];
    if (googlebotOnly.length > 0) {
      const examples = anchorsOf(googlebot.doc, base).filter(anchor => googlebotOnly.includes(registrableDomain(anchor.href)!)).slice(0, 3);
      return { outcome: 'fail', severity: 'high', reason: 'googlebot-only-links', params: { hosts: summarizeList(googlebotOnly) },
        evidence: [...evidence, ...examples.map(anchor => cite(context, 'probe', 'followed link served only to the Googlebot user agent', { url: googlebot.probe.fetch.finalUrl, excerpt: `${anchor.text} -> ${anchor.href}`, line: anchor.line }))] };
    }
    if (headingDiffers && distance > 10) return { outcome: 'fail', severity: 'high', reason: 'different-content', evidence, params: { distance } };
    if (headingDiffers || distance > 10) return { outcome: 'fail', severity: 'low', reason: 'minor-divergence', evidence, params: { distance } };
    return { outcome: 'pass', evidence };
  },
};

const consentOrLogin = /consent|cookie|gdpr|privacy|captcha|challenge|login|signin|sign-in|auth|sso|account/iu;

/** The URL a response finally shows, following an immediate meta refresh as browsers do. */
function landing(view: ProbeView): string {
  const refresh = view.doc?.parsed.metas.find(meta => (meta.attrs['http-equiv'] ?? '').toLowerCase() === 'refresh');
  const target = /^\s*\d+\s*[;,]\s*url\s*=\s*['"]?([^'"]+)/iu.exec(refresh?.attrs.content ?? '')?.[1];
  return (target && absoluteUrl(target, view.probe.fetch.finalUrl)) || view.probe.fetch.finalUrl;
}

export const sneakyRedirects: RuleImplementation = {
  id: 'content-sneaky-redirects',
  evaluate(context) {
    const page = context.page!;
    const googlebot = probeView(page, 'googlebot');
    const browser = probeView(page, 'browser');
    if (!googlebot || !browser) return notEvaluated('missing-probe');
    if (googlebot.probe.fetch.error || browser.probe.fetch.error) return notEvaluated('probe-failed');
    const googlebotLanding = landing(googlebot);
    const browserLanding = landing(browser);
    const evidence = [
      cite(context, 'redirect', 'where the Googlebot user agent lands', { url: googlebot.probe.url, excerpt: googlebotLanding }),
      cite(context, 'redirect', 'where a browser user agent lands', { url: browser.probe.url, excerpt: browserLanding }),
    ];
    if (registrableDomain(googlebotLanding) === registrableDomain(browserLanding)) return { outcome: 'pass', evidence };
    if ([googlebotLanding, browserLanding].some(landingUrl => consentOrLogin.test(landingUrl))) return notEvaluated('consent-or-login-redirect');
    return { outcome: 'fail', severity: 'critical', evidence, params: { googlebot: googlebotLanding, browser: browserLanding } };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Hacked content

const spamVocabulary = /\b(viagra|cialis|levitra|kamagra|tadalafil|sildenafil|online casino|casino online|slot online|slot gacor|judi online|togel|replica (?:watches|watch|handbags|bags)|payday loans?|cheap (?:jerseys|oakley|ray-?ban|ugg)|porn|xxx|escort service|essay writing service|buy followers)\b/iu;
const cjk = /[぀-ヿ㐀-䶿一-鿿가-힯]/gu;

function siteTopic(context: RuleContext): string {
  const home = homePage(context.site);
  const doc = home ? docOf(home) : undefined;
  return [pageTitle(doc)?.text, firstH1(doc)?.text, metaDescription(doc)?.text].filter(Boolean).join(' ');
}

export const hackedSignals: RuleImplementation = {
  id: 'content-hacked-signals',
  evaluate(context) {
    const topic = siteTopic(context);
    if (spamVocabulary.test(topic)) return notApplicable('site-topic-matches-vocabulary');
    const cjkSite = (topic.match(cjk) ?? []).length > 0;
    const results: RuleResult[] = [];
    const spamUrls = context.site.sitemaps.flatMap(sitemap => (sitemap.document?.urls ?? []).map(url => ({ sitemap, url })))
      .filter(entry => spamVocabulary.test(safePath(entry.url.loc).replace(/[-_/+]/gu, ' ')));
    if (spamUrls.length > 0) {
      results.push({ outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'spam-urls-in-sitemap', params: { count: spamUrls.length },
        evidence: spamUrls.slice(0, 5).map(entry => cite(context, 'sitemap', 'sitemap URL with vocabulary typical of injected spam', { url: entry.sitemap.url, excerpt: entry.url.loc, line: entry.url.line })) });
    }
    const pageHits: string[] = [];
    const foreign: string[] = [];
    for (const page of context.site.pages.values()) {
      const doc = docOf(page);
      if (!doc) continue;
      const text = contentText(doc, { wholeBody: true });
      const links = anchorsOf(doc, page.fetch.finalUrl).filter(anchor => anchor.external && spamVocabulary.test(`${anchor.text} ${anchor.href}`));
      for (const anchor of links.slice(0, 3)) pageHits.push(cite(context, 'html', 'outbound link with vocabulary typical of injected spam', { url: page.fetch.finalUrl, excerpt: `${anchor.text} -> ${anchor.href}`, line: anchor.line }));
      const match = spamVocabulary.exec(text);
      if (links.length === 0 && match) pageHits.push(cite(context, 'text', 'page text with vocabulary typical of injected spam', { url: page.fetch.finalUrl, excerpt: clip(text.slice(Math.max(0, match.index - 60), match.index + 80), 200) }));
      const letters = (text.match(/\p{L}/gu) ?? []).length;
      const cjkCount = (text.match(cjk) ?? []).length;
      const lang = (doc.parsed.htmlLang ?? '').toLowerCase();
      if (!cjkSite && !/^(zh|ja|ko)/u.test(lang) && cjkCount >= 200 && cjkCount / Math.max(letters, 1) >= 0.3) {
        foreign.push(cite(context, 'text', 'large block of Chinese, Japanese or Korean text on a site in another language', { url: page.fetch.finalUrl, excerpt: clip(text.slice(text.search(cjk), text.search(cjk) + 120)) }));
      }
    }
    if (pageHits.length > 0) results.push({ outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'spam-vocabulary', params: { count: pageHits.length }, evidence: pageHits.slice(0, 5) });
    if (foreign.length > 0) results.push({ outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'foreign-script-block', params: { count: foreign.length }, evidence: foreign.slice(0, 5) });
    for (const page of context.site.pages.values()) {
      const googlebot = probeView(page, 'googlebot');
      const browser = probeView(page, 'browser');
      if (!googlebot?.doc || !browser?.doc) continue;
      const served = contentText(googlebot.doc, { wholeBody: true });
      const match = spamVocabulary.exec(served);
      if (match && !spamVocabulary.test(contentText(browser.doc, { wholeBody: true }))) {
        results.push({ outcome: 'fail', severity: 'medium', needsJudgment: true, reason: 'cloaked-spam', params: { term: match[0] },
          evidence: [cite(context, 'probe', 'spam vocabulary served only to the Googlebot user agent', { url: googlebot.probe.fetch.finalUrl, excerpt: clip(served.slice(Math.max(0, match.index - 60), match.index + 80), 200) })] });
      }
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

function safePath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return '';
  }
}
