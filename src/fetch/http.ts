import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Readable, Writable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { Agent, request } from 'undici';
import { version } from '../version.ts';
import { addressAllowed, publicOnly, type NetworkPolicy } from './ip-guard.ts';

export const defaultUserAgent = `Mozilla/5.0 (compatible; Altimeter/${version}; +https://github.com/Altitud-Studio-S-L-U/altimeter)`;

export type FetchErrorCode =
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'blocked-address'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'timeout'
  | 'redirect-loop'
  | 'too-many-redirects'
  | 'decode'
  | 'aborted';

export type HeaderMap = Readonly<Record<string, readonly string[]>>;

export interface Hop {
  readonly url: string;
  readonly status: number;
  readonly headers: HeaderMap;
  /** The redirect target resolved against `url`, when the response is a redirect. */
  readonly location?: string;
  /** Milliseconds from sending the request to receiving the response headers. */
  readonly ttfbMs: number;
}

export interface FetchResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  /** Every response received, the final one last. Empty when no response arrived. */
  readonly hops: readonly Hop[];
  readonly status: number | undefined;
  readonly headers: HeaderMap;
  /** The decoded body of the final response, cut at `maxBytes`. */
  readonly body: Buffer;
  readonly transferBytes: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly error?: { readonly code: FetchErrorCode; readonly message: string };
}

export interface FetchOptions {
  readonly method?: 'GET' | 'HEAD' | 'POST';
  /** Request body for POST; dropped when a 301, 302 or 303 redirect turns the request into a GET. */
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Decoded body limit in bytes (default 15 MiB). */
  readonly maxBytes?: number;
  /** Redirects to follow before failing with too-many-redirects (default 10, as Googlebot). */
  readonly maxRedirects?: number;
  readonly followRedirects?: boolean;
  /** Per-request deadline in milliseconds (default 20 s). */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type Lookup = typeof dnsLookup;
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Wraps DNS resolution so a connection is only opened to addresses the policy allows. */
export function guardedLookup(policy: NetworkPolicy, resolve: Lookup = dnsLookup) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const allowed = addresses.filter(entry => addressAllowed(policy, hostname, entry.address));
      if (allowed.length === 0) {
        const blocked: NodeJS.ErrnoException = new Error(`${hostname} resolves only to addresses that the network policy blocks`);
        blocked.code = 'ALTIMETER_BLOCKED_ADDRESS';
        return callback(blocked, []);
      }
      if (options.all) return callback(null, allowed);
      return callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

class LimitReached extends Error {}

function headerMap(raw: Record<string, string | string[] | undefined>): HeaderMap {
  const result: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value : [value];
  }
  return result;
}

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const values = headers[name.toLowerCase()];
  return values === undefined ? undefined : values.join(', ');
}

function decoderFor(encoding: string): Transform | undefined {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case 'zstd':
      return zlib.createZstdDecompress();
    default:
      return undefined;
  }
}

function errorCode(error: unknown): FetchErrorCode {
  const record = error as { code?: string; name?: string; cause?: { code?: string; name?: string } } | null;
  const code = record?.code ?? record?.cause?.code ?? '';
  const name = record?.name ?? record?.cause?.name ?? '';
  if (code === 'ALTIMETER_BLOCKED_ADDRESS') return 'blocked-address';
  if (name === 'TimeoutError' || code.startsWith('UND_ERR_') && code.includes('TIMEOUT')) return 'timeout';
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') return 'aborted';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'EAI_NODATA') return 'dns';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/u.test(code)) return 'tls';
  return 'connection';
}

/** An HTTP client that never connects to blocked addresses and records every redirect hop. */
export class HttpClient {
  readonly #agent: Agent;
  readonly #policy: NetworkPolicy;
  readonly #userAgent: string;

  constructor(options: { policy?: NetworkPolicy; userAgent?: string; lookup?: Lookup; ca?: string | readonly string[] } = {}) {
    this.#policy = options.policy ?? publicOnly;
    this.#userAgent = options.userAgent ?? defaultUserAgent;
    this.#agent = new Agent({
      connect: {
        lookup: guardedLookup(this.#policy, options.lookup) as never,
        timeout: 10_000,
        ...(options.ca === undefined ? {} : { ca: options.ca as string | string[] }),
      },
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    });
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const started = performance.now();
    const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
    const maxRedirects = options.maxRedirects ?? 10;
    const hops: Hop[] = [];
    const visited = new Set<string>();
    let method = options.method ?? 'GET';
    let requestBody = method === 'POST' ? options.body : undefined;
    let current = url;
    const finish = (extra: Partial<FetchResult> & { error?: FetchResult['error'] }): FetchResult => ({
      requestedUrl: url,
      finalUrl: current,
      hops,
      status: hops.at(-1)?.status,
      headers: hops.at(-1)?.headers ?? {},
      body: Buffer.alloc(0),
      transferBytes: 0,
      truncated: false,
      durationMs: performance.now() - started,
      ...extra,
    });

    for (;;) {
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        return finish({ error: { code: 'invalid-url', message: `Not a valid URL: ${current}` } });
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return finish({ error: { code: 'unsupported-protocol', message: `Only http and https are fetched, not ${target.protocol}` } });
      }
      const host = target.hostname.replace(/^\[|\]$/gu, '');
      if (isIP(host) !== 0 && !addressAllowed(this.#policy, host, host)) {
        return finish({ error: { code: 'blocked-address', message: `${host} is not a public address` } });
      }
      visited.add(target.href);
      const signals = [AbortSignal.timeout(options.timeoutMs ?? 20_000), ...(options.signal ? [options.signal] : [])];
      const sent = performance.now();
      let response;
      try {
        response = await request(target, {
          dispatcher: this.#agent,
          method,
          ...(requestBody === undefined ? {} : { body: requestBody }),
          signal: AbortSignal.any(signals),
          headers: {
            'user-agent': this.#userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            ...options.headers,
          },
        });
      } catch (error) {
        return finish({ error: { code: errorCode(error), message: error instanceof Error ? error.message : 'Request failed' } });
      }
      const headers = headerMap(response.headers);
      const locationHeader = headerValue(headers, 'location');
      const isRedirect = redirectStatuses.has(response.statusCode) && locationHeader !== undefined;
      let location: string | undefined;
      if (isRedirect) {
        try {
          location = new URL(locationHeader, target).href;
        } catch {
          location = undefined;
        }
      }
      hops.push({ url: target.href, status: response.statusCode, headers, ttfbMs: performance.now() - sent, ...(location ? { location } : {}) });

      if (isRedirect && options.followRedirects !== false) {
        await response.body.dump().catch(() => {});
        if (location === undefined) return finish({ error: { code: 'invalid-url', message: `Invalid redirect target: ${locationHeader}` } });
        if (visited.has(location)) {
          current = location;
          return finish({ error: { code: 'redirect-loop', message: `Redirect loop at ${location}` } });
        }
        if (hops.length > maxRedirects) {
          return finish({ error: { code: 'too-many-redirects', message: `More than ${maxRedirects} redirects` } });
        }
        if (response.statusCode === 303 || (method === 'POST' && (response.statusCode === 301 || response.statusCode === 302))) {
          method = 'GET';
          requestBody = undefined;
        }
        current = location;
        continue;
      }

      if (method === 'HEAD') {
        await response.body.dump().catch(() => {});
        return finish({});
      }
      const encodings = (headerValue(headers, 'content-encoding') ?? '')
        .split(',').map(value => value.trim().toLowerCase()).filter(value => value !== '' && value !== 'identity');
      const decoders = encodings.reverse().map(decoderFor);
      if (decoders.some(decoder => decoder === undefined)) {
        await response.body.dump().catch(() => {});
        return finish({ error: { code: 'decode', message: `Unsupported content encoding: ${encodings.join(', ')}` } });
      }
      let transferBytes = 0;
      let size = 0;
      let truncated = false;
      const chunks: Buffer[] = [];
      const body = response.body;
      async function* source() {
        for await (const chunk of body) {
          transferBytes += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      }
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (size + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            callback(new LimitReached());
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
          callback();
        },
      });
      try {
        await pipeline([Readable.from(source()), ...(decoders as Transform[]), sink]);
      } catch (error) {
        if (!(error instanceof LimitReached)) {
          body.destroy();
          const code = errorCode(error);
          return finish({
            body: Buffer.concat(chunks),
            transferBytes,
            error: { code: code === 'connection' ? 'decode' : code, message: error instanceof Error ? error.message : 'Body could not be read' },
          });
        }
        body.destroy();
      }
      return finish({ body: Buffer.concat(chunks), transferBytes, truncated });
    }
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }
}
