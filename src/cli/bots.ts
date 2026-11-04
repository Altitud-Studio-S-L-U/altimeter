import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SiteFacts } from '../core/facts.ts';
import { HttpClient } from '../fetch/http.ts';
import { languages, type Language } from '../i18n/messages.ts';
import type { BotActivity, IpSource, LogFormat } from '../owner/bots/activity.ts';
import { BotActivityError, collectBotActivity, type CollectBotActivityOptions, type FolderLogFile } from '../owner/bots/collect.ts';
import { jsonFieldRoles, logFormats, type JsonFields } from '../owner/bots/formats.ts';
import type { IpListOptions } from '../owner/bots/ip-ranges.ts';
import { buildBotsReport, renderBotsMarkdown } from '../owner/bots/report.ts';
import { botSiteInput, fetchSiteFacts } from '../owner/bots/site.ts';
import type { DnsResolver } from '../owner/bots/verify.ts';
import { cleanLine } from '../report/sanitize.ts';
import { runFolderName, safeFolderName } from '../report/write.ts';

export { collectBotActivity, type CollectBotActivityOptions } from '../owner/bots/collect.ts';

export const botsHelp = `Usage:
  altimeter bots [--cloudflare-zone <domain>] [--logs <file>]... [--days 30] [--out <dir>] [--lang en|es|ca]

Shows which crawlers really fetch the site, each request verified against its operator's published IP list or
reverse DNS, and compares them with robots.txt and the sitemaps. Writes bots.json and bots.md.

Options:
  --cloudflare-zone <domain>  Read Cloudflare GraphQL Analytics for the zone (read-only token in ALTIMETER_CLOUDFLARE_API_TOKEN,
                              with Zone > Analytics > Read and Zone > Zone > Read). Counts are sampled estimates.
  --logs <file|dir>           Access logs, plain or gzip; repeat it, or list more files after the options. A folder means its files,
                              skipping with a warning those that are empty or not access logs.
  --log-format <name>         combined, common, nginx-json, iis, cloudfront, alb, cloudflare, vercel or netlify (default: detected).
  --ip-source <source>        Client address in server logs: remote (default), xff-last (last X-Forwarded-For entry, right behind
                              one trusted proxy) or xff-first (first entry, forgeable by clients; only when every hop is trusted).
  --json-fields <map>         Field names of a JSON log, e.g. time=ts,ip=client,path=uri,userAgent=agent,status=code.
  --site <url>                The site whose robots.txt and sitemaps are compared (default https://<zone>/).
  --robots-since <date>       When the current robots.txt took effect, if its Last-Modified header is wrong.
  --days <n>                  Window ending now, 1 to 400 days (default 30).
  --no-dns                    Skip reverse DNS checks; crawlers that need them stay unverified.
  --out <dir>                 Parent folder for the output (default ./altimeter-report).
  --lang <en|es|ca>           Language of bots.md (default en).
  --allow-private-network     Allow private and loopback addresses for --site, for local or staging sites.
  --quiet                     Print only the output folder.
`;

/** A wrong option; its message is safe to print. */
export class BotsUsageError extends Error {}

/** Dependencies tests replace; the command line uses the defaults. */
export interface BotsCommandContext {
  readonly client?: HttpClient;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  readonly dns?: DnsResolver;
  readonly ipLists?: Omit<IpListOptions, 'client' | 'now'>;
  readonly cloudflareEndpoint?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

function parseJsonFields(value: string): JsonFields {
  const fields: Record<string, string> = {};
  for (const pair of value.split(',').map(entry => entry.trim()).filter(Boolean)) {
    const [role, name, ...rest] = pair.split('=');
    if (rest.length > 0 || !role || !name || !(jsonFieldRoles as readonly string[]).includes(role) || !/^[A-Za-z0-9_@.-]{1,80}$/u.test(name)) {
      throw new BotsUsageError(`--json-fields takes role=field pairs; roles are ${jsonFieldRoles.join(', ')}.`);
    }
    fields[role] = name;
  }
  return fields as JsonFields;
}

/**
 * The files named by --logs: a folder means the files in it, which are skipped when they are not access logs; a
 * missing path is a usage error. A file named itself is checked strictly, even when a folder given too holds it.
 */
export async function logFiles(paths: readonly string[]): Promise<Array<string | FolderLogFile>> {
  const files = new Map<string, string | FolderLogFile>();
  for (const path of paths) {
    const absolute = resolve(path);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new BotsUsageError(`${cleanLine(path, 200)} does not exist.`);
    }
    if (info.isDirectory()) {
      const entries = (await readdir(absolute, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
      if (entries.length === 0) throw new BotsUsageError(`${cleanLine(path, 200)} holds no file.`);
      for (const file of entries.map(name => join(absolute, name))) if (!files.has(file)) files.set(file, { path: file, inFolder: true });
    } else {
      files.set(absolute, absolute);
    }
  }
  return [...files.values()];
}

function siteOrigin(site: string | undefined, zone: string | undefined): string | undefined {
  if (site !== undefined) {
    let url: URL;
    try {
      url = new URL(site);
    } catch {
      throw new BotsUsageError('--site must be an absolute URL, for example https://example.com/.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BotsUsageError('--site must be an http or https URL.');
    return url.origin;
  }
  if (zone !== undefined && !/^[0-9a-f]{32}$/iu.test(zone.trim())) {
    try {
      return new URL(`https://${zone.trim().replace(/\.$/u, '')}/`).origin;
    } catch {
      throw new BotsUsageError('--cloudflare-zone must be a domain name or a zone ID.');
    }
  }
  return undefined;
}

function summary(activity: BotActivity): string[] {
  const lines: string[] = [];
  for (const bot of activity.bots.slice(0, 12)) {
    const counts = !bot.verifiable && bot.verified.hits === 0
      ? `${Math.round(bot.unverified.hits)} claimed, no published check`
      : `${Math.round(bot.verified.hits)} verified, ${Math.round(bot.unverified.hits)} unverified, ${Math.round(bot.spoofed.hits)} spoofed`;
    lines.push(`  ${bot.name} (${bot.operator}, ${bot.purpose}): ${counts}${activity.sampled ? ' (estimates)' : ''}`);
  }
  return lines;
}

/** `altimeter bots`: reads crawler activity, evaluates the crawler rules and writes bots.json and bots.md. */
export async function botsCommand(args: string[], context: BotsCommandContext = {}): Promise<number> {
  const out = context.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = context.stderr ?? ((text: string) => void process.stderr.write(text));
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      'cloudflare-zone': { type: 'string' }, logs: { type: 'string', multiple: true }, days: { type: 'string' }, out: { type: 'string' }, lang: { type: 'string' },
      site: { type: 'string' }, 'log-format': { type: 'string' }, 'ip-source': { type: 'string' }, 'json-fields': { type: 'string' },
      'robots-since': { type: 'string' }, 'no-dns': { type: 'boolean' }, 'allow-private-network': { type: 'boolean' }, quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    out(botsHelp);
    return 0;
  }
  const language = (values.lang ?? 'en') as Language;
  if (!languages.includes(language)) throw new BotsUsageError('--lang must be en, es or ca.');
  const days = values.days === undefined ? 30 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new BotsUsageError('--days must be a whole number from 1 to 400.');
  const format = values['log-format'] as LogFormat | undefined;
  if (format !== undefined && !logFormats.includes(format)) throw new BotsUsageError(`--log-format must be one of ${logFormats.join(', ')}.`);
  const ipSource = values['ip-source'] as IpSource | undefined;
  if (ipSource !== undefined && !['remote', 'xff-first', 'xff-last'].includes(ipSource)) throw new BotsUsageError('--ip-source must be remote, xff-first or xff-last.');
  const robotsSince = values['robots-since'];
  if (robotsSince !== undefined && (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/u.test(robotsSince) || Number.isNaN(Date.parse(robotsSince)))) {
    throw new BotsUsageError('--robots-since must be a date such as 2026-10-01.');
  }
  const jsonFields = values['json-fields'] === undefined ? undefined : parseJsonFields(values['json-fields']);
  const zone = values['cloudflare-zone'];
  const files = await logFiles([...(values.logs ?? []), ...positionals]);
  if (files.length === 0 && zone === undefined) throw new BotsUsageError('bots needs --cloudflare-zone or --logs. Run "altimeter bots --help".');
  const origin = siteOrigin(values.site, zone);
  const quiet = values.quiet === true;
  const log = quiet ? undefined : (message: string) => err(`· ${cleanLine(message)}\n`);
  const client = context.client ?? new HttpClient(values['allow-private-network'] ? { policy: { allowPrivate: true } } : {});
  try {
    let site: SiteFacts | undefined;
    let siteWarnings: readonly string[] = [];
    if (origin) {
      log?.(`Reading robots.txt and the sitemaps of ${cleanLine(origin, 200)}`);
      ({ site, warnings: siteWarnings } = await fetchSiteFacts(client, origin));
    } else {
      log?.('No --site given: robots.txt and sitemaps are not compared.');
    }
    const options: CollectBotActivityOptions = {
      logs: files, days, client, ...(context.now ? { now: context.now } : {}), ...(context.env ? { env: context.env } : {}),
      ...(zone ? { cloudflare: { zone, ...(context.cloudflareEndpoint ? { endpoint: context.cloudflareEndpoint } : {}) } } : {}),
      ...(site ? { site: botSiteInput(site) } : {}), ...(format ? { format } : {}), ...(ipSource ? { ipSource } : {}), ...(jsonFields ? { jsonFields } : {}),
      ...(robotsSince ? { robotsSince } : {}), dns: values['no-dns'] ? false : (context.dns ?? true),
      ...(context.ipLists ? { ipLists: context.ipLists } : {}), ...(log ? { log } : {}),
    };
    let activity: BotActivity;
    try {
      activity = await collectBotActivity(options);
    } catch (error) {
      if (error instanceof BotActivityError) throw new BotsUsageError(error.message);
      throw error;
    }
    // Sitemaps left unread limit the coverage figures, so their warnings go into bots.json and bots.md with the rest.
    activity = { ...activity, warnings: [...siteWarnings, ...activity.warnings] };
    const report = buildBotsReport(activity, site);
    const base = resolve(values.out ?? 'altimeter-report');
    const directory = join(base, safeFolderName(origin ? new URL(origin).host : 'logs'), `${runFolderName(new Date(activity.fetchedAt))}-bots`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'bots.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(directory, 'bots.md'), renderBotsMarkdown(report, language), 'utf8');
    const shown = relative(process.cwd(), directory) || '.';
    if (quiet) {
      out(`${shown}\n`);
    } else {
      const failures = report.findings.filter(finding => finding.outcome === 'fail').length;
      out([
        `\nCrawler activity from ${activity.window.start.slice(0, 10)} to ${activity.window.end.slice(0, 10)}${activity.sampled ? ' (Cloudflare counts are estimates)' : ''}`,
        ...(activity.bots.length > 0 ? summary(activity) : ['  No request from a known crawler.']),
        `${failures} finding(s) · ${shown}${process.platform === 'win32' ? '\\' : '/'}bots.md`, '',
      ].join('\n'));
      for (const warning of activity.warnings) err(`! ${cleanLine(warning, 400)}\n`);
    }
    return 0;
  } finally {
    if (!context.client) await client.close();
  }
}
