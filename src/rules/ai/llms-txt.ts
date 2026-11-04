import { isHtmlResponse } from '../../collect/page.ts';
import { headerValue } from '../../fetch/http.ts';
import { isAllowed } from '../../fetch/robots.ts';
import { summarizeList } from '../helpers.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { clip } from './support.ts';

export interface LlmsTxtShape {
  /** Problems with the layout the llms.txt proposal describes: one H1 first, then optional text and H2 link sections. */
  readonly problems: readonly string[];
  readonly links: readonly { readonly href: string; readonly line: number }[];
}

export function llmsTxtShape(text: string): LlmsTxtShape {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
  const problems: string[] = [];
  const first = lines.findIndex(line => line.trim() !== '');
  if (first === -1) return { problems: ['the file is empty'], links: [] };
  if (!/^#\s+\S/u.test(lines[first]!)) problems.push('the first line is not an H1 heading');
  const h1s = lines.filter(line => /^#\s+\S/u.test(line)).length;
  if (h1s > 1) problems.push(`it has ${h1s} H1 headings`);
  const links = lines.flatMap((line, index) => [...line.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/gu)].map(match => ({ href: match[1]!, line: index + 1 })));
  return { problems, links };
}

const llmsTxt: RuleImplementation = {
  id: 'ai-llms-txt',
  evaluate({ site, evidence }) {
    const resource = site.resources.find(entry => entry.purpose === 'llms-txt');
    if (!resource) return { outcome: 'not_evaluated', reason: 'llms-txt-not-fetched' };
    const { fetch } = resource;
    if (fetch.status === undefined) return { outcome: 'not_evaluated', reason: 'llms-txt-unreachable' };
    // An absent file, or an HTML page served for every unknown path, both mean the site has no llms.txt: a choice, not a defect.
    if (fetch.status !== 200) return { outcome: 'not_applicable', reason: 'no-llms-txt' };
    if (isHtmlResponse(fetch.headers, fetch.body)) return { outcome: 'not_applicable', reason: 'html-response' };
    const type = headerValue(fetch.headers, 'content-type') ?? '';
    const text = fetch.body.toString('utf8');
    const shape = llmsTxtShape(text);
    const url = fetch.finalUrl;
    const fileEvidence = evidence.add({ kind: 'http', url, label: 'llms.txt response', excerpt: `HTTP 200; content-type: ${type || '(none)'}\n${clip(text.trim(), 300)}` });
    const results: RuleResult[] = [];
    if (!/^text\/(?:plain|markdown)\b/iu.test(type)) {
      results.push({ outcome: 'fail', severity: 'info', reason: 'content-type', evidence: [fileEvidence], params: { contentType: type || '(none)' } });
    }
    if (shape.problems.length > 0) {
      results.push({ outcome: 'fail', severity: 'info', reason: 'structure', evidence: [fileEvidence], params: { problems: summarizeList(shape.problems) } });
    }
    const robots = site.robots?.availability.kind === 'parsed' ? site.robots.availability.file : undefined;
    const disallowed = robots === undefined ? [] : shape.links.filter(link => {
      let target: URL;
      try { target = new URL(link.href, url); } catch { return false; }
      if (target.origin !== site.origin) return false;
      const path = `${target.pathname}${target.search}`;
      return ['oai-searchbot', 'claude-searchbot', 'perplexitybot', 'googlebot'].some(token => !isAllowed(robots, [token], path).allowed);
    });
    if (disallowed.length > 0) {
      results.push({
        outcome: 'fail', severity: 'info', reason: 'disallowed-links',
        evidence: disallowed.slice(0, 5).map(link => evidence.add({ kind: 'text', url, label: 'llms.txt link to a path robots.txt disallows for a search crawler', excerpt: link.href, line: link.line })),
        params: { count: disallowed.length },
      });
    }
    return results.length > 0 ? results : { outcome: 'pass', evidence: [fileEvidence] };
  },
};

export const llmsTxtRules: readonly RuleImplementation[] = [llmsTxt];
