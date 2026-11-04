import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Environment } from '../ai/providers.ts';
import { searchConsoleToken } from '../audit.ts';
import { HttpClient } from '../fetch/http.ts';
import { publicOnly, type NetworkPolicy } from '../fetch/ip-guard.ts';
import { languages, type Language } from '../i18n/messages.ts';
import { fetchGscData, type GscData } from '../owner/gsc.ts';
import { probeStrings } from '../probe/i18n.ts';
import { defaultRuns, maxRuns, planProbe, type PlanInput } from '../probe/plan.ts';
import { probeDirectory, renderPlan, renderSummary, writeProbeReport } from '../probe/report.ts';
import { runProbe, type ProbeOptions } from '../probe/run.ts';
import { readSite } from '../probe/site.ts';
import { probeEngines, type ProbeEngine } from '../probe/types.ts';
import { parseUrl } from '../probe/urls.ts';
import { cleanLine } from '../report/sanitize.ts';

export const aiProbeHelp = `Usage:
  altimeter ai-probe <domain> [options]   Ask answer engines, through your own Claude Code and Codex sign-ins,
                                          whether they cite the site for a few queries. Without --yes it only
                                          prints the plan and calls nothing.

Options:
  --keyword <query>      A query to ask; repeat it for several (at most 10 queries in all). Leave the domain out.
  --from-gsc             Use the site's top non-brand Search Console queries; they are sent to the engines.
  --engines <list>       claude, codex or claude,codex (default claude,codex).
  --runs <1-5>           Runs per query; fewer than 3 completed runs are an insufficient sample (default 3).
  --yes                  Run the plan. Every call counts toward your plan's usage limits.
  --refresh              Ask again instead of reusing runs made in the last 7 days.
  --out <dir>            Parent folder for probe.json and probe.md (default ./altimeter-report).
  --lang <en|es|ca>      Report language (default en).

Without --keyword or --from-gsc, queries are inferred from the home page and a few pages it links to, and are
labelled as inferred. A brand question ("What is <brand>?") is added when there is room: it measures
recognition, not visibility. Results are samples from these CLI agents. They do not represent ChatGPT,
Claude.ai, Copilot, Perplexity or Google AI Overviews, and Claude Code's web search is localised in the
United States.

Exit status: 0 the plan was printed or at least one run completed, 2 error or no run completed.
`;

class UsageError extends Error {}

export interface AiProbeContext {
  readonly env?: Environment;
  /** Network policy for reading the site; tests pass one that allows their loopback server. */
  readonly policy?: NetworkPolicy;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly cwd?: string;
  /** Reads Search Console for --from-gsc; by default with the credential an audit would use. */
  readonly searchConsole?: (origin: string) => Promise<GscData>;
  /** Timeouts, pause, cache folder and clock for the run; tests only. */
  readonly probe?: Partial<Omit<ProbeOptions, 'plan' | 'language' | 'env' | 'refresh' | 'log'>>;
}

function languageOf(value: string | undefined): Language {
  const chosen = (value ?? 'en') as Language;
  if (!languages.includes(chosen)) throw new UsageError('--lang must be en, es or ca.');
  return chosen;
}

/** The origin to probe: a host name such as example.com means https; an http or https URL keeps its scheme. */
function siteOrigin(value: string): string {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `https://${text}`);
  } catch {
    throw new UsageError('The domain must be a host name such as example.com, or an http or https URL.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || !parseUrl(url.origin)) {
    throw new UsageError('The domain must be a host name such as example.com, or an http or https URL.');
  }
  return url.origin;
}

function enginesOf(value: string | undefined): ProbeEngine[] {
  const names = (value ?? 'claude,codex').split(',').map(entry => entry.trim().toLowerCase()).filter(entry => entry !== '');
  if (names.length === 0 || names.some(name => !probeEngines.includes(name as ProbeEngine))) throw new UsageError('--engines must be claude, codex or claude,codex.');
  return [...new Set(names)] as ProbeEngine[];
}

/** Read-only Search Console access with the credential an audit with --gsc would use. */
async function readSearchConsole(origin: string): Promise<GscData> {
  const client = new HttpClient();
  try {
    const token = await searchConsoleToken(client);
    if (!token) throw new Error('no Search Console credential was found. Run "altimeter gsc login --client <client_secret.json> --remember <dpapi|file>" or set ALTIMETER_GSC_ACCESS_TOKEN.');
    return await fetchGscData(client, token, { url: `${origin}/` });
  } finally {
    await client.close();
  }
}

/**
 * altimeter ai-probe <domain>: plans a small sample of questions, prints the plan and, only with --yes, asks the
 * engines within the plan's call cap and writes probe.json and probe.md.
 */
export async function aiProbeCommand(args: string[], context: AiProbeContext = {}): Promise<number> {
  const write = context.stdout ?? ((text: string) => void process.stdout.write(text));
  const warn = context.stderr ?? ((text: string) => void process.stderr.write(text));
  try {
    const { values, positionals } = parseArgs({
      args, strict: true, allowPositionals: true,
      options: {
        keyword: { type: 'string', multiple: true }, 'from-gsc': { type: 'boolean' }, engines: { type: 'string' }, runs: { type: 'string' },
        yes: { type: 'boolean' }, refresh: { type: 'boolean' }, out: { type: 'string' }, lang: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help === true) {
      write(aiProbeHelp);
      return 0;
    }
    if (positionals.length !== 1) throw new UsageError('ai-probe needs exactly one domain, for example: altimeter ai-probe example.com --keyword "seo audit".');
    const language = languageOf(values.lang);
    const origin = siteOrigin(positionals[0]!);
    const engines = enginesOf(values.engines);
    const runs = values.runs === undefined ? defaultRuns : Number(values.runs);
    if (!Number.isInteger(runs) || runs < 1 || runs > maxRuns) throw new UsageError(`--runs must be a whole number from 1 to ${maxRuns}.`);

    const client = new HttpClient({ policy: context.policy ?? publicOnly });
    let site: PlanInput['site'];
    try {
      site = await readSite(origin, client);
    } finally {
      await client.close();
    }
    let searchConsole: PlanInput['searchConsole'];
    if (values['from-gsc'] === true) {
      try {
        searchConsole = { data: await (context.searchConsole ?? readSearchConsole)(origin) };
      } catch (error) {
        searchConsole = { problem: error instanceof Error ? error.message : 'unknown error' };
      }
    }
    const plan = planProbe({ site, keywords: values.keyword ?? [], ...(searchConsole ? { searchConsole } : {}), engines, runsPerQuery: runs, language });
    write(renderPlan(plan, language));
    if (values.yes !== true) {
      write(`${probeStrings(language).planNothingSent}\n`);
      return 0;
    }

    // Ctrl+C cancels the probe: the running CLI's process tree is stopped and the report says which runs were left.
    // A second Ctrl+C exits at once.
    const interrupted = new AbortController();
    const onInterrupt = () => interrupted.abort();
    process.once('SIGINT', onInterrupt);
    let report: Awaited<ReturnType<typeof runProbe>>;
    try {
      report = await runProbe({
        ...context.probe,
        plan,
        language,
        env: context.env ?? process.env,
        refresh: values.refresh === true,
        log: message => warn(`· ${cleanLine(message)}\n`),
        signal: context.probe?.signal ? AbortSignal.any([interrupted.signal, context.probe.signal]) : interrupted.signal,
      });
    } finally {
      process.removeListener('SIGINT', onInterrupt);
    }
    const cwd = context.cwd ?? process.cwd();
    const directory = probeDirectory(resolve(cwd, values.out ?? 'altimeter-report'), origin, new Date(report.generatedAt));
    await writeProbeReport(directory, report, language);
    write(renderSummary(report, language));
    write(`${join(relative(cwd, directory) || '.', 'probe.md')}\n`);
    return report.engines.some(section => section.runs.some(run => run.status === 'ok' || run.status === 'cached')) ? 0 : 2;
  } catch (error) {
    warn(`${cleanLine(error instanceof Error ? error.message : 'Unexpected error', 500)}\n`);
    return 2;
  }
}
