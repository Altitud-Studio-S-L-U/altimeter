import { evidenceLabel } from '../../core/evidence.ts';
import { headerValue } from '../../fetch/http.ts';
import { isAllowed, parseRobots } from '../../fetch/robots.ts';
import { summarizeList } from '../helpers.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { allAiCrawlers } from './crawlers.ts';
import { isResult, parsedRobots, robotsLineEvidence, type Parsed } from './support.ts';

const managedStart = /^\s*#\s*BEGIN Cloudflare Managed content/iu;
const managedEnd = /^\s*#\s*END Cloudflare Managed Content/iu;

const purposeOf = new Map(allAiCrawlers.map(entry => [entry.token, entry]));

const managedRobots: RuleImplementation = {
  id: 'ai-cdn-cloudflare-managed-robots',
  evaluate(context) {
    const robots = parsedRobots(context);
    if (isResult(robots)) return robots;
    const start = robots.lines.findIndex(line => managedStart.test(line));
    if (start === -1) return { outcome: 'not_applicable', reason: 'no-managed-block' };
    const endOffset = robots.lines.slice(start + 1).findIndex(line => managedEnd.test(line));
    const end = endOffset === -1 ? robots.lines.length : start + 1 + endOffset;
    // Blank lines keep the segment's line numbers equal to the file's.
    const segment = parseRobots(robots.lines.map((line, index) => (index > start && index < end ? line : '')).join('\n'));
    const marker = robotsLineEvidence(context, robots, start + 1, evidenceLabel('start of the Cloudflare managed robots.txt block'));
    const disallowed = segment.groups.flatMap(group => group.userAgents.filter(token => !isAllowed(segment, [token], '/').allowed && token !== '*').map(token => ({ token, group })));
    if (disallowed.length === 0) return { outcome: 'pass', evidence: [marker] };
    const searchEngines = disallowed.filter(entry => entry.token === 'googlebot' || entry.token === 'bingbot');
    const answer = disallowed.filter(entry => { const known = purposeOf.get(entry.token); return known !== undefined && known.purpose !== 'training'; });
    const evidence = [marker, ...disallowed.map(entry => robotsLineEvidence(context, robots, entry.group.line, evidenceLabel('group inside the managed block that disallows /')))];
    const names = (entries: typeof disallowed) => summarizeList(entries.map(entry => purposeOf.get(entry.token)?.name ?? entry.token), 5);
    if (searchEngines.length > 0) return { outcome: 'fail', severity: 'medium', reason: 'search-engine-blocked', evidence, params: { agents: names(searchEngines) } };
    if (answer.length > 0) return { outcome: 'fail', severity: 'low', reason: 'answer-crawler-blocked', evidence, params: { agents: names(answer) } };
    return { outcome: 'fail', severity: 'info', reason: 'training-blocked', evidence, params: { agents: names(disallowed) } };
  },
};

const contentSignalKeys: Readonly<Record<string, readonly string[]>> = {
  search: ['yes', 'no'],
  'ai-input': ['yes', 'no'],
  'ai-train': ['yes', 'no'],
  use: ['reference'],
};

function contentSignalLines(robots: Parsed) {
  return robots.file.unsupported.filter(line => line.key === 'content-signal');
}

const contentSignals: RuleImplementation = {
  id: 'ai-content-signal-lines',
  evaluate(context) {
    const robots = parsedRobots(context);
    if (isResult(robots)) return robots;
    const lines = contentSignalLines(robots);
    if (lines.length === 0) return { outcome: 'not_applicable', reason: 'no-content-signal' };
    const invalid: { line: number; pair: string }[] = [];
    const aiInputNo: number[] = [];
    for (const line of lines) {
      for (const pair of line.value.split(',').map(part => part.trim()).filter(Boolean)) {
        const [key, value, extra] = pair.split('=').map(part => part.trim().toLowerCase());
        const allowed = key === undefined ? undefined : contentSignalKeys[key];
        if (!allowed || value === undefined || extra !== undefined || !allowed.includes(value)) invalid.push({ line: line.line, pair });
        else if (key === 'ai-input' && value === 'no') aiInputNo.push(line.line);
      }
    }
    const results: RuleResult[] = [];
    if (invalid.length > 0) {
      results.push({
        outcome: 'fail', severity: 'info', reason: 'invalid',
        evidence: [...new Set(invalid.map(entry => entry.line))].map(line => robotsLineEvidence(context, robots, line, evidenceLabel('Content-Signal line with an unknown key or value'))),
        params: { pairs: summarizeList(invalid.map(entry => entry.pair), 4) },
      });
    }
    if (aiInputNo.length > 0) {
      results.push({
        outcome: 'fail', severity: 'info', reason: 'ai-input-no',
        evidence: [...new Set(aiInputNo)].map(line => robotsLineEvidence(context, robots, line, evidenceLabel('Content-Signal line that states ai-input=no'))),
      });
    }
    if (results.length > 0) return results;
    return { outcome: 'pass', evidence: lines.map(line => robotsLineEvidence(context, robots, line.line, evidenceLabel('Content-Signal line'))) };
  },
};

const aiprefKeys = new Set(['train-ai', 'ai-use', 'search']);

/** Problems in an AIPREF usage preference, read as an RFC 9651 dictionary whose values are the tokens y or n. */
export function usagePreferenceProblems(value: string): string[] {
  const problems: string[] = [];
  const members = value.split(',').map(member => member.trim());
  if (members.some(member => member === '')) problems.push('empty member');
  for (const member of members.filter(Boolean)) {
    const [item = ''] = member.split(';');
    const separator = item.indexOf('=');
    const key = (separator === -1 ? item : item.slice(0, separator)).trim();
    if (!/^[a-z*][a-z0-9_.*-]*$/u.test(key)) {
      problems.push(`invalid key "${key}"`);
      continue;
    }
    if (!aiprefKeys.has(key)) continue;
    const token = separator === -1 ? undefined : item.slice(separator + 1).trim();
    if (token !== 'y' && token !== 'n') problems.push(`${key} needs y or n`);
  }
  return problems;
}

interface UsageSignal {
  readonly evidence: string;
  readonly value: string;
}

function robotsUsageLines(context: RuleContext): UsageSignal[] {
  const robots = parsedRobots(context);
  if (isResult(robots)) return [];
  return robots.file.unsupported.filter(line => line.key === 'content-usage').map(line => {
    // An optional path comes first; the preference is the rest of the line.
    const value = line.value.startsWith('/') ? line.value.replace(/^\S+\s*/u, '') : line.value;
    return { evidence: robotsLineEvidence(context, robots, line.line, evidenceLabel('Content-Usage line in robots.txt')), value };
  });
}

function headerUsage(context: RuleContext): UsageSignal[] {
  const signals: UsageSignal[] = [];
  for (const page of context.site.pages.values()) {
    const value = headerValue(page.fetch.headers, 'content-usage');
    if (value === undefined) continue;
    signals.push({ evidence: context.evidence.add({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('Content-Usage response header'), excerpt: value }), value });
  }
  return signals;
}

const aiprefSignals: RuleImplementation = {
  id: 'ai-aipref-signals',
  evaluate(context) {
    const signals = [...robotsUsageLines(context), ...headerUsage(context)];
    const robots = parsedRobots(context);
    const usageGroup = isResult(robots) ? undefined : robots.file.groups.find(group => group.userAgents.includes('__usage_ai-training'));
    const groupEvidence = usageGroup && !isResult(robots) ? [robotsLineEvidence(context, robots, usageGroup.line, evidenceLabel('robots.txt group for the shared AI training token'))] : [];
    if (signals.length === 0 && groupEvidence.length === 0) return { outcome: 'not_applicable', reason: 'no-aipref' };
    const broken = signals.map(signal => ({ signal, problems: usagePreferenceProblems(signal.value) })).filter(entry => entry.problems.length > 0);
    if (broken.length > 0) {
      return {
        outcome: 'fail', severity: 'info', reason: 'parse-error', evidence: broken.map(entry => entry.signal.evidence),
        params: { problems: summarizeList(broken.flatMap(entry => entry.problems), 3) },
      };
    }
    return { outcome: 'pass', evidence: [...signals.map(signal => signal.evidence), ...groupEvidence] };
  },
};

export const signalRules: readonly RuleImplementation[] = [managedRobots, contentSignals, aiprefSignals];
