import { setTimeout as delay } from 'node:timers/promises';
import { resolveProvider, type Environment, type ResolvedProvider } from '../ai/providers.ts';
import type { Language } from '../i18n/messages.ts';
import { cleanLine } from '../report/sanitize.ts';
import { version } from '../version.ts';
import { brandAliases } from './brand.ts';
import { probeCacheDirectory, probeCacheKey, readProbeCache, writeProbeCache } from './cache.ts';
import { runClaudeProbe } from './claude.ts';
import { runCodexProbe } from './codex.ts';
import { asRunError, type EngineCall } from './engine.ts';
import { evaluateRun, queryMetrics, type EvaluatedRun, type SiteMatch } from './metrics.ts';
import { maxProbeCalls } from './plan.ts';
import { promptFingerprint, promptVersion } from './prompt.ts';
import type {
  EngineNotice, EngineSection, ProbeEngine, ProbePlan, ProbeReport, RawRun, RunFailureCode, RunRecord, SearchLocale, SearchMode, SkipReason,
} from './types.ts';

export const engineNames: Readonly<Record<ProbeEngine, string>> = { claude: 'Claude Code', codex: 'Codex CLI' };

interface EngineSetup {
  readonly searchMode: SearchMode;
  readonly locale: SearchLocale;
  readonly provenance: 'retrieval' | 'unverifiable';
  readonly run: (call: EngineCall) => Promise<RawRun>;
}

const setups: Readonly<Record<ProbeEngine, EngineSetup>> = {
  claude: { searchMode: 'claude-websearch', locale: 'united-states', provenance: 'retrieval', run: runClaudeProbe },
  codex: { searchMode: 'codex-live', locale: 'not-set', provenance: 'unverifiable', run: runCodexProbe },
};

export interface ProbeOptions {
  readonly plan: ProbePlan;
  readonly language: Language;
  readonly env?: Environment;
  /** Ask the engines again instead of reusing runs from the last seven days. */
  readonly refresh?: boolean;
  readonly cacheDir?: string;
  readonly callTimeoutMs?: number;
  /** Deadline for the whole probe. */
  readonly deadlineMs?: number;
  /** Pause between two calls to the same engine. */
  readonly pauseMs?: number;
  /** Hard limit on CLI calls; never more than the plan's count or maxProbeCalls. */
  readonly maxCalls?: number;
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

/** Tool conventions: a run with a few searches takes well under three minutes, and a full probe under an hour. */
export const probeDefaults = { callTimeoutMs: 180_000, deadlineMs: 3_600_000, pauseMs: 1500 } as const;
const minimumCallMs = 5000;

/** Failed runs in a row after which an engine is not asked again in the same probe. A tool convention. */
export const maxConsecutiveFailures = 2;

/** Failures that will not go away on the next question: the engine is not asked again in this probe. */
export const stoppingFailures: ReadonlySet<RunFailureCode> = new Set([
  'unavailable', 'unsafe-directory', 'command-too-long', 'start-failed', 'termination-failed', 'tool-use', 'isolation', 'limit-or-auth', 'cancelled',
]);

function retrievalFormat(raw: RawRun): NonNullable<RunRecord['retrievalFormat']> {
  const formats = raw.formats ?? [];
  if (formats.includes('text')) return 'text';
  if (formats.includes('links-json')) return 'links-json';
  if (formats.includes('structured')) return 'structured';
  return 'none';
}

function evaluated(queryId: string, run: number, status: 'ok' | 'cached', raw: RawRun, cacheKey: string, site: SiteMatch): EvaluatedRun {
  const evaluation = evaluateRun(raw, site);
  const record: RunRecord = {
    queryId,
    run,
    status,
    at: raw.at,
    durationMs: raw.durationMs,
    ...(raw.model ? { model: raw.model } : {}),
    searches: raw.searches,
    ...(raw.retrieved ? { retrievalFormat: retrievalFormat(raw), retrieved: raw.retrieved } : {}),
    cited: evaluation.cited,
    brandMentioned: evaluation.mention !== undefined,
    ...(evaluation.mention === undefined ? {} : { mention: evaluation.mention }),
    cacheKey,
    ...(raw.costUsd === undefined ? {} : { costUsd: raw.costUsd }),
    ...(raw.usage ? { usage: raw.usage } : {}),
  };
  return { record, raw, evaluation };
}

interface Shared {
  readonly options: ProbeOptions;
  readonly env: Environment;
  readonly now: () => Date;
  readonly directory: string;
  readonly cap: number;
  readonly deadline: number;
  readonly site: SiteMatch;
  readonly budget: { made: number };
}

function unavailable(engine: ProbeEngine, plan: ProbePlan, problem: string): EngineSection {
  const setup = setups[engine];
  return {
    engine, status: 'unavailable', problem: cleanLine(problem, 300), models: [], searchMode: setup.searchMode, locale: setup.locale, provenance: setup.provenance,
    runsPerQuery: plan.runsPerQuery, queries: [], runs: [], notices: [],
  };
}

/**
 * Runs one engine through the plan, one call at a time: run 1 of every query, then run 2 and so on, so a probe
 * cut short still covers every query. Cached runs are read first; a call is made only within the shared call cap
 * and the deadline, and an engine that fails in a way the next question cannot fix is not asked again.
 */
async function runEngine(engine: ProbeEngine, shared: Shared): Promise<EngineSection> {
  const { options, env, now } = shared;
  const { plan } = options;
  const setup = setups[engine];
  let provider: ResolvedProvider;
  try {
    provider = await resolveProvider(engine, { env });
  } catch (error) {
    return unavailable(engine, plan, error instanceof Error ? error.message : `${engineNames[engine]} is unavailable.`);
  }
  const results = new Map<string, EvaluatedRun>();
  const notices: EngineNotice[] = provider.capabilities.verified ? [] : [{ code: 'unverified-version', version: provider.version }];
  let stopped: RunFailureCode | undefined;
  let consecutive = 0;
  let called = false;
  const pauseMs = options.pauseMs ?? probeDefaults.pauseMs;
  for (let run = 1; run <= plan.runsPerQuery; run += 1) {
    for (const query of plan.queries) {
      const id = `${query.id}#${run}`;
      const skip = (reason: SkipReason) => results.set(id, { record: { queryId: query.id, run, status: 'skipped', skipped: reason } });
      const cacheKey = probeCacheKey({ engine, cliVersion: provider.version, searchMode: setup.searchMode, locale: setup.locale, prompt: promptFingerprint, query: query.text, run });
      const cacheOptions = { directory: shared.directory, now: () => now().getTime() };
      if (options.refresh !== true) {
        const cached = await readProbeCache(cacheKey, cacheOptions);
        if (cached) {
          results.set(id, evaluated(query.id, run, 'cached', cached, cacheKey, shared.site));
          continue;
        }
      }
      if (options.signal?.aborted) {
        skip('cancelled');
        continue;
      }
      if (stopped) {
        skip('engine-stopped');
        continue;
      }
      if (shared.budget.made >= shared.cap) {
        skip('call-cap');
        continue;
      }
      if (called && pauseMs > 0) await delay(pauseMs, undefined, options.signal ? { signal: options.signal } : {}).catch(() => {});
      const remaining = shared.deadline - Date.now();
      if (options.signal?.aborted) {
        skip('cancelled');
        continue;
      }
      if (remaining < minimumCallMs) {
        skip('deadline');
        continue;
      }
      // Counted before the call starts, so two engines running side by side can never pass the cap together.
      shared.budget.made += 1;
      called = true;
      options.log?.(`Asking ${engineNames[engine]}: ${query.id}, run ${run} of ${plan.runsPerQuery}`);
      try {
        const raw = await setup.run({
          query: query.text,
          provider,
          env,
          timeoutMs: Math.min(options.callTimeoutMs ?? probeDefaults.callTimeoutMs, remaining),
          ...(options.signal ? { signal: options.signal } : {}),
          now,
        });
        await writeProbeCache(cacheKey, raw, cacheOptions).catch(() => {});
        results.set(id, evaluated(query.id, run, 'ok', raw, cacheKey, shared.site));
        consecutive = 0;
      } catch (error) {
        const failure = asRunError(error);
        results.set(id, { record: { queryId: query.id, run, status: 'failed', error: { code: failure.code, message: cleanLine(failure.message, 300) } } });
        consecutive += 1;
        if (stoppingFailures.has(failure.code) || consecutive >= maxConsecutiveFailures) {
          stopped = failure.code;
          notices.push({ code: 'stopped', reason: failure.code, consecutive });
        }
      }
    }
  }
  const order = new Map(plan.queries.map((query, index) => [query.id, index]));
  const entries = [...results.values()].sort((a, b) => (order.get(a.record.queryId)! - order.get(b.record.queryId)!) || a.record.run - b.record.run);
  const verifiable = setup.provenance === 'retrieval';
  const queries = plan.queries.map(query => queryMetrics(query.id, plan.runsPerQuery, entries.filter(entry => entry.record.queryId === query.id), verifiable));
  const completed = entries.filter(entry => entry.raw !== undefined).map(entry => entry.raw!);
  const days = completed.map(raw => raw.at.slice(0, 10)).sort();
  const made = entries.filter(entry => entry.record.status === 'ok' && entry.raw?.costUsd !== undefined);
  const unrecognised = entries.filter(entry => entry.raw !== undefined && entry.raw.searches > 0 && (entry.record.retrievalFormat === 'text' || entry.record.retrievalFormat === 'none')).length;
  if (unrecognised > 0) notices.push({ code: 'unrecognised-results', runs: unrecognised });
  return {
    engine,
    status: 'ran',
    cliVersion: provider.version,
    verifiedVersion: provider.capabilities.verified,
    models: [...new Set(completed.map(raw => raw.model).filter((model): model is string => model !== undefined))],
    searchMode: setup.searchMode,
    locale: setup.locale,
    provenance: setup.provenance,
    ...(days.length > 0 ? { firstRun: days[0]!, lastRun: days.at(-1)! } : {}),
    runsPerQuery: plan.runsPerQuery,
    queries,
    runs: entries.map(entry => entry.record),
    ...(made.length > 0 ? { costUsd: made.reduce((sum, entry) => sum + entry.raw!.costUsd!, 0) } : {}),
    notices,
  };
}

/**
 * Runs a probe plan on its engines, side by side and one call at a time each, and returns the report. Search
 * results and answers are only read for URLs and brand mentions; nothing from them is ever passed to another
 * tool or another call.
 */
export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const { plan } = options;
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const env = options.env ?? process.env;
  const shared: Shared = {
    options,
    env,
    now,
    directory: options.cacheDir ?? probeCacheDirectory(env),
    cap: Math.max(0, Math.min(options.maxCalls ?? plan.calls, plan.calls, maxProbeCalls)),
    deadline: Date.now() + (options.deadlineMs ?? probeDefaults.deadlineMs),
    site: { domain: plan.site.domain, aliases: brandAliases(plan.site.brandNames, plan.site.host.split('.')[0] ?? '') },
    budget: { made: 0 },
  };
  const engines = await Promise.all(plan.engines.map(engine => runEngine(engine, shared)));
  const runs = engines.flatMap(section => section.runs);
  return {
    schemaVersion: 1,
    kind: 'ai-probe',
    tool: { name: 'altimeter', version },
    promptVersion,
    generatedAt,
    language: options.language,
    site: { origin: plan.site.origin, host: plan.site.host, domain: plan.site.domain, brandNames: plan.site.brandNames, pagesRead: plan.site.pages },
    runsPerQuery: plan.runsPerQuery,
    queries: plan.queries,
    notes: plan.notes,
    siteNotices: plan.site.notices,
    engines,
    calls: {
      planned: plan.calls,
      cap: shared.cap,
      made: shared.budget.made,
      fromCache: runs.filter(run => run.status === 'cached').length,
      skipped: runs.filter(run => run.status === 'skipped').length,
    },
  };
}
