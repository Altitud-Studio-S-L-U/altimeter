/**
 * Helpers for crawler activity tests: the dated list snapshot served from a loopback server, a scripted DNS resolver
 * and builders for activity summaries.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { BotActivity, BotSummary, RequestTally } from '../../src/owner/bots/activity.ts';
import { HttpClient } from '../../src/fetch/http.ts';
import { ipListDefinitions, type IpListId } from '../../src/owner/bots/operators.ts';
import type { DnsResolver } from '../../src/owner/bots/verify.ts';

export const fixtureDirectory = fileURLToPath(new URL('../fixtures/bots/', import.meta.url));
export const logFixture = (name: string) => fileURLToPath(new URL(`../fixtures/bots/logs/${name}`, import.meta.url));

/** The moment the fixtures are read at: their window of 30 days starts on 2026-10-05 at noon. */
export const now = new Date('2026-11-04T12:00:00Z');

export const loopbackClient = () => new HttpClient({ policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) } });

/** Serves the list snapshot under /lists/<id>, counting requests; ids without a fixture answer 404. */
export async function listServer(): Promise<{ server: Server; base: string; urls: Partial<Record<IpListId, string>>; requests: string[]; close(): Promise<void> }> {
  const files = new Map(readdirSync(new URL('../fixtures/bots/ip-lists/', import.meta.url)).map(name => [name.replace(/\.(json|html|txt)$/u, ''), name]));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const id = (request.url ?? '').replace(/^\/lists\//u, '');
    requests.push(id);
    const file = files.get(id);
    if (!file) return void response.writeHead(404).end('missing');
    const type = file.endsWith('.json') ? 'application/json' : file.endsWith('.html') ? 'text/html' : 'text/plain';
    response.writeHead(200, { 'content-type': type }).end(readFileSync(new URL(`../fixtures/bots/ip-lists/${file}`, import.meta.url)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const urls = Object.fromEntries(Object.keys(ipListDefinitions).map(id => [id, `${base}/lists/${id}`])) as Partial<Record<IpListId, string>>;
  return {
    server, base, urls, requests,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const notFound = () => Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });

/** A resolver that answers from fixed records and records every lookup; unknown names have no record. */
export function scriptedResolver(reverse: Readonly<Record<string, readonly string[] | Error>>, forward: Readonly<Record<string, readonly string[]>>): DnsResolver & { readonly lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async reverse(address) {
      lookups.push(`ptr ${address}`);
      const entry = reverse[address];
      if (entry instanceof Error) throw entry;
      if (!entry) throw notFound();
      return [...entry];
    },
    async resolve(hostname, family) {
      lookups.push(`a${family} ${hostname}`);
      const entry = forward[hostname];
      if (!entry) throw notFound();
      return [...entry];
    },
  };
}

export function tally(overrides: Partial<RequestTally> = {}): RequestTally {
  return { hits: 0, bytes: 0, activeDays: 0, statuses: {}, challenges: 0, ...overrides };
}

/** A crawler summary with nothing counted; give the fields a test is about. */
export function botSummary(overrides: Partial<BotSummary> & Pick<BotSummary, 'id' | 'name' | 'operator' | 'purpose' | 'token'>): BotSummary {
  return {
    verifiable: true, basis: 'verified', verified: tally(), unverified: tally(), spoofed: tally(), verifiedBy: {}, unverifiedReasons: {},
    robotsTxt: 0, llmsTxt: 0, scripts: 0, stylesheets: 0, paths: { distinct: 0, capped: false, top: [] }, truncated: false, ...overrides,
  };
}

/** Thirty days of log data from one access log with user agents and client addresses, ending at `now`. */
export function activity(overrides: Partial<BotActivity> = {}): BotActivity {
  return {
    fetchedAt: now.toISOString(),
    window: { start: '2026-10-05T12:00:00.000Z', end: now.toISOString(), days: 30, firstRecord: '2026-10-05T13:00:00.000Z', lastRecord: '2026-11-04T10:00:00.000Z' },
    sources: [{
      kind: 'access-log', file: 'access.log', format: 'combined', lines: 100, records: 100, malformed: 0, skipped: {},
      fields: { userAgent: true, clientIp: true, referer: true, host: false, bytes: true },
    }],
    sampled: false,
    clientIp: { source: 'remote', claims: 0, checkable: 0, discarded: {} },
    ipLists: [], dns: { enabled: true, lookups: 0, errors: 0, capped: false },
    site: { origin: 'https://example.com', sitemapUrls: 4, robots: { url: 'https://example.com/robots.txt', effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveFromSource: 'last-modified' } },
    bots: [], notObservable: [{ name: 'Google-Extended', token: 'google-extended', operator: 'Google' }, { name: 'Applebot-Extended', token: 'applebot-extended', operator: 'Apple' }],
    referrals: { byHost: [], tagged: 0, total: 0 }, warnings: [],
    ...overrides,
  };
}
