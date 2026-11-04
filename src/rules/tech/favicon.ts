import { evidenceLabel } from '../../core/evidence.ts';
import type { ResourceFacts, SiteFacts } from '../../core/facts.ts';
import { isAllowed } from '../../fetch/robots.ts';
import type { LinkRef } from '../../parse/html.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, directivesFor, documentBase, pageDocument, robotsDirectives, sameSite } from '../helpers.ts';
import { describeImage, imageInfo, type ImageInfo } from './image.ts';
import { citer, fail, firstHeader, homePage, notApplicable, pass, type Cite } from './shared.ts';

/** rel values Google reads for favicons in Search. */
function isFaviconLink(link: LinkRef): boolean {
  return link.rel.includes('icon') || link.rel.includes('apple-touch-icon') || link.rel.includes('apple-touch-icon-precomposed');
}

function linkExcerpt(link: LinkRef): string {
  return `<link ${Object.entries(link.attrs).map(([name, value]) => `${name}="${value}"`).join(' ')}>`;
}

export const faviconDeclared: RuleImplementation = {
  id: 'tech-favicon-declared',
  evaluate(context) {
    const page = context.page!;
    const doc = pageDocument(page)!;
    const cite = citer(context);
    const links = doc.parsed.links.filter(link => isFaviconLink(link) && (link.attrs.href ?? '').trim() !== '');
    const inHead = links.filter(link => link.inHead);
    if (inHead.length > 0) {
      return pass(inHead.slice(0, 4).map(link => cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('favicon link element in the home page head'), excerpt: linkExcerpt(link), line: link.line })));
    }
    if (links.length > 0) {
      const evidence = links.slice(0, 4).map(link => cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('favicon link element outside the head'), excerpt: linkExcerpt(link), line: link.line }));
      return fail('low', evidence, 'outside-head');
    }
    const fallback = context.site.resources.find(resource => resource.purpose === 'favicon' && new URL(resource.url).pathname === '/favicon.ico' && sameSite(resource.url, page.fetch.finalUrl));
    const absent = cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('home page without a link element whose rel is icon, shortcut icon or apple-touch-icon'), excerpt: '<link rel="icon"> (absent)' });
    if (fallback && fallback.fetch.status === 200 && imageInfo(fallback.fetch.body).format !== undefined) {
      // Google documents only the link element; /favicon.ico alone is reported for context.
      return fail('info', [absent, cite({ kind: 'http', url: fallback.url, label: evidenceLabel('undeclared /favicon.ico response'), excerpt: `${fallback.fetch.status} ${firstHeader(fallback.fetch.headers, 'content-type') ?? ''}`.trim() })], 'favicon-ico-only');
    }
    return fail('medium', [absent], 'missing');
  },
};

const googleFormats = new Set(['bmp', 'gif', 'ico', 'png', 'jpeg', 'ppm', 'tiff']);

interface Candidate {
  readonly resource: ResourceFacts;
  readonly info: ImageInfo;
  readonly evidence: string;
  /** Why Google cannot use the file, or undefined when it can. */
  readonly problem: string | undefined;
}

/** Favicon URLs the home page declares; the resource list also holds icons of other pages and /favicon.ico. */
function declaredOnHome(site: SiteFacts): Set<string> | undefined {
  const home = homePage(site);
  const doc = home ? pageDocument(home, 'raw') ?? pageDocument(home) : undefined;
  if (!home || !doc) return undefined;
  const base = documentBase(doc, home.fetch.finalUrl);
  return new Set(doc.parsed.links.filter(isFaviconLink).map(link => absoluteUrl(link.attrs.href, base)).filter((url): url is string => url !== undefined));
}

function robotsProblem(site: SiteFacts, url: string): string | undefined {
  const availability = site.robots?.availability;
  if (!availability || availability.kind !== 'parsed' || new URL(url).origin !== new URL(site.origin).origin) return undefined;
  const parsed = new URL(url);
  return isAllowed(availability.file, ['googlebot-image', 'googlebot'], `${parsed.pathname}${parsed.search}`).allowed ? undefined : 'blocked-for-googlebot-image';
}

function candidate(site: SiteFacts, resource: ResourceFacts, cite: Cite): Candidate {
  const { fetch } = resource;
  const info = fetch.status === 200 ? imageInfo(fetch.body) : { format: undefined };
  const evidence = cite({ kind: 'http', url: resource.url, label: evidenceLabel('favicon file response'), excerpt: `${fetch.status ?? fetch.error?.code ?? 'no response'} ${firstHeader(fetch.headers, 'content-type') ?? ''} ${fetch.status === 200 ? describeImage(info) : ''}`.replace(/\s+/gu, ' ').trim() });
  const directives = directivesFor(robotsDirectives(fetch.headers, undefined), 'googlebot-image');
  let problem: string | undefined;
  if (fetch.status !== 200) problem = 'not-200';
  else if (info.format === undefined) problem = 'not-an-image';
  else if (info.format === 'svg') problem = 'svg';
  else if (!googleFormats.has(info.format)) problem = 'unsupported-format';
  else if (info.width !== undefined && info.height !== undefined && info.width !== info.height) problem = 'not-square';
  else if (info.width !== undefined && info.width < 8) problem = 'too-small';
  else if (directives.has('noindex') || directives.has('noimageindex')) problem = 'noindex';
  else problem = robotsProblem(site, resource.url);
  return { resource, info, evidence, problem };
}

export const faviconFileValid: RuleImplementation = {
  id: 'tech-favicon-file-valid',
  evaluate(context): RuleResult {
    const { site } = context;
    const declared = declaredOnHome(site);
    const resources = site.resources.filter(resource => (resource.purpose === 'favicon' || resource.purpose === 'apple-touch-icon') && (declared === undefined || declared.has(resource.url)));
    if (resources.length === 0) return notApplicable(declared === undefined || declared.size === 0 ? 'no-declared-favicon' : 'favicon-not-fetched');
    const cite = citer(context);
    const candidates = resources.map(resource => candidate(site, resource, cite));
    const usable = candidates.filter(entry => entry.problem === undefined);
    const evidence = candidates.map(entry => entry.evidence);
    if (usable.length === 0) {
      const svgOnly = candidates.every(entry => entry.problem === 'svg');
      const first = candidates.find(entry => entry.problem !== 'svg') ?? candidates[0]!;
      return fail('medium', evidence, svgOnly ? 'svg-only' : first.problem, { url: first.resource.url, format: first.info.format ?? 'unknown' });
    }
    const measured = usable.filter(entry => entry.info.width !== undefined);
    const largest = Math.max(0, ...measured.map(entry => entry.info.width!));
    if (measured.length === usable.length && largest <= 48) {
      return fail('low', evidence, 'small', { url: measured[0]!.resource.url, size: `${largest}x${largest}` });
    }
    const broken = candidates.filter(entry => entry.problem !== undefined && entry.problem !== 'svg');
    if (broken.length > 0) return fail('low', evidence, 'broken-alternate', { url: broken[0]!.resource.url, problem: broken[0]!.problem! });
    return pass(evidence);
  },
};
