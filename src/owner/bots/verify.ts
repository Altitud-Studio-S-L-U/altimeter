import { Resolver } from 'node:dns/promises';
import { BlockList } from 'node:net';
import { classifyAddress } from '../../fetch/ip-guard.ts';
import type { VerificationMethod } from './activity.ts';
import { ipFamily, listContains, normalizeIp, type LoadedIpList } from './ip-ranges.ts';
import { ipListDefinitions, isVerifiable, type BotDefinition, type IpListId } from './operators.ts';

/** DNS lookups, injectable so tests never reach a real resolver. */
export interface DnsResolver {
  reverse(address: string): Promise<string[]>;
  resolve(hostname: string, family: 4 | 6): Promise<string[]>;
}

/** The system resolver, with a short timeout and one try per lookup. */
export function systemResolver(timeoutMs = 3000): DnsResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    reverse: address => resolver.reverse(address),
    resolve: (hostname, family) => (family === 6 ? resolver.resolve6(hostname) : resolver.resolve4(hostname)),
  };
}

export type ReverseDnsResult =
  /** Host names of the address, and those whose forward lookup returns the address again. */
  | { readonly kind: 'names'; readonly names: readonly string[]; readonly confirmed: readonly string[] }
  /** The address has no reverse record. */
  | { readonly kind: 'none' }
  /** The lookup failed for another reason (timeout, server failure), so nothing can be concluded. */
  | { readonly kind: 'error'; readonly code: string };

const noRecord = new Set(['ENOTFOUND', 'ENODATA']);
const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{1,63}$/u;

export function hasSuffix(name: string, suffix: string): boolean {
  return name === suffix || name.endsWith(`.${suffix}`);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.slice(0, 40) : 'EUNKNOWN';
}

function sameAddress(a: string, b: string): boolean {
  const family = ipFamily(a) === 6 ? 'ipv6' : 'ipv4';
  if (family !== (ipFamily(b) === 6 ? 'ipv6' : 'ipv4')) return false;
  const single = new BlockList();
  single.addAddress(a, family);
  return single.check(b, family);
}

/**
 * Reverse DNS with forward confirmation, as Google, Microsoft, Apple and Common Crawl document it. Only names under
 * one of the suffixes are looked up forward, so no lookup reaches a domain the requester chose.
 */
export async function reverseDns(resolver: DnsResolver, address: string, suffixes: readonly string[]): Promise<ReverseDnsResult> {
  let names: string[];
  try {
    names = await resolver.reverse(address);
  } catch (error) {
    const code = errorCode(error);
    return noRecord.has(code) ? { kind: 'none' } : { kind: 'error', code };
  }
  const cleaned = names.map(name => name.toLowerCase().replace(/\.$/u, '')).filter(name => hostname.test(name)).slice(0, 5);
  const confirmed: string[] = [];
  let failure: string | undefined;
  for (const name of cleaned.filter(entry => suffixes.some(suffix => hasSuffix(entry, suffix)))) {
    try {
      const addresses = await resolver.resolve(name, ipFamily(address));
      if (addresses.some(entry => normalizeIp(entry) !== undefined && sameAddress(normalizeIp(entry)!, address))) confirmed.push(name);
    } catch (error) {
      const code = errorCode(error);
      if (!noRecord.has(code)) failure = code;
    }
  }
  if (confirmed.length === 0 && failure) return { kind: 'error', code: failure };
  return { kind: 'names', names: cleaned, confirmed };
}

export type VerificationOutcome =
  | { readonly verdict: 'verified'; readonly method: VerificationMethod }
  | { readonly verdict: 'spoofed' }
  | { readonly verdict: 'unverified'; readonly reason: string };

export interface VerificationContext {
  readonly lists: ReadonlyMap<IpListId, LoadedIpList>;
  /** CDN address lists: a client address in them is the proxy's, never a crawler's. */
  readonly proxies: readonly LoadedIpList[];
  readonly dnsEnabled: boolean;
  /** Reverse DNS results by address, for the addresses that were looked up. */
  readonly dns: ReadonlyMap<string, ReverseDnsResult>;
}

/**
 * Whether an address can be a crawler's. Private, loopback, link-local, shared and unique-local addresses mean the log
 * recorded a proxy or a load balancer. Documentation ranges stay usable so synthetic logs can be checked.
 */
export function usableAddress(address: string): boolean {
  const kind = classifyAddress(address);
  return kind === 'public' || kind === 'documentation';
}

/** Whether the crawler documents reverse DNS for this address family. */
export function dnsApplies(definition: BotDefinition, address: string): boolean {
  return definition.checks.dnsSuffixes.length > 0 && (definition.checks.dnsFamilies?.includes(ipFamily(address)) ?? true);
}

/** The first published list of the crawler that contains the address. */
export function matchingList(definition: BotDefinition, address: string, lists: ReadonlyMap<IpListId, LoadedIpList>): IpListId | undefined {
  return definition.checks.lists.find(id => {
    const list = lists.get(id);
    return list !== undefined && listContains(list, address);
  });
}

/**
 * Checks one claim. Cloudflare's verified-bot flag verifies it; otherwise the client address is matched against the
 * crawler's published lists and, where the operator documents it, reverse DNS with forward confirmation. A claim is
 * spoofed only when every documented check ran on fresh data and failed.
 */
export function verifyClaim(definition: BotDefinition, address: string | undefined, edgeCategory: string | undefined, context: VerificationContext): VerificationOutcome {
  if (edgeCategory) return { verdict: 'verified', method: 'edge' };
  if (!isVerifiable(definition)) return { verdict: 'unverified', reason: 'no-published-check' };
  if (address === undefined) return { verdict: 'unverified', reason: edgeCategory === '' ? 'edge-not-verified' : 'no-client-ip' };
  if (!usableAddress(address)) return { verdict: 'unverified', reason: 'private-address' };
  if (context.proxies.some(list => listContains(list, address))) return { verdict: 'unverified', reason: 'proxy-address' };
  const matched = matchingList(definition, address, context.lists);
  if (matched) return { verdict: 'verified', method: ipListDefinitions[matched].scope === 'operator' ? 'operator-ip-list' : 'ip-list' };
  const states = definition.checks.lists.map(id => context.lists.get(id));
  const missing = states.some(list => list === undefined || list.prefixes === 0);
  const stale = states.some(list => list?.from === 'stale-cache');
  if (dnsApplies(definition, address)) {
    if (!context.dnsEnabled) return { verdict: 'unverified', reason: 'dns-disabled' };
    const result = context.dns.get(address);
    if (!result) return { verdict: 'unverified', reason: 'dns-not-checked' };
    if (result.kind === 'error') return { verdict: 'unverified', reason: 'dns-error' };
    if (result.kind === 'names' && result.confirmed.some(name => definition.checks.dnsSuffixes.some(suffix => hasSuffix(name, suffix)))) {
      return { verdict: 'verified', method: 'reverse-dns' };
    }
    if (missing) return { verdict: 'unverified', reason: 'list-unavailable' };
    if (stale) return { verdict: 'unverified', reason: 'list-stale' };
    return { verdict: 'spoofed' };
  }
  if (missing) return { verdict: 'unverified', reason: 'list-unavailable' };
  if (stale) return { verdict: 'unverified', reason: 'list-stale' };
  if (definition.checks.listsInconclusive) return { verdict: 'unverified', reason: 'not-in-list' };
  return { verdict: 'spoofed' };
}
