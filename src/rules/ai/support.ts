import type { RobotsFile } from '../../fetch/robots.ts';
import type { RuleContext, RuleResult } from '../engine.ts';
import { groupOfRule, type CrawlerAccess } from './crawlers.ts';

export type Parsed = { readonly file: RobotsFile; readonly url: string; readonly lines: readonly string[] };

/**
 * The parsed robots.txt, or the result to return when there is nothing to read: no file means no restriction
 * (not applicable), and an unreachable file is the crawl rules' finding.
 */
export function parsedRobots(context: RuleContext): Parsed | RuleResult {
  const robots = context.site.robots;
  if (!robots) return { outcome: 'not_evaluated', reason: 'robots-not-fetched' };
  if (robots.availability.kind === 'unreachable') return { outcome: 'not_evaluated', reason: 'robots-unreachable' };
  if (robots.availability.kind === 'unrestricted') return { outcome: 'not_applicable', reason: 'no-robots-rules' };
  const text = robots.fetch.body.toString('utf8').replace(/^﻿/u, '');
  return { file: robots.availability.file, url: robots.url, lines: text.split(/\r\n|\r|\n/u) };
}

export function isResult(value: Parsed | RuleResult): value is RuleResult {
  return 'outcome' in value;
}

/** Records one robots.txt line as evidence, quoting it exactly as served. */
export function robotsLineEvidence(context: RuleContext, robots: Parsed, line: number, label: string): string {
  return context.evidence.add({ kind: 'robots', url: robots.url, label, excerpt: (robots.lines[line - 1] ?? '').trim(), line });
}

/** Evidence for how robots.txt treats a crawler: the user-agent line of the deciding group and the deciding rule. */
export function accessEvidence(context: RuleContext, robots: Parsed, access: CrawlerAccess): string[] {
  const ids: string[] = [];
  const name = access.crawler.name;
  const rule = access.root.rule;
  if (rule) {
    const group = groupOfRule(robots.file, rule.line);
    if (group) ids.push(robotsLineEvidence(context, robots, group.line, `start of the robots.txt group that applies to ${name}`));
    ids.push(robotsLineEvidence(context, robots, rule.line, `robots.txt rule that decides whether ${name} may fetch /`));
  } else {
    ids.push(context.evidence.add({ kind: 'robots', url: robots.url, label: `no robots.txt rule matches / for ${name}` }));
  }
  if (access.root.allowed && access.blocked.length > 0) {
    ids.push(context.evidence.add({
      kind: 'robots', url: robots.url, label: `sampled paths disallowed for ${name} (${access.blocked.length} of ${access.sampled.length})`,
      excerpt: access.blocked.slice(0, 10).join('\n'),
    }));
  }
  return ids;
}

/** Words of a text: runs that contain a letter or a digit. */
export function words(text: string): string[] {
  return text.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word));
}

export function clip(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
