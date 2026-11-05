import { evidenceLabel } from '../../core/evidence.ts';
import type { PageFacts } from '../../core/facts.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { auditedPages, citer, fail, firstHeader, pass, shorten, wordCount, type Cite } from './shared.ts';

/** Wording of maintenance and outage pages in English, Spanish, Catalan, French and German. */
const maintenanceWording = /\b(under maintenance|down for maintenance|scheduled maintenance|maintenance mode|temporarily unavailable|we'?ll be back( soon)?|be right back|en mantenimiento|estamos en mantenimiento|en manteniment|temporalmente no disponible|en maintenance|site en maintenance|wartungsarbeiten|wartungsmodus|vor[uü]bergehend nicht verf[uü]gbar)\b/iu;

/** Retry-After is an HTTP-date or a number of seconds (RFC 9110 section 10.2.3). */
function validRetryAfter(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return /^\d+$/u.test(trimmed) || !Number.isNaN(Date.parse(trimmed));
}

function maintenanceCandidate(page: PageFacts, cite: Cite): RuleResult | undefined {
  const raw = page.raw;
  if (!raw) return undefined;
  const title = raw.parsed.titles[0]?.text.trim() ?? '';
  const h1 = raw.parsed.headings.find(heading => heading.level === 1)?.text ?? '';
  const words = wordCount(raw.parsed.bodyText);
  // A short page whose title or main heading announces maintenance; long pages that discuss maintenance are content.
  if (words > 200 || !(maintenanceWording.test(title) || maintenanceWording.test(h1))) return undefined;
  const evidence = [
    cite({ kind: 'http', url: page.url, label: evidenceLabel('status of the audited page'), excerpt: `${page.fetch.status} ${page.fetch.finalUrl}` }),
    cite({ kind: 'html', url: page.fetch.finalUrl, label: evidenceLabel('title and main heading of the page'), excerpt: shorten(`title: ${title}\nh1: ${h1}`, 300) }),
  ];
  return fail('medium', evidence, 'maintenance-page-200', { url: page.fetch.finalUrl, words }, true);
}

export const maintenance503: RuleImplementation = {
  id: 'tech-maintenance-503',
  evaluate(context) {
    const cite = citer(context);
    const results: RuleResult[] = [];
    const passes: string[] = [];
    for (const page of auditedPages(context.site)) {
      if (page.fetch.status === 503) {
        const retryAfter = firstHeader(page.fetch.headers, 'retry-after');
        const evidence = retryAfter === undefined
          ? cite({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('503 response without a Retry-After header') })
          : cite({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('503 response and its Retry-After header'), excerpt: `503; Retry-After: ${retryAfter}` });
        if (validRetryAfter(retryAfter)) passes.push(evidence);
        else results.push(fail('low', [evidence], retryAfter === undefined ? 'missing-retry-after' : 'invalid-retry-after', { url: page.fetch.finalUrl }));
        continue;
      }
      if (page.fetch.status !== undefined && page.fetch.status >= 200 && page.fetch.status < 300) {
        const candidate = maintenanceCandidate(page, cite);
        if (candidate) results.push(candidate);
      }
    }
    return results.length > 0 ? results : pass(passes);
  },
};
