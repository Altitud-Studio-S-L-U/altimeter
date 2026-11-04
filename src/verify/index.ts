import { notAuditableReason } from '../analyze/auditability.ts';
import { rules as catalogRules } from '../catalog/index.ts';
import { collect } from '../collect/index.ts';
import { EvidenceStore } from '../core/evidence.ts';
import type { PageFacts, SiteFacts } from '../core/facts.ts';
import type { FetchResult } from '../fetch/http.ts';
import type { RuleMeta, Verification } from '../core/types.ts';
import { hostPort, publicOnly, type NetworkPolicy } from '../fetch/ip-guard.ts';
import { runRules, type Finding, type FindingScope, type RuleImplementation } from '../rules/engine.ts';
import { implementations as registered } from '../rules/registry.ts';
import type { Report } from '../report/model.ts';
import { defaultVerification, type Task, type TaskCheck } from '../report/tasks.ts';
import { serveStatic } from './static-server.ts';

export type TaskVerdict = 'pass' | 'fail' | 'not-verifiable';

export interface CheckResult {
  readonly check: TaskCheck;
  readonly outcome: Finding['outcome'] | 'missing';
  /** The finding's reason, such as a missing input, or the verification a check needs when this run left it out. */
  readonly reason?: string;
}

export interface TaskVerification {
  readonly taskId: string;
  readonly verdict: TaskVerdict;
  readonly reason?: string;
  readonly acceptance: readonly CheckResult[];
  /** Checks that passed in the audit and fail now. */
  readonly regressions: readonly CheckResult[];
  /** Checks that passed in the audit and that this run could not evaluate again; they leave the verdict unchanged. */
  readonly notRechecked: readonly CheckResult[];
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

/** Whether a run can confirm a check: a served build shows only what needs no deployment, and no run shows field or owner data. */
function confirms(verification: Verification, servesBuild: boolean): boolean {
  return verification === 'local' || (verification === 'deployed' && !servesBuild);
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
 * checks pass and no check that passed before on the same scope fails now. The checks this run cannot evaluate
 * again, such as rendered checks without `render` or what only a deployment shows, are listed as not re-checked.
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
    const served = new URL(origin);
    // Only the host and port under test may be private, so its pages cannot reach other local services.
    const policy: NetworkPolicy = isLocal
      ? { allowPrivate: false, privateOrigins: new Set([hostPort(served.hostname, Number(served.port) || (served.protocol === 'https:' ? 443 : 80))]) }
      : publicOnly;
    const byUrl = new Map<string, SiteFacts>();
    const factsFor = async (productionUrl: string): Promise<SiteFacts> => {
      const cached = byUrl.get(productionUrl);
      if (cached) return cached;
      const target = swapOrigin(productionUrl, production, origin);
      options.log?.(`Checking ${target}`);
      const collected = await collect({
        url: target,
        policy,
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
      if (!confirms(task.verifiableBy, local !== undefined)) {
        results.push({ taskId: task.id, verdict: 'not-verifiable', reason: `needs ${task.verifiableBy} verification`, acceptance: [], regressions: [], notRechecked: [] });
        continue;
      }
      const findings = new Map<string, Finding>();
      const leftOut = new Map<TaskCheck, string>();
      for (const check of [...task.acceptance, ...task.mustRemainPassing]) {
        const rule = (options.rules ?? catalogRules).find(entry => entry.id === check.ruleId);
        if (!rule) continue;
        const needs = defaultVerification(rule);
        if (!confirms(needs, local !== undefined)) {
          leftOut.set(check, `needs ${needs} verification`);
          continue;
        }
        const site = await factsFor(check.scope.kind === 'page' ? check.scope.url : `${production}/`);
        for (const finding of runRules({ rules: [rule], implementations, site, evidence: new EvidenceStore() })) findings.set(`${finding.ruleId} ${scopeKey(finding.scope)}`, finding);
      }
      const resolve = (check: TaskCheck): CheckResult => {
        const reason = leftOut.get(check);
        if (reason) return { check, outcome: 'not_evaluated', reason };
        const finding = findings.get(`${check.ruleId} ${scopeKey(check.scope)}`);
        if (!finding) return { check, outcome: 'missing' };
        return { check, outcome: finding.outcome, ...(finding.reason === undefined ? {} : { reason: finding.reason }) };
      };
      const acceptance = task.acceptance.map(resolve);
      const kept = task.mustRemainPassing.map(resolve);
      const regressions = kept.filter(result => result.outcome === 'fail');
      const notRechecked = kept.filter(result => result.outcome === 'not_evaluated' || result.outcome === 'missing');
      const passed = acceptance.every(result => result.outcome === 'pass' || result.outcome === 'not_applicable') && regressions.length === 0;
      const unknown = acceptance.some(result => result.outcome === 'missing' || result.outcome === 'not_evaluated');
      results.push({
        taskId: task.id, verdict: unknown ? 'not-verifiable' : passed ? 'pass' : 'fail', ...(unknown ? { reason: 'a check could not be evaluated' } : {}),
        acceptance, regressions, notRechecked,
      });
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
