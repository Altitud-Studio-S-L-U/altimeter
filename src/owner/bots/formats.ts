import type { IpSource, LogFormat } from './activity.ts';
import { normalizeIp } from './ip-ranges.ts';

export const logFormats: readonly LogFormat[] = ['combined', 'common', 'nginx-json', 'iis', 'cloudfront', 'alb', 'cloudflare', 'vercel', 'netlify'];

/** One request as a log recorded it. Every text field is untrusted. */
export interface LogRecord {
  /** Epoch milliseconds, UTC. */
  readonly time: number;
  /** The client address from the configured source, or undefined when the line does not carry it. */
  readonly ip?: string;
  readonly method?: string;
  readonly host?: string;
  /** Path and query as requested. */
  readonly path: string;
  readonly status?: number;
  readonly bytes?: number;
  readonly userAgent?: string;
  readonly referer?: string;
  /** Cloudflare's verified-bot category: '' when Cloudflare did not verify the request, undefined when not logged. */
  readonly edgeCategory?: string;
  readonly challenged?: boolean;
  /** Request id, to drop the same request logged twice. */
  readonly requestId?: string;
}

export type ParsedLine =
  | { readonly kind: 'records'; readonly records: readonly LogRecord[] }
  /** W3C directives such as #Fields. */
  | { readonly kind: 'directive' }
  /** A well-formed line that is not a request, such as a build log or a background revalidation. */
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

/** Field names of a JSON access log, as dotted paths; each role falls back to the usual nginx variable names. */
export interface JsonFields {
  readonly time?: string;
  readonly ip?: string;
  readonly forwardedFor?: string;
  readonly method?: string;
  readonly path?: string;
  readonly query?: string;
  readonly request?: string;
  readonly status?: string;
  readonly bytes?: string;
  readonly referer?: string;
  readonly userAgent?: string;
  readonly host?: string;
}

export const jsonFieldRoles = ['time', 'ip', 'forwardedFor', 'method', 'path', 'query', 'request', 'status', 'bytes', 'referer', 'userAgent', 'host'] as const;

export interface ParserOptions {
  /** Applies to server logs (combined, common, nginx JSON, IIS, CloudFront); CDN logs record the visitor's address. */
  readonly ipSource?: IpSource;
  readonly jsonFields?: JsonFields;
}

export interface LineParser {
  readonly format: LogFormat;
  parse(line: string): ParsedLine;
}

const malformed = (reason: string): ParsedLine => ({ kind: 'malformed', reason });
const skip = (reason: string): ParsedLine => ({ kind: 'skip', reason });
const single = (record: LogRecord): ParsedLine => ({ kind: 'records', records: [record] });
const present = (value: string | undefined): string | undefined => (value === undefined || value === '' || value === '-' ? undefined : value);

const months: Readonly<Record<string, number>> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const clfTimePattern = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)? ([+-])(\d{2}):?(\d{2})$/u;

/** Common Log Format time, `10/Oct/2000:13:55:36 -0700`, as epoch milliseconds. */
export function parseClfTime(text: string): number | undefined {
  const match = clfTimePattern.exec(text.trim());
  if (!match) return undefined;
  const month = months[match[2]!.toLowerCase()];
  if (month === undefined) return undefined;
  const offset = (match[8] === '-' ? -1 : 1) * (Number(match[9]) * 60 + Number(match[10])) * 60_000;
  const time = Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]), Number((match[7] ?? '0').padEnd(3, '0')));
  return Number.isFinite(time) ? time - offset : undefined;
}

/** An epoch number in seconds, milliseconds, microseconds or nanoseconds, told apart by magnitude. */
function epochMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (value >= 1e17) return Math.floor(value / 1e6);
  if (value >= 1e14) return Math.floor(value / 1e3);
  if (value >= 1e11) return Math.floor(value);
  return Math.floor(value * 1000);
}

/** A timestamp from a JSON log: epoch numbers, numeric strings, ISO 8601 or Common Log Format. */
export function parseTimeValue(value: unknown): number | undefined {
  if (typeof value === 'number') return epochMs(value);
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(text)) return epochMs(Number(text));
  const clf = parseClfTime(text);
  if (clf !== undefined) return clf;
  if (!/^\d{4}-\d{2}-\d{2}/u.test(text)) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : time;
}

/** Undoes the escaping nginx and Apache apply to quoted fields: `\"`, `\\` and `\xHH` bytes. */
export function unescapeLogField(value: string): string {
  if (!value.includes('\\')) return value;
  const bytes: number[] = [];
  const characters = [...value];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!;
    if (character === '\\' && index + 1 < characters.length) {
      const next = characters[index + 1]!;
      const hex = next === 'x' ? characters.slice(index + 2, index + 4).join('') : '';
      if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
      if (next === '"' || next === '\\') {
        bytes.push(next.charCodeAt(0));
        index += 1;
        continue;
      }
    }
    bytes.push(...Buffer.from(character, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The client address from X-Forwarded-For: its first or last valid entry. */
export function forwardedAddress(header: string | undefined, source: 'xff-first' | 'xff-last'): string | undefined {
  const entries = (present(header) ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '' && entry.toLowerCase() !== 'unknown');
  const chosen = source === 'xff-first' ? entries[0] : entries.at(-1);
  return chosen === undefined ? undefined : normalizeIp(chosen);
}

function chooseIp(remote: string | undefined, forwarded: string | undefined, source: IpSource): string | undefined {
  if (source === 'remote') return remote === undefined ? undefined : normalizeIp(remote);
  return forwardedAddress(forwarded, source);
}

/** Path and host of a request target in origin form (`/a?b`) or absolute form (`https://host/a?b`). */
function target(value: string): { readonly path: string; readonly host?: string } | undefined {
  if (value.startsWith('/') || value === '*') return { path: value };
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      return { path: `${url.pathname}${url.search}`, host: url.hostname.toLowerCase() };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const requestLinePattern = /^([A-Za-z]+) (.+?)(?: HTTP\/\d(?:\.\d)?)?$/u;

function requestLine(line: string): { readonly method: string; readonly path: string; readonly host?: string } | undefined {
  const match = requestLinePattern.exec(line);
  if (!match) return undefined;
  const parsed = target(match[2]!);
  return parsed ? { method: match[1]!.toUpperCase(), ...parsed } : undefined;
}

const numberOf = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
};

const statusOf = (value: unknown): number | undefined => {
  const status = numberOf(value);
  return status !== undefined && status >= 0 && status <= 999 ? status : undefined;
};

const quoted = String.raw`"((?:[^"\\]|\\.)*)"`;
const combinedPattern = new RegExp(String.raw`^(\S+) \S+ \S+ \[([^\]]+)\] ${quoted} (\d{3}|-) (\d+|-)(?: ${quoted} ${quoted})?(.*)$`, 'u');
const trailingQuoted = new RegExp(quoted, 'gu');

function combinedParser(format: 'combined' | 'common', ipSource: IpSource): LineParser {
  return {
    format,
    parse(line) {
      const match = combinedPattern.exec(line);
      if (!match) return malformed('pattern');
      const time = parseClfTime(match[2]!);
      if (time === undefined) return malformed('time');
      const request = requestLine(unescapeLogField(match[3]!));
      if (!request) return skip('invalid-request');
      const [forwarded] = [...(match[8] ?? '').matchAll(trailingQuoted)].map(entry => unescapeLogField(entry[1]!));
      const ip = chooseIp(match[1], forwarded, ipSource);
      const status = statusOf(match[4]);
      const bytes = numberOf(match[5]);
      const referer = match[6] === undefined ? undefined : present(unescapeLogField(match[6]));
      const userAgent = match[7] === undefined ? undefined : present(unescapeLogField(match[7]));
      return single({
        time, path: request.path, method: request.method, ...(request.host ? { host: request.host } : {}), ...(ip ? { ip } : {}),
        ...(status === undefined ? {} : { status }), ...(bytes === undefined ? {} : { bytes }), ...(referer ? { referer } : {}), ...(userAgent ? { userAgent } : {}),
      });
    },
  };
}

function pathValue(object: unknown, path: string): unknown {
  let current: unknown = object;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? present(value) : typeof value === 'number' ? String(value) : undefined);

const jsonCandidates: Readonly<Record<(typeof jsonFieldRoles)[number], readonly string[]>> = {
  time: ['time_iso8601', 'time', 'timestamp', '@timestamp', 'msec', 'time_local', 'date'],
  ip: ['remote_addr', 'client_ip', 'clientip', 'ip', 'client'],
  forwardedFor: ['http_x_forwarded_for', 'x_forwarded_for', 'xff'],
  method: ['request_method', 'method'],
  path: ['request_uri', 'uri', 'path', 'url'],
  query: ['args', 'query_string'],
  request: ['request'],
  status: ['status', 'status_code'],
  bytes: ['body_bytes_sent', 'bytes_sent', 'bytes', 'response_size', 'size'],
  referer: ['http_referer', 'referer', 'referrer'],
  userAgent: ['http_user_agent', 'user_agent', 'agent', 'ua'],
  host: ['host', 'http_host', 'server_name'],
};

function jsonRecord(object: Record<string, unknown>, fields: JsonFields, ipSource: IpSource): ParsedLine {
  const value = (role: (typeof jsonFieldRoles)[number]): unknown => {
    const configured = fields[role];
    if (configured !== undefined) return pathValue(object, configured);
    for (const key of jsonCandidates[role]) if (object[key] !== undefined) return object[key];
    return undefined;
  };
  const time = parseTimeValue(value('time'));
  if (time === undefined) return malformed('time');
  let path = text(value('path'));
  let method = text(value('method'))?.toUpperCase();
  let host = text(value('host'))?.toLowerCase();
  if (path !== undefined) {
    const parsed = target(path);
    if (!parsed) return skip('invalid-request');
    path = parsed.path;
    host = parsed.host ?? host;
    const query = text(value('query'));
    if (query && !path.includes('?') && (fields.path !== undefined || object.request_uri === undefined)) path = `${path}?${query}`;
  } else {
    const request = text(value('request'));
    const parsed = request === undefined ? undefined : requestLine(request);
    if (!parsed) return request === undefined ? malformed('path') : skip('invalid-request');
    path = parsed.path;
    method = method ?? parsed.method;
    host = parsed.host ?? host;
  }
  const ip = chooseIp(text(value('ip')), text(value('forwardedFor')), ipSource);
  const status = statusOf(value('status'));
  const bytes = numberOf(value('bytes'));
  const referer = text(value('referer'));
  const userAgent = text(value('userAgent'));
  return single({
    time, path, ...(method ? { method } : {}), ...(host ? { host } : {}), ...(ip ? { ip } : {}), ...(status === undefined ? {} : { status }),
    ...(bytes === undefined ? {} : { bytes }), ...(referer ? { referer } : {}), ...(userAgent ? { userAgent } : {}),
  });
}

const challengeActions = new Set(['challenge', 'jschallenge', 'managedchallenge']);

function cloudflareRecord(object: Record<string, unknown>): ParsedLine {
  const time = parseTimeValue(object.EdgeStartTimestamp);
  if (time === undefined) return malformed('time');
  const path = text(object.ClientRequestURI) ?? text(object.ClientRequestPath);
  if (path === undefined) return malformed('path');
  const parsed = target(path);
  if (!parsed) return skip('invalid-request');
  const ip = typeof object.ClientIP === 'string' ? normalizeIp(object.ClientIP) : undefined;
  const status = statusOf(object.EdgeResponseStatus);
  const bytes = numberOf(object.EdgeResponseBytes);
  const actions = [object.SecurityAction, ...(Array.isArray(object.SecurityActions) ? object.SecurityActions : [])]
    .filter((entry): entry is string => typeof entry === 'string').map(entry => entry.toLowerCase());
  const referer = text(object.ClientRequestReferer);
  const userAgent = text(object.ClientRequestUserAgent);
  const host = text(object.ClientRequestHost)?.toLowerCase();
  const method = text(object.ClientRequestMethod)?.toUpperCase();
  const requestId = text(object.RayID);
  return single({
    time, path: parsed.path, ...(method ? { method } : {}), ...(host ? { host } : {}), ...(ip ? { ip } : {}), ...(status === undefined ? {} : { status }),
    ...(bytes === undefined ? {} : { bytes }), ...(referer ? { referer } : {}), ...(userAgent ? { userAgent } : {}),
    ...(typeof object.VerifiedBotCategory === 'string' ? { edgeCategory: object.VerifiedBotCategory.trim() } : {}),
    ...(actions.some(action => challengeActions.has(action)) ? { challenged: true } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function vercelRecord(object: Record<string, unknown>): ParsedLine {
  const proxy = object.proxy;
  if (proxy === null || typeof proxy !== 'object') return skip('not-a-request');
  const entry = proxy as Record<string, unknown>;
  const status = statusOf(entry.statusCode);
  // A status of -1 marks a background revalidation that no client requested.
  if (numberOf(entry.statusCode) === -1) return skip('background-revalidation');
  const time = parseTimeValue(entry.timestamp) ?? parseTimeValue(object.timestamp);
  if (time === undefined) return malformed('time');
  const path = text(entry.path);
  const parsed = path === undefined ? undefined : target(path);
  if (!parsed) return path === undefined ? malformed('path') : skip('invalid-request');
  const agents = Array.isArray(entry.userAgent) ? entry.userAgent : [entry.userAgent];
  const userAgent = text(agents[0]);
  const ip = typeof entry.clientIp === 'string' ? normalizeIp(entry.clientIp) : undefined;
  const bytes = numberOf(entry.responseByteSize);
  const referer = text(entry.referer);
  const host = text(entry.host)?.toLowerCase();
  const method = text(entry.method)?.toUpperCase();
  const requestId = text(object.requestId);
  return single({
    time, path: parsed.path, ...(method ? { method } : {}), ...(host ? { host } : {}), ...(ip ? { ip } : {}), ...(status === undefined ? {} : { status }),
    ...(bytes === undefined ? {} : { bytes }), ...(referer ? { referer } : {}), ...(userAgent ? { userAgent } : {}),
    ...(entry.wafAction === 'challenge' ? { challenged: true } : {}), ...(requestId ? { requestId } : {}),
  });
}

function netlifyRecord(object: Record<string, unknown>): ParsedLine {
  if (object.log_type !== undefined && object.log_type !== 'traffic') return skip('not-a-request');
  const time = parseTimeValue(object.timestamp);
  if (time === undefined) return malformed('time');
  const url = text(object.url);
  const parsed = url === undefined ? undefined : target(url);
  if (!parsed) return url === undefined ? malformed('path') : skip('invalid-request');
  const ip = typeof object.client_ip === 'string' ? normalizeIp(object.client_ip) : undefined;
  const status = statusOf(object.status_code);
  const bytes = numberOf(object.response_size);
  const referer = text(object.referrer);
  const userAgent = text(object.user_agent);
  const method = text(object.method)?.toUpperCase();
  const requestId = text(object.request_id);
  return single({
    time, path: parsed.path, ...(method ? { method } : {}), ...(parsed.host ? { host: parsed.host } : {}), ...(ip ? { ip } : {}),
    ...(status === undefined ? {} : { status }), ...(bytes === undefined ? {} : { bytes }), ...(referer ? { referer } : {}), ...(userAgent ? { userAgent } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

/** Parses one JSON line: an object, or an array of objects as log drains deliver them in batches. */
function jsonParser(format: 'nginx-json' | 'cloudflare' | 'vercel' | 'netlify', options: ParserOptions): LineParser {
  const ipSource = options.ipSource ?? 'remote';
  const one = (object: Record<string, unknown>): ParsedLine => {
    switch (format) {
      case 'cloudflare': return cloudflareRecord(object);
      case 'vercel': return vercelRecord(object);
      case 'netlify': return netlifyRecord(object);
      default: return jsonRecord(object, options.jsonFields ?? {}, ipSource);
    }
  };
  return {
    format,
    parse(line) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return malformed('json');
      }
      const objects = Array.isArray(value) ? value : [value];
      const records: LogRecord[] = [];
      let last: ParsedLine | undefined;
      for (const object of objects) {
        if (object === null || typeof object !== 'object' || Array.isArray(object)) return malformed('json');
        last = one(object as Record<string, unknown>);
        if (last.kind === 'records') records.push(...last.records);
      }
      if (records.length > 0) return { kind: 'records', records };
      return last ?? skip('empty');
    },
  };
}

/** Field orders used when a W3C file has no #Fields directive: CloudFront's documented order and IIS's default. */
const cloudfrontFields = [
  'date', 'time', 'x-edge-location', 'sc-bytes', 'c-ip', 'cs-method', 'cs(Host)', 'cs-uri-stem', 'sc-status', 'cs(Referer)', 'cs(User-Agent)', 'cs-uri-query',
  'cs(Cookie)', 'x-edge-result-type', 'x-edge-request-id', 'x-host-header', 'cs-protocol', 'cs-bytes', 'time-taken', 'x-forwarded-for', 'ssl-protocol',
  'ssl-cipher', 'x-edge-response-result-type', 'cs-protocol-version', 'fle-status', 'fle-encrypted-fields', 'c-port', 'time-to-first-byte',
  'x-edge-detailed-result-type', 'sc-content-type', 'sc-content-len', 'sc-range-start', 'sc-range-end',
];
const iisFields = ['date', 'time', 's-ip', 'cs-method', 'cs-uri-stem', 'cs-uri-query', 's-port', 'cs-username', 'c-ip', 'cs(User-Agent)', 'cs(Referer)', 'sc-status', 'sc-substatus', 'sc-win32-status', 'time-taken'];

/** IIS W3C extended logs and CloudFront standard logs: the latest #Fields directive names the columns. */
function w3cParser(format: 'iis' | 'cloudfront', ipSource: IpSource): LineParser {
  let fields: readonly string[] | undefined;
  return {
    format,
    parse(line) {
      if (line.startsWith('#')) {
        const directive = /^#Fields:\s*(.*)$/iu.exec(line);
        if (directive) fields = directive[1]!.trim().split(/\s+/u);
        return { kind: 'directive' };
      }
      const values = format === 'cloudfront' ? line.split('\t') : line.split(' ');
      const columns = fields ?? (format === 'cloudfront' ? cloudfrontFields : iisFields);
      if (!fields && values.length < (format === 'cloudfront' ? 26 : iisFields.length)) return malformed('no-fields-directive');
      if (values.length < Math.min(columns.length, 12)) return malformed('columns');
      const field = (...names: string[]): string | undefined => {
        for (const name of names) {
          const index = columns.findIndex(column => column.toLowerCase() === name.toLowerCase());
          if (index !== -1) return present(values[index]);
        }
        return undefined;
      };
      const date = field('date');
      const clock = field('time');
      const time = date && clock && /^\d{4}-\d{2}-\d{2}$/u.test(date) && /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(clock) ? Date.parse(`${date}T${clock}Z`) : Number.NaN;
      if (Number.isNaN(time)) return malformed('time');
      const stem = field('cs-uri-stem');
      if (stem === undefined || !stem.startsWith('/')) return skip('invalid-request');
      const query = field('cs-uri-query');
      const decode = format === 'cloudfront' ? safeDecode : (value: string) => value.replace(/\+/gu, ' ');
      const userAgent = field('cs(User-Agent)');
      const referer = field('cs(Referer)', 'cs(Referrer)');
      const host = field('x-host-header', 'cs-host', 'cs(Host)')?.toLowerCase();
      const ip = chooseIp(field('c-ip'), field('x-forwarded-for', 'X-Forwarded-For', 'cs(X-Forwarded-For)'), ipSource);
      const status = statusOf(field('sc-status'));
      const bytes = numberOf(field('sc-bytes'));
      const method = field('cs-method')?.toUpperCase();
      const requestId = field('x-edge-request-id');
      return single({
        time, path: query ? `${stem}?${query}` : stem, ...(method ? { method } : {}), ...(host ? { host } : {}), ...(ip ? { ip } : {}),
        ...(status === undefined ? {} : { status }), ...(bytes === undefined ? {} : { bytes }), ...(referer ? { referer: decode(referer) } : {}),
        ...(userAgent ? { userAgent: decode(userAgent) } : {}), ...(requestId ? { requestId } : {}),
      });
    },
  };
}

const albToken = /"(?:[^"\\]|\\.)*"|\S+/gu;
const albTypes = new Set(['http', 'https', 'h2', 'grpcs', 'ws', 'wss']);

/** AWS Application Load Balancer access logs: space-separated fields with quoted request and user agent. */
function albParser(): LineParser {
  return {
    format: 'alb',
    parse(line) {
      const tokens = line.match(albToken) ?? [];
      if (tokens.length < 14 || !albTypes.has(tokens[0]!)) return malformed('pattern');
      const time = parseTimeValue(tokens[1]);
      if (time === undefined) return malformed('time');
      const unquote = (value: string) => (value.startsWith('"') && value.endsWith('"') ? unescapeLogField(value.slice(1, -1)) : value);
      const request = requestLine(unquote(tokens[12]!));
      if (!request) return skip('invalid-request');
      const client = tokens[3]!;
      const separator = client.lastIndexOf(':');
      const ip = client === '-' || separator === -1 ? undefined : normalizeIp(client.slice(0, separator));
      const status = statusOf(tokens[8]);
      const bytes = numberOf(tokens[11]);
      const userAgent = present(unquote(tokens[13]!));
      return single({
        time, path: request.path, method: request.method, ...(request.host ? { host: request.host } : {}), ...(ip ? { ip } : {}),
        ...(status === undefined ? {} : { status }), ...(bytes === undefined ? {} : { bytes }), ...(userAgent ? { userAgent } : {}),
      });
    },
  };
}

export function createParser(format: LogFormat, options: ParserOptions = {}): LineParser {
  const ipSource = options.ipSource ?? 'remote';
  switch (format) {
    case 'combined':
    case 'common':
      return combinedParser(format, ipSource);
    case 'iis':
    case 'cloudfront':
      return w3cParser(format, ipSource);
    case 'alb':
      return albParser();
    default:
      return jsonParser(format, options);
  }
}

function jsonFormat(value: unknown): LogFormat | undefined {
  const object = Array.isArray(value) ? value[0] : value;
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const keys = object as Record<string, unknown>;
  if ('EdgeStartTimestamp' in keys || 'ClientRequestUserAgent' in keys || 'ClientRequestURI' in keys) return 'cloudflare';
  if ((keys.proxy !== null && typeof keys.proxy === 'object') || ('deploymentId' in keys && 'source' in keys)) return 'vercel';
  if ('log_type' in keys || ('client_ip' in keys && 'status_code' in keys)) return 'netlify';
  return 'nginx-json';
}

/** Recognises a log format from its first lines; undefined when none matches. */
export function detectFormat(lines: readonly string[]): LogFormat | undefined {
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line.startsWith('#')) {
      const directive = /^#Fields:\s*(.*)$/iu.exec(line);
      if (directive) return /\bx-edge-location\b/u.test(directive[1]!) ? 'cloudfront' : 'iis';
      continue;
    }
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        const format = jsonFormat(JSON.parse(line));
        if (format) return format;
      } catch {
        // A line that is not JSON says nothing about the format.
      }
      continue;
    }
    if (/^(?:https?|h2|grpcs|wss?) \d{4}-\d{2}-\d{2}T\S+ \S+ \S+ /u.test(line)) return 'alb';
    const combined = combinedPattern.exec(line);
    if (combined) return combined[7] === undefined ? 'common' : 'combined';
    if (/^\d{4}-\d{2}-\d{2}\t\d{2}:\d{2}:\d{2}\t/u.test(line)) return 'cloudfront';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /u.test(line)) return 'iis';
  }
  return undefined;
}
