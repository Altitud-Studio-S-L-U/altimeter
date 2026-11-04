import { isAllowed, normalizeRobotsPath, type RobotsDecision, type RobotsFile } from '../../fetch/robots.ts';
import { cleanLine } from '../../report/sanitize.ts';
import type { BotSummary, DisallowedPath, PathCount, ReferralCount, RequestTally, RobotsCompliance, SitemapCoverage, VerificationMethod } from './activity.ts';
import type { LogRecord } from './formats.ts';
import { assistantFor, matchBot, taggedByChatGpt, type BotDefinition, isVerifiable } from './operators.ts';
import type { VerificationOutcome } from './verify.ts';

/** A request, or a group of requests a CDN reports together. */
export interface Observation extends LogRecord {
  /** Requests it stands for: 1 for a log line, the estimate of a sampled group. */
  readonly count: number;
  /** Length in milliseconds of the period that starts at `time`: 0 for an exact time, a day for daily groups. */
  readonly span: number;
}

export interface AggregatorSite {
  /** Lowercase host name of the audited site; requests logged for other hosts count but are not compared with its files. */
  readonly host?: string;
  /** The current robots.txt and the moment it is taken to apply from. */
  readonly robots?: { readonly file: RobotsFile; readonly effectiveFrom: number };
  /** Sitemap URLs of the site. */
  readonly sitemapUrls?: readonly string[];
}

export interface AggregatorOptions {
  readonly site?: AggregatorSite;
  readonly verify: (definition: BotDefinition, observation: Observation) => VerificationOutcome;
}

/** Memory bounds per crawler (tool conventions): distinct paths kept, robots.txt decisions cached, compliance entries kept. */
export const aggregateLimits = {
  paths: 2000, topPaths: 20, decisions: 20_000, decisionKeyLength: 2048, disallowedPaths: 200, listedDisallowed: 20, pendingEvents: 5000, missingExamples: 25,
} as const;

const iso = (time: number) => new Date(time).toISOString();
const isoDay = (time: number) => iso(time).slice(0, 10);
const hourMs = 3_600_000;
const scriptPath = /\.m?js$/u;
const stylePath = /\.css$/u;
const subresourcePath = /\.(?:m?js|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot)$/u;

function pathname(pathAndQuery: string): string {
  return (pathAndQuery.split(/[?#]/u, 1)[0] ?? '').toLowerCase();
}

/** The key a requested path and a sitemap URL are compared by: no query, normalised escapes, no index file or trailing slash. */
export function coverageKey(pathAndQuery: string): string {
  let path = normalizeRobotsPath(pathAndQuery.split(/[?#]/u, 1)[0] || '/');
  path = path.replace(/\/index\.html?$/iu, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

const okStatus = (status: number | undefined) => status !== undefined && ((status >= 200 && status < 300) || status === 304);

class TallyBuilder {
  hits = 0;
  bytes = 0;
  first: number | undefined;
  last: number | undefined;
  readonly days = new Set<string>();
  readonly statuses = new Map<string, number>();
  challenges = 0;

  add(observation: Observation): void {
    this.hits += observation.count;
    this.bytes += observation.bytes ?? 0;
    if (this.first === undefined || observation.time < this.first) this.first = observation.time;
    if (this.last === undefined || observation.time > this.last) this.last = observation.time;
    this.days.add(isoDay(observation.time));
    if (observation.status !== undefined) {
      const key = String(observation.status);
      this.statuses.set(key, (this.statuses.get(key) ?? 0) + observation.count);
    }
    if (observation.challenged) this.challenges += observation.count;
  }

  result(): RequestTally {
    return {
      hits: this.hits, bytes: this.bytes,
      ...(this.first === undefined ? {} : { firstSeen: iso(this.first) }), ...(this.last === undefined ? {} : { lastSeen: iso(this.last) }),
      activeDays: this.days.size,
      statuses: Object.fromEntries([...this.statuses].sort((a, b) => Number(a[0]) - Number(b[0]))),
      challenges: this.challenges,
    };
  }
}

interface PendingEvent {
  readonly start: number;
  readonly key: string;
  readonly hits: number;
  readonly rule: string;
  readonly line: number;
}

/**
 * Disallowed requests counted only once the crawler must have known the current robots.txt: after its caching window
 * from the moment the file took effect, or after its first successful robots.txt fetch from that moment on.
 */
class ComplianceBuilder {
  readonly effectiveFrom: number;
  readonly windowMs: number;
  readonly cacheHours: number;
  readonly documented: boolean;
  readonly entries = new Map<string, { hits: number; last: number; rule: string; line: number }>();
  total = 0;
  readonly pending: PendingEvent[] = [];
  incomplete = false;
  robotsFetchEnd: number | undefined;

  constructor(effectiveFrom: number, cacheHours: number, documented: boolean) {
    this.effectiveFrom = effectiveFrom;
    this.cacheHours = cacheHours;
    this.windowMs = cacheHours * hourMs;
    this.documented = documented;
  }

  robotsFetched(observation: Observation): void {
    if (observation.time < this.effectiveFrom || !(observation.status !== undefined && observation.status >= 200 && observation.status < 300)) return;
    const end = observation.time + observation.span;
    if (this.robotsFetchEnd === undefined || end < this.robotsFetchEnd) this.robotsFetchEnd = end;
  }

  disallowed(observation: Observation, key: string, decision: RobotsDecision): void {
    if (observation.time < this.effectiveFrom || !decision.rule) return;
    if (observation.time >= this.effectiveFrom + this.windowMs) {
      this.record(key, observation.count, observation.time, cleanLine(decision.rule.pattern, 300), decision.rule.line);
    } else if (this.pending.length < aggregateLimits.pendingEvents) {
      this.pending.push({ start: observation.time, key, hits: observation.count, rule: cleanLine(decision.rule.pattern, 300), line: decision.rule.line });
    } else {
      this.incomplete = true;
    }
  }

  record(key: string, hits: number, time: number, rule: string, line: number): void {
    this.total += hits;
    const entry = this.entries.get(key);
    if (entry) {
      entry.hits += hits;
      entry.last = Math.max(entry.last, time);
    } else if (this.entries.size < aggregateLimits.disallowedPaths) {
      this.entries.set(key, { hits, last: time, rule, line });
    }
  }

  result(windowEnd: number): RobotsCompliance {
    const fetchEnd = this.robotsFetchEnd;
    if (fetchEnd !== undefined) for (const event of this.pending) if (event.start >= fetchEnd) this.record(event.key, event.hits, event.start, event.rule, event.line);
    const checkedFrom = Math.min(this.effectiveFrom + this.windowMs, fetchEnd ?? Number.POSITIVE_INFINITY);
    const paths: DisallowedPath[] = [...this.entries].sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0])).slice(0, aggregateLimits.listedDisallowed)
      .map(([path, entry]) => ({ path, hits: entry.hits, lastSeen: iso(entry.last), rule: entry.rule, line: entry.line }));
    return {
      cacheHours: this.cacheHours, cacheBasis: this.documented ? 'documented' : 'standard',
      ...(checkedFrom < windowEnd ? { checkedFrom: iso(checkedFrom) } : {}),
      disallowed: this.total, paths, incomplete: this.incomplete,
    };
  }
}

/** The figures computed over one set of requests: the verified ones, or every claim. */
class ViewBuilder {
  robotsTxt = 0;
  llmsTxt = 0;
  scripts = 0;
  stylesheets = 0;
  readonly paths = new Map<string, { hits: number; statuses: Map<string, number> }>();
  pathsCapped = false;
  readonly onAllowed = new TallyBuilder();
  readonly fetched = new Set<string>();
  readonly ok = new Set<string>();
  readonly compliance: ComplianceBuilder | undefined;

  constructor(compliance: ComplianceBuilder | undefined) {
    this.compliance = compliance;
  }
}

class BotBuilder {
  readonly definition: BotDefinition;
  readonly verified = new TallyBuilder();
  readonly unverified = new TallyBuilder();
  readonly spoofed = new TallyBuilder();
  readonly verifiedBy = new Map<VerificationMethod, number>();
  readonly reasons = new Map<string, number>();
  readonly verifiedView: ViewBuilder;
  readonly claimedView: ViewBuilder;
  readonly decisions = new Map<string, RobotsDecision>();
  userAgent: string | undefined;

  constructor(definition: BotDefinition, robots: AggregatorSite['robots']) {
    this.definition = definition;
    const checksRobots = robots !== undefined && definition.followsRobots && definition.purpose !== 'user-triggered';
    const hours = definition.robotsCacheHours ?? 24;
    this.verifiedView = new ViewBuilder(checksRobots ? new ComplianceBuilder(robots.effectiveFrom, hours, definition.robotsCacheHours !== undefined) : undefined);
    this.claimedView = new ViewBuilder(undefined);
  }
}

/** The robots.txt decision for a crawler, with Amazon's documented fallback to the groups written for other search bots. */
export function robotsDecision(file: RobotsFile, definition: BotDefinition, pathAndQuery: string): RobotsDecision {
  const own = isAllowed(file, definition.robotsTokens, pathAndQuery);
  if (definition.robotsFallback !== 'search-bots' || own.matchedToken === definition.token) return own;
  const candidates = ['googlebot', 'bingbot'].filter(token => file.groups.some(group => group.userAgents.includes(token))).map(token => isAllowed(file, [token], pathAndQuery));
  // Blocked only when every group it may follow blocks it.
  return [...candidates, own].find(decision => decision.allowed) ?? own;
}

/** Folds requests into per-crawler summaries with bounded memory. */
export class BotAggregator {
  readonly #site: AggregatorSite | undefined;
  readonly #verify: AggregatorOptions['verify'];
  readonly #bots = new Map<string, BotBuilder>();
  readonly #truncated = new Set<string>();
  readonly #sitemapKeys = new Map<string, string>();
  readonly #referrals = new Map<string, { assistant: string; visits: number }>();
  #tagged = 0;
  #referred = 0;
  #first: number | undefined;
  #last: number | undefined;

  constructor(options: AggregatorOptions) {
    this.#site = options.site;
    this.#verify = options.verify;
    for (const url of options.site?.sitemapUrls ?? []) {
      try {
        const parsed = new URL(url);
        if (options.site?.host && parsed.hostname.toLowerCase() !== options.site.host) continue;
        const key = coverageKey(`${parsed.pathname}`);
        if (!this.#sitemapKeys.has(key)) this.#sitemapKeys.set(key, parsed.href);
      } catch {
        // Invalid sitemap URLs are reported by the sitemap rules.
      }
    }
  }

  get sitemapUrls(): number {
    return this.#sitemapKeys.size;
  }

  #onSiteHost(observation: Observation): boolean {
    const host = this.#site?.host;
    return host === undefined || observation.host === undefined || observation.host.replace(/:\d+$/u, '') === host;
  }

  add(observation: Observation): void {
    if (this.#first === undefined || observation.time < this.#first) this.#first = observation.time;
    if (this.#last === undefined || observation.time > this.#last) this.#last = observation.time;
    const definition = matchBot(observation.userAgent);
    if (!definition) {
      this.#countReferral(observation);
      return;
    }
    let builder = this.#bots.get(definition.id);
    if (!builder) {
      builder = new BotBuilder(definition, this.#site?.robots);
      this.#bots.set(definition.id, builder);
    }
    builder.userAgent ??= cleanLine(observation.userAgent ?? '', 200);
    const outcome = this.#verify(definition, observation);
    if (outcome.verdict === 'verified') {
      builder.verified.add(observation);
      builder.verifiedBy.set(outcome.method, (builder.verifiedBy.get(outcome.method) ?? 0) + observation.count);
      this.#addToView(builder, builder.verifiedView, observation);
    } else if (outcome.verdict === 'spoofed') {
      builder.spoofed.add(observation);
    } else {
      builder.unverified.add(observation);
      builder.reasons.set(outcome.reason, (builder.reasons.get(outcome.reason) ?? 0) + observation.count);
    }
    this.#addToView(builder, builder.claimedView, observation);
  }

  #addToView(builder: BotBuilder, view: ViewBuilder, observation: Observation): void {
    const lower = pathname(observation.path);
    if (lower === '/robots.txt') view.robotsTxt += observation.count;
    else if (lower === '/llms.txt' || lower === '/llms-full.txt') view.llmsTxt += observation.count;
    if (scriptPath.test(lower)) view.scripts += observation.count;
    else if (stylePath.test(lower)) view.stylesheets += observation.count;
    const shown = cleanLine(observation.path, 300);
    const entry = view.paths.get(shown);
    if (entry || view.paths.size < aggregateLimits.paths) {
      const target = entry ?? { hits: 0, statuses: new Map<string, number>() };
      target.hits += observation.count;
      if (observation.status !== undefined) target.statuses.set(String(observation.status), (target.statuses.get(String(observation.status)) ?? 0) + observation.count);
      if (!entry) view.paths.set(shown, target);
    } else {
      view.pathsCapped = true;
    }
    if (!this.#onSiteHost(observation)) return;
    if (this.#sitemapKeys.size > 0) {
      const key = coverageKey(observation.path);
      if (this.#sitemapKeys.has(key)) {
        view.fetched.add(key);
        if (okStatus(observation.status)) view.ok.add(key);
      }
    }
    const robots = this.#site?.robots;
    if (!robots) return;
    let decision = builder.decisions.get(observation.path);
    if (!decision) {
      decision = robotsDecision(robots.file, builder.definition, observation.path);
      if (builder.decisions.size < aggregateLimits.decisions && observation.path.length <= aggregateLimits.decisionKeyLength) builder.decisions.set(observation.path, decision);
    }
    if (decision.allowed) view.onAllowed.add(observation);
    if (!view.compliance) return;
    if (lower === '/robots.txt') view.compliance.robotsFetched(observation);
    else if (!decision.allowed) view.compliance.disallowed(observation, shown, decision);
  }

  #countReferral(observation: Observation): void {
    if (observation.method !== undefined && observation.method !== 'GET' && observation.method !== 'HEAD') return;
    if (subresourcePath.test(pathname(observation.path))) return;
    const assistant = assistantFor(observation.referer);
    const tagged = taggedByChatGpt(observation.path);
    if (assistant) this.addReferrals(assistant.host, assistant.assistant, observation.count);
    if (tagged) this.#tagged += observation.count;
    if (assistant || tagged) this.#referred += observation.count;
  }

  /** Adds referred visits counted by a source that groups them, such as Cloudflare. */
  addReferrals(host: string, assistant: string, visits: number): void {
    const entry = this.#referrals.get(host) ?? { assistant, visits: 0 };
    entry.visits += visits;
    this.#referrals.set(host, entry);
  }

  addTagged(visits: number): void {
    this.#tagged += visits;
  }

  /** Visits with either signal, for sources that group them: the larger of the two counts is a lower bound. */
  addReferred(visits: number): void {
    this.#referred += visits;
  }

  markTruncated(id: string): void {
    this.#truncated.add(id);
  }

  finish(windowEnd: number): {
    readonly bots: readonly BotSummary[];
    readonly referrals: { readonly byHost: readonly ReferralCount[]; readonly tagged: number; readonly total: number };
    readonly firstRecord?: string;
    readonly lastRecord?: string;
  } {
    const bots = [...this.#bots.values()].map(builder => this.#summary(builder, windowEnd))
      .sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
    const byHost = [...this.#referrals].map(([host, entry]) => ({ host, assistant: entry.assistant, visits: entry.visits })).sort((a, b) => b.visits - a.visits || a.host.localeCompare(b.host));
    return {
      bots, referrals: { byHost, tagged: this.#tagged, total: this.#referred },
      ...(this.#first === undefined ? {} : { firstRecord: iso(this.#first) }), ...(this.#last === undefined ? {} : { lastRecord: iso(this.#last) }),
    };
  }

  #summary(builder: BotBuilder, windowEnd: number): BotSummary {
    const definition = builder.definition;
    const checked = builder.verified.hits + builder.spoofed.hits;
    const basis = checked > 0 ? 'verified' : 'claimed';
    const view = basis === 'verified' ? builder.verifiedView : builder.claimedView;
    const top: PathCount[] = [...view.paths].sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0])).slice(0, aggregateLimits.topPaths)
      .map(([path, entry]) => ({ path, hits: entry.hits, statuses: Object.fromEntries([...entry.statuses].sort((x, y) => Number(x[0]) - Number(y[0]))) }));
    let coverage: SitemapCoverage | undefined;
    if (this.#sitemapKeys.size > 0) {
      const missing = [...this.#sitemapKeys].filter(([key]) => !view.fetched.has(key)).slice(0, aggregateLimits.missingExamples).map(([, url]) => url);
      coverage = { urls: this.#sitemapKeys.size, fetched: view.fetched.size, ok: view.ok.size, missing };
    }
    const compliance = basis === 'verified' ? view.compliance?.result(windowEnd) : undefined;
    return {
      id: definition.id, name: definition.name, operator: definition.operator, purpose: definition.purpose, token: definition.token,
      verifiable: isVerifiable(definition), basis,
      verified: builder.verified.result(), unverified: builder.unverified.result(), spoofed: builder.spoofed.result(),
      verifiedBy: Object.fromEntries(builder.verifiedBy), unverifiedReasons: Object.fromEntries([...builder.reasons].sort((a, b) => b[1] - a[1])),
      ...(this.#site?.robots ? { onAllowedPaths: view.onAllowed.result() } : {}),
      robotsTxt: view.robotsTxt, llmsTxt: view.llmsTxt, scripts: view.scripts, stylesheets: view.stylesheets,
      paths: { distinct: view.paths.size, capped: view.pathsCapped, top },
      ...(coverage ? { coverage } : {}), ...(compliance ? { compliance } : {}),
      ...(builder.userAgent ? { userAgent: builder.userAgent } : {}),
      truncated: this.#truncated.has(definition.id),
    };
  }
}

function total(summary: BotSummary): number {
  return summary.verified.hits + summary.unverified.hits + summary.spoofed.hits;
}
