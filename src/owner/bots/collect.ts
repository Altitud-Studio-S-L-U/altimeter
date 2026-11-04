import { basename } from 'node:path';
import { HttpClient } from '../../fetch/http.ts';
import { cleanLine } from '../../report/sanitize.ts';
import type { BotActivity, CloudflareSourceSummary, IpSource, LogFormat, LogSourceSummary } from './activity.ts';
import { BotAggregator, type Observation } from './aggregate.ts';
import { CloudflareError, fetchCloudflareActivity, type CloudflareData } from './cloudflare.ts';
import { createParser, detectFormat, type JsonFields, type LogRecord } from './formats.ts';
import { listContains, loadIpLists, type IpListOptions, type LoadedIpList } from './ip-ranges.ts';
import { readLogLines } from './lines.ts';
import { assistantReferrers, botById, ipListDefinitions, isVerifiable, matchBot, proxyListIds, robotsOnlyTokens, type BotDefinition, type IpListId } from './operators.ts';
import type { BotSiteInput } from './site.ts';
import { dnsApplies, matchingList, reverseDns, systemResolver, usableAddress, verifyClaim, type DnsResolver, type ReverseDnsResult, type VerificationContext, type VerificationOutcome } from './verify.ts';

/** A problem with the inputs, such as a missing token or an unreadable file; its message is safe to print. */
export class BotActivityError extends Error {}

/** A log file found by listing a folder rather than named itself. */
export interface FolderLogFile {
  readonly path: string;
  readonly inFolder: true;
}

export interface CollectBotActivityOptions {
  /**
   * Access log files, plain or gzip, in any supported format. A file named itself must be in a format that can be
   * recognised; one found in a folder is skipped with a warning when it is not, and an empty file is skipped either way.
   */
  readonly logs?: readonly (string | FolderLogFile)[];
  /** Cloudflare GraphQL Analytics for a zone, with the token from ALTIMETER_CLOUDFLARE_API_TOKEN unless one is given. */
  readonly cloudflare?: { readonly zone: string; readonly token?: string; readonly endpoint?: string; readonly maxQueries?: number };
  /** Days before `now` the window covers (default 30). */
  readonly days?: number;
  readonly now?: Date;
  /** The site's robots.txt and sitemap URLs, for coverage and compliance. */
  readonly site?: BotSiteInput;
  /** The log format; detected from each file's first lines when omitted. */
  readonly format?: LogFormat;
  /** Where server logs keep the client address (default `remote`). */
  readonly ipSource?: IpSource;
  readonly jsonFields?: JsonFields;
  /** When the current robots.txt took effect (an ISO date), when the owner knows it better than its Last-Modified header. */
  readonly robotsSince?: string;
  /** Reverse DNS checks: on with the system resolver by default, off with false, or through the given resolver. */
  readonly dns?: boolean | DnsResolver;
  /** Distinct addresses looked up in reverse DNS per run (default 400, a tool convention). */
  readonly maxDnsLookups?: number;
  /** A guarded client for the address lists and Cloudflare; one with the public-only policy is made when omitted. */
  readonly client?: HttpClient;
  readonly ipLists?: Omit<IpListOptions, 'client' | 'now'>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (message: string) => void;
}

const dayMs = 86_400_000;
/** Records up to a day after the window end are kept: clocks and time zones of log writers drift. */
const futureToleranceMs = dayMs;
const maxTrackedAddresses = 100_000;
const maxSeenRequestIds = 100_000;
/** A log whose requests come from one or two addresses records a proxy, not clients (tool convention). */
const proxyShare = 0.95;
const proxyMinimumRecords = 200;
const formatsWithReferer: ReadonlySet<LogFormat> = new Set(['combined', 'cloudfront', 'cloudflare', 'vercel', 'netlify']);
const clientAddressFormats: ReadonlySet<LogFormat> = new Set(['alb', 'cloudflare', 'vercel', 'netlify']);

interface FileScan {
  readonly path: string;
  readonly name: string;
  readonly format: LogFormat;
  lines: number;
  records: number;
  malformed: number;
  readonly skipped: Map<string, number>;
  first: number | undefined;
  last: number | undefined;
  readonly fields: { userAgent: boolean; clientIp: boolean; referer: boolean; host: boolean; bytes: boolean };
  /** Claimed crawler requests by crawler and address, for the reverse DNS queue. */
  readonly claims: Map<string, Map<string, number>>;
  proxySuspected: boolean;
  readonly warnings: string[];
}

/** The format of a file from its first lines, and whether it holds nothing but blank lines. */
async function detect(path: string): Promise<{ readonly format: LogFormat | undefined; readonly empty: boolean }> {
  const sample: string[] = [];
  let empty = true;
  for await (const event of readLogLines(path)) {
    if (!('line' in event) || event.line.trim() !== '') empty = false;
    if ('line' in event && event.line.trim() !== '') sample.push(event.line);
    if (sample.length >= 50 || 'error' in event) break;
  }
  return { format: detectFormat(sample), empty };
}

/** Reads one file's records within the window, calling `each` for every record that is not a duplicate. */
async function readRecords(scan: FileScan, options: CollectBotActivityOptions, window: { start: number; end: number }, each: (record: LogRecord) => void, count: boolean): Promise<void> {
  const parser = createParser(scan.format, { ...(options.ipSource ? { ipSource: options.ipSource } : {}), ...(options.jsonFields ? { jsonFields: options.jsonFields } : {}) });
  const seen = new Set<string>();
  const skipped = (reason: string) => {
    if (count) scan.skipped.set(reason, (scan.skipped.get(reason) ?? 0) + 1);
  };
  for await (const event of readLogLines(scan.path)) {
    if ('error' in event) {
      if (count) scan.warnings.push(`${scan.name}: reading stopped early (${cleanLine(event.error, 120)}).`);
      break;
    }
    if ('tooLong' in event) {
      if (count) scan.malformed += 1;
      continue;
    }
    if (event.line.trim() === '') continue;
    if (count) scan.lines += 1;
    const parsed = parser.parse(event.line);
    if (parsed.kind === 'directive') continue;
    if (parsed.kind === 'skip') {
      skipped(parsed.reason);
      continue;
    }
    if (parsed.kind === 'malformed') {
      if (count) scan.malformed += 1;
      continue;
    }
    for (const record of parsed.records) {
      if (record.time < window.start || record.time > window.end + futureToleranceMs) {
        skipped('outside-window');
        continue;
      }
      if (record.requestId !== undefined) {
        if (seen.has(record.requestId)) {
          skipped('duplicate');
          continue;
        }
        if (seen.size < maxSeenRequestIds) seen.add(record.requestId);
      }
      if (count) {
        scan.records += 1;
        if (scan.first === undefined || record.time < scan.first) scan.first = record.time;
        if (scan.last === undefined || record.time > scan.last) scan.last = record.time;
        if (record.userAgent) scan.fields.userAgent = true;
        if (record.ip) scan.fields.clientIp = true;
        if (record.referer) scan.fields.referer = true;
        if (record.host) scan.fields.host = true;
        if (record.bytes !== undefined) scan.fields.bytes = true;
      }
      each(record);
    }
  }
}

/** Runs a file operation, turning a file that cannot be opened into an input error. */
async function guarded<T>(name: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^E[A-Z]+$/u.test(code)) throw new BotActivityError(`${name} could not be read (${code}).`);
    throw error;
  }
}

/**
 * First pass over a file: counts, fields, claimed crawler addresses and whether the addresses look like a proxy's.
 * For a file it skips, it returns the warning that says why.
 */
async function scanFile(path: string, inFolder: boolean, options: CollectBotActivityOptions, window: { start: number; end: number }): Promise<FileScan | string> {
  const name = cleanLine(basename(path), 120);
  let format = options.format;
  if (!format) {
    const detected = await guarded(name, () => detect(path));
    if (detected.empty) return `${name} is empty, so it was skipped.`;
    if (!detected.format && inFolder) return `The format of ${name} was not recognised, so it was skipped.`;
    if (!detected.format) throw new BotActivityError(`The format of ${name} was not recognised. Supported formats are combined, common, nginx-json, iis, cloudfront, alb, cloudflare, vercel and netlify; "altimeter bots --log-format" reads a file in one of them that is not detected.`);
    format = detected.format;
  }
  const scan: FileScan = {
    path, name, format, lines: 0, records: 0, malformed: 0, skipped: new Map(), first: undefined, last: undefined,
    fields: { userAgent: false, clientIp: false, referer: false, host: false, bytes: false }, claims: new Map(), proxySuspected: false, warnings: [],
  };
  const addresses = new Map<string, number>();
  let tracked = 0;
  let withAddress = 0;
  await guarded(name, () => readRecords(scan, options, window, record => {
    if (record.ip === undefined) return;
    withAddress += 1;
    if (addresses.has(record.ip) || addresses.size < maxTrackedAddresses) addresses.set(record.ip, (addresses.get(record.ip) ?? 0) + 1);
    const definition = matchBot(record.userAgent);
    if (!definition || !isVerifiable(definition)) return;
    const byAddress = scan.claims.get(definition.id) ?? new Map<string, number>();
    if (byAddress.has(record.ip) || tracked < maxTrackedAddresses) {
      if (!byAddress.has(record.ip)) tracked += 1;
      byAddress.set(record.ip, (byAddress.get(record.ip) ?? 0) + 1);
      scan.claims.set(definition.id, byAddress);
    }
  }, true));
  const top = [...addresses.values()].sort((a, b) => b - a).slice(0, 2).reduce((sum, value) => sum + value, 0);
  if (!clientAddressFormats.has(format) && withAddress >= proxyMinimumRecords && top / withAddress >= proxyShare) {
    scan.proxySuspected = true;
    scan.warnings.push(`${name}: ${Math.round((top / withAddress) * 100)}% of its requests come from one or two addresses, which looks like a proxy or load balancer, so its addresses were not used to verify crawlers. Log the client address and pass --ip-source.`);
  }
  if (format === 'common') scan.warnings.push(`${name} uses the Common Log Format, which has no user agent, so crawlers cannot be identified in it.`);
  else if (scan.records > 0 && !scan.fields.userAgent) {
    scan.warnings.push(`${name} records no user agent${format === 'netlify' ? ' (Netlify removes client_ip and user_agent when PII is excluded)' : ''}, so crawlers cannot be identified in it.`);
  }
  if (options.ipSource && options.ipSource !== 'remote' && clientAddressFormats.has(format)) {
    scan.warnings.push(`${name} (${format}) records the client address itself; --ip-source applies to server logs only.`);
  }
  return scan;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function effectiveFrom(options: CollectBotActivityOptions, windowStart: number, now: number): { time: number; source: 'owner' | 'last-modified' | 'assumed' } {
  const owner = options.robotsSince === undefined ? Number.NaN : Date.parse(options.robotsSince);
  if (Number.isFinite(owner) && owner <= now) return { time: owner, source: 'owner' };
  const modified = options.site?.robots?.lastModified === undefined ? Number.NaN : Date.parse(options.site.robots.lastModified);
  if (Number.isFinite(modified) && modified <= now) return { time: modified, source: 'last-modified' };
  return { time: windowStart, source: 'assumed' };
}

/**
 * Reads crawler activity from access logs and Cloudflare analytics, verifies each claimed crawler against its
 * operator's published checks and compares the requests with the site's robots.txt and sitemaps. Log files are read
 * twice as streams (to collect the addresses to check, then to count), so memory stays bounded whatever their size.
 */
export async function collectBotActivity(options: CollectBotActivityOptions): Promise<BotActivity> {
  const logs = options.logs ?? [];
  if (logs.length === 0 && !options.cloudflare) throw new BotActivityError('Give access logs or a Cloudflare zone to read crawler activity from.');
  const now = options.now ?? new Date();
  const days = options.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new BotActivityError('The window must be a whole number of days from 1 to 400.');
  const end = now.getTime();
  const window = { start: end - days * dayMs, end };
  const log = options.log ?? (() => {});
  const warnings: string[] = [];
  const client = options.client ?? new HttpClient();
  try {
    let cloudflare: CloudflareData | undefined;
    if (options.cloudflare) {
      const token = options.cloudflare.token ?? (options.env ?? process.env).ALTIMETER_CLOUDFLARE_API_TOKEN;
      if (!token || token.trim() === '') throw new BotActivityError('Set ALTIMETER_CLOUDFLARE_API_TOKEN to a read-only Cloudflare API token (Zone > Analytics > Read) to read Cloudflare analytics.');
      log(`Reading Cloudflare analytics for ${cleanLine(options.cloudflare.zone, 100)}`);
      try {
        cloudflare = await fetchCloudflareActivity({
          client, token: token.trim(), zone: options.cloudflare.zone, start: new Date(window.start), end: now,
          ...(options.cloudflare.endpoint ? { endpoint: options.cloudflare.endpoint } : {}), ...(options.cloudflare.maxQueries ? { maxQueries: options.cloudflare.maxQueries } : {}),
        });
      } catch (error) {
        if (error instanceof CloudflareError) throw new BotActivityError(error.message);
        throw error;
      }
      warnings.push(...cloudflare.warnings);
    }

    const scans: FileScan[] = [];
    for (const entry of logs) {
      const path = typeof entry === 'string' ? entry : entry.path;
      log(`Reading ${cleanLine(basename(path), 120)}`);
      const scan = await scanFile(path, typeof entry !== 'string', options, window);
      if (typeof scan === 'string') warnings.push(scan);
      else scans.push(scan);
    }
    if (cloudflare && scans.length > 0) warnings.push('Cloudflare analytics and access logs may count the same requests twice.');
    for (const scan of scans) warnings.push(...scan.warnings);

    // Only the lists of crawlers whose claims carry an address that a list could verify are downloaded.
    const claimed = new Set<string>();
    for (const scan of scans) for (const id of scan.claims.keys()) claimed.add(id);
    for (const observation of cloudflare?.observations ?? []) {
      const definition = matchBot(observation.userAgent);
      if (definition && observation.ip && !observation.edgeCategory) claimed.add(definition.id);
    }
    const listIds = new Set<IpListId>();
    for (const id of claimed) for (const list of botById(id)?.checks.lists ?? []) listIds.add(list);
    const serverLogs = scans.some(scan => scan.fields.clientIp && !clientAddressFormats.has(scan.format));
    if (serverLogs) for (const id of proxyListIds) listIds.add(id);
    const lists = listIds.size === 0 ? new Map<IpListId, LoadedIpList>() : await loadIpLists(listIds, { client, now, ...options.ipLists });
    for (const list of lists.values()) {
      const proxy = ipListDefinitions[list.id].scope === 'proxy';
      if (list.from === 'unavailable' && proxy) warnings.push(`The address list ${list.id} could not be read (${cleanLine(list.error ?? 'unknown error', 120)}); a log that records Cloudflare's addresses cannot be recognised.`);
      else if (list.from === 'unavailable') warnings.push(`The address list ${list.id} could not be read (${cleanLine(list.error ?? 'unknown error', 120)}); requests it would verify stay unverified.`);
      else if (list.from === 'stale-cache') warnings.push(`The address list ${list.id} could not be refreshed (${cleanLine(list.error ?? 'unknown error', 120)}); the cached copy from ${list.fetchedAt ?? 'an earlier run'} was used.`);
    }
    const proxies = proxyListIds.map(id => lists.get(id)).filter((entry): entry is LoadedIpList => entry !== undefined && entry.prefixes > 0);
    const botLists = new Map([...lists].filter(([id]) => ipListDefinitions[id].scope !== 'proxy'));

    const dnsEnabled = options.dns !== false;
    const resolver = typeof options.dns === 'object' ? options.dns : systemResolver();
    const dnsResults = new Map<string, ReverseDnsResult>();
    let lookups = 0;
    let dnsErrors = 0;
    let capped = false;
    if (dnsEnabled) {
      const candidates = new Map<string, { hits: number; suffixes: Set<string> }>();
      const consider = (definition: BotDefinition, address: string, hits: number) => {
        if (!dnsApplies(definition, address) || !usableAddress(address) || proxies.some(list => listContains(list, address))) return;
        if (matchingList(definition, address, botLists)) return;
        const entry = candidates.get(address) ?? { hits: 0, suffixes: new Set<string>() };
        entry.hits += hits;
        for (const suffix of definition.checks.dnsSuffixes) entry.suffixes.add(suffix);
        candidates.set(address, entry);
      };
      for (const scan of scans) {
        if (scan.proxySuspected) continue;
        for (const [id, addresses] of scan.claims) {
          const definition = botById(id)!;
          for (const [address, hits] of addresses) consider(definition, address, hits);
        }
      }
      for (const observation of cloudflare?.observations ?? []) {
        const definition = matchBot(observation.userAgent);
        if (definition && observation.ip && !observation.edgeCategory) consider(definition, observation.ip, observation.count);
      }
      const limit = options.maxDnsLookups ?? 400;
      const queue = [...candidates].sort((a, b) => b[1].hits - a[1].hits);
      capped = queue.length > limit;
      if (queue.length > 0) log(`Checking ${Math.min(queue.length, limit)} crawler addresses in reverse DNS`);
      const results = await mapLimit(queue.slice(0, limit), 10, async ([address, entry]) => [address, await reverseDns(resolver, address, [...entry.suffixes])] as const);
      for (const [address, result] of results) {
        lookups += 1;
        if (result.kind === 'error') dnsErrors += 1;
        dnsResults.set(address, result);
      }
      if (capped) warnings.push(`Reverse DNS was limited to the ${limit} busiest addresses; requests from the others stay unverified when their lists do not verify them.`);
    }

    const context: VerificationContext = { lists: botLists, proxies, dnsEnabled, dns: dnsResults };
    const discarded = new Map<string, number>();
    const discard = (reason: string, count: number) => discarded.set(reason, (discarded.get(reason) ?? 0) + count);
    let claims = 0;
    let checkable = 0;
    // Set while reading a file whose addresses look like a proxy's: its claims are not checked against the lists.
    let suspected = false;
    const memo = new Map<string, VerificationOutcome>();
    const check = (definition: BotDefinition, observation: Observation): VerificationOutcome => {
      claims += observation.count;
      if (suspected && observation.ip !== undefined && !observation.edgeCategory) {
        discard('proxy-suspected', observation.count);
        return { verdict: 'unverified', reason: 'proxy-suspected' };
      }
      const key = `${definition.id}|${observation.ip ?? ''}|${observation.edgeCategory ?? '-'}`;
      let outcome = memo.get(key);
      if (!outcome) {
        outcome = verifyClaim(definition, observation.ip, observation.edgeCategory, context);
        if (memo.size < 200_000) memo.set(key, outcome);
      }
      if (outcome.verdict === 'unverified' && (outcome.reason === 'private-address' || outcome.reason === 'proxy-address')) discard(outcome.reason, observation.count);
      else if (outcome.verdict !== 'unverified' || (observation.ip !== undefined && isVerifiable(definition))) checkable += observation.count;
      return outcome;
    };
    const site = options.site;
    const host = site ? new URL(site.origin).hostname.toLowerCase() : undefined;
    const robotsStart = effectiveFrom(options, window.start, end);
    const aggregator = new BotAggregator({
      ...(site ? { site: {
        ...(host ? { host } : {}), sitemapUrls: site.sitemapUrls,
        ...(site.robots ? { robots: { file: site.robots.file, effectiveFrom: robotsStart.time } } : {}),
      } } : {}),
      verify: check,
    });

    for (const scan of scans) {
      suspected = scan.proxySuspected;
      await guarded(scan.name, () => readRecords(scan, options, window, record => aggregator.add({ ...record, count: 1, span: 0 }), false));
    }
    suspected = false;
    for (const observation of cloudflare?.observations ?? []) aggregator.add(observation);
    if (cloudflare?.referrals) {
      let byReferrer = 0;
      for (const [hostName, visits] of cloudflare.referrals.byHost) {
        aggregator.addReferrals(hostName, assistantReferrers.find(entry => entry.host === hostName)?.assistant ?? hostName, visits);
        byReferrer += visits;
      }
      if (cloudflare.referrals.tagged !== undefined) aggregator.addTagged(cloudflare.referrals.tagged);
      aggregator.addReferred(Math.max(byReferrer, cloudflare.referrals.tagged ?? 0));
    }
    for (const id of cloudflare?.truncatedBots ?? []) aggregator.markTruncated(id);
    const result = aggregator.finish(end);

    for (const reason of ['private-address', 'proxy-address'] as const) {
      const count = discarded.get(reason) ?? 0;
      if (count === 0) continue;
      const one = count === 1;
      warnings.push(reason === 'private-address'
        ? `${count} crawler ${one ? 'request carries a private or loopback address' : 'requests carry private or loopback addresses'}, so the logs record a proxy or load balancer; log the client address and pass --ip-source.`
        : `${count} crawler ${one ? 'request comes' : 'requests come'} from Cloudflare's own addresses, so the logs record Cloudflare rather than the client; log CF-Connecting-IP and pass --ip-source.`);
    }
    if (scans.length > 0 && scans.every(scan => scan.records === 0)) {
      const covered = scans.filter(scan => scan.lines > 0).map(scan => scan.name);
      warnings.push(`No request falls within the window (${new Date(window.start).toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)})${covered.length > 0 ? `; check the dates of ${covered.join(', ')}` : ''}.`);
    }
    if (cloudflare && cloudflare.observations.length === 0) warnings.push('Cloudflare reported no request from a known crawler in the window.');

    const sources: Array<LogSourceSummary | CloudflareSourceSummary> = scans.map(scan => ({
      kind: 'access-log', file: scan.name, format: scan.format, lines: scan.lines, records: scan.records, malformed: scan.malformed,
      skipped: Object.fromEntries(scan.skipped), ...(scan.first === undefined ? {} : { firstRecord: new Date(scan.first).toISOString() }),
      ...(scan.last === undefined ? {} : { lastRecord: new Date(scan.last).toISOString() }), fields: { ...scan.fields },
    }));
    if (cloudflare) {
      sources.push({
        kind: 'cloudflare-graphql', zone: cloudflare.zone.name, dataset: 'httpRequestsAdaptiveGroups', sampled: true, queries: cloudflare.queries,
        dimensions: cloudflare.dimensions, truncated: cloudflare.truncated, ...(cloudflare.sampleInterval === undefined ? {} : { sampleInterval: cloudflare.sampleInterval }),
      });
    }
    const referrersRecorded = scans.some(scan => formatsWithReferer.has(scan.format) || scan.fields.referer) || cloudflare?.referrals !== undefined;
    const windowStart = cloudflare && cloudflare.start.getTime() > window.start && scans.length === 0 ? cloudflare.start.getTime() : window.start;
    return {
      fetchedAt: now.toISOString(),
      window: {
        start: new Date(windowStart).toISOString(), end: now.toISOString(), days,
        ...(result.firstRecord ? { firstRecord: result.firstRecord } : {}), ...(result.lastRecord ? { lastRecord: result.lastRecord } : {}),
      },
      sources, sampled: cloudflare !== undefined,
      clientIp: { source: options.ipSource ?? 'remote', claims, checkable, discarded: Object.fromEntries(discarded) },
      ipLists: [...lists.values()].map(({ blocks: _blocks, ...status }) => status).sort((a, b) => a.id.localeCompare(b.id)),
      dns: { enabled: dnsEnabled, lookups, errors: dnsErrors, capped },
      ...(site ? { site: {
        origin: site.origin, sitemapUrls: aggregator.sitemapUrls,
        ...(site.robots ? { robots: { url: site.robots.url, effectiveFrom: new Date(robotsStart.time).toISOString(), effectiveFromSource: robotsStart.source } } : {}),
      } } : {}),
      bots: result.bots,
      notObservable: robotsOnlyTokens.map(({ name, token, operator }) => ({ name, token, operator })),
      ...(referrersRecorded ? { referrals: result.referrals } : {}),
      warnings: [...new Set(warnings)],
    };
  } finally {
    if (!options.client) await client.close();
  }
}
