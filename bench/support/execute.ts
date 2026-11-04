import { performance } from 'node:perf_hooks';
import { audit, type AuditResult } from '../../src/audit.ts';
import { rules as catalogRules } from '../../src/catalog/index.ts';
import type { ReportFinding } from '../../src/report/model.ts';
import { implementations as registered } from '../../src/rules/registry.ts';
import type { TestCa } from '../../test/support/certificates.ts';
import {
  loopbackLookup, loopbackPolicy, route, type FailExpectation, type Origins, type QuietExpectation, type Scenario, type ScenarioContext,
} from './scenario.ts';
import { startVirtualHosts, type KeyPair } from './server.ts';

const day = 86_400_000;

export interface ScenarioRun {
  readonly scenario: Scenario;
  readonly result: AuditResult;
  readonly port: number;
  readonly durationMs: number;
  /** Hosts the server was asked for that the scenario does not serve. */
  readonly strayHosts: readonly string[];
}

/** Certificates for the scenario's hosts from the bench CA, including the expired ones it asks for. */
function certificatesFor(scenario: Scenario, ca: TestCa): { tls: KeyPair; hostTls: Record<string, KeyPair> } {
  const leaf = ca.issue(scenario.hosts);
  const hostTls: Record<string, KeyPair> = {};
  for (const host of scenario.expiredCertificates ?? []) {
    const expired = ca.issue([host], { notBefore: new Date(Date.now() - 30 * day), notAfter: new Date(Date.now() - 2 * day) });
    hostTls[host] = { key: expired.key, cert: expired.chain };
  }
  return { tls: { key: leaf.key, cert: leaf.chain }, hostTls };
}

function contextFor(port: number): ScenarioContext {
  return {
    port,
    origin: base => {
      const url = new URL(base);
      url.port = String(port);
      return url.origin;
    },
  };
}

/** Serves the scenario on a fresh loopback port and audits it with the real pipeline, without any model provider. */
export async function executeScenario(scenario: Scenario, options: { readonly ca: TestCa; readonly chromePath: string }): Promise<ScenarioRun> {
  const started = performance.now();
  let origins: Origins = {};
  const server = await startVirtualHosts({ ...certificatesFor(scenario, options.ca), handle: request => route(origins, request) });
  try {
    const site = scenario.build(contextFor(server.port));
    origins = site.origins;
    const result = await audit({
      url: site.url,
      policy: loopbackPolicy(scenario.hosts),
      lookup: loopbackLookup(scenario.hosts),
      ca: options.ca.cert,
      chromePath: options.chromePath,
      render: true,
      lighthouse: scenario.options?.lighthouse === true,
      labRuns: 1,
      crawl: scenario.options?.crawl === true,
      ...(scenario.options?.maxPages ? { maxPages: scenario.options.maxPages } : {}),
      crawlDelayMs: 0,
      ...(site.cruxEndpoint ? { cruxKey: 'bench-placeholder-key', cruxEndpoint: site.cruxEndpoint } : {}),
    });
    const known = new Set(scenario.hosts.map(host => host.toLowerCase()));
    const strayHosts = [...new Set(server.requests.map(request => request.host).filter(host => !known.has(host)))];
    return { scenario, result, port: server.port, durationMs: performance.now() - started, strayHosts };
  } finally {
    await server.close();
  }
}

/** `unevaluated`: a rule that must not fail did not reach the outcome required, so the check proves nothing. */
export type Verdict = 'tp' | 'fn' | 'fp' | 'tn' | 'unevaluated';

export interface Check {
  readonly rule: string;
  readonly expected: 'fail' | 'quiet';
  readonly verdict: Verdict;
  readonly page?: string;
  readonly known?: string;
  /** What the rule reported, for the violation list. */
  readonly detail: string;
}

function pageUrl(run: ScenarioRun, page: string | undefined): string | undefined {
  if (page === undefined) return undefined;
  return new URL(page, run.result.report.target.url).href;
}

/** Findings of one rule, restricted to one page when the expectation names it (by requested or final URL). */
function findingsOf(run: ScenarioRun, rule: string, page: string | undefined): ReportFinding[] {
  const target = pageUrl(run, page);
  const finalUrl = (url: string) => run.result.collected.site.pages.get(url)?.fetch.finalUrl;
  return run.result.report.findings.filter(finding => finding.ruleId === rule
    && (target === undefined || (finding.scope.kind === 'page' && (finding.scope.url === target || finalUrl(finding.scope.url) === target))));
}

const describe = (finding: ReportFinding) => finding.outcome === 'fail'
  ? `fail ${finding.severity}${finding.reason ? ` (${finding.reason})` : ''}${finding.scope.kind === 'page' ? ` on ${finding.scope.url}` : ''}: ${finding.message ?? ''}`
  : `${finding.outcome}${finding.reason ? ` (${finding.reason})` : ''}`;

/** What the rule reported, or why it reported nothing that the expectation could match. */
function reported(run: ScenarioRun, rule: string, findings: readonly ReportFinding[]): string {
  if (findings.length > 0) return [...new Set(findings.map(describe))].join('; ');
  const meta = catalogRules.find(entry => entry.id === rule);
  if (!meta) return 'no finding: the catalog has no such rule';
  if (meta.status === 'planned' || !registered.has(rule)) return 'no finding: the rule is not implemented';
  const elsewhere = run.result.report.findings.filter(finding => finding.ruleId === rule);
  if (elsewhere.length > 0) {
    return `no finding on that page; the rule reported on ${[...new Set(elsewhere.map(finding => (finding.scope.kind === 'site' ? 'the site' : finding.scope.url)))].join(', ')}`;
  }
  return 'no finding: the rule did not run';
}

function failCheck(run: ScenarioRun, expectation: FailExpectation): Check {
  const findings = findingsOf(run, expectation.rule, expectation.page);
  const matched = findings.some(finding => finding.outcome === 'fail' && (expectation.severity === undefined || finding.severity === expectation.severity)
    && (expectation.reason === undefined || finding.reason === expectation.reason));
  const wanted = [expectation.severity, expectation.reason].filter(Boolean).join(', ');
  return {
    rule: expectation.rule, expected: 'fail', verdict: matched ? 'tp' : 'fn',
    ...(expectation.page ? { page: expectation.page } : {}), ...(expectation.known ? { known: expectation.known } : {}),
    detail: matched ? '' : `expected a failure${wanted ? ` (${wanted})` : ''}, got ${reported(run, expectation.rule, findings)}`,
  };
}

function quietCheck(run: ScenarioRun, expectation: QuietExpectation): Check {
  const findings = findingsOf(run, expectation.rule, expectation.page);
  const failures = findings.filter(finding => finding.outcome === 'fail');
  const allowed = expectation.outcome ? [expectation.outcome] : ['pass', 'not_applicable'];
  const held = failures.length === 0 && findings.some(finding => allowed.includes(finding.outcome));
  return {
    rule: expectation.rule, expected: 'quiet', verdict: failures.length > 0 ? 'fp' : held ? 'tn' : 'unevaluated',
    ...(expectation.page ? { page: expectation.page } : {}), ...(expectation.known ? { known: expectation.known } : {}),
    detail: held ? '' : failures.length > 0 ? `expected no failure, got ${reported(run, expectation.rule, failures)}`
      : `expected ${allowed.join(' or ')}, got ${reported(run, expectation.rule, findings)}`,
  };
}

/** Grades every expectation of the scenario against the audit's findings. */
export function checkScenario(run: ScenarioRun): Check[] {
  return [
    ...run.scenario.mustFail.map(expectation => failCheck(run, expectation)),
    ...run.scenario.mustNotFail.map(expectation => quietCheck(run, typeof expectation === 'string' ? { rule: expectation } : expectation)),
  ];
}

/** Rules that threw while evaluating: always a bug, whatever the expectations say. */
export function ruleErrors(run: ScenarioRun): string[] {
  return run.result.report.findings.filter(finding => finding.reason?.startsWith('rule-error:')).map(finding => `${finding.ruleId}: ${finding.reason}`);
}

/** The deterministic findings as comparable lines, with the run's port taken out. */
export function fingerprint(run: ScenarioRun): string[] {
  const port = `:${run.port}`;
  return run.result.report.findings
    .filter(finding => finding.origin !== 'ai')
    .map(finding => [finding.ruleId, finding.scope.kind === 'page' ? finding.scope.url : 'site', finding.outcome, finding.severity ?? '', finding.reason ?? ''].join(' ').replaceAll(port, ':<port>'))
    .sort();
}
