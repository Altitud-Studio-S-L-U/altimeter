import type { LighthouseSummary } from '../../render/lighthouse.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { auditFailed, citer, fail, lighthouseSummary, notEvaluated, pass, type Cite } from './shared.ts';

/** Lighthouse 13.6 SEO audits, each mapped to the catalog rule that counts its failure. */
const seoAudits = ['is-crawlable', 'document-title', 'meta-description', 'http-status-code', 'link-text', 'crawlable-anchors', 'robots-txt', 'image-alt', 'hreflang', 'canonical'] as const;

/** Accessibility audits that check what crawlers also read; the rest affect users only. */
const searchA11yAudits = ['image-alt', 'link-name', 'document-title', 'html-has-lang'] as const;
const otherA11yAudits = ['input-image-alt', 'button-name', 'html-lang-valid', 'valid-lang', 'frame-title', 'heading-order', 'color-contrast', 'target-size', 'meta-viewport', 'meta-refresh', 'label'] as const;

const bestPracticeAudits = ['is-on-https', 'redirects-http', 'deprecations', 'inspector-issues', 'third-party-cookies', 'doctype', 'charset', 'image-aspect-ratio', 'image-size-responsive', 'errors-in-console'] as const;

function failing(summary: LighthouseSummary, ids: readonly string[]): string[] {
  return ids.filter(id => auditFailed(summary.audits[id]));
}

function categoryResult(cite: Cite, url: string, summary: LighthouseSummary, category: string, groups: ReadonlyArray<readonly [string, readonly string[]]>): RuleResult {
  const score = summary.categories[category];
  if (score === undefined || score === null) return notEvaluated(`no-${category}-category`);
  const percent = Math.round(score * 100);
  const evidence = [cite({ kind: 'lighthouse', url, label: `Lighthouse ${summary.lighthouseVersion} ${category} category score`, excerpt: `${category}=${percent}` })];
  const params: Record<string, string | number> = { score: percent };
  let total = 0;
  for (const [name, ids] of groups) {
    const failed = failing(summary, ids);
    total += failed.length;
    params[name] = failed.length > 0 ? failed.join(', ') : 'none';
    for (const id of failed) evidence.push(cite({ kind: 'lighthouse', url, label: `failing Lighthouse audit: ${summary.audits[id]!.title}`, excerpt: `${id} score=0` }));
  }
  if (total === 0) return pass(evidence);
  return fail('info', evidence, undefined, { ...params, count: total });
}

export const lighthouseSeoCategory: RuleImplementation = {
  id: 'tech-lighthouse-seo-category',
  evaluate(context) {
    const page = context.page!;
    return categoryResult(citer(context), page.fetch.finalUrl, lighthouseSummary(page)!, 'seo', [['audits', seoAudits]]);
  },
};

export const lighthouseA11yOverlap: RuleImplementation = {
  id: 'tech-lighthouse-a11y-overlap',
  evaluate(context) {
    const page = context.page!;
    return categoryResult(citer(context), page.fetch.finalUrl, lighthouseSummary(page)!, 'accessibility', [['searchAudits', searchA11yAudits], ['otherAudits', otherA11yAudits]]);
  },
};

export const chromeBestPracticesTrust: RuleImplementation = {
  id: 'tech-chrome-best-practices-trust',
  evaluate(context) {
    const page = context.page!;
    return categoryResult(citer(context), page.fetch.finalUrl, lighthouseSummary(page)!, 'best-practices', [['audits', bestPracticeAudits]]);
  },
};
