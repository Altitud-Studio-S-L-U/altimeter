import type { RuleImplementation, RuleResult } from '../engine.ts';
import { annotationEvidence, documentAnnotations, headerAnnotations, linkAnnotation, normalizeUrl, parseLinkHeader, type Annotation } from './annotations.ts';
import { fail, groupBy, list, maxEvidence, notApplicable, notEvaluated, pass } from './shared.ts';

type HrefProblem = 'empty-href' | 'protocol-relative' | 'relative' | 'unsupported-scheme';

function hrefProblem(raw: string | undefined): HrefProblem | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return 'empty-href';
  if (value.startsWith('//')) return 'protocol-relative';
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) return 'relative';
  if (scheme !== 'http' && scheme !== 'https') return 'unsupported-scheme';
  return /^https?:\/\/[^/]/iu.test(value) ? undefined : 'relative';
}

const hrefLabel: Readonly<Record<HrefProblem, string>> = {
  'empty-href': 'hreflang annotation without a URL',
  'protocol-relative': 'protocol-relative hreflang URL',
  relative: 'relative hreflang URL',
  'unsupported-scheme': 'hreflang URL with a scheme other than http or https',
};

export const relativeUrl: RuleImplementation = {
  id: 'intl-hreflang-relative-url',
  evaluate({ page, evidence }) {
    const base = normalizeUrl(page!.fetch.finalUrl) ?? page!.fetch.finalUrl;
    const html = documentAnnotations(page!.raw, base, 'html');
    const rendered = page!.rendered && page!.rendered.result.error === undefined ? documentAnnotations(page!.rendered, base, 'rendered') : [];
    // Sitemap alternates are checked by intl-hreflang-sitemap-format, which reads every sitemap entry.
    const annotations = [...(html.length > 0 ? html : rendered), ...headerAnnotations(page!)];
    if (annotations.length === 0) return notApplicable('no-hreflang');
    const flagged = annotations.flatMap(annotation => {
      const problem = hrefProblem(annotation.rawHref);
      return problem ? [{ annotation, problem }] : [];
    });
    if (flagged.length === 0) return pass();
    return [...groupBy(flagged, entry => entry.problem)].map(([problem, group]) => fail(
      problem === 'protocol-relative' ? 'medium' : 'high',
      group.slice(0, maxEvidence).map(entry => annotationEvidence(evidence, entry.annotation, hrefLabel[entry.problem])),
      { count: group.length, hrefs: list(group.map(entry => `"${entry.annotation.rawHref ?? ''}"`)) },
      problem,
    ));
  },
};

export const outsideHead: RuleImplementation = {
  id: 'intl-hreflang-outside-head',
  evaluate({ page, evidence }) {
    const base = normalizeUrl(page!.fetch.finalUrl) ?? page!.fetch.finalUrl;
    const raw = documentAnnotations(page!.raw, base, 'html');
    const renderedDoc = page!.rendered && page!.rendered.result.error === undefined ? page!.rendered : undefined;
    const rendered = documentAnnotations(renderedDoc, base, 'rendered');
    if (raw.length === 0 && rendered.length === 0) return notApplicable('no-hreflang-links');
    const results: RuleResult[] = [];
    const displacedRaw = raw.filter(annotation => annotation.inHead === false);
    if (displacedRaw.length > 0) {
      const ids = displacedRaw.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang link element parsed into the body'));
      const closure = page!.raw!.parsed.headClosure;
      let cause = 'not determined';
      if (closure) {
        cause = closure.cause.kind === 'element' ? `<${closure.cause.tag}> element` : 'text content';
        ids.push(evidence.add({
          kind: 'html', url: base, label: 'content that ended the head early, before the hreflang links',
          excerpt: closure.cause.kind === 'element' ? `<${closure.cause.tag}>` : closure.cause.text, line: closure.cause.line,
        }));
      }
      results.push(fail('high', ids, { count: displacedRaw.length, cause, line: closure?.cause.line ?? 0 }, 'raw-body'));
    }
    // Links that sit in the head of the raw HTML but in the body after rendering were moved by a script.
    const displacedRendered = rendered.filter(annotation => annotation.inHead === false
      && !displacedRaw.some(entry => entry.value === annotation.value && entry.href === annotation.href));
    if (displacedRendered.length > 0) {
      results.push(fail('high', displacedRendered.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang link element in the body of the rendered DOM')),
        { count: displacedRendered.length, cause: 'script', line: 0 }, 'rendered-body'));
    }
    return results.length > 0 ? results : pass();
  },
};

const key = (annotation: Annotation) => `${annotation.value.toLowerCase()} ${annotation.href ?? annotation.rawHref ?? ''}`;

export const renderedOnly: RuleImplementation = {
  id: 'intl-hreflang-rendered-only',
  evaluate({ page, evidence }) {
    const base = normalizeUrl(page!.fetch.finalUrl) ?? page!.fetch.finalUrl;
    const raw = documentAnnotations(page!.raw, base, 'html');
    const rendered = documentAnnotations(page!.rendered, base, 'rendered');
    if (raw.length === 0 && rendered.length === 0) return notApplicable('no-hreflang-links');
    if (raw.length === 0) {
      return fail('low', rendered.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang link element present only after rendering')),
        { count: rendered.length, added: rendered.length, removed: 0 }, 'rendered-only');
    }
    const rawKeys = new Set(raw.map(key));
    const renderedKeys = new Set(rendered.map(key));
    const added = rendered.filter(annotation => !rawKeys.has(key(annotation)));
    const removed = raw.filter(annotation => !renderedKeys.has(key(annotation)));
    if (added.length === 0 && removed.length === 0) return pass();
    return fail('low', [
      ...added.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang link element added by rendering')),
      ...removed.slice(0, maxEvidence).map(annotation => annotationEvidence(evidence, annotation, 'hreflang link element missing after rendering')),
    ], { count: added.length + removed.length, added: added.length, removed: removed.length }, 'differs');
  },
};

const htmlTypes = new Set(['text/html', 'application/xhtml+xml']);

function combination(annotation: Annotation): 'media' | 'canonical' | 'type' | undefined {
  const attrs = annotation.attrs ?? {};
  if (annotation.rel?.includes('canonical')) return 'canonical';
  if (attrs.media !== undefined) return 'media';
  const type = attrs.type?.trim().toLowerCase().split(';')[0];
  if (type && !htmlTypes.has(type)) return 'type';
  return undefined;
}

const combinationLabel = {
  media: 'hreflang combined with a media attribute in one link',
  canonical: 'hreflang attribute on a rel=canonical link',
  type: 'hreflang combined with a non-HTML type in one link',
} as const;

export const combinedLinkAttributes: RuleImplementation = {
  id: 'intl-hreflang-combined-link-attributes',
  evaluate({ page, evidence }) {
    const base = normalizeUrl(page!.fetch.finalUrl) ?? page!.fetch.finalUrl;
    // rel=canonical links with hreflang are not hreflang annotations, so they are collected separately.
    const canonicalWithHreflang = (page!.raw?.parsed.links ?? [])
      .filter(link => link.rel.includes('canonical') && !link.rel.includes('alternate') && link.attrs.hreflang !== undefined)
      .map(link => linkAnnotation(page!.raw!, link, base, 'html'));
    const annotations = [...documentAnnotations(page!.raw, base, 'html'), ...headerAnnotations(page!), ...canonicalWithHreflang];
    if (annotations.length === 0) return notApplicable('no-hreflang');
    const flagged = annotations.flatMap(annotation => {
      const kind = combination(annotation);
      return kind ? [{ annotation, kind }] : [];
    });
    if (flagged.length === 0) return pass();
    return [...groupBy(flagged, entry => entry.kind)].map(([kind, group]) => fail('low',
      group.slice(0, maxEvidence).map(entry => annotationEvidence(evidence, entry.annotation, combinationLabel[entry.kind])),
      { count: group.length }, kind));
  },
};

export const httpHeaderFormat: RuleImplementation = {
  id: 'intl-hreflang-http-header-format',
  evaluate({ page, evidence }) {
    const values = page!.fetch.headers.link ?? [];
    if (values.length === 0) return notApplicable('no-link-header');
    const parsed = parseLinkHeader(values);
    const broken = parsed.errors.filter(raw => /hreflang/iu.test(raw));
    const annotations = headerAnnotations(page!);
    if (annotations.length === 0 && broken.length === 0) return notApplicable('no-hreflang-in-link-header');
    const url = normalizeUrl(page!.fetch.finalUrl);
    const results: RuleResult[] = [];
    if (broken.length > 0) {
      results.push(fail('low', broken.slice(0, maxEvidence).map(raw => evidence.add({ kind: 'header', url: page!.fetch.finalUrl, label: 'Link header value that does not parse as an RFC 8288 link-value', excerpt: raw })),
        { count: broken.length }, 'parse-error'));
    }
    if (annotations.length > 0 && !annotations.some(annotation => annotation.href === url)) {
      results.push(fail('low', [
        evidence.add({ kind: 'header', url: page!.fetch.finalUrl, label: 'Link header hreflang entries, none of which points to the response URL', excerpt: values.join(', ') }),
      ], { count: annotations.length, url: page!.fetch.finalUrl }, 'missing-self'));
    }
    if (results.length > 0) return results;
    if (!url) return notEvaluated('unparseable-url');
    return pass([evidence.add({ kind: 'header', url: page!.fetch.finalUrl, label: 'Link header with hreflang entries', excerpt: values.join(', ') })]);
  },
};

export const placementImplementations: readonly RuleImplementation[] = [relativeUrl, outsideHead, renderedOnly, combinedLinkAttributes, httpHeaderFormat];
