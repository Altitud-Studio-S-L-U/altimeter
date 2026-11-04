#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { clearCache } from '../ai/cache.ts';
import { call as callClaude } from '../ai/claude.ts';
import { call as callCodex } from '../ai/codex.ts';
import { describeProviders } from '../ai/providers.ts';
import { runAnalysis } from '../ai/run.ts';
import { audit, auditExitCode } from '../audit.ts';
import { rule as catalogRule, rules as catalogRules } from '../catalog/index.ts';
import { categories, type Category } from '../core/types.ts';
import { format, ruleTexts, type Language } from '../i18n/messages.ts';
import { ui } from '../i18n/ui.ts';
import { findChrome } from '../render/chrome.ts';
import { compareReports } from '../report/compare.ts';
import { analysisSummary } from '../report/markdown.ts';
import { mergeAnalysis, type Report } from '../report/model.ts';
import { mythMatches } from '../rules/myth-filter.ts';
import { cleanLine } from '../report/sanitize.ts';
import { isInside, reportDirectory, writeReport } from '../report/write.ts';
import { locateFixes } from '../source/locate.ts';
import { verifyExitCode, verifyTasks, type CheckResult } from '../verify/index.ts';
import { HttpClient } from '../fetch/http.ts';
import { spkiHashes } from '../fetch/tls.ts';
import { deleteLogin, loadLogin, loginStatus, saveLogin } from '../owner/credential-store.ts';
import { readOAuthClient, startLoopbackLogin } from '../owner/google-auth.ts';
import { ipListCacheDirectory } from '../owner/bots/ip-ranges.ts';
import { probeCacheDirectory } from '../probe/cache.ts';
import { version } from '../version.ts';
import { aiProbeCommand } from './ai-probe.ts';
import { botsCommand, logFiles } from './bots.ts';

export const help = `Altimeter ${version}: evidence-based SEO audits.

Usage:
  altimeter audit <url> [options]                  Audit a page and its site context.
  altimeter render <report.json> --lang <en|es|ca>  Write a report again in another language.
  altimeter compare <before.json> <after.json>     Show fixed, new and remaining problems.
  altimeter verify <report.json> [--task <id>] [--static <dir> | --origin <url>] [--render]
                                                   Re-check tasks against a local build or another origin;
                                                   rendered checks run only with --render.
  altimeter rules [--category <name>] [--stale]    List the rule catalog.
  altimeter explain <rule-id>                      Show a rule and its sources.
  altimeter doctor [--probe]                       Check Node.js, Chrome and the Claude Code and Codex CLIs; --probe
                                                   sends each CLI one tiny request (a little of your plan's quota).
  altimeter cache clear                            Delete cached model answers, probe runs and crawler IP lists.
  altimeter gsc login --client <client_secret.json> [--remember <dpapi|file>]
  altimeter gsc logout | gsc status                Manage read-only Search Console access.
  altimeter bots [--cloudflare-zone <domain>] [--logs <file>]...
                                                   Show which crawlers really fetch the site, each verified by its
                                                   operator's IP list or reverse DNS.
  altimeter ai-probe <domain> [--keyword <query>]... [--yes]
                                                   Ask Claude Code and Codex whether they cite the site; without
                                                   --yes it only prints the plan.
  altimeter --version                              Print the version.

Run "altimeter <command> --help" for the options of bots and ai-probe.

Audit options:
  --lang <en|es|ca>          Report language (default en).
  --crawl                    Crawl the site politely from the page, the home page and the sitemaps.
  --max-pages <n>            Pages to audit when crawling, 1 to 1000 (default 100).
  --gsc                      Add Search Console data (from ALTIMETER_GSC_ACCESS_TOKEN, ALTIMETER_GSC_SA_KEY or gsc login).
  --gsc-property <property>  Use this property, for example sc-domain:example.com.
  --bing                     Add Bing Webmaster Tools data (API key in BING_WEBMASTER_API_KEY).
  --bing-site <url>          Use this Bing site, for example https://example.com/.
  --redact-queries           Write numbered labels instead of Search Console and Bing queries, for a report to share.
  --bots-from <source>       Add the crawler requests the site really received: cloudflare (read-only token in
                             ALTIMETER_CLOUDFLARE_API_TOKEN) or an access log file or folder; repeat it for several.
  --bots-days <n>            Days of crawler activity, ending now, 1 to 400 (default 30).
  --no-bots-dns              Skip reverse DNS checks; crawlers that need them stay unverified.
  --source <dir>             The site's repository: tasks name the files that most likely hold each fix (read only).
  --out <dir>                Parent folder for reports (default ./altimeter-report).
  --no-render                Skip Chrome rendering and Lighthouse.
  --no-lighthouse            Skip Lighthouse.
  --lab-runs <1-7>           Lighthouse runs; the median run is kept (default 3).
  --fail-on <level>          Exit 1 when a check fails at critical, high, medium or low (default none).
  --allow-private-network    Allow private and loopback addresses, for local or staging sites.
  --ca <file>                Also trust the PEM certificates in <file>, such as a staging site's private CA. Chrome
                             accepts them only when the server sends one in its certificate chain.
  --quiet                    Print only the report folder.

Model analysis options (Claude Code or Codex, run with your own login; the pages analysed are sent to it):
  --provider <name>          auto (Claude Code, then Codex), claude, codex or none (default auto, or ALTIMETER_PROVIDER).
  --verifier <who>           Who checks each model finding: same, other or none (default same).
  --model <id>               Model for the analyst; the CLI's default when omitted.
  --ai-pages <1-10>          Pages the analyst reads: the audited page, the home page, then the most linked (default 3).
  --ai-max-calls <1-64>      Provider calls allowed for analysis and verification together (default 16).
  --keyword <query>          A query the page should rank for; repeat it for several. Intent is judged only against one.
  --dry-run <dir>            Write the prompts and the call plan to <dir> and call no provider.
  --use-api-keys             Pass API key variables to the CLIs (off: a key exported for another tool is never spent).
  --no-ai-cache              Ask the provider again instead of reusing cached answers.

Field data from the Chrome UX Report is queried when ALTIMETER_GOOGLE_API_KEY holds a Google Cloud API key
with the Chrome UX Report API enabled. The key is sent in a header to Google only. Search Console, Bing and
crawler activity data never reach the model. For log formats, proxies and other crawler options, run
"altimeter bots --help".

Exit status: 0 done, 1 a check failed at --fail-on or above, 2 error, 3 the page could not be audited.
`;

const languages: readonly Language[] = ['en', 'es', 'ca'];
const failLevels = ['critical', 'high', 'medium', 'low', 'none'] as const;

class UsageError extends Error {}

function language(value: string | undefined): Language {
  const chosen = (value ?? 'en') as Language;
  if (!languages.includes(chosen)) throw new UsageError('--lang must be en, es or ca.');
  return chosen;
}

async function readReport(path: string): Promise<Report> {
  const report = JSON.parse(await readFile(path, 'utf8')) as Report;
  if (report?.schemaVersion !== 1 || report.tool?.name !== 'altimeter') throw new UsageError(`${path} is not an Altimeter report.`);
  return report;
}

const providers = ['auto', 'claude', 'codex', 'none'] as const;
const verifiers = ['same', 'other', 'none'] as const;

function wholeNumber(value: string | undefined, fallback: number, low: number, high: number, flag: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < low || parsed > high) throw new UsageError(`${flag} must be a whole number from ${low} to ${high}.`);
  return parsed;
}

interface AnalysisFlags {
  readonly provider?: string | undefined;
  readonly verifier?: string | undefined;
  readonly model?: string | undefined;
  readonly 'ai-pages'?: string | undefined;
  readonly 'ai-max-calls'?: string | undefined;
  readonly keyword?: string[] | undefined;
  readonly 'dry-run'?: string | undefined;
  readonly 'use-api-keys'?: boolean | undefined;
  readonly 'no-ai-cache'?: boolean | undefined;
}

/** The model analysis settings from the flags; the provider defaults to ALTIMETER_PROVIDER, then auto. */
function analysisOptions(values: AnalysisFlags) {
  const provider = (values.provider ?? process.env.ALTIMETER_PROVIDER ?? 'auto') as (typeof providers)[number];
  if (!providers.includes(provider)) throw new UsageError('--provider must be auto, claude, codex or none.');
  const verifier = (values.verifier ?? 'same') as (typeof verifiers)[number];
  if (!verifiers.includes(verifier)) throw new UsageError('--verifier must be same, other or none.');
  const keyword = (values.keyword ?? []).map(entry => entry.trim()).filter(Boolean);
  if (keyword.some(entry => entry.length > 120)) throw new UsageError('Each --keyword must be at most 120 characters.');
  return {
    provider,
    verifier,
    ...(values.model ? { model: values.model } : {}),
    aiPages: wholeNumber(values['ai-pages'], 3, 1, 10, '--ai-pages'),
    maxCalls: wholeNumber(values['ai-max-calls'], 16, 1, 64, '--ai-max-calls'),
    keyword,
    ...(values['dry-run'] ? { dryRunDir: resolve(values['dry-run']) } : {}),
    useApiKeys: values['use-api-keys'] === true,
    cache: values['no-ai-cache'] !== true,
  };
}

async function auditCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      lang: { type: 'string' }, out: { type: 'string' }, 'no-render': { type: 'boolean' }, 'no-lighthouse': { type: 'boolean' },
      'lab-runs': { type: 'string' }, 'fail-on': { type: 'string' }, 'allow-private-network': { type: 'boolean' }, quiet: { type: 'boolean' },
      crawl: { type: 'boolean' }, 'max-pages': { type: 'string' }, gsc: { type: 'boolean' }, 'gsc-property': { type: 'string' },
      'redact-queries': { type: 'boolean' }, source: { type: 'string' }, provider: { type: 'string' }, verifier: { type: 'string' }, model: { type: 'string' },
      'ai-pages': { type: 'string' }, 'ai-max-calls': { type: 'string' }, keyword: { type: 'string', multiple: true }, 'dry-run': { type: 'string' },
      'use-api-keys': { type: 'boolean' }, 'no-ai-cache': { type: 'boolean' }, bing: { type: 'boolean' }, 'bing-site': { type: 'string' },
      'bots-from': { type: 'string', multiple: true }, 'bots-days': { type: 'string' }, 'no-bots-dns': { type: 'boolean' }, ca: { type: 'string' },
    },
  });
  if (positionals.length !== 1) throw new UsageError('audit needs exactly one URL.');
  let url: URL;
  try {
    url = new URL(positionals[0]!);
  } catch {
    throw new UsageError('The URL must be absolute, for example https://example.com/.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('Only http and https URLs can be audited.');
  const failOn = (values['fail-on'] ?? 'none') as (typeof failLevels)[number];
  if (!failLevels.includes(failOn)) throw new UsageError('--fail-on must be critical, high, medium, low or none.');
  const labRuns = values['lab-runs'] === undefined ? 3 : Number(values['lab-runs']);
  if (!Number.isInteger(labRuns) || labRuns < 1 || labRuns > 7) throw new UsageError('--lab-runs must be a whole number from 1 to 7.');
  const maxPages = values['max-pages'] === undefined ? 100 : Number(values['max-pages']);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new UsageError('--max-pages must be a whole number from 1 to 1000.');
  const lang = language(values.lang);
  const quiet = values.quiet === true;
  const log = quiet ? undefined : (message: string) => process.stderr.write(`· ${cleanLine(message)}\n`);
  const useGsc = values.gsc === true || values['gsc-property'] !== undefined;
  const useBing = values.bing === true || values['bing-site'] !== undefined;
  if (values['bing-site'] !== undefined && !/^https?:\/\/[^/]/iu.test(values['bing-site'])) throw new UsageError('--bing-site must be the URL of a Bing Webmaster Tools site, for example https://example.com/.');
  const redactQueries = values['redact-queries'] === true;
  const botsFrom = (values['bots-from'] ?? []).map(entry => entry.trim()).filter(Boolean);
  if (botsFrom.length === 0 && (values['bots-days'] !== undefined || values['no-bots-dns'])) throw new UsageError('--bots-days and --no-bots-dns need --bots-from.');
  const botsFromCloudflare = botsFrom.some(entry => entry.toLowerCase() === 'cloudflare');
  // Paths are checked now: a missing log should stop the run before the crawl, not after it.
  const botLogs = await logFiles(botsFrom.filter(entry => entry.toLowerCase() !== 'cloudflare'));
  const botsDays = wholeNumber(values['bots-days'], 30, 1, 400, '--bots-days');
  const ca = values.ca === undefined ? undefined : await readFile(values.ca, 'utf8').catch(() => { throw new UsageError(`--ca: ${values.ca} cannot be read.`); });
  if (ca !== undefined && spkiHashes(ca).length === 0) throw new UsageError('--ca must be a PEM file with at least one certificate.');
  const ai = analysisOptions(values);
  const outRoot = resolve(values.out ?? 'altimeter-report');
  const source = values.source === undefined ? undefined : resolve(values.source);
  if (source !== undefined) {
    if (!(await stat(source).then(info => info.isDirectory(), () => false))) throw new UsageError('--source must be the folder of the site\'s repository.');
    // The repository is only read; a report folder inside it could end up committed with the site.
    if (isInside(source, outRoot)) throw new UsageError('--out must be outside the --source repository.');
  }
  const botActivity = botsFromCloudflare && botLogs.length > 0 ? 'cloudflare+logs' : botsFromCloudflare ? 'cloudflare' : botLogs.length > 0 ? 'logs' : 'none';
  const recordedOptions = {
    crawl: values.crawl === true, maxPages, searchConsole: useGsc, bing: useBing, botActivity, redactQueries, source: source !== undefined, render: values['no-render'] !== true,
    lighthouse: values['no-lighthouse'] !== true && values['no-render'] !== true, labRuns, failOn, allowPrivateNetwork: values['allow-private-network'] === true,
    extraCa: ca !== undefined, provider: ai.provider, verifier: ai.verifier, aiPages: ai.aiPages, aiMaxCalls: ai.maxCalls, dryRun: ai.dryRunDir !== undefined,
  };
  const result = await audit({
    url: url.href,
    language: lang,
    ...(values['allow-private-network'] ? { policy: { allowPrivate: true } } : {}),
    ...(ca === undefined ? {} : { ca }),
    render: values['no-render'] !== true,
    lighthouse: recordedOptions.lighthouse,
    labRuns,
    crawl: values.crawl === true,
    maxPages,
    ...(useGsc ? { gsc: { ...(values['gsc-property'] ? { property: values['gsc-property'] } : {}), redactQueries } } : {}),
    ...(useBing ? { bing: { ...(values['bing-site'] ? { site: values['bing-site'] } : {}), redactQueries } } : {}),
    ...(botActivity === 'none' ? {} : {
      bots: {
        ...(botLogs.length > 0 ? { logs: botLogs } : {}),
        // Cloudflare finds the zone from the audited host, trying its parent domains.
        ...(botsFromCloudflare ? { cloudflare: { zone: url.hostname } } : {}),
        days: botsDays,
        dns: values['no-bots-dns'] !== true,
      },
    }),
    ...(process.env.ALTIMETER_GOOGLE_API_KEY ? { cruxKey: process.env.ALTIMETER_GOOGLE_API_KEY } : {}),
    ...(log ? { log } : {}),
    recordedOptions,
  });
  let report = result.report;
  if (ai.provider !== 'none' && !result.collected.site.pages.values().next().value?.notAuditable) {
    const analysis = await runAnalysis({ ...ai, report, collected: result.collected, mythMatches, ...(log ? { log } : {}) });
    report = mergeAnalysis(report, analysis);
  }
  if (source !== undefined) report = await locateFixes(report, source);
  const directory = reportDirectory(outRoot, report.target.origin, new Date(report.run.startedAt));
  await writeReport(directory, report, lang);
  const shown = relative(process.cwd(), directory) || '.';
  if (quiet) {
    process.stdout.write(`${shown}\n`);
  } else {
    const t = ui(lang);
    const { score, coverage, tasks } = report;
    process.stdout.write(`\nAltimeter ${version} · ${cleanLine(report.target.url)}\n`);
    process.stdout.write(`${t.score} ${score.overall ?? t.notScored} · ${t.indexability}: ${t.indexabilityStates[score.indexability]}\n`);
    process.stdout.write(`${cleanLine(format(t.coverageLine, { evaluated: coverage.evaluated, notEvaluated: coverage.notEvaluated, notApplicable: coverage.notApplicable }))}\n`);
    if (report.ai) process.stdout.write(`${cleanLine(analysisSummary(report.ai, lang))}\n`);
    if (tasks.length > 0) process.stdout.write(`\n${t.topActions}:\n`);
    for (const task of tasks.slice(0, 5)) {
      const rule = catalogRule(task.ruleId);
      process.stdout.write(`  ${task.priority}. [${t.severities[task.severity]}] ${cleanLine(rule ? ruleTexts(lang, rule).title : task.title, 120)} (${task.id})\n`);
    }
    for (const warning of [...report.run.warnings, ...(report.ai?.warnings ?? [])]) process.stderr.write(`! ${cleanLine(warning)}\n`);
    process.stdout.write(`\n${shown}${process.platform === 'win32' ? '\\' : '/'}report.md\n`);
  }
  return auditExitCode(result, failOn);
}

async function renderCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { lang: { type: 'string' }, out: { type: 'string' } } });
  if (positionals.length !== 1) throw new UsageError('render needs the path of a report.json.');
  const path = resolve(positionals[0]!);
  const report = await readReport(path);
  const lang = language(values.lang);
  const directory = values.out ? resolve(values.out) : dirname(path);
  await writeReport(directory, { ...report, run: { ...report.run, language: lang } }, lang);
  process.stdout.write(`${relative(process.cwd(), directory) || '.'}\n`);
  return 0;
}

async function compareCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
  if (positionals.length !== 2) throw new UsageError('compare needs two report.json paths: before and after.');
  const comparison = compareReports(await readReport(resolve(positionals[0]!)), await readReport(resolve(positionals[1]!)));
  const list = (label: string, findings: typeof comparison.fixed) => {
    process.stdout.write(`${label}: ${findings.length}\n`);
    for (const finding of findings) process.stdout.write(`  ${finding.ruleId} · ${cleanLine(finding.scope.kind === 'page' ? finding.scope.url : finding.scope.origin, 160)}\n`);
  };
  list('Fixed', comparison.fixed);
  list('New', comparison.introduced);
  list('Remaining', comparison.remaining);
  if (comparison.notComparable.length > 0) list('Not comparable (evaluated in only one report)', comparison.notComparable);
  return comparison.introduced.length > 0 ? 1 : 0;
}

async function verifyCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    task: { type: 'string', multiple: true }, static: { type: 'string' }, origin: { type: 'string' }, render: { type: 'boolean' },
  } });
  if (positionals.length !== 1) throw new UsageError('verify needs the path of a report.json.');
  if (values.static && values.origin) throw new UsageError('Use either --static or --origin, not both.');
  if (values.origin !== undefined) {
    const origin = new URL(values.origin);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw new UsageError('--origin must be an http or https origin.');
  }
  const report = await readReport(resolve(positionals[0]!));
  const results = await verifyTasks({
    report,
    ...(values.task ? { taskIds: values.task } : {}),
    ...(values.static ? { staticDir: resolve(values.static) } : {}),
    ...(values.origin ? { origin: new URL(values.origin).origin } : {}),
    render: values.render === true,
  });
  const where = (entry: CheckResult) => cleanLine(entry.check.scope.kind === 'page' ? entry.check.scope.url : entry.check.scope.origin, 160);
  for (const result of results) {
    const label = result.verdict === 'pass' ? 'PASS' : result.verdict === 'fail' ? 'FAIL' : 'NOT VERIFIABLE';
    process.stdout.write(`${result.taskId} ${label}${result.reason ? ` (${cleanLine(result.reason)})` : ''}\n`);
    for (const entry of [...result.acceptance.filter(check => check.outcome !== 'pass'), ...result.regressions]) {
      process.stdout.write(`  ${entry.check.ruleId} ${entry.outcome}${entry.reason ? ` (${cleanLine(entry.reason)})` : ''} · ${where(entry)}\n`);
    }
    // Checks this run could not evaluate leave the verdict alone; --render or a deployment can still confirm them.
    for (const entry of result.notRechecked) process.stdout.write(`  ${entry.check.ruleId} not re-checked (${cleanLine(entry.reason ?? entry.outcome)}) · ${where(entry)}\n`);
  }
  return verifyExitCode(results);
}

async function gscCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'status') {
    const status = await loginStatus();
    process.stdout.write(status.stored ? `A Search Console login is stored (${status.mode}, since ${status.createdAt}).\n` : 'No Search Console login is stored.\n');
    return 0;
  }
  if (action === 'logout') {
    const login = await loadLogin().catch(() => undefined);
    if (login) {
      const client = new HttpClient();
      await client.fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', followRedirects: false, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: login.refreshToken }).toString() });
      await client.close();
    }
    await deleteLogin();
    process.stdout.write('The stored Search Console login was revoked and deleted.\n');
    return 0;
  }
  if (action !== 'login') throw new UsageError('Use "altimeter gsc login", "gsc logout" or "gsc status".');
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { client: { type: 'string' }, remember: { type: 'string' } } });
  if (!values.client) throw new UsageError('gsc login needs --client with the Desktop OAuth client JSON from your Google Cloud project.');
  if (values.remember !== undefined && values.remember !== 'dpapi' && values.remember !== 'file') throw new UsageError('--remember must be dpapi (Windows) or file.');
  const oauth = await readOAuthClient(resolve(values.client));
  const client = new HttpClient();
  try {
    const login = await startLoopbackLogin(client, oauth);
    process.stderr.write(`Open this address in your browser and allow read-only access to Search Console:\n\n${login.authorizationUrl}\n\n`);
    const token = await login.token;
    if (values.remember) {
      if (!token.refreshToken) throw new UsageError('Google did not return a refresh token, so the login cannot be stored.');
      const path = await saveLogin({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, refreshToken: token.refreshToken, createdAt: new Date().toISOString() }, values.remember);
      process.stdout.write(`Signed in. The login is stored in ${path}. If your OAuth consent screen is in Testing mode, Google expires it after 7 days.\n`);
    } else {
      process.stdout.write('Signed in for this session only. Pass the token to an audit with ALTIMETER_GSC_ACCESS_TOKEN, or log in again with --remember.\n');
    }
    return 0;
  } finally {
    await client.close();
  }
}

function rulesCommand(args: string[]): number {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { category: { type: 'string' }, stale: { type: 'boolean' }, lang: { type: 'string' } } });
  const lang = language(values.lang);
  if (values.category !== undefined && !categories.includes(values.category as Category)) throw new UsageError(`--category must be one of ${categories.join(', ')}.`);
  const cutoff = Date.now() - 180 * 86_400_000;
  for (const entry of catalogRules) {
    if (values.category && entry.category !== values.category) continue;
    if (values.stale && !entry.sources.some(source => Date.parse(source.verified) < cutoff)) continue;
    process.stdout.write(`${entry.id}\t${entry.maxSeverity}\t${entry.status}\t${ruleTexts(lang, entry).title}\n`);
  }
  return 0;
}

function explainCommand(args: string[]): number {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { lang: { type: 'string' } } });
  if (positionals.length !== 1) throw new UsageError('explain needs a rule id, for example crawl-meta-robots-noindex.');
  const entry = catalogRule(positionals[0]!);
  if (!entry) throw new UsageError(`No rule ${positionals[0]}. List them with "altimeter rules".`);
  const texts = ruleTexts(language(values.lang), entry);
  process.stdout.write([
    `${entry.id} · ${entry.category} · max ${entry.maxSeverity} · ${entry.status}`,
    texts.title, '', texts.why, '', `Fix: ${texts.fix}`, '', `Thresholds: ${entry.thresholds}`, '',
    ...entry.sources.map(source => `Source: ${source.url} (verified ${source.verified})`), '',
  ].join('\n'));
  return 0;
}

const providerNames = { claude: 'Claude Code', codex: 'Codex' } as const;

/** The smallest request that exercises the flags, the system prompt and a schema with every keyword type in use. */
const probeSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    language: { type: 'string', minLength: 2, maxLength: 2, pattern: '^[a-z]{2}$' },
    words: { type: 'array', items: { type: 'string', maxLength: 20 }, minItems: 1, maxItems: 3 },
  },
  required: ['ok', 'language', 'words'],
  additionalProperties: false,
} as const;

async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { probe: { type: 'boolean' } } });
  const chrome = findChrome();
  const major = Number(process.versions.node.split('.')[0]);
  process.stdout.write(`Node.js ${process.versions.node}${major >= 24 ? '' : ' (Altimeter needs 24 or newer)'}\n`);
  process.stdout.write(`Chrome: ${chrome ? 'found' : 'not found; set CHROME_PATH to enable rendering and Lighthouse'}\n`);
  process.stdout.write(`Chrome UX Report key: ${process.env.ALTIMETER_GOOGLE_API_KEY ? 'set' : 'not set (lab data only)'}\n`);
  let failed = false;
  // Without --probe only --version runs: no prompt is sent, so checking costs nothing.
  for (const provider of await describeProviders()) {
    const name = providerNames[provider.name];
    if (!provider.found) {
      process.stdout.write(`${name}: not found${provider.problem ? ` (${cleanLine(provider.problem, 200)})` : ''}\n`);
      continue;
    }
    const state = provider.verified ? 'a verified version' : 'not in the verified table';
    process.stdout.write(`${name}: ${cleanLine(provider.version ?? 'unknown version')}, ${state} (${cleanLine(provider.path ?? '', 200)})\n`);
    for (const warning of provider.warnings) process.stdout.write(`  ! ${cleanLine(warning, 300)}\n`);
    if (!values.probe) continue;
    const call = provider.name === 'claude' ? callClaude : callCodex;
    try {
      const result = await call({ prompt: 'Connectivity check for Altimeter. Set ok to true, language to the two-letter code of your default answer language, and words to ["ready"].', schema: probeSchema, timeoutMs: 180_000 });
      const cost = result.costUsd === undefined ? '' : `, USD ${result.costUsd.toFixed(4)}`;
      process.stdout.write(`  probe: answered with ${cleanLine(result.model ?? 'the default model', 80)}${cost}\n`);
    } catch (error) {
      failed = true;
      process.stdout.write(`  probe failed: ${cleanLine(error instanceof Error ? error.message : 'unknown error', 300)}\n`);
    }
  }
  return major < 24 || failed ? 2 : 0;
}

async function cacheCommand(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== 'clear') throw new UsageError('Use "altimeter cache clear".');
  const answers = await clearCache();
  const probes = await clearCache({ directory: probeCacheDirectory() });
  const lists = await clearCache({ directory: ipListCacheDirectory() });
  process.stdout.write(`Removed ${answers} cached model answer(s), ${probes} cached probe run(s) and ${lists} crawler IP list(s).\n`);
  return 0;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
      process.stdout.write(help);
      return 0;
    }
    if (command === '--version' || command === '-v') {
      process.stdout.write(`${version}\n`);
      return 0;
    }
    switch (command) {
      case 'audit': return await auditCommand(rest);
      case 'render': return await renderCommand(rest);
      case 'compare': return await compareCommand(rest);
      case 'verify': return await verifyCommand(rest);
      case 'gsc': return await gscCommand(rest);
      case 'rules': return rulesCommand(rest);
      case 'explain': return explainCommand(rest);
      case 'doctor': return await doctorCommand(rest);
      case 'cache': return await cacheCommand(rest);
      case 'bots': return await botsCommand(rest);
      case 'ai-probe': return await aiProbeCommand(rest);
      default:
        throw new UsageError(`Unknown command: ${command}. Run "altimeter --help".`);
    }
  } catch (error) {
    const message = error instanceof UsageError || error instanceof TypeError ? error.message : error instanceof Error ? error.message : 'Unexpected error';
    process.stderr.write(`${cleanLine(message, 500)}\n`);
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) process.exitCode = await main();
