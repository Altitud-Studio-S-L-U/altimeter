import { notAuditableReason } from './analyze/auditability.ts';
import { rules as catalogRules } from './catalog/index.ts';
import { collect, type CollectOptions, type CollectResult } from './collect/index.ts';
import { servedUrl } from './collect/page.ts';
import { EvidenceStore } from './core/evidence.ts';
import type { PageFacts } from './core/facts.ts';
import type { Language } from './i18n/messages.ts';
import { runRules, type RuleImplementation } from './rules/engine.ts';
import { implementations as registered } from './rules/registry.ts';
import { buildReport, type Report } from './report/model.ts';
import { HttpClient } from './fetch/http.ts';
import type { NetworkPolicy } from './fetch/ip-guard.ts';
import { loadLogin } from './owner/credential-store.ts';
import { refreshAccessToken, tokenFromEnvironment, tokenFromServiceAccount, type AccessToken } from './owner/google-auth.ts';
import { fetchGscData, type searchConsoleApi } from './owner/gsc.ts';
import { withBing, type BingRequest } from './owner/bing.ts';
import { collectBotActivity, type CollectBotActivityOptions } from './owner/bots/collect.ts';
import { botSiteInput } from './owner/bots/site.ts';

export interface AuditOptions extends CollectOptions {
  readonly language?: Language;
  /** Rule implementations to run; defaults to every registered implementation. */
  readonly implementations?: ReadonlyMap<string, RuleImplementation>;
  /**
   * Read the owner's Search Console data; `property` overrides the automatic choice, `redactQueries` writes
   * numbered labels instead of the queries, `propertyOption` names the caller's option for `property` in errors, and
   * `endpoints` and `policy` point the calls at a local server in tests.
   */
  readonly gsc?: {
    readonly property?: string; readonly redactQueries?: boolean; readonly propertyOption?: string;
    readonly endpoints?: typeof searchConsoleApi; readonly policy?: NetworkPolicy;
  };
  /** Read the owner's Bing Webmaster Tools data, with the key in BING_WEBMASTER_API_KEY unless one is given. */
  readonly bing?: BingRequest;
  /**
   * Read the crawler requests the site really received, from access logs or Cloudflare analytics, and compare them
   * with the robots.txt and sitemaps the audit collected.
   */
  readonly bots?: Omit<CollectBotActivityOptions, 'site' | 'log'>;
  /** Options recorded in the report, already free of secrets. */
  readonly recordedOptions?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditResult {
  readonly report: Report;
  readonly collected: CollectResult;
}

function markAuditability(collected: CollectResult): CollectResult {
  const pages = new Map<string, PageFacts>();
  for (const [key, page] of collected.site.pages) {
    const reason = notAuditableReason(page.fetch, page.raw?.html);
    pages.set(key, reason ? { ...page, notAuditable: reason } : page);
  }
  return { ...collected, site: { ...collected.site, pages } };
}

/** The first Search Console credential available: a short-lived token, a service account key, then a stored login. */
export async function searchConsoleToken(client: HttpClient): Promise<AccessToken | undefined> {
  const fromEnvironment = tokenFromEnvironment();
  if (fromEnvironment) return fromEnvironment;
  if (process.env.ALTIMETER_GSC_SA_KEY) return tokenFromServiceAccount(client, process.env.ALTIMETER_GSC_SA_KEY);
  const login = await loadLogin();
  if (!login) return undefined;
  return refreshAccessToken(client, { clientId: login.clientId, clientSecret: login.clientSecret, authUri: '', tokenUri: 'https://oauth2.googleapis.com/token' }, login.refreshToken);
}

async function withSearchConsole(collected: CollectResult, options: AuditOptions): Promise<CollectResult> {
  if (!options.gsc) return collected;
  const client = new HttpClient(options.gsc.policy ? { policy: options.gsc.policy } : {});
  try {
    const token = await searchConsoleToken(client);
    if (!token) return { ...collected, warnings: [...collected.warnings, 'Search Console was requested but no credential was found. Run "altimeter gsc login --client <client_secret.json> --remember <dpapi|file>" or set ALTIMETER_GSC_ACCESS_TOKEN.'] };
    const inspectUrls = [...collected.site.pages.values()].filter(page => page.fetch.status === 200).map(page => page.fetch.finalUrl).slice(0, 10);
    const gsc = await fetchGscData(client, token, {
      url: servedUrl(collected.site.pages.values().next().value, options.url), inspectUrls,
      ...(options.gsc.property ? { siteUrl: options.gsc.property } : {}),
      ...(options.gsc.propertyOption ? { propertyOption: options.gsc.propertyOption } : {}),
      ...(options.gsc.endpoints ? { endpoints: options.gsc.endpoints } : {}),
    });
    return { ...collected, site: { ...collected.site, owner: { ...collected.site.owner, gsc, ...(options.gsc.redactQueries ? { redactQueries: true } : {}) } } };
  } catch (error) {
    return { ...collected, warnings: [...collected.warnings, `Search Console data was not used: ${error instanceof Error ? error.message : 'unknown error'}`] };
  } finally {
    await client.close();
  }
}

async function withBots(collected: CollectResult, options: AuditOptions): Promise<CollectResult> {
  if (!options.bots) return collected;
  try {
    const bots = await collectBotActivity({ ...options.bots, site: botSiteInput(collected.site), ...(options.log ? { log: options.log } : {}) });
    return {
      ...collected,
      warnings: [...collected.warnings, ...bots.warnings.map(warning => `Crawler activity: ${warning}`)],
      site: { ...collected.site, owner: { ...collected.site.owner, bots } },
    };
  } catch (error) {
    return { ...collected, warnings: [...collected.warnings, `Crawler activity was not read: ${error instanceof Error ? error.message : 'unknown error'}`] };
  }
}

/**
 * Runs a deterministic audit of one URL: collects the facts, adds the owner's data when authorised, evaluates every
 * implemented rule and builds the report. This programmatic API is experimental until 1.0.
 */
export async function audit(options: AuditOptions): Promise<AuditResult> {
  const startedAt = new Date();
  const collected = await withBots(await withBing(await withSearchConsole(markAuditability(await collect(options)), options), options), options);
  const evidence = new EvidenceStore();
  const implementations = options.implementations ?? registered;
  const findings = runRules({ rules: catalogRules, implementations, site: collected.site, evidence });
  const report = buildReport({
    collected,
    findings,
    evidence,
    implemented: [...implementations.keys()].filter(id => catalogRules.some(rule => rule.id === id && rule.status === 'v1')).length,
    language: options.language ?? 'en',
    startedAt,
    targetUrl: options.url,
    options: options.recordedOptions ?? {},
  });
  return { report, collected };
}

/** Exit status for the command line: 3 when the audited page could not be audited. */
export function auditExitCode(result: AuditResult, failOn: 'critical' | 'high' | 'medium' | 'low' | 'none'): 0 | 1 | 3 {
  const target = result.collected.site.pages.values().next().value as PageFacts | undefined;
  if (!target || target.notAuditable) return 3;
  if (failOn === 'none') return 0;
  const order = ['critical', 'high', 'medium', 'low'];
  const limit = order.indexOf(failOn);
  const failing = result.report.findings.some(finding => finding.outcome === 'fail' && !finding.needsJudgment && finding.origin !== 'ai'
    && order.indexOf(finding.severity ?? 'info') !== -1 && order.indexOf(finding.severity ?? 'info') <= limit);
  return failing ? 1 : 0;
}
