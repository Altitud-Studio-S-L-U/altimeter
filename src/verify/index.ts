import { notAuditableReason } from '../analyze/auditability.ts';
import { rules as catalogRules } from '../catalog/index.ts';
import { collect } from '../collect/index.ts';
import { EvidenceStore } from '../core/evidence.ts';
import type { PageFacts, SiteFacts } from '../core/facts.ts';
import type { FetchResult } from '../fetch/http.ts';
import type { RuleMeta } from '../core/types.ts';
import { publicOnly } from '../fetch/ip-guard.ts';
import { runRules, type Finding, type FindingScope, type RuleImplementation } from '../rules/engine.ts';
import { implementations as registered } from '../rules/registry.ts';
import type { Report } from '../report/model.ts';
import type { Task, TaskCheck } from '../report/tasks.ts';
import { serveStatic } from './static-server.ts';

export type TaskVerdict = 'pass' | 'fail' | 'not-verifiable';

export interface CheckResult {
  readonly check: TaskCheck;
  readonly outcome: Finding['outcome'] | 'missing';
}

export interface TaskVerification {
  readonly taskId: string;
  readonly verdict: TaskVerdict;
  readonly reason?: string;
  readonly acceptance: readonly CheckResult[];
  readonly regressions: readonly CheckResult[];
}

function swapOrigin(url: string, from: string, to: string): string {
  return url.startsWith(from) ? `${to}${url.slice(from.length)}` : url;
}

function rebaseFetch(fetch: FetchResult, from: string, to: string): FetchResult {
  return {
    ...fetch,
    requestedUrl: swapOrigin(fetch.requestedUrl, from, to),
    finalUrl: swapOrigin(fetch.finalUrl, from, to),
    hops: fetch.hops.map(hop => ({ ...hop, url: swapOrigin(hop.url, from, to), ...(hop.location ? { location: swapOrigin(hop.location, from, to) } : {}) })),
  };
}

function rebasePage(page: PageFacts, from: string, to: string): PageFacts {
  return { ...page, url: swapOrigin(page.url, from, to), fetch: rebaseFetch(page.fetch, from, to) };
}

/**
 * Presents facts collected from a local build as if they came from production, so rules that compare URLs in the
 * HTML (canonical, hreflang, links) with the page's own URL see the production origin the HTML refers to.
 */
export function rebaseSite(site: SiteFacts, from: string, to: string): SiteFacts {
  const pages = new Map<string, PageFacts>();
  for (const page of site.pages.values()) {
    const rebased = rebasePage(page, from, to);
    pages.set(rebased.url, rebased);
  }
  return {
    ...site,
    origin: to,
    pages,
    siblings: site.siblings.map(page => rebasePage(page, from, to)),
    ...(site.alternates ? { alternates: site.alternates.map(page => rebasePage(page, from, to)) } : {}),
    variants: site.variants.map(probe => ({ ...probe, url: swapOrigin(probe.url, from, to), fetch: rebaseFetch(probe.fetch, from, to) })),
    sitemaps: site.sitemaps.map(entry => ({ ...entry, url: swapOrigin(entry.url, from, to), fetch: rebaseFetch(entry.fetch, from, to) })),
    resources: site.resources.map(entry => ({ ...entry, url: swapOrigin(entry.url, from, to), fetch: rebaseFetch(entry.fetch, from, to) })),
    localeProbes: site.localeProbes.map(entry => ({ ...entry, url: swapOrigin(entry.url, from, to), fetch: rebaseFetch(entry.fetch, from, to) })),
    agentProbes: site.agentProbes.map(entry => ({ ...entry, url: swapOrigin(entry.url, from, to), fetch: rebaseFetch(entry.fetch, from, to) })),
    ...(site.robots ? { robots: { ...site.robots, url: swapOrigin(site.robots.url, from, to), fetch: rebaseFetch(site.robots.fetch, from, to) } } : {}),
    ...(site.notFound ? { notFound: { ...site.notFound, url: swapOrigin(site.notFound.url, from, to), fetch: rebaseFetch(site.notFound.fetch, from, to) } } : {}),
    ...(site.homeUrl ? { homeUrl: swapOrigin(site.homeUrl, from, to) } : {}),
  };
}

function scopeKey(scope: FindingScope): string {
  return scope.kind === 'page' ? scope.url : scope.origin;
}

export interface VerifyOptions {
  readonly report: Report;
  readonly taskIds?: readonly string[];
  /** A local build folder to serve, or an origin to fetch instead of production. */
  readonly staticDir?: string;
  readonly origin?: string;
  readonly render?: boolean;
  readonly implementations?: ReadonlyMap<string, RuleImplementation>;
  /** Rule metadata to evaluate with; defaults to the catalog. */
  readonly rules?: readonly RuleMeta[];
  readonly log?: (message: string) => void;
}

/**
 * Re-checks tasks from a report against a local build or another origin. A task passes when all its acceptance
 * checks pass and every check that passed before on the same scope still passes.
 */
export async function verifyTasks(options: VerifyOptions): Promise<TaskVerification[]> {
  const tasks = options.report.tasks.filter(task => !options.taskIds || options.taskIds.includes(task.id));
  const missingIds = (options.taskIds ?? []).filter(id => !options.report.tasks.some(task => task.id === id));
  if (missingIds.length > 0) throw new Error(`Unknown task ${missingIds.join(', ')} in this report.`);
  const production = options.report.target.origin;
  const local = options.staticDir ? await serveStatic(options.staticDir) : undefined;
  const origin = local?.origin ?? options.origin ?? production;
  const isLocal = origin !== production;
  const implementations = options.implementations ?? registered;
  const results: TaskVerification[] = [];
  try {
    const byUrl = new Map<string, SiteFacts>();
    const factsFor = async (productionUrl: string): Promise<SiteFacts> => {
      const cached = byUrl.get(productionUrl);
      if (cached) return cached;
      const target = swapOrigin(productionUrl, production, origin);
      const host = new URL(origin).hostname;
      options.log?.(`Checking ${target}`);
      const collected = await collect({
        url: target,
        policy: isLocal ? { allowPrivate: false, privateHosts: new Set([host]) } : publicOnly,
        render: options.render ?? false,
        lighthouse: false,
      });
      const marked = new Map<string, PageFacts>();
      for (const [key, page] of collected.site.pages) {
        const reason = notAuditableReason(page.fetch, page.raw?.html);
        marked.set(key, reason ? { ...page, notAuditable: reason } : page);
      }
      const site = { ...collected.site, pages: marked };
      const facts = isLocal ? rebaseSite(site, origin, production) : site;
      byUrl.set(productionUrl, facts);
      return facts;
    };
    for (const task of tasks) {
      if (local && task.verifiableBy !== 'local') {
        results.push({ taskId: task.id, verdict: 'not-verifiable', reason: `needs ${task.verifiableBy} verification`, acceptance: [], regressions: [] });
        continue;
      }
      if (task.verifiableBy === 'field-28d' || task.verifiableBy === 'owner-data' || task.verifiableBy === 'manual') {
        results.push({ taskId: task.id, verdict: 'not-verifiable', reason: `needs ${task.verifiableBy} verification`, acceptance: [], regressions: [] });
        continue;
      }
      const checks = [...task.acceptance, ...task.mustRemainPassing];
      const outcomes = new Map<string, Finding['outcome']>();
      for (const check of checks) {
        const url = check.scope.kind === 'page' ? check.scope.url : `${production}/`;
        const site = await factsFor(url);
        const rule = (options.rules ?? catalogRules).find(entry => entry.id === check.ruleId);
        if (!rule) continue;
        const findings = runRules({ rules: [rule], implementations, site, evidence: new EvidenceStore() });
        for (const finding of findings) outcomes.set(`${finding.ruleId} ${scopeKey(finding.scope)}`, finding.outcome);
      }
      const resolve = (check: TaskCheck): CheckResult => ({ check, outcome: outcomes.get(`${check.ruleId} ${scopeKey(check.scope)}`) ?? 'missing' });
      const acceptance = task.acceptance.map(resolve);
      const regressions = task.mustRemainPassing.map(resolve).filter(result => result.outcome !== 'pass');
      const passed = acceptance.every(result => result.outcome === 'pass' || result.outcome === 'not_applicable') && regressions.length === 0;
      const unknown = acceptance.some(result => result.outcome === 'missing' || result.outcome === 'not_evaluated');
      results.push({ taskId: task.id, verdict: unknown ? 'not-verifiable' : passed ? 'pass' : 'fail', ...(unknown ? { reason: 'a check could not be evaluated' } : {}), acceptance, regressions });
    }
  } finally {
    await local?.close();
  }
  return results;
}

export function verifyExitCode(results: readonly TaskVerification[]): 0 | 1 | 3 {
  if (results.some(result => result.verdict === 'fail')) return 1;
  if (results.some(result => result.verdict === 'not-verifiable')) return 3;
  return 0;
}

export type { Task };
