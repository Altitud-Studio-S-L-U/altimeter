import lighthouse from 'lighthouse';
import { computeMedianRun, filterToValidRuns } from 'lighthouse/core/lib/median-run.js';
import type { AuditBrowser } from './chrome.ts';

type LighthouseResult = NonNullable<Awaited<ReturnType<typeof lighthouse>>>['lhr'];

/** Categories Altimeter reads; the agentic-browsing category is informational and not run. */
export const lighthouseCategories = ['performance', 'accessibility', 'best-practices', 'seo'] as const;

/** Audits whose detail tables are kept, trimmed; everything else keeps only its score and value. */
const detailedAudits = new Set([
  'network-requests',
  'largest-contentful-paint-element',
  'lcp-breakdown-insight',
  'lcp-discovery-insight',
  'render-blocking-insight',
  'document-latency-insight',
  'cache-insight',
  'image-delivery-insight',
  'font-display-insight',
  'cls-culprits-insight',
  'third-parties-insight',
  'network-dependency-tree-insight',
  'legacy-javascript-insight',
  'duplicated-javascript-insight',
  'dom-size-insight',
  'forced-reflow-insight',
  'viewport-insight',
  'bf-cache',
  'unused-javascript',
  'unused-css-rules',
  'bootup-time',
  'mainthread-work-breakdown',
  'long-tasks',
  'total-byte-weight',
  'is-crawlable',
  'robots-txt',
  'crawlable-anchors',
  'link-text',
  'hreflang',
  'canonical',
  'image-alt',
  'target-size',
  'color-contrast',
  'errors-in-console',
  'unsized-images',
  'non-composited-animations',
  'unminified-css',
  'unminified-javascript',
]);

const omittedAudits = new Set(['screenshot-thumbnails', 'final-screenshot', 'full-page-screenshot', 'main-thread-tasks', 'script-treemap-data']);

export interface LighthouseAudit {
  readonly title: string;
  readonly score: number | null;
  readonly scoreDisplayMode: string;
  readonly numericValue?: number;
  readonly numericUnit?: string;
  readonly displayValue?: string;
  readonly details?: unknown;
}

export interface LighthouseSummary {
  readonly lighthouseVersion: string;
  readonly fetchTime: string;
  readonly finalUrl: string;
  readonly runs: number;
  readonly validRuns: number;
  readonly runWarnings: readonly string[];
  readonly categories: Readonly<Record<string, number | null>>;
  readonly audits: Readonly<Record<string, LighthouseAudit>>;
  readonly settings: {
    readonly formFactor: string;
    readonly throttlingMethod: string;
    readonly throttling: unknown;
    readonly screenEmulation: unknown;
  };
  readonly benchmarkIndex: number | undefined;
  /** Spread of lab LCP across valid runs, in milliseconds, to judge stability. */
  readonly lcpRangeMs: readonly [number, number] | undefined;
}

export type LighthouseOutcome = { readonly ok: true; readonly summary: LighthouseSummary } | { readonly ok: false; readonly error: string };

function trimDetails(details: unknown, maxItems: number): unknown {
  if (!details || typeof details !== 'object') return details;
  const record = { ...(details as Record<string, unknown>) };
  if (Array.isArray(record.items)) record.items = record.items.slice(0, maxItems).map(item => trimDetails(item, maxItems));
  for (const key of ['debugData', 'screenshot', 'data']) delete record[key];
  return record;
}

function summarize(result: LighthouseResult, runs: LighthouseResult[], validRuns: LighthouseResult[], requested: number): LighthouseSummary {
  const audits: Record<string, LighthouseAudit> = {};
  for (const [id, audit] of Object.entries(result.audits)) {
    if (omittedAudits.has(id)) continue;
    audits[id] = {
      title: audit.title,
      score: audit.score,
      scoreDisplayMode: audit.scoreDisplayMode,
      ...(audit.numericValue === undefined ? {} : { numericValue: audit.numericValue }),
      ...(audit.numericUnit === undefined ? {} : { numericUnit: audit.numericUnit }),
      ...(audit.displayValue === undefined ? {} : { displayValue: audit.displayValue }),
      ...(detailedAudits.has(id) && audit.details ? { details: trimDetails(audit.details, id === 'network-requests' ? 300 : 25) } : {}),
    };
  }
  const lcps = validRuns.map(run => run.audits['largest-contentful-paint']?.numericValue).filter((value): value is number => typeof value === 'number');
  return {
    lighthouseVersion: result.lighthouseVersion,
    fetchTime: result.fetchTime,
    finalUrl: result.finalDisplayedUrl,
    runs: requested,
    validRuns: validRuns.length,
    runWarnings: [...new Set(runs.flatMap(run => run.runWarnings ?? []))],
    categories: Object.fromEntries(Object.entries(result.categories).map(([id, category]) => [id, category.score])),
    audits,
    settings: {
      formFactor: result.configSettings.formFactor,
      throttlingMethod: result.configSettings.throttlingMethod,
      throttling: result.configSettings.throttling,
      screenEmulation: result.configSettings.screenEmulation,
    },
    benchmarkIndex: result.environment?.benchmarkIndex,
    lcpRangeMs: lcps.length > 0 ? [Math.min(...lcps), Math.max(...lcps)] : undefined,
  };
}

/**
 * Runs Lighthouse `runs` times, each in a fresh browser context, and keeps the median run as Lighthouse
 * defines it. Runs never execute in parallel: concurrent runs on one machine skew lab metrics.
 */
export async function runLighthouse(audit: AuditBrowser, url: string, options: { runs?: number; formFactor?: 'mobile' | 'desktop' } = {}): Promise<LighthouseOutcome> {
  const requested = Math.max(1, Math.min(options.runs ?? 3, 7));
  const formFactor = options.formFactor ?? 'mobile';
  const runs: LighthouseResult[] = [];
  let lastError = '';
  for (let index = 0; index < requested; index += 1) {
    const context = await audit.browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const outcome = await lighthouse(url, {
        logLevel: 'error',
        output: 'json',
        onlyCategories: [...lighthouseCategories],
        formFactor,
        screenEmulation: formFactor === 'mobile'
          ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
          : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
        throttlingMethod: 'simulate',
        disableFullPageScreenshot: true,
        maxWaitForLoad: 45_000,
      }, undefined, page as never);
      if (outcome?.lhr) runs.push(outcome.lhr);
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Lighthouse failed';
    } finally {
      await context.close().catch(() => {});
    }
  }
  const valid = filterToValidRuns(runs);
  if (runs.length === 0) return { ok: false, error: lastError || 'Lighthouse returned no result' };
  const median = valid.length > 0 ? computeMedianRun(valid) : runs[0]!;
  return { ok: true, summary: summarize(median, runs, valid, requested) };
}
