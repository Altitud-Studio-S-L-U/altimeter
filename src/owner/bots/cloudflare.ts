import type { HttpClient } from '../../fetch/http.ts';
import { cleanLine } from '../../report/sanitize.ts';
import type { Observation } from './aggregate.ts';
import { normalizeIp } from './ip-ranges.ts';
import { assistantReferrers, botDefinitions, type BotDefinition } from './operators.ts';

export const cloudflareApi = 'https://api.cloudflare.com/client/v4';

/** A failure reading Cloudflare; its message never contains the token. */
export class CloudflareError extends Error {}

/** Limits of the httpRequestsAdaptiveGroups dataset for the zone, read before any data query. */
export interface DatasetSettings {
  readonly enabled: boolean;
  /** Longest time range one query may cover, in seconds. */
  readonly maxDuration: number;
  /** How far back the dataset reaches, in seconds. */
  readonly notOlderThan: number;
  readonly maxPageSize: number;
  readonly maxNumberOfFields?: number;
  readonly availableFields?: readonly string[];
}

export interface CloudflareOptions {
  readonly client: HttpClient;
  /** A read-only API token; it is sent only to the API endpoint, in the Authorization header. */
  readonly token: string;
  /** The zone's domain name (a subdomain also works) or its 32-character zone ID. */
  readonly zone: string;
  readonly start: Date;
  readonly end: Date;
  readonly endpoint?: string;
  /** Queries allowed in one run, far below Cloudflare's 300 per five minutes (tool convention). */
  readonly maxQueries?: number;
  readonly bots?: readonly BotDefinition[];
}

export interface CloudflareData {
  readonly zone: { readonly id: string; readonly name: string };
  readonly settings: DatasetSettings;
  readonly start: Date;
  readonly end: Date;
  readonly observations: readonly Observation[];
  /** Visits by referrer host and visits tagged utm_source=chatgpt.com, when the zone exposes those fields. */
  readonly referrals?: { readonly byHost: ReadonlyMap<string, number>; readonly tagged?: number };
  readonly dimensions: readonly string[];
  readonly queries: number;
  /** Crawlers whose rows hit the page size even when queried alone. */
  readonly truncatedBots: readonly string[];
  readonly truncated: boolean;
  readonly sampleInterval?: number;
  readonly warnings: readonly string[];
}

const zoneId = /^[0-9a-f]{32}$/u;
const domainName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/u;
const dayMs = 86_400_000;
const hourMs = 3_600_000;

/** Serialises a GraphQL input value; every string is escaped, and keys must be plain names. */
export function graphqlLiteral(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(graphqlLiteral).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, entry]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new TypeError(`Not a GraphQL name: ${key}`);
      return `${key}: ${graphqlLiteral(entry)}`;
    }).join(', ')}}`;
  }
  throw new TypeError('Unsupported GraphQL value');
}

const time = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');

class Api {
  readonly #client: HttpClient;
  readonly #token: string;
  readonly #endpoint: string;
  readonly #maxQueries: number;
  queries = 0;

  constructor(client: HttpClient, token: string, endpoint: string, maxQueries: number) {
    this.#client = client;
    this.#token = token;
    this.#endpoint = endpoint.replace(/\/$/u, '');
    this.#maxQueries = maxQueries;
  }

  get budgetLeft(): number {
    return this.#maxQueries - this.queries;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: string): Promise<Record<string, unknown>> {
    this.queries += 1;
    const result = await this.#client.fetch(`${this.#endpoint}${path}`, {
      method, followRedirects: false, maxBytes: 32 * 1024 * 1024, timeoutMs: 60_000,
      headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body }),
    });
    if (result.error) throw new CloudflareError(`Cloudflare could not be reached (${result.error.code}).`);
    if (result.status === 401 || result.status === 403) {
      throw new CloudflareError('Cloudflare refused the token. It needs read access to the zone: Zone > Analytics > Read (and Zone > Zone > Read to find the zone by name).');
    }
    if (result.status === 429) throw new CloudflareError('Cloudflare rate limit reached; try again in a few minutes.');
    if (result.status !== 200) throw new CloudflareError(`Cloudflare answered HTTP ${result.status}.`);
    let payload: unknown;
    try {
      payload = JSON.parse(result.body.toString('utf8'));
    } catch {
      throw new CloudflareError('Cloudflare answered with something that is not JSON.');
    }
    if (payload === null || typeof payload !== 'object') throw new CloudflareError('Cloudflare answered with an unexpected value.');
    return payload as Record<string, unknown>;
  }

  async rest(path: string): Promise<Record<string, unknown>> {
    const payload = await this.#call('GET', path);
    if (payload.success === false) throw new CloudflareError(`Cloudflare refused the request: ${firstMessage(payload.errors)}`);
    return payload;
  }

  async graphql(query: string): Promise<Record<string, unknown>> {
    const payload = await this.#call('POST', '/graphql', JSON.stringify({ query }));
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new CloudflareError(`Cloudflare GraphQL error: ${firstMessage(payload.errors)}`);
    const data = payload.data;
    if (data === null || typeof data !== 'object') throw new CloudflareError('Cloudflare GraphQL answered without data.');
    return data as Record<string, unknown>;
  }
}

function firstMessage(errors: unknown): string {
  const first = Array.isArray(errors) ? (errors[0] as { message?: unknown } | undefined) : undefined;
  return typeof first?.message === 'string' ? cleanLine(first.message, 200) : 'no details';
}

/** Finds the zone by name, trying the parent domains of a subdomain, or takes a zone ID as given. */
async function resolveZone(api: Api, zone: string): Promise<{ id: string; name: string }> {
  const value = zone.trim().toLowerCase().replace(/\.$/u, '');
  if (zoneId.test(value)) return { id: value, name: value };
  if (!domainName.test(value)) throw new CloudflareError('The Cloudflare zone must be a domain name such as example.com, or a zone ID.');
  const labels = value.split('.');
  for (let index = 0; index <= labels.length - 2 && index < 3; index++) {
    const name = labels.slice(index).join('.');
    const payload = await api.rest(`/zones?name=${encodeURIComponent(name)}&per_page=5`);
    const results = Array.isArray(payload.result) ? (payload.result as Array<Record<string, unknown>>) : [];
    const match = results.find(entry => typeof entry.name === 'string' && entry.name.toLowerCase() === name && typeof entry.id === 'string' && zoneId.test(entry.id));
    if (match) return { id: match.id as string, name };
  }
  throw new CloudflareError(`No Cloudflare zone for ${value} is visible to the token. Give it Zone > Zone > Read for the zone, or pass the zone ID.`);
}

function zoneNode(data: Record<string, unknown>): Record<string, unknown> {
  const zones = (data.viewer as { zones?: unknown } | undefined)?.zones;
  const zone = Array.isArray(zones) ? zones[0] : undefined;
  if (zone === null || typeof zone !== 'object') throw new CloudflareError('The token cannot read analytics for this zone.');
  return zone as Record<string, unknown>;
}

async function readSettings(api: Api, id: string): Promise<DatasetSettings> {
  const query = `{ viewer { zones(filter: ${graphqlLiteral({ zoneTag: id })}) { settings { httpRequestsAdaptiveGroups { enabled maxDuration notOlderThan maxPageSize maxNumberOfFields availableFields } } } } }`;
  const node = (zoneNode(await api.graphql(query)).settings as { httpRequestsAdaptiveGroups?: Record<string, unknown> } | undefined)?.httpRequestsAdaptiveGroups;
  if (!node) throw new CloudflareError('The httpRequestsAdaptiveGroups dataset is not available for this zone.');
  const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
  const fields = Array.isArray(node.availableFields) ? node.availableFields.filter((entry): entry is string => typeof entry === 'string') : undefined;
  return {
    enabled: node.enabled !== false,
    maxDuration: number(node.maxDuration, dayMs / 1000),
    notOlderThan: number(node.notOlderThan, 31 * dayMs / 1000),
    maxPageSize: Math.min(number(node.maxPageSize, 10_000), 10_000),
    ...(typeof node.maxNumberOfFields === 'number' ? { maxNumberOfFields: node.maxNumberOfFields } : {}),
    ...(fields && fields.length > 0 ? { availableFields: fields } : {}),
  };
}

/** Fields assumed when the zone does not list its available fields: the ones Cloudflare's examples use. */
const assumedFields = new Set(['count', 'date', 'userAgent', 'clientRequestPath', 'edgeResponseStatus', 'edgeResponseBytes']);

export function fieldAvailable(settings: DatasetSettings, field: string): boolean {
  if (!settings.availableFields) return assumedFields.has(field);
  return settings.availableFields.some(entry => entry === field || entry.endsWith(`_${field}`));
}

interface Plan {
  readonly time?: 'date' | 'datetimeHour';
  readonly dimensions: readonly string[];
  readonly bytes: boolean;
  readonly sampleInterval: boolean;
  readonly requestSource: boolean;
}

function plan(settings: DatasetSettings): Plan {
  for (const field of ['userAgent', 'clientRequestPath']) {
    if (!fieldAvailable(settings, field)) throw new CloudflareError(`This zone's analytics do not expose ${field}, so crawler requests cannot be read.`);
  }
  const time = fieldAvailable(settings, 'date') ? 'date' : fieldAvailable(settings, 'datetimeHour') ? 'datetimeHour' : undefined;
  const wanted = [time, 'edgeResponseStatus', 'verifiedBotCategory', 'clientIP'].filter((field): field is string => field !== undefined && fieldAvailable(settings, field));
  const bytes = fieldAvailable(settings, 'edgeResponseBytes');
  const sampleInterval = fieldAvailable(settings, 'sampleInterval');
  // count, userAgent and clientRequestPath are always selected; the optional fields go in priority order.
  let budget = (settings.maxNumberOfFields ?? Number.POSITIVE_INFINITY) - 3;
  const dimensions = ['userAgent', 'clientRequestPath'];
  for (const field of wanted) if (budget-- > 0) dimensions.push(field);
  const withBytes = bytes && budget-- > 0;
  const withInterval = sampleInterval && budget-- > 0;
  return {
    ...(time && dimensions.includes(time) ? { time } : {}), dimensions, bytes: withBytes, sampleInterval: withInterval,
    requestSource: fieldAvailable(settings, 'requestSource'),
  };
}

interface Row {
  readonly count: number;
  readonly sum?: { readonly edgeResponseBytes?: number };
  readonly avg?: { readonly sampleInterval?: number };
  readonly dimensions: Readonly<Record<string, unknown>>;
}

function groupsQuery(id: string, limit: number, filter: Record<string, unknown>, selection: string): string {
  return `{ viewer { zones(filter: ${graphqlLiteral({ zoneTag: id })}) { httpRequestsAdaptiveGroups(limit: ${limit}, filter: ${graphqlLiteral(filter)}, orderBy: [count_DESC]) { ${selection} } } } }`;
}

function rowsOf(data: Record<string, unknown>): Row[] {
  const groups = zoneNode(data).httpRequestsAdaptiveGroups;
  if (!Array.isArray(groups)) return [];
  return groups.filter((row): row is Row => row !== null && typeof row === 'object' && typeof (row as Row).count === 'number'
    && (row as Row).dimensions !== null && typeof (row as Row).dimensions === 'object');
}

function baseFilter(from: number, to: number, plan: Plan): Record<string, unknown> {
  return { datetime_geq: time(from), datetime_lt: time(to), ...(plan.requestSource ? { requestSource: 'eyeball' } : {}) };
}

/**
 * Reads crawler requests from Cloudflare's GraphQL Analytics API, read-only: the zone's dataset limits first, then
 * requests grouped by user agent, path, status, day and, where the plan allows, client address and Cloudflare's
 * verified-bot category. Counts are adaptive-sampling estimates. When a query returns its maximum rows, the crawlers
 * are split into smaller groups and queried again.
 */
export async function fetchCloudflareActivity(options: CloudflareOptions): Promise<CloudflareData> {
  const api = new Api(options.client, options.token, options.endpoint ?? cloudflareApi, options.maxQueries ?? 120);
  const warnings: string[] = [];
  const zone = await resolveZone(api, options.zone);
  const settings = await readSettings(api, zone.id);
  if (!settings.enabled) throw new CloudflareError('The httpRequestsAdaptiveGroups dataset is not enabled for this zone.');
  const queryPlan = plan(settings);
  const end = options.end.getTime();
  const oldest = end - settings.notOlderThan * 1000 + 60_000;
  let start = options.start.getTime();
  if (start < oldest) {
    start = oldest;
    warnings.push(`Cloudflare keeps ${Math.floor(settings.notOlderThan / 86_400)} days of this data for the zone, so the window starts on ${time(start).slice(0, 10)}.`);
  }
  const sliceMs = Math.max(hourMs, Math.min(settings.maxDuration * 1000, end - start));
  let slices: Array<readonly [number, number]> = [];
  for (let from = start; from < end; from += sliceMs) slices.push([from, Math.min(from + sliceMs, end)]);
  const referralFields = fieldAvailable(settings, 'clientRefererHost');
  const taggedField = fieldAvailable(settings, 'clientRequestQuery');
  const perSlice = 1 + (referralFields ? 1 : 0) + (taggedField ? 1 : 0);
  const budget = Math.max(1, Math.floor(api.budgetLeft / perSlice));
  if (slices.length > budget) {
    slices = slices.slice(-budget);
    start = slices[0]![0];
    warnings.push(`Cloudflare allows ${Math.round(sliceMs / hourMs)} hours per query, so only the data from ${time(start).slice(0, 10)} was read.`);
  }
  const bots = options.bots ?? botDefinitions;
  const selection = [
    'count', ...(queryPlan.bytes ? ['sum { edgeResponseBytes }'] : []), ...(queryPlan.sampleInterval ? ['avg { sampleInterval }'] : []),
    `dimensions { ${queryPlan.dimensions.join(' ')} }`,
  ].join(' ');
  const observations: Observation[] = [];
  const truncatedBots = new Set<string>();
  let truncated = false;
  let intervalWeight = 0;
  let intervalSum = 0;
  const spanOf = (from: number, to: number) => (queryPlan.time === 'date' ? dayMs : queryPlan.time === 'datetimeHour' ? hourMs : to - from);

  for (const [from, to] of slices) {
    const rows = new Map<string, Row>();
    const queue: BotDefinition[][] = [[...bots]];
    while (queue.length > 0) {
      const group = queue.shift()!;
      if (api.budgetLeft <= 0) {
        truncated = true;
        for (const definition of group) truncatedBots.add(definition.id);
        continue;
      }
      const filter = { ...baseFilter(from, to, queryPlan), OR: group.flatMap(definition => definition.userAgentTokens.map(token => ({ userAgent_like: `%${token}%` }))) };
      const result = rowsOf(await api.graphql(groupsQuery(zone.id, settings.maxPageSize, filter, selection)));
      if (result.length >= settings.maxPageSize) {
        if (group.length > 1) {
          const half = Math.ceil(group.length / 2);
          queue.push(group.slice(0, half), group.slice(half));
          continue;
        }
        truncated = true;
        truncatedBots.add(group[0]!.id);
      }
      for (const row of result) rows.set(JSON.stringify(queryPlan.dimensions.map(field => row.dimensions[field] ?? null)), row);
    }
    for (const row of rows.values()) {
      const dimensions = row.dimensions;
      const timeValue = queryPlan.time === 'date' ? Date.parse(`${String(dimensions.date)}T00:00:00Z`) : queryPlan.time === 'datetimeHour' ? Date.parse(String(dimensions.datetimeHour)) : from;
      const status = typeof dimensions.edgeResponseStatus === 'number' ? dimensions.edgeResponseStatus : undefined;
      const ip = typeof dimensions.clientIP === 'string' ? normalizeIp(dimensions.clientIP) : undefined;
      const path = typeof dimensions.clientRequestPath === 'string' && dimensions.clientRequestPath.startsWith('/') ? dimensions.clientRequestPath : undefined;
      if (path === undefined || Number.isNaN(timeValue)) continue;
      if (queryPlan.sampleInterval && typeof row.avg?.sampleInterval === 'number' && Number.isFinite(row.avg.sampleInterval)) {
        intervalSum += row.avg.sampleInterval * row.count;
        intervalWeight += row.count;
      }
      observations.push({
        time: timeValue, span: spanOf(from, to), count: row.count, path,
        ...(typeof dimensions.userAgent === 'string' ? { userAgent: dimensions.userAgent } : {}),
        ...(status === undefined ? {} : { status }), ...(ip ? { ip } : {}),
        ...(queryPlan.bytes && typeof row.sum?.edgeResponseBytes === 'number' ? { bytes: row.sum.edgeResponseBytes } : {}),
        ...(queryPlan.dimensions.includes('verifiedBotCategory') ? { edgeCategory: typeof dimensions.verifiedBotCategory === 'string' ? dimensions.verifiedBotCategory.trim() : '' } : {}),
      });
    }
  }

  let referrals: CloudflareData['referrals'];
  if (referralFields || taggedField) {
    const byHost = new Map<string, number>();
    let tagged: number | undefined;
    const hosts = assistantReferrers.flatMap(entry => [entry.host, `www.${entry.host}`]);
    for (const [from, to] of slices) {
      if (referralFields && api.budgetLeft > 0) {
        const rows = rowsOf(await api.graphql(groupsQuery(zone.id, 100, { ...baseFilter(from, to, queryPlan), clientRefererHost_in: hosts }, 'count dimensions { clientRefererHost }')));
        for (const row of rows) {
          const host = typeof row.dimensions.clientRefererHost === 'string' ? row.dimensions.clientRefererHost.toLowerCase().replace(/^www\./u, '') : '';
          if (assistantReferrers.some(entry => entry.host === host)) byHost.set(host, (byHost.get(host) ?? 0) + row.count);
        }
      }
      if (taggedField && api.budgetLeft > 0) {
        const dimension = queryPlan.time ?? 'userAgent';
        const rows = rowsOf(await api.graphql(groupsQuery(zone.id, settings.maxPageSize, { ...baseFilter(from, to, queryPlan), clientRequestQuery_like: '%utm_source=chatgpt.com%' }, `count dimensions { ${dimension} }`)));
        tagged = (tagged ?? 0) + rows.reduce((sum, row) => sum + row.count, 0);
      }
    }
    referrals = { byHost, ...(tagged === undefined ? {} : { tagged }) };
  }
  if (truncated) warnings.push('Some Cloudflare queries returned their maximum rows, so rare crawlers or paths may be missing and counts are lower bounds.');
  return {
    zone, settings, start: new Date(start), end: new Date(end), observations, ...(referrals ? { referrals } : {}),
    dimensions: queryPlan.dimensions, queries: api.queries, truncatedBots: [...truncatedBots], truncated,
    ...(intervalWeight > 0 ? { sampleInterval: Math.round((intervalSum / intervalWeight) * 100) / 100 } : {}), warnings,
  };
}
