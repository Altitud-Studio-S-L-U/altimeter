import { decodeHtml, isHtmlResponse } from '../../collect/page.ts';
import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { AgentProbe } from '../../core/facts.ts';
import type { Severity } from '../../core/types.ts';
import { headerValue } from '../../fetch/http.ts';
import { isAllowed } from '../../fetch/robots.ts';
import { parseHtml } from '../../parse/html.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { clip, words } from './support.ts';

const blockStatuses = new Set([401, 403, 429, 503]);
// Googlebot and Bingbot blocking is owned by crawl-bot-blocking; this rule covers the AI search and answer agents.
const searchEngineTokens = new Set(['googlebot', 'bingbot']);
const challengeTitle = /<title>\s*just a moment\.\.\.\s*<\/title>/iu;

function baselineOf(context: RuleContext): AgentProbe | RuleResult {
  const baseline = context.site.agentProbes.find(probe => probe.agent.purpose === 'baseline');
  if (!baseline) return { outcome: 'not_evaluated', reason: 'no-baseline' };
  if (baseline.fetch.status === undefined || baseline.fetch.status < 200 || baseline.fetch.status >= 300) return { outcome: 'not_evaluated', reason: 'baseline-not-ok' };
  return baseline;
}

const isProbe = (value: AgentProbe | RuleResult): value is AgentProbe => 'agent' in value;

/** Whether robots.txt lets the probed agent fetch the probed path. */
function robotsStance(context: RuleContext, probe: AgentProbe): 'allow' | 'disallow' | 'unknown' {
  const robots = context.site.robots;
  if (!robots) return 'unknown';
  if (robots.availability.kind === 'unrestricted') return 'allow';
  if (robots.availability.kind !== 'parsed') return 'unknown';
  const tokens = probe.agent.token === 'applebot' ? ['applebot', 'googlebot'] : [probe.agent.token];
  const url = new URL(probe.url);
  const decision = isAllowed(robots.availability.file, tokens, `${url.pathname}${url.search}`);
  return decision.allowed ? 'allow' : 'disallow';
}

function bodyText(probe: AgentProbe): string | undefined {
  if (probe.fetch.status !== 200 || !isHtmlResponse(probe.fetch.headers, probe.fetch.body)) return undefined;
  return decodeHtml(probe.fetch.headers, probe.fetch.body);
}

function challenged(probe: AgentProbe, baseline: AgentProbe): string | undefined {
  const mitigated = headerValue(probe.fetch.headers, 'cf-mitigated');
  if (mitigated && /challenge|block/iu.test(mitigated) && !headerValue(baseline.fetch.headers, 'cf-mitigated')) return `cf-mitigated: ${mitigated}`;
  const html = probe.fetch.body.subarray(0, 64 * 1024).toString('utf8');
  const baselineHtml = baseline.fetch.body.subarray(0, 64 * 1024).toString('utf8');
  const title = challengeTitle.exec(html)?.[0];
  if (title && !challengeTitle.test(baselineHtml)) return title;
  return undefined;
}

function wordSet(html: string): Set<string> {
  return new Set(words(parseHtml(html).bodyText.toLowerCase()));
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

function probeEvidence(context: RuleContext, probe: AgentProbe, label: EvidenceLabel, excerpt: string): string {
  return context.evidence.add({ kind: 'probe', url: probe.url, label, excerpt });
}

const edgeBlock: RuleImplementation = {
  id: 'ai-edge-ua-block-probe',
  evaluate(context) {
    const baseline = baselineOf(context);
    if (!isProbe(baseline)) return baseline;
    const baselineHtml = bodyText(baseline);
    const baselineWords = baselineHtml === undefined ? undefined : wordSet(baselineHtml);
    const results: RuleResult[] = [];
    const baselineId = probeEvidence(context, baseline, evidenceLabel('response to a browser user agent ({agent})', { agent: baseline.agent.name }), `HTTP ${baseline.fetch.status}`);
    for (const probe of context.site.agentProbes) {
      if (probe.agent.purpose === 'baseline' || searchEngineTokens.has(probe.agent.token)) continue;
      const status = probe.fetch.status;
      if (status === undefined) continue;
      const challenge = challenged(probe, baseline);
      const stance = robotsStance(context, probe);
      if (blockStatuses.has(status) || challenge) {
        // The probe spoofs the user agent from Altimeter's own address, and operators verify their crawlers by IP, so a
        // block may target impostors only. Without proof that the real crawler is affected, the finding stays low.
        const severity: Severity = stance === 'disallow' ? 'info' : 'low';
        const excerpt = challenge ? `HTTP ${status}; ${challenge}` : `HTTP ${status}`;
        results.push({
          outcome: 'fail', severity, reason: stance === 'disallow' ? 'blocked-as-robots-says' : 'ua-blocked',
          evidence: [probeEvidence(context, probe, evidenceLabel('response to the {agent} user agent', { agent: probe.agent.name }), excerpt), baselineId],
          params: { agent: probe.agent.name, status },
        });
        continue;
      }
      const html = bodyText(probe);
      if (html === undefined || baselineWords === undefined || baselineWords.size < 50) continue;
      const score = similarity(wordSet(html), baselineWords);
      if (score >= 0.5) continue;
      results.push({
        outcome: 'fail', severity: stance === 'disallow' ? 'info' : 'low', reason: 'content-differs',
        evidence: [
          probeEvidence(context, probe, evidenceLabel('text served to the {agent} user agent (word overlap with the browser response {similarity}%)', { agent: probe.agent.name, similarity: Math.round(score * 100) }), clip(parseHtml(html).bodyText, 300)),
          probeEvidence(context, baseline, evidenceLabel('text served to a browser user agent'), clip(parseHtml(baselineHtml!).bodyText, 300)),
        ],
        params: { agent: probe.agent.name, similarity: Math.round(score * 100) },
      });
    }
    return results.length > 0 ? results : { outcome: 'pass', evidence: [baselineId] };
  },
};

const payPerCrawl: RuleImplementation = {
  id: 'ai-pay-per-crawl-402',
  evaluate(context) {
    const baseline = baselineOf(context);
    if (!isProbe(baseline)) return baseline;
    const results: RuleResult[] = [];
    for (const probe of context.site.agentProbes) {
      if (probe.agent.purpose === 'baseline' || probe.fetch.status !== 402) continue;
      const pricing = Object.entries(probe.fetch.headers).filter(([name]) => name.startsWith('crawler-')).map(([name, values]) => `${name}: ${values.join(', ')}`);
      const deliberate = probe.agent.purpose === 'training' || robotsStance(context, probe) === 'disallow';
      results.push({
        outcome: 'fail', severity: deliberate ? 'info' : 'medium', reason: deliberate ? 'training-or-disallowed' : 'search-agent-charged',
        evidence: [probeEvidence(context, probe, evidenceLabel('response to the {agent} user agent', { agent: probe.agent.name }), ['HTTP 402', ...pricing].join('\n'))],
        params: { agent: probe.agent.name },
      });
    }
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

const cloudflareDetected: RuleImplementation = {
  id: 'ai-cdn-cloudflare-detected',
  evaluate(context) {
    const responses = [...context.site.pages.values()].flatMap(page => page.fetch.hops.map(hop => ({ url: hop.url, headers: hop.headers })));
    for (const { url, headers } of responses) {
      const server = headerValue(headers, 'server');
      const ray = headerValue(headers, 'cf-ray');
      const byServer = server !== undefined && /cloudflare/iu.test(server);
      if (byServer || ray) {
        // The cf-ray value changes on every request, so only its presence is recorded to keep the finding stable.
        const evidence = byServer
          ? context.evidence.add({ kind: 'header', url, label: evidenceLabel('Server response header'), excerpt: `server: ${server}` })
          : context.evidence.add({ kind: 'header', url, label: evidenceLabel('cf-ray response header present') });
        return { outcome: 'fail', severity: 'info', reason: 'cloudflare', evidence: [evidence] };
      }
    }
    return { outcome: 'not_applicable', reason: 'no-cloudflare' };
  },
};

export const edgeRules: readonly RuleImplementation[] = [edgeBlock, payPerCrawl, cloudflareDetected];
