import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { Severity } from '../../core/types.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { annotationEvidence, pageAnnotations, type Annotation } from './annotations.ts';
import { documentAt } from './cluster.ts';
import { countryLanguage, parseHreflang, problemOwner, reservedRegions, withdrawn639, type HreflangProblem } from './codes.ts';
import { fail, groupBy, list, maxEvidence, notApplicable, pass } from './shared.ts';
import { languageEvidence, languageLabel, pageLanguage } from './text.ts';

interface Flagged {
  readonly annotation: Annotation;
  readonly problem: HreflangProblem;
}

function flagged(context: RuleContext, owner: (typeof problemOwner)[HreflangProblem]): { annotations: Annotation[]; flags: Flagged[] } {
  const annotations = pageAnnotations(context.page!, context.site);
  const flags: Flagged[] = [];
  for (const annotation of annotations) {
    for (const problem of parseHreflang(annotation.value).problems) if (problemOwner[problem] === owner) flags.push({ annotation, problem });
  }
  return { annotations, flags };
}

const problemLabel: Readonly<Record<HreflangProblem, EvidenceLabel>> = {
  empty: evidenceLabel('empty hreflang value'),
  'language-not-two-letters': evidenceLabel('language subtag is not a two-letter ISO 639-1 code'),
  'unknown-language': evidenceLabel('language subtag is not in ISO 639-1'),
  'withdrawn-language': evidenceLabel('language subtag was withdrawn from ISO 639-1'),
  'private-use': evidenceLabel('private-use or grandfathered tag other than x-default'),
  'country-as-language': evidenceLabel('country code used where a language code belongs'),
  'unassigned-region': evidenceLabel('region subtag is not an assigned ISO 3166-1 alpha-2 code'),
  'reserved-region': evidenceLabel('region subtag is a reserved ISO 3166-1 code'),
  'numeric-region': evidenceLabel('numeric UN M.49 region, which Google does not support'),
  'three-letter-region': evidenceLabel('three-letter region subtag'),
  whitespace: evidenceLabel('whitespace inside the value'),
  underscore: evidenceLabel('underscore used as separator'),
  'empty-subtag': evidenceLabel('empty subtag'),
  'unknown-script': evidenceLabel('script subtag is not an ISO 15924 code'),
  'script-after-region': evidenceLabel('script subtag placed after the region'),
  variant: evidenceLabel('variant subtag, which Google does not document for hreflang'),
  extension: evidenceLabel('extension subtag, which Google does not document for hreflang'),
  'too-many-subtags': evidenceLabel('more than three subtags'),
  malformed: evidenceLabel('value does not follow language-Script-REGION'),
};

/** One failure per problem kind, citing the first annotations that show it. */
function report(context: RuleContext, flags: readonly Flagged[], severityOf: (problem: HreflangProblem) => Severity, extra?: (problem: HreflangProblem, flags: readonly Flagged[]) => Record<string, string>): RuleResult[] {
  return [...groupBy(flags, flag => flag.problem)].map(([problem, group]) => {
    const first = new Map<string, Flagged>();
    for (const flag of group) {
      const key = `${flag.annotation.source} ${flag.annotation.value}`;
      if (!first.has(key)) first.set(key, flag);
    }
    const evidence = [...first.values()].slice(0, maxEvidence).map(flag => annotationEvidence(context.evidence, flag.annotation, problemLabel[flag.problem]));
    const values = group.map(flag => flag.annotation.value);
    return fail(severityOf(problem as HreflangProblem), evidence, {
      count: new Set(values).size,
      values: list(values.map(value => `"${value}"`)),
      sources: list(group.map(flag => flag.annotation.source)),
      ...(extra ? extra(problem as HreflangProblem, group) : {}),
    }, problem);
  });
}

export const invalidLanguageCode: RuleImplementation = {
  id: 'intl-hreflang-invalid-language-code',
  evaluate(context) {
    const { annotations, flags } = flagged(context, 'language');
    if (annotations.length === 0) return notApplicable('no-hreflang');
    if (flags.length === 0) return pass();
    // A withdrawn code (iw for Hebrew) still names a real language; the risk is lower than an unknown code.
    return report(context, flags, problem => (problem === 'withdrawn-language' ? 'low' : 'medium'), (problem, group) =>
      problem === 'withdrawn-language' ? { replacement: list(group.map(flag => withdrawn639[parseHreflang(flag.annotation.value).language ?? ''] ?? '')) } : {});
  },
};

export const invalidRegionCode: RuleImplementation = {
  id: 'intl-hreflang-invalid-region-code',
  evaluate(context) {
    const { annotations, flags } = flagged(context, 'region');
    if (annotations.length === 0) return notApplicable('no-hreflang');
    if (!annotations.some(annotation => parseHreflang(annotation.value).region !== undefined)) return notApplicable('no-region-subtag');
    if (flags.length === 0) return pass();
    return report(context, flags, () => 'medium', (problem, group) =>
      problem === 'reserved-region' ? { replacement: list(group.map(flag => reservedRegions[parseHreflang(flag.annotation.value).region ?? ''] ?? '')) } : {});
  },
};

export const invalidScriptOrSyntax: RuleImplementation = {
  id: 'intl-hreflang-invalid-script-or-syntax',
  evaluate(context) {
    const { annotations, flags } = flagged(context, 'syntax');
    if (annotations.length === 0) return notApplicable('no-hreflang');
    if (flags.length === 0) return pass();
    // Variants are valid BCP 47 that Google does not document; reported, but below real syntax errors.
    return report(context, flags, problem => (problem === 'variant' ? 'low' : 'medium'));
  },
};

export const regionOnlyValue: RuleImplementation = {
  id: 'intl-hreflang-region-only-value',
  evaluate(context) {
    const { annotations, flags } = flagged(context, 'region-only');
    if (annotations.length === 0) return notApplicable('no-hreflang');
    const results: RuleResult[] = flags.length > 0 ? report(context, flags, () => 'medium') : [];
    // A valid language code that is also a country code ("ca", "be") is a mistake only when the target's content
    // is in a language of that country instead.
    const ambiguous = annotations.filter(annotation => {
      const parsed = parseHreflang(annotation.value);
      return parsed.problems.length === 0 && parsed.region === undefined && parsed.script === undefined && countryLanguage[parsed.language ?? ''];
    });
    const seen = new Set<string>();
    for (const annotation of ambiguous) {
      const code = parseHreflang(annotation.value).language!;
      if (!annotation.href || seen.has(`${code} ${annotation.href}`)) continue;
      seen.add(`${code} ${annotation.href}`);
      const target = documentAt(context.site, annotation.href);
      const language = target ? pageLanguage(target) : undefined;
      if (!language || language.guess.language === 'und' || language.guess.confidence < 0.9) continue;
      const detected = language.guess.language;
      if (detected === code || !countryLanguage[code]!.includes(detected)) continue;
      results.push(fail('medium', [
        annotationEvidence(context.evidence, annotation, evidenceLabel('hreflang "{value}" names {language}', { value: annotation.value, language: languageLabel(code) })),
        languageEvidence(context.evidence, annotation.href, language),
      ], { values: `"${annotation.value}"`, count: 1, sources: annotation.source, language: languageLabel(code), detected: languageLabel(detected), target: annotation.href }, 'possible-country', true));
    }
    return results.length > 0 ? results : pass();
  },
};

export const valueImplementations: readonly RuleImplementation[] = [invalidLanguageCode, regionOnlyValue, invalidRegionCode, invalidScriptOrSyntax];
