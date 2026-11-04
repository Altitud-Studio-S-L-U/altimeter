import { evidenceLabel, joinLabels, type EvidenceLabel } from '../../core/evidence.ts';
import type { Severity } from '../../core/types.ts';
import type { RobotsFile } from '../../fetch/robots.ts';
import type { BotActivity, BotSummary, RequestTally } from '../../owner/bots/activity.ts';
import { robotsDecision } from '../../owner/bots/aggregate.ts';
import { botById, robotsOnlyTokens } from '../../owner/bots/operators.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';

const dayMs = 86_400_000;
const activityOf = (context: RuleContext): BotActivity => context.site.owner!.bots!;
const percent = (part: number, whole: number) => `${whole === 0 ? 0 : Math.round((part / whole) * 100)}%`;
const day = (iso: string | undefined) => iso?.slice(0, 10) ?? 'unknown';

/** Counts read from a sampling source are estimates and carry a tilde. */
function count(activity: BotActivity, value: number): string | number {
  return activity.sampled ? `~${Math.round(value)}` : value;
}

/** The first and last day of the data, for evidence labels. */
function windowOf(activity: BotActivity): { start: string; end: string } {
  return { start: day(activity.window.start), end: day(activity.window.end) };
}

/** Days the data covers: the whole window for Cloudflare, from the first to the last request for logs. */
export function dataDays(activity: BotActivity): number {
  if (activity.sources.some(source => source.kind === 'cloudflare-graphql')) return (Date.parse(activity.window.end) - Date.parse(activity.window.start)) / dayMs;
  if (!activity.window.firstRecord || !activity.window.lastRecord) return 0;
  return (Date.parse(activity.window.lastRecord) - Date.parse(activity.window.firstRecord)) / dayMs;
}

/** Whether the data records user agents, so an absent crawler really sent no request. */
function recordsUserAgents(activity: BotActivity): boolean {
  return activity.sources.some(source => source.kind === 'cloudflare-graphql' || source.fields.userAgent);
}

function statusList(statuses: Readonly<Record<string, number>>, keep?: (status: number) => boolean, max = 6): string {
  const entries = Object.entries(statuses).filter(([status]) => keep === undefined || keep(Number(status))).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  return entries.length === 0 ? 'none' : entries.slice(0, max).map(([status, hits]) => `${status} x${Math.round(hits)}`).join(', ');
}

function sum(statuses: Readonly<Record<string, number>>, keep: (status: number) => boolean): number {
  return Object.entries(statuses).reduce((total, [status, hits]) => (keep(Number(status)) ? total + hits : total), 0);
}

function tallyLine(name: string, tally: RequestTally): string {
  return `${name}: ${Math.round(tally.hits)} requests; answers ${statusList(tally.statuses)}${tally.challenges > 0 ? `; ${Math.round(tally.challenges)} challenged` : ''}; first ${day(tally.firstSeen)}; last ${day(tally.lastSeen)}`;
}

function botLine(bot: BotSummary): string {
  const definition = botById(bot.id);
  const role = `${bot.operator}, ${bot.purpose}`;
  if (!bot.verifiable && bot.verified.hits === 0) return `${bot.name} (${role}): ${Math.round(bot.unverified.hits)} claimed requests; the operator publishes no way to verify them`;
  const parts = [
    `${Math.round(bot.verified.hits)} verified`, `${Math.round(bot.unverified.hits)} unverified`, `${Math.round(bot.spoofed.hits)} spoofed`,
    `last verified ${day(bot.verified.lastSeen)}`, `robots.txt ${Math.round(bot.robotsTxt)}`, `llms.txt ${Math.round(bot.llmsTxt)}`,
    `scripts ${Math.round(bot.scripts)}`, `style sheets ${Math.round(bot.stylesheets)}`,
  ];
  return `${bot.name} (${role}${definition?.followsRobots === false ? ', fetches on user request' : ''}): ${parts.join('; ')}${bot.basis === 'claimed' ? ' (figures count unverified claims)' : ''}${bot.truncated ? ' (lower bounds)' : ''}`;
}

function activityEvidence(context: RuleContext, activity: BotActivity, bots: readonly BotSummary[], label: EvidenceLabel): string {
  return context.evidence.add({ kind: 'owner-data', label: joinLabels(label, evidenceLabel('from {start} to {end}', windowOf(activity))), excerpt: bots.map(botLine).join('\n') || 'no request' });
}

type RobotsState = { readonly file?: RobotsFile } | RuleResult;

/** robots.txt rules for the stance checks: none when the file does not exist, not evaluated when it was unreachable. */
function robotsState(context: RuleContext): RobotsState {
  const robots = context.site.robots;
  if (!robots) return { outcome: 'not_evaluated', reason: 'robots-not-fetched' };
  if (robots.availability.kind === 'unreachable') return { outcome: 'not_evaluated', reason: 'robots-unreachable' };
  return robots.availability.kind === 'parsed' ? { file: robots.availability.file } : {};
}

const isState = (value: RobotsState): value is { readonly file?: RobotsFile } => !('outcome' in value);

function allowedAtRoot(state: { readonly file?: RobotsFile }, id: string): boolean {
  const definition = botById(id);
  return !state.file || !definition || robotsDecision(state.file, definition, '/').allowed;
}

/** The requests a stance check reads: those for paths robots.txt allows, else all basis requests. */
function basisTally(bot: BotSummary): RequestTally {
  return bot.onAllowedPaths ?? (bot.basis === 'verified' ? bot.verified : bot.unverified);
}

function blockedPaths(bot: BotSummary, refused: (status: number) => boolean): string {
  const paths = bot.paths.top.filter(entry => Object.keys(entry.statuses).some(status => refused(Number(status))))
    .map(entry => `${entry.path} (${statusList(entry.statuses, refused)})`);
  return paths.length > 0 ? paths.slice(0, 10).join('\n') : 'no listed path';
}

const crawlActivity: RuleImplementation = {
  id: 'ai-bots-crawl-activity',
  evaluate(context) {
    const activity = activityOf(context);
    if (!recordsUserAgents(activity)) return { outcome: 'not_evaluated', reason: 'no-user-agents' };
    const ai = activity.bots.filter(bot => botById(bot.id)?.family === 'ai');
    const notObservable = context.evidence.add({
      kind: 'owner-data', label: evidenceLabel('robots.txt tokens no request carries, so logs cannot show them'),
      excerpt: robotsOnlyTokens.map(token => `${token.name} (${token.operator})`).join('\n'),
    });
    if (ai.length === 0) {
      return { outcome: 'pass', evidence: [context.evidence.add({ kind: 'owner-data', label: evidenceLabel('requests from AI crawlers from {start} to {end}', windowOf(activity)), excerpt: 'no request' }), notObservable] };
    }
    const verified = ai.reduce((total, bot) => total + bot.verified.hits, 0);
    const claims = ai.filter(bot => !bot.verifiable).reduce((total, bot) => total + bot.unverified.hits, 0);
    const seen = ai.filter(bot => bot.verified.hits > 0).map(bot => bot.name);
    return {
      outcome: 'fail', severity: 'info', reason: verified > 0 ? 'seen' : 'claims-only',
      evidence: [activityEvidence(context, activity, ai, evidenceLabel('requests from AI crawlers in the owner\'s data')), notObservable],
      params: { verified: count(activity, verified), crawlers: seen.length > 0 ? summarizeList(seen, 6) : 'none', claims: count(activity, claims + ai.filter(bot => bot.verifiable).reduce((total, bot) => total + bot.unverified.hits, 0)) },
    };
  },
};

const aiRefused = (status: number) => status === 401 || status === 402 || status === 403 || status === 429;

const aiBlockedAtEdge: RuleImplementation = {
  id: 'ai-bots-blocked-at-edge',
  evaluate(context) {
    const activity = activityOf(context);
    const state = robotsState(context);
    if (!isState(state)) return state;
    const candidates = activity.bots.filter(bot => {
      const definition = botById(bot.id);
      return definition?.family === 'ai' && definition.purpose !== 'training' && allowedAtRoot(state, bot.id);
    });
    if (candidates.length === 0) return { outcome: 'not_applicable', reason: 'no-requests' };
    const results: RuleResult[] = [];
    for (const bot of candidates) {
      const tally = basisTally(bot);
      const blocked = Math.max(sum(tally.statuses, aiRefused), tally.challenges);
      if (blocked < 3 || blocked / tally.hits < 0.05) continue;
      const claimed = bot.basis === 'claimed';
      const payment = sum(tally.statuses, status => status === 402);
      const severity: Severity = claimed ? 'info' : blocked >= 5 && blocked / tally.hits >= 0.5 ? 'medium' : 'low';
      const reason = claimed ? 'unverified-claims' : payment * 2 >= blocked ? 'payment-required' : 'refused';
      results.push({
        outcome: 'fail', severity, reason,
        evidence: [
          context.evidence.add({ kind: 'owner-data', label: claimed
            ? evidenceLabel('claimed {crawler} requests for paths robots.txt allows, from {start} to {end}', { crawler: bot.name, ...windowOf(activity) })
            : evidenceLabel('verified {crawler} requests for paths robots.txt allows, from {start} to {end}', { crawler: bot.name, ...windowOf(activity) }), excerpt: tallyLine(bot.name, tally) }),
          context.evidence.add({ kind: 'owner-data', label: evidenceLabel('paths where {crawler} was refused', { crawler: bot.name }), excerpt: blockedPaths(bot, aiRefused) }),
        ],
        params: { agent: bot.name, blocked: count(activity, blocked), total: count(activity, tally.hits), share: percent(blocked, tally.hits), statuses: statusList(tally.statuses, aiRefused) },
      });
    }
    if (results.length > 0) return results;
    return { outcome: 'pass', evidence: [activityEvidence(context, activity, candidates, evidenceLabel('requests from AI search and answer crawlers'))] };
  },
};

/** The AI search engines' own index crawlers; Applebot and Meta's crawler are left out (Apple search, no published check). */
export const aiSearchCrawlers = ['oai-searchbot', 'claude-searchbot', 'perplexitybot', 'duckassistbot', 'mistralai-index', 'amzn-searchbot'] as const;
/** Days of data an absence needs before it is reported (tool convention). */
const minimumDays = 14;

const aiSearchNotSeen: RuleImplementation = {
  id: 'ai-bots-search-not-seen',
  evaluate(context) {
    const activity = activityOf(context);
    if (!recordsUserAgents(activity)) return { outcome: 'not_evaluated', reason: 'no-user-agents' };
    const state = robotsState(context);
    if (!isState(state)) return state;
    const days = dataDays(activity);
    if (days < minimumDays) return { outcome: 'not_evaluated', reason: 'short-window' };
    const allowed = aiSearchCrawlers.filter(id => allowedAtRoot(state, id));
    if (allowed.length === 0) return { outcome: 'not_applicable', reason: 'all-disallowed' };
    const bots = activity.bots.filter(bot => (allowed as readonly string[]).includes(bot.id));
    const evidence = [context.evidence.add({
      kind: 'owner-data', label: evidenceLabel('requests from the AI search crawlers robots.txt allows, from {start} to {end}', windowOf(activity)),
      excerpt: allowed.map(id => {
        const bot = bots.find(entry => entry.id === id);
        return bot ? botLine(bot) : `${botById(id)!.name}: no request`;
      }).join('\n'),
    })];
    if (bots.some(bot => bot.verified.hits > 0)) return { outcome: 'pass', evidence };
    const names = allowed.map(id => botById(id)!.name);
    const claimed = bots.filter(bot => bot.unverified.hits > 0);
    if (claimed.length > 0) {
      return { outcome: 'fail', severity: 'info', reason: 'unverified-only', evidence, params: { agents: summarizeList(claimed.map(bot => bot.name), 6), days: Math.floor(days) } };
    }
    return { outcome: 'fail', severity: 'low', reason: 'none-seen', evidence, params: { agents: summarizeList(names, 6), days: Math.floor(days) } };
  },
};

const referrals: RuleImplementation = {
  id: 'ai-bots-referrals',
  evaluate(context) {
    const activity = activityOf(context);
    const data = activity.referrals;
    if (!data) return { outcome: 'not_evaluated', reason: 'no-referrer-data' };
    if (data.total === 0 && data.tagged === 0 && data.byHost.length === 0) return { outcome: 'pass' };
    const lines = [...data.byHost.map(entry => `${entry.host} (${entry.assistant}): ${Math.round(entry.visits)}`), `utm_source=chatgpt.com: ${Math.round(data.tagged)}`];
    return {
      outcome: 'fail', severity: 'info',
      evidence: [context.evidence.add({ kind: 'owner-data', label: evidenceLabel('browser visits referred by AI assistants from {start} to {end}', windowOf(activity)), excerpt: lines.join('\n') })],
      params: {
        visits: count(activity, data.total), tagged: count(activity, data.tagged),
        assistants: data.byHost.length > 0 ? summarizeList(data.byHost.map(entry => `${entry.assistant} ${Math.round(entry.visits)}`), 5) : 'none by referrer',
      },
    };
  },
};

const engineRefused = (status: number) => status === 401 || status === 403 || status === 429;
const serverError = (status: number) => status >= 500 && status <= 599;

const searchEngineBlocked: RuleImplementation = {
  id: 'crawl-bots-blocked-at-edge',
  evaluate(context) {
    const activity = activityOf(context);
    const engines = activity.bots.filter(bot => botById(bot.id)?.family === 'search-engine');
    const verified = engines.filter(bot => bot.basis === 'verified' && bot.verified.hits > 0);
    if (verified.length === 0) {
      if (engines.some(bot => bot.basis === 'claimed')) return { outcome: 'not_evaluated', reason: 'unverified-only' };
      return { outcome: 'not_applicable', reason: engines.length > 0 ? 'no-verified-requests' : 'no-requests' };
    }
    const results: RuleResult[] = [];
    for (const bot of verified) {
      const tally = basisTally(bot);
      if (tally.hits === 0) continue;
      const refused = Math.max(sum(tally.statuses, engineRefused), tally.challenges);
      const errors = sum(tally.statuses, serverError);
      const evidence = () => [
        context.evidence.add({ kind: 'owner-data', label: evidenceLabel('verified {crawler} requests for paths robots.txt allows, from {start} to {end}', { crawler: bot.name, ...windowOf(activity) }), excerpt: tallyLine(bot.name, tally) }),
        context.evidence.add({ kind: 'owner-data', label: evidenceLabel('paths where {crawler} got errors or refusals', { crawler: bot.name }), excerpt: blockedPaths(bot, status => engineRefused(status) || serverError(status)) }),
      ];
      if (refused >= 3) {
        const share = refused / tally.hits;
        const severity: Severity = share >= 0.5 && refused >= 10 ? 'high' : share >= 0.1 && refused >= 5 ? 'medium' : 'low';
        results.push({ outcome: 'fail', severity, reason: 'refused', evidence: evidence(),
          params: { agent: bot.name, count: count(activity, refused), total: count(activity, tally.hits), share: percent(refused, tally.hits), statuses: statusList(tally.statuses, engineRefused) } });
      }
      if (errors >= 3) {
        const severity: Severity = errors / tally.hits >= 0.1 && errors >= 10 ? 'medium' : 'low';
        results.push({ outcome: 'fail', severity, reason: 'server-errors', evidence: evidence(),
          params: { agent: bot.name, count: count(activity, errors), total: count(activity, tally.hits), share: percent(errors, tally.hits), statuses: statusList(tally.statuses, serverError) } });
      }
    }
    return results.length > 0 ? results : { outcome: 'pass', evidence: [activityEvidence(context, activity, verified, evidenceLabel('verified requests from search engine crawlers'))] };
  },
};

function robotsLines(context: RuleContext): readonly string[] {
  return (context.site.robots?.fetch.body.toString('utf8') ?? '').replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
}

const robotsCompliance: RuleImplementation = {
  id: 'crawl-bots-robots-compliance',
  evaluate(context) {
    const activity = activityOf(context);
    const state = robotsState(context);
    if (!isState(state)) return state;
    if (!state.file) return { outcome: 'not_applicable', reason: 'no-robots-rules' };
    const robots = activity.site?.robots;
    if (!robots) return { outcome: 'not_evaluated', reason: 'robots-not-compared' };
    const checked = activity.bots.filter(bot => bot.compliance !== undefined);
    if (checked.length === 0) return { outcome: 'not_applicable', reason: 'no-verified-crawlers' };
    const lines = robotsLines(context);
    const assumed = robots.effectiveFromSource === 'assumed';
    const results: RuleResult[] = [];
    for (const bot of checked) {
      const compliance = bot.compliance!;
      if (compliance.disallowed === 0) continue;
      const rules = [...new Map(compliance.paths.map(entry => [entry.line, entry])).values()].slice(0, 3);
      results.push({
        outcome: 'fail', severity: assumed ? 'info' : 'low', reason: assumed ? 'assumed-unchanged' : 'disallowed',
        evidence: [
          context.evidence.add({
            kind: 'owner-data', label: compliance.incomplete
              ? evidenceLabel('verified {crawler} requests for paths robots.txt disallows, from {start} (lower bound)', { crawler: bot.name, start: day(compliance.checkedFrom) })
              : evidenceLabel('verified {crawler} requests for paths robots.txt disallows, from {start}', { crawler: bot.name, start: day(compliance.checkedFrom) }),
            excerpt: compliance.paths.map(entry => `${entry.path} (${Math.round(entry.hits)} requests, last ${day(entry.lastSeen)})`).join('\n'),
          }),
          ...rules.map(entry => context.evidence.add({ kind: 'robots', url: robots.url, label: evidenceLabel('robots.txt rule that disallows paths {crawler} fetched', { crawler: bot.name }), excerpt: (lines[entry.line - 1] ?? '').trim(), line: entry.line })),
        ],
        params: { agent: bot.name, count: count(activity, compliance.disallowed), hours: compliance.cacheHours, since: day(robots.effectiveFrom) },
      });
    }
    if (results.length > 0) return results;
    return { outcome: 'pass', evidence: [activityEvidence(context, activity, checked, evidenceLabel('verified requests from crawlers that follow robots.txt'))] };
  },
};

const googlebotCoverage: RuleImplementation = {
  id: 'crawl-bots-googlebot-sitemap-coverage',
  evaluate(context) {
    const activity = activityOf(context);
    if (!activity.site || activity.site.sitemapUrls === 0) return { outcome: 'not_applicable', reason: 'no-sitemap-urls' };
    if (!recordsUserAgents(activity)) return { outcome: 'not_evaluated', reason: 'no-user-agents' };
    const days = dataDays(activity);
    if (days < minimumDays) return { outcome: 'not_evaluated', reason: 'short-window' };
    const googlebot = activity.bots.find(bot => bot.id === 'googlebot');
    if (googlebot?.basis === 'claimed') return { outcome: 'not_evaluated', reason: 'unverified-only' };
    const coverage = googlebot?.coverage;
    if (!googlebot || googlebot.verified.hits === 0 || !coverage) {
      return {
        outcome: 'fail', severity: 'low', reason: 'not-seen',
        evidence: [context.evidence.add({ kind: 'owner-data', label: evidenceLabel('verified Googlebot requests from {start} to {end}', windowOf(activity)), excerpt: googlebot ? botLine(googlebot) : 'Googlebot: no request' })],
        params: { days: Math.floor(days), fetched: 0, urls: activity.site.sitemapUrls, share: '0%' },
      };
    }
    const share = coverage.ok / coverage.urls;
    const evidence = [
      context.evidence.add({ kind: 'owner-data', label: evidenceLabel('verified Googlebot requests for sitemap URLs from {start} to {end}', windowOf(activity)), excerpt: `${coverage.ok} of ${coverage.urls} sitemap URLs answered 2xx or 304; ${coverage.fetched} requested at all` }),
      ...(coverage.missing.length > 0 ? [context.evidence.add({ kind: 'owner-data', label: evidenceLabel('sitemap URLs verified Googlebot did not request'), excerpt: coverage.missing.join('\n') })] : []),
    ];
    const params = { days: Math.floor(days), fetched: coverage.ok, urls: coverage.urls, share: percent(coverage.ok, coverage.urls) };
    if (share < 0.5) return { outcome: 'fail', severity: 'low', reason: 'low-coverage', evidence, params };
    if (share < 0.9) return { outcome: 'fail', severity: 'info', reason: 'partial-coverage', evidence, params };
    return { outcome: 'pass', evidence };
  },
};

const served = (status: number) => status >= 200 && status < 400;

const spoofedCrawlers: RuleImplementation = {
  id: 'crawl-bots-spoofed-crawlers',
  evaluate(context) {
    const activity = activityOf(context);
    const verifiable = activity.bots.filter(bot => bot.verifiable);
    const verified = verifiable.reduce((total, bot) => total + bot.verified.hits, 0);
    const spoofed = verifiable.reduce((total, bot) => total + bot.spoofed.hits, 0);
    const checked = verified + spoofed;
    if (checked === 0) return verifiable.length > 0 ? { outcome: 'not_evaluated', reason: 'no-client-address' } : { outcome: 'not_applicable', reason: 'no-claims' };
    const impostors = verifiable.filter(bot => bot.spoofed.hits > 0);
    const evidence = [context.evidence.add({
      kind: 'owner-data', label: evidenceLabel("crawler requests that failed their operator's checks, from {start} to {end}", windowOf(activity)),
      excerpt: impostors.map(bot => `${bot.name}: ${Math.round(bot.spoofed.hits)} of ${Math.round(bot.verified.hits + bot.spoofed.hits)} checked requests failed; answers ${statusList(bot.spoofed.statuses)}`).join('\n') || 'none',
    })];
    const share = spoofed / checked;
    if (spoofed === 0 || share < 0.05) return { outcome: 'pass', evidence };
    const servedHits = impostors.reduce((total, bot) => total + sum(bot.spoofed.statuses, served), 0);
    const params = {
      spoofed: count(activity, spoofed), checked: count(activity, checked), share: percent(spoofed, checked), served: count(activity, servedHits),
      agents: summarizeList(impostors.sort((a, b) => b.spoofed.hits - a.spoofed.hits).map(bot => bot.name), 4),
    };
    if (spoofed >= 20 && share >= 0.2) {
      const mostlyServed = servedHits / spoofed >= 0.5;
      return { outcome: 'fail', severity: mostlyServed ? 'low' : 'info', reason: mostlyServed ? 'served' : 'refused', evidence, params };
    }
    return { outcome: 'fail', severity: 'info', reason: 'present', evidence, params };
  },
};

export const implementations: readonly RuleImplementation[] = [
  crawlActivity, aiBlockedAtEdge, aiSearchNotSeen, referrals, searchEngineBlocked, robotsCompliance, googlebotCoverage, spoofedCrawlers,
];
