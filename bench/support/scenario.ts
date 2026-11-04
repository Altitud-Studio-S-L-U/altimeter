import type { lookup as dnsLookup, LookupAddress } from 'node:dns';
import type { Severity } from '../../src/core/types.ts';
import type { NetworkPolicy } from '../../src/fetch/ip-guard.ts';
import type { BenchRequest, BenchResponse } from './server.ts';

export type Handler = BenchResponse | ((request: BenchRequest) => BenchResponse);

/** The routes of one origin, keyed by path; a key with a query string matches only that exact request. */
export interface SiteRoutes {
  readonly routes: ReadonlyMap<string, Handler> | Readonly<Record<string, Handler>>;
  /** What unknown paths get; a plain 404 when absent. */
  readonly fallback?: Handler;
}

/** Sites keyed by origin without the bench port, such as `https://vellora.example` or `http://www.vellora.example`. */
export type Origins = Readonly<Record<string, SiteRoutes | Handler>>;

export interface ScenarioContext {
  readonly port: number;
  /** The origin with the bench port: `https://vellora.example` becomes `https://vellora.example:<port>`. */
  origin(base: string): string;
}

export interface ScenarioSite {
  readonly origins: Origins;
  /** The URL to audit. */
  readonly url: string;
  /** A Chrome UX Report endpoint the scenario serves; the audit then queries it with a placeholder key. */
  readonly cruxEndpoint?: string;
}

export interface FailExpectation {
  readonly rule: string;
  readonly severity?: Severity;
  readonly reason?: string;
  /** Path on the audited origin (or an absolute URL) of the page the finding is about; site findings have none. */
  readonly page?: string;
  /** Why this expectation is a documented gap: the runner lists it instead of failing. */
  readonly known?: string;
}

export interface QuietExpectation {
  readonly rule: string;
  readonly page?: string;
  /** The outcome required instead of the default, which accepts pass or not_applicable. */
  readonly outcome?: 'pass' | 'not_applicable' | 'not_evaluated';
  readonly known?: string;
}

export interface ScenarioOptions {
  readonly crawl?: boolean;
  readonly maxPages?: number;
  readonly lighthouse?: boolean;
}

export interface Scenario {
  readonly name: string;
  /** One line on what the scenario reproduces. */
  readonly summary: string;
  /** Host names the scenario serves. They resolve to 127.0.0.1; every other name fails to resolve. */
  readonly hosts: readonly string[];
  /** Hosts that present an expired certificate instead of the scenario's valid leaf. */
  readonly expiredCertificates?: readonly string[];
  readonly options?: ScenarioOptions;
  readonly build: (context: ScenarioContext) => ScenarioSite;
  /** Rules that must report a failure. */
  readonly mustFail: readonly FailExpectation[];
  /** Rules that must not report a failure: they pass or do not apply, unless an outcome is given. */
  readonly mustNotFail: readonly (string | QuietExpectation)[];
}

const notFound: BenchResponse = { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' };

function entries(routes: SiteRoutes['routes']): ReadonlyMap<string, Handler> {
  return routes instanceof Map ? routes : new Map(Object.entries(routes));
}

const isRoutes = (value: SiteRoutes | Handler): value is SiteRoutes => typeof value === 'object' && 'routes' in value;
const answer = (handler: Handler, request: BenchRequest) => (typeof handler === 'function' ? handler(request) : handler);

/** Answers a request from the scenario's sites: the exact path first, then the path without its query. */
export function route(origins: Origins, request: BenchRequest): BenchResponse {
  const site = origins[`${request.secure ? 'https' : 'http'}://${request.host}`];
  if (!site) return { status: 421, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `No site for ${request.host}` };
  if (!isRoutes(site)) return answer(site, request);
  const routes = entries(site.routes);
  const handler = routes.get(request.path) ?? routes.get(request.pathname) ?? site.fallback;
  return handler ? answer(handler, request) : notFound;
}

/** Resolves the scenario's hosts to 127.0.0.1 and refuses every other name, so no request leaves the machine. */
export function loopbackLookup(hosts: readonly string[]): typeof dnsLookup {
  const known = new Set(hosts.map(host => host.toLowerCase()));
  const lookup = (hostname: string, options: { all?: boolean } | number | undefined, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    const all = typeof options === 'object' && options?.all === true;
    process.nextTick(() => {
      if (!known.has(hostname.toLowerCase())) {
        const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        error.code = 'ENOTFOUND';
        return callback(error, all ? [] : '');
      }
      return all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
    });
  };
  return lookup as unknown as typeof dnsLookup;
}

/** Private addresses are refused except for the scenario's own host names, which the network guard matches by name. */
export function loopbackPolicy(hosts: readonly string[]): NetworkPolicy {
  return { allowPrivate: false, privateHosts: new Set(hosts.map(host => host.toLowerCase())) };
}

export function defineScenario(scenario: Scenario): Scenario {
  return scenario;
}
