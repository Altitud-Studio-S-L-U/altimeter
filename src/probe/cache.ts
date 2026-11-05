import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { cacheTtlMs } from '../ai/cache.ts';
import { userCacheDirectory, type Environment } from '../ai/providers.ts';
import type { Usage } from '../ai/types.ts';
import { cleanText } from '../report/sanitize.ts';
import { isRecord, modelName } from './engine.ts';
import { answerLimit, type ProbeEngine, type RawRun, type RetrievalFormat, type SearchLocale, type SearchMode } from './types.ts';
import { canonicalList } from './urls.ts';

/** Runs are reused for the same seven days as model answers, then asked again: indexes and models change. */
export const probeCacheTtlMs = cacheTtlMs;

/** %LOCALAPPDATA%\altimeter\ai-probe on Windows, the matching folder of the user cache elsewhere. */
export function probeCacheDirectory(env: Environment = process.env, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).join(userCacheDirectory(env, platform), 'ai-probe');
}

export interface ProbeCacheKeyInput {
  readonly engine: ProbeEngine;
  readonly cliVersion: string;
  readonly searchMode: SearchMode;
  readonly locale: SearchLocale;
  /** Identifies the prompt template and its instructions. */
  readonly prompt: string;
  readonly query: string;
  /** Each run of a query is its own sample, so each has its own entry. */
  readonly run: number;
}

/** Everything that can change a run is part of the key: the engine and its version, the search setup, the template, the question and the run. */
export function probeCacheKey(input: ProbeCacheKeyInput): string {
  return createHash('sha256').update(JSON.stringify(['ai-probe', 1, input.engine, input.cliVersion, input.searchMode, input.locale, input.prompt, input.query, input.run])).digest('hex');
}

export interface ProbeCacheOptions {
  readonly directory: string;
  readonly now?: () => number;
}

function entryPath(directory: string, key: string): string {
  return join(directory, key.slice(0, 2), `${key}.json`);
}

const formats = new Set<RetrievalFormat>(['links-json', 'structured', 'text', 'empty']);
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage = {
    ...(nonNegative(value.inputTokens) ? { inputTokens: value.inputTokens } : {}),
    ...(nonNegative(value.outputTokens) ? { outputTokens: value.outputTokens } : {}),
    ...(nonNegative(value.cachedInputTokens) ? { cachedInputTokens: value.cachedInputTokens } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** A stored run, checked field by field and cleaned again: the file sits in a folder other programs can write. */
function storedRun(value: unknown): RawRun | undefined {
  if (!isRecord(value)) return undefined;
  const { answer, retrieved, searches, durationMs, at } = value;
  if (typeof answer !== 'string' || answer.trim() === '' || answer.length > answerLimit + 1) return undefined;
  if (!Number.isInteger(searches) || (searches as number) < 0 || !nonNegative(durationMs)) return undefined;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  if (retrieved !== undefined && (!Array.isArray(retrieved) || retrieved.some(entry => typeof entry !== 'string'))) return undefined;
  if (value.formats !== undefined && (!Array.isArray(value.formats) || value.formats.some(entry => !formats.has(entry as RetrievalFormat)))) return undefined;
  const model = modelName(value.model);
  const usage = usageOf(value.usage);
  return {
    answer: cleanText(answer, answerLimit),
    ...(retrieved === undefined ? {} : { retrieved: canonicalList(retrieved as string[], 200) }),
    ...(value.formats === undefined ? {} : { formats: value.formats as RetrievalFormat[] }),
    searches: searches as number,
    ...(model ? { model } : {}),
    ...(nonNegative(value.costUsd) ? { costUsd: value.costUsd } : {}),
    ...(usage ? { usage } : {}),
    durationMs,
    at: new Date(Date.parse(at)).toISOString(),
  };
}

/** A cached run younger than seven days, or undefined; an entry that is stale, from the future or malformed is removed. */
export async function readProbeCache(key: string, options: ProbeCacheOptions): Promise<RawRun | undefined> {
  if (!/^[0-9a-f]{64}$/u.test(key)) return undefined;
  const path = entryPath(options.directory, key);
  let entry: unknown;
  try {
    entry = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  const now = (options.now ?? Date.now)();
  const record = isRecord(entry) ? entry : {};
  const fresh = typeof record.createdAt === 'number' && record.createdAt <= now && now - record.createdAt < probeCacheTtlMs;
  const run = record.version === 1 && record.key === key && fresh ? storedRun(record.run) : undefined;
  if (!run) {
    await rm(path, { force: true }).catch(() => {});
    return undefined;
  }
  return run;
}

/** Stores a completed run atomically. */
export async function writeProbeCache(key: string, run: RawRun, options: ProbeCacheOptions): Promise<void> {
  const path = entryPath(options.directory, key);
  await mkdir(join(options.directory, key.slice(0, 2)), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, key, createdAt: (options.now ?? Date.now)(), run }), { mode: 0o600 });
  await rename(temporary, path);
}
