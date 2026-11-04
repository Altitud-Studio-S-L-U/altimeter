import { rule as catalogRule } from '../catalog/index.ts';
import type { EvidenceItem } from '../core/evidence.ts';
import { categories, type Category } from '../core/types.ts';
import { findingMessage, format, ruleTexts, type Language } from '../i18n/messages.ts';
import { ui } from '../i18n/ui.ts';
import type { FindingScope } from '../rules/engine.ts';
import { severityWeights } from '../score/score.ts';
import type { Report, ReportFinding } from './model.ts';
import { cleanLine, untrustedBlock, untrustedInline } from './sanitize.ts';
import type { Task } from './tasks.ts';

export function scopeLabel(scope: FindingScope): string {
  return scope.kind === 'page' ? scope.url : scope.origin;
}

function evidenceLine(item: EvidenceItem): string {
  const where = [item.url, item.line ? `line ${item.line}` : undefined, item.path].filter(Boolean).join(', ');
  const excerpt = item.excerpt === undefined ? '' : `: ${untrustedInline(item.excerpt, 240)}`;
  return `${cleanLine(item.label)}${where ? ` (${cleanLine(where)})` : ''}${excerpt}`;
}

function message(language: Language, finding: ReportFinding): string {
  return findingMessage(language, finding.ruleId, 'fail', finding.reason, finding.params) ?? finding.message ?? finding.title;
}

function sortedFailures(findings: readonly ReportFinding[]): ReportFinding[] {
  return findings.filter(finding => finding.outcome === 'fail' && !finding.needsJudgment)
    .sort((a, b) => severityWeights[b.severity ?? 'info'] - severityWeights[a.severity ?? 'info'] || a.ruleId.localeCompare(b.ruleId));
}

export function renderMarkdown(report: Report, language: Language): string {
  const t = ui(language);
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  const lines: string[] = [];
  const date = report.run.startedAt.slice(0, 10);
  lines.push(`# ${format(t.reportTitle, { site: cleanLine(new URL(report.target.origin).host) })}`, '');
  lines.push(`${t.audited}: ${untrustedInline(report.target.url)} · ${format(t.generated, { version: report.tool.version, date })}`, '');

  lines.push(`## ${t.summary}`, '', `| | ${t.score} |`, '| --- | --- |');
  lines.push(`| **${t.overall}** | ${report.score.overall ?? t.notScored} |`);
  for (const entry of report.score.categories) lines.push(`| ${t.categories[entry.category]} | ${entry.score ?? t.notScored} |`);
  lines.push('', `**${t.indexability}:** ${t.indexabilityStates[report.score.indexability]}`, '');
  lines.push(`**${t.coverage}:** ${format(t.coverageLine, { evaluated: report.coverage.evaluated, notEvaluated: report.coverage.notEvaluated, notApplicable: report.coverage.notApplicable })}`);
  const missing = Object.entries(report.coverage.missingInputs);
  if (missing.length > 0) lines.push('', `${t.missingInputs}: ${missing.map(([input, count]) => `\`${input}\` (${count})`).join(', ')}`);
  if (report.run.warnings.length > 0) lines.push('', `**${t.warnings}:**`, ...report.run.warnings.map(warning => `- ${cleanLine(warning)}`));
  lines.push('');

  lines.push(`## ${t.topActions}`, '');
  if (report.tasks.length === 0) lines.push(t.noActions);
  for (const task of report.tasks.slice(0, 10)) {
    const rule = catalogRule(task.ruleId);
    const title = rule ? ruleTexts(language, rule).title : task.title;
    lines.push(`${task.priority}. **[${t.severities[task.severity]}]** ${cleanLine(title)} · ${task.scopes.length} · \`${task.id}\``);
  }
  lines.push('');

  lines.push(`## ${t.findings}`, '');
  const failures = sortedFailures(report.findings);
  for (const category of categories as readonly Category[]) {
    lines.push(`### ${t.categories[category]}`, '');
    const inCategory = failures.filter(finding => finding.category === category);
    if (inCategory.length === 0) lines.push(t.noFindings, '');
    for (const finding of inCategory) {
      const rule = catalogRule(finding.ruleId);
      const texts = rule ? ruleTexts(language, rule) : { title: finding.title, fix: '', why: '' };
      lines.push(`- **[${t.severities[finding.severity ?? 'info']}] ${cleanLine(texts.title)}** (\`${finding.ruleId}\`) · ${untrustedInline(scopeLabel(finding.scope), 160)}`);
      lines.push(`  ${cleanLine(message(language, finding), 600)}`);
      for (const id of finding.evidence.slice(0, 4)) {
        const item = evidence.get(id);
        if (item) lines.push(`  - ${t.evidence}: ${evidenceLine(item)}`);
      }
      if (texts.fix) lines.push(`  - ${t.fix}: ${cleanLine(texts.fix, 700)}`);
      for (const source of rule?.sources.slice(0, 2) ?? []) lines.push(`  - ${t.source}: <${source.url}> (${format(t.verified, { date: source.verified })})`);
    }
    if (inCategory.length > 0) lines.push('');
  }

  const pending = report.findings.filter(finding => finding.needsJudgment);
  if (pending.length > 0) {
    lines.push(`## ${t.pendingReview}`, '', t.pendingReviewIntro, '');
    for (const finding of pending) lines.push(`- ${cleanLine(finding.title)} (\`${finding.ruleId}\`) · ${untrustedInline(scopeLabel(finding.scope), 160)}`);
    lines.push('');
  }

  const notEvaluated = report.findings.filter(finding => finding.outcome === 'not_evaluated');
  if (notEvaluated.length > 0) {
    lines.push(`## ${t.notEvaluated}`, '');
    const byReason = new Map<string, number>();
    for (const finding of notEvaluated) byReason.set(finding.reason ?? 'unknown', (byReason.get(finding.reason ?? 'unknown') ?? 0) + 1);
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) lines.push(`- \`${cleanLine(reason)}\`: ${count}`);
    lines.push('');
  }

  lines.push(`## ${t.pages}`, '', `| ${t.page} | ${t.status} | ${t.type} | ${t.rendered} |`, '| --- | --- | --- | --- |');
  for (const page of report.pages) lines.push(`| ${untrustedInline(page.finalUrl, 160)} | ${page.status ?? '-'} | ${page.pageType} | ${page.rendered ? t.yes : t.no} |`);
  lines.push('', `## ${t.method}`, '', t.methodIntro, '', cleanLine(report.score.formula, 1200), '');
  lines.push(`Catalog \`${report.catalog.hash.slice(0, 12)}\` · ${report.catalog.implemented}/${report.catalog.rules} · Node ${report.run.versions.node}${report.run.versions.chrome ? ` · ${cleanLine(report.run.versions.chrome)}` : ''}${report.run.versions.lighthouse ? ` · Lighthouse ${cleanLine(report.run.versions.lighthouse)}` : ''}`, '');
  return lines.join('\n');
}

function verifyHint(task: Task): string {
  const base = `altimeter verify report.json --task ${task.id}`;
  return task.verifiableBy === 'local' ? `${base} --static <build directory>` : base;
}

function taskBody(report: Report, task: Task, language: Language, evidenceBudget: number): string {
  const t = ui(language);
  const rule = catalogRule(task.ruleId);
  const texts = rule ? ruleTexts(language, rule) : { title: task.title, why: '', fix: task.desired };
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  const lines: string[] = [`## ${task.id} · [${t.severities[task.severity]}] ${cleanLine(texts.title)}`, ''];
  lines.push(`- ${t.rule}: \`${task.ruleId}\` (${t.categories[task.category]})`);
  lines.push(`- ${t.page}: ${task.scopes.map(scope => untrustedInline(scopeLabel(scope), 160)).join(', ')}`);
  lines.push(`- ${t.whereToFix}: ${t.fixLocations[task.fixLocation]}`);
  lines.push(`- ${t.howToVerify}: ${t.verifications[task.verifiableBy]}`);
  lines.push(`- ${t.verifyCommand}: \`${verifyHint(task)}\``, '');
  const problem = findingMessage(language, task.ruleId, 'fail', task.reason, task.params) ?? task.problem;
  lines.push(`### ${t.problem}`, '', untrustedBlock(problem, 1500), '');
  if (texts.why) lines.push(cleanLine(texts.why, 700), '');
  lines.push(`### ${t.evidence}`, '');
  let used = 0;
  for (const id of task.evidence) {
    const item = evidence.get(id);
    if (!item) continue;
    const where = [item.url, item.line ? `line ${item.line}` : undefined, item.path].filter(Boolean).join(', ');
    const block = item.excerpt === undefined ? '' : `\n\n${untrustedBlock(item.excerpt, 1200)}`;
    const entry = `- \`${item.id}\` ${cleanLine(item.label)}${where ? ` (${cleanLine(where)})` : ''}${block}`;
    if (used + entry.length > evidenceBudget) {
      lines.push(`- … ${task.evidence.length} evidence items in report.json`);
      break;
    }
    used += entry.length;
    lines.push(entry);
  }
  lines.push('', `### ${t.desiredState}`, '', cleanLine(texts.fix, 700), '', `### ${t.acceptance}`, '');
  for (const check of task.acceptance) lines.push(`- ${format(t.acceptanceLine, { rule: check.ruleId, scope: untrustedInline(scopeLabel(check.scope), 160) })}`);
  if (task.mustRemainPassing.length > 0) {
    lines.push('', `### ${t.keepPassing}`, '');
    for (const check of task.mustRemainPassing) lines.push(`- \`${check.ruleId}\` · ${untrustedInline(scopeLabel(check.scope), 160)}`);
  }
  lines.push('', `### ${t.source}`, '');
  for (const source of task.sources) lines.push(`- <${source.url}> (${format(t.verified, { date: source.verified })})`);
  return lines.join('\n');
}

/** FIXES.md: every task in priority order, with the handling rules for untrusted text first. */
export function renderFixPlan(report: Report, language: Language): string {
  const t = ui(language);
  const header = [`# ${format(t.fixPlanTitle, { site: cleanLine(new URL(report.target.origin).host) })}`, '',
    format(t.generated, { version: report.tool.version, date: report.run.startedAt.slice(0, 10) }), '', ...t.fixPlanIntro.map(line => `- ${line}`), ''];
  if (report.tasks.length === 0) return [...header, t.noActions, ''].join('\n');
  return [...header, ...report.tasks.map(task => taskBody(report, task, language, 6000)), ''].join('\n\n');
}

/** Forge accepts task files up to 24,000 UTF-8 bytes. */
export const taskFileLimit = 24_000;

/** One task as a standalone file that a coding agent can take as its task. */
export function renderTaskFile(report: Report, task: Task, language: Language): string {
  const t = ui(language);
  const intro = t.fixPlanIntro.map(line => `- ${line}`).join('\n');
  for (const budget of [12_000, 6000, 2000, 0]) {
    const text = `${intro}\n\n${taskBody(report, task, language, budget)}\n`;
    if (Buffer.byteLength(text, 'utf8') <= taskFileLimit) return text;
  }
  return `${intro}\n\n## ${task.id}\n\nSee report.json for this task.\n`;
}
