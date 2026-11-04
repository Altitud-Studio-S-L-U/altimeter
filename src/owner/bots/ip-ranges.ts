import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { userCacheDirectory } from '../../ai/providers.ts';
import type { HttpClient } from '../../fetch/http.ts';
import { cleanLine } from '../../report/sanitize.ts';
import type { IpListStatus } from './activity.ts';
import { ipListDefinitions, type IpListId } from './operators.ts';

/** Lists are downloaded again after a day: operators add ranges without notice (tool convention). */
export const ipListTtlMs = 24 * 60 * 60 * 1000;

/** Altimeter's cache of the published lists: the `bot-ip-ranges` folder in the user cache directory. */
export function ipListCacheDirectory(): string {
  return join(userCacheDirectory(), 'bot-ip-ranges');
}

/**
 * An address in canonical text, or undefined when the value is not an IP address. Brackets, an IPv4 port, an IPv6
 * zone and the IPv4-mapped IPv6 form (`::ffff:1.2.3.4`) are removed.
 */
export function normalizeIp(raw: string): string | undefined {
  let value = raw.trim();
  if (value === '' || value === '-') return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(value);
  if (bracketed) value = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/u.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  value = value.replace(/%.*$/u, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value);
  if (mapped) value = mapped[1]!;
  return isIP(value) === 0 ? undefined : value;
}

export function ipFamily(address: string): 4 | 6 {
  return isIP(address) === 6 ? 6 : 4;
}

function validPrefix(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([0-9A-Fa-f:.]+)\/(\d{1,3})$/u.exec(value.trim());
  if (!match) return undefined;
  const family = isIP(match[1]!);
  const bits = Number(match[2]);
  if ((family === 4 && bits <= 32) || (family === 6 && bits <= 128)) return `${match[1]!.toLowerCase()}/${bits}`;
  return undefined;
}

export interface ParsedIpList {
  readonly creationTime?: string;
  readonly prefixes: readonly string[];
  /** Entries that looked like prefixes but were not valid CIDR blocks. */
  readonly invalid: number;
}

const prefixKeys = ['ipv4Prefix', 'ipv6Prefix', 'ip_prefix', 'ipv6_prefix', 'prefix'];

function collect(candidates: readonly unknown[]): { prefixes: string[]; invalid: number } {
  const prefixes = new Set<string>();
  let invalid = 0;
  for (const candidate of candidates) {
    const prefix = validPrefix(candidate);
    if (prefix) prefixes.add(prefix);
    else invalid += 1;
  }
  return { prefixes: [...prefixes], invalid };
}

/**
 * Reads a published address list: the JSON most operators use (`{creationTime, prefixes: [{ipv4Prefix}]}`), a page
 * that embeds such JSON (Amazon), or a plain list of CIDR blocks (Cloudflare).
 */
export function parseIpList(body: string): ParsedIpList {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  if (json !== undefined && json !== null && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    const entries = Array.isArray(json) ? json : Array.isArray(record.prefixes) ? record.prefixes : [];
    const values = entries.map(entry => (typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object'
      ? prefixKeys.map(key => (entry as Record<string, unknown>)[key]).find(value => value !== undefined) : entry));
    const { prefixes, invalid } = collect(values);
    const creationTime = typeof record.creationTime === 'string' ? cleanLine(record.creationTime, 64) : undefined;
    return { ...(creationTime ? { creationTime } : {}), prefixes, invalid };
  }
  const decoded = body.replace(/&quot;|&#34;|&#x22;/giu, '"');
  const found = /"creationTime"\s*:\s*"([^"]{1,64})"/u.exec(decoded)?.[1];
  const creationTime = found === undefined ? undefined : cleanLine(found, 64);
  const keyed = [...decoded.matchAll(/"(?:ipv4Prefix|ipv6Prefix|ip_prefix|ipv6_prefix)"\s*:\s*"([^"]{1,64})"/gu)].map(match => match[1]!);
  const { prefixes, invalid } = collect(keyed.length > 0 ? keyed : decoded.split(/\s+/u).filter(token => token.includes('/') && /^[0-9A-Fa-f:.]+\/\d+$/u.test(token)));
  return { ...(creationTime ? { creationTime } : {}), prefixes, invalid };
}

/** A list ready for matching, with where it came from. */
export interface LoadedIpList extends IpListStatus {
  readonly id: IpListId;
  readonly blocks: BlockList;
}

export function blockListOf(prefixes: readonly string[]): BlockList {
  const blocks = new BlockList();
  for (const prefix of prefixes) {
    const [network, bits] = prefix.split('/');
    blocks.addSubnet(network!, Number(bits), isIP(network!) === 6 ? 'ipv6' : 'ipv4');
  }
  return blocks;
}

export function listContains(list: LoadedIpList, address: string): boolean {
  return list.prefixes > 0 && list.blocks.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

interface CachedList {
  readonly version: 1;
  readonly url: string;
  readonly fetchedAt: string;
  readonly creationTime?: string;
  readonly prefixes: readonly string[];
}

async function readCached(directory: string, id: IpListId, url: string): Promise<CachedList | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as Partial<CachedList>;
    if (value.version !== 1 || value.url !== url || typeof value.fetchedAt !== 'string' || !Array.isArray(value.prefixes)) return undefined;
    const prefixes = value.prefixes.map(validPrefix).filter((entry): entry is string => entry !== undefined);
    return { version: 1, url, fetchedAt: value.fetchedAt, ...(typeof value.creationTime === 'string' ? { creationTime: value.creationTime } : {}), prefixes };
  } catch {
    return undefined;
  }
}

async function writeCached(directory: string, id: IpListId, entry: CachedList): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${id}.json`);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface IpListOptions {
  /** A guarded client; lists are only fetched from the operators' public URLs. */
  readonly client: HttpClient;
  readonly cacheDirectory?: string;
  readonly ttlMs?: number;
  readonly now?: Date;
  /** Other URLs for some lists, for tests and mirrors. */
  readonly urls?: Partial<Record<IpListId, string>>;
  /** Use cached lists only, without network access. */
  readonly offline?: boolean;
}

function loaded(id: IpListId, url: string, from: IpListStatus['from'], entry: CachedList | undefined, error?: string): LoadedIpList {
  const prefixes = entry?.prefixes ?? [];
  return {
    id, url, from, prefixes: prefixes.length, blocks: blockListOf(prefixes),
    ...(entry?.creationTime ? { creationTime: entry.creationTime } : {}), ...(entry ? { fetchedAt: entry.fetchedAt } : {}), ...(error ? { error } : {}),
  };
}

async function loadOne(id: IpListId, options: IpListOptions, directory: string): Promise<LoadedIpList> {
  const url = options.urls?.[id] ?? ipListDefinitions[id].url;
  const now = options.now ?? new Date();
  const cached = await readCached(directory, id, url);
  if (cached && now.getTime() - Date.parse(cached.fetchedAt) < (options.ttlMs ?? ipListTtlMs)) return loaded(id, url, 'cache', cached);
  if (options.offline) return cached ? loaded(id, url, 'stale-cache', cached, 'offline') : loaded(id, url, 'unavailable', undefined, 'offline');
  const result = await options.client.fetch(url, {
    maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000, headers: { accept: 'application/json, text/plain;q=0.9, text/html;q=0.8' },
  });
  let error: string | undefined;
  let parsed: ParsedIpList | undefined;
  if (result.error) error = `could not be read (${result.error.code})`;
  else if (result.status !== 200) error = `answered HTTP ${result.status}`;
  else {
    parsed = parseIpList(result.body.toString('utf8'));
    if (parsed.prefixes.length === 0) error = 'holds no address prefix; its format may have changed';
  }
  if (error || !parsed) return cached ? loaded(id, url, 'stale-cache', cached, error) : loaded(id, url, 'unavailable', undefined, error);
  const entry: CachedList = { version: 1, url, fetchedAt: now.toISOString(), ...(parsed.creationTime ? { creationTime: parsed.creationTime } : {}), prefixes: parsed.prefixes };
  await writeCached(directory, id, entry).catch(() => undefined);
  return loaded(id, url, 'network', entry);
}

/** Loads the lists, each from the cache while it is fresh, otherwise from its URL; a failed download falls back to the cache. */
export async function loadIpLists(ids: Iterable<IpListId>, options: IpListOptions): Promise<Map<IpListId, LoadedIpList>> {
  const directory = options.cacheDirectory ?? ipListCacheDirectory();
  const unique = [...new Set(ids)];
  const lists = await Promise.all(unique.map(id => loadOne(id, options, directory)));
  return new Map(lists.map(list => [list.id, list]));
}
