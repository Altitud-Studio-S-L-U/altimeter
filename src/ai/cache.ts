import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { userCacheDirectory, type Environment } from './providers.ts';
import { validateSchema, type Schema } from './schema.ts';
import type { ProviderName, Role, Usage } from './types.ts';

/** Answers are reused for a week, then asked again: sites and models change. */
export const cacheTtlMs = 7 * 24 * 60 * 60 * 1000;

/** Cached answers: %LOCALAPPDATA%\altimeter\ai-cache on Windows, the matching folder of the user cache elsewhere. */
export function analysisCacheDirectory(env: Environment = process.env, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).join(userCacheDirectory(env, platform), 'ai-cache');
}

export interface CacheKeyInput {
  /** The prompt with the nonce and volatile values removed. */
  readonly canonicalPrompt: string;
  readonly provider: ProviderName;
  readonly cliVersion: string;
  readonly model?: string;
  readonly effort?: string;
  readonly schema: Schema;
  readonly catalogSlice: string;
  readonly myths: string;
  readonly rubric: string;
  readonly keyword: readonly string[];
  readonly role: Role;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Everything that can change an answer is part of the key, so a hit is the same question to the same model. */
export function cacheKey(input: CacheKeyInput): string {
  return sha256(JSON.stringify([
    sha256(input.canonicalPrompt),
    input.provider,
    input.cliVersion,
    input.model ?? 'default',
    input.effort ?? 'default',
    sha256(JSON.stringify(input.schema)),
    sha256(input.catalogSlice),
    sha256(input.myths),
    sha256(input.rubric),
    input.keyword,
    input.role,
  ]));
}

export interface CachedAnswer {
  readonly value: unknown;
  readonly cliVersion: string;
  readonly model?: string;
  readonly costUsd?: number;
  readonly usage?: Usage;
}

export interface CacheOptions {
  readonly directory: string;
  readonly now?: () => number;
}

function entryPath(directory: string, key: string): string {
  return join(directory, key.slice(0, 2), `${key}.json`);
}

/**
 * A cached answer, re-validated on every read: wrong key, unknown format, expired or no longer matching the
 * schema means a miss, and the entry is removed.
 */
export async function readCache(key: string, schema: Schema, options: CacheOptions): Promise<CachedAnswer | undefined> {
  if (!/^[0-9a-f]{64}$/u.test(key)) return undefined;
  const path = entryPath(options.directory, key);
  let entry: unknown;
  try {
    entry = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  const now = (options.now ?? Date.now)();
  const record = entry as { version?: unknown; key?: unknown; createdAt?: unknown; answer?: CachedAnswer };
  const fresh = typeof record.createdAt === 'number' && record.createdAt <= now && now - record.createdAt < cacheTtlMs;
  const valid = record.version === 1 && record.key === key && fresh && record.answer !== undefined && typeof record.answer.cliVersion === 'string'
    && validateSchema(record.answer.value, schema).length === 0;
  if (!valid) {
    await rm(path, { force: true }).catch(() => {});
    return undefined;
  }
  return record.answer;
}

/** Stores an answer atomically; only answers that match their schema completely are worth keeping. */
export async function writeCache(key: string, schema: Schema, answer: CachedAnswer, options: CacheOptions): Promise<void> {
  if (validateSchema(answer.value, schema).length > 0) return;
  const path = entryPath(options.directory, key);
  await mkdir(join(options.directory, key.slice(0, 2)), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, key, createdAt: (options.now ?? Date.now)(), answer }), { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Removes a cache folder (the model answers by default) and returns how many entries it held, counting the JSON files
 * in it and in its subfolders.
 */
export async function clearCache(options: { readonly directory?: string; readonly env?: Environment } = {}): Promise<number> {
  const directory = options.directory ?? analysisCacheDirectory(options.env);
  let count = 0;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) count += (await readdir(join(directory, entry.name))).filter(name => name.endsWith('.json')).length;
      else if (entry.name.endsWith('.json')) count += 1;
    }
  } catch {
    return 0;
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return count;
}
