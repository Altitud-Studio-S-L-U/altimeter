import type { AiFinding, ProviderSummary, ReportAnalysis } from '../ai/types.ts';
import { rule as catalogRule, myths } from '../catalog/index.ts';
import type { EvidenceItem } from '../core/evidence.ts';
import { categories, type Category } from '../core/types.ts';
import { evidenceLabelText, quotedEvidenceLabel } from '../i18n/evidence.ts';
import { formatNumber } from '../i18n/format.ts';
import { filledMessage, findingMessage, format, placeholders, ruleTexts, type Language } from '../i18n/messages.ts';
import { ui } from '../i18n/ui.ts';
import { localizeValue } from '../i18n/values.ts';
import type { FindingScope } from '../rules/engine.ts';
import { scoreFormula, severityWeights } from '../score/score.ts';
import type { Report, ReportFinding } from './model.ts';
import { cleanLine, markdownText, untrustedBlock, untrustedInline } from './sanitize.ts';
import type { Task } from './tasks.ts';

export function scopeLabel(scope: FindingScope): string {
  return scope.kind === 'page' ? scope.url : scope.origin;
}

/** Where an evidence item was observed: its URL, line and path. */
export function evidenceWhere(item: Pick<EvidenceItem, 'url' | 'line' | 'path'>, language: Language): string {
  return [item.url, item.line ? format(ui(language).lineNumber, { line: item.line }, language) : undefined, item.path].filter(Boolean).join(', ');
}

/** Where an evidence item was observed, for Markdown: the URL and the path come from the site, so both are quoted. */
function evidenceWhereMarkdown(item: Pick<EvidenceItem, 'url' | 'line' | 'path'>, language: Language): string {
  return [item.url ? untrustedInline(item.url, 300) : undefined, item.line ? format(ui(language).lineNumber, { line: item.line }, language) : undefined, item.path ? untrustedInline(item.path, 200) : undefined]
    .filter(Boolean).join(', ');
}

function evidenceLine(item: EvidenceItem, language: Language): string {
  const where = evidenceWhereMarkdown(item, language);
  const excerpt = item.excerpt === undefined ? '' : `: ${untrustedInline(item.excerpt, 240)}`;
  return `${markdownText(evidenceLabelText(language, item))}${where ? ` (${where})` : ''}${excerpt}`;
}

/** A rule's title in `language`, or `fallback` for a rule the catalog no longer has. */
export function ruleTitle(language: Language, ruleId: string, fallback: string): string {
  const rule = catalogRule(ruleId);
  return rule ? ruleTexts(language, rule).title : fallback;
}

/** The score formula in `language` when the report used the current one; an older report keeps its own words. */
export function formulaText(report: Report, language: Language): string {
  return report.score.formula === scoreFormula ? ui(language).scoreFormula : report.score.formula;
}

/** The page type a report shows, in `language`. */
export function pageTypeText(pageType: string, language: Language): string {
  return (ui(language).pageTypes as Readonly<Record<string, string>>)[pageType] ?? pageType;
}

/** Why a file was picked for a task, in `language`: each reason is a pattern of the `fileReason` value catalog. */
export function fileReasonText(reason: string, language: Language): string {
  return reason.split('; ').map(part => localizeValue(language, 'fileReason', part)).join('; ');
}

function message(language: Language, finding: ReportFinding): string {
  return findingMessage(language, finding.ruleId, 'fail', finding.reason, finding.params) ?? finding.message ?? finding.title;
}

/** The myths list in the public repository, for readers of a report who do not have the package's docs at hand. */
export const mythsListUrl = 'https://github.com/Altitud-Studio-S-L-U/altimeter/blob/main/docs/rules.md#myths';

const providerNames = { claude: 'Claude Code', codex: 'Codex' } as const;

export function providerLabel(summary: ProviderSummary | undefined, nobody: string): string {
  return summary ? `${providerNames[summary.name]} ${summary.cliVersion}${summary.model ? ` (${summary.model})` : ''}` : nobody;
}

/** One line on what the analysis kept and what it cost; for a dry run, how many calls it planned and that none ran. */
export function analysisSummary(analysis: ReportAnalysis, language: Language): string {
  const strings = ui(language).analysis;
  const planned = analysis.calls.filter(call => call.status === 'planned').length;
  if (planned > 0 && planned === analysis.calls.length) return format(strings.dryRunLine, { calls: planned }, language);
  const calls = analysis.calls.filter(call => call.status !== 'skipped' && call.status !== 'planned');
  // Codex reports no cost, so a total of zero there means unknown rather than free.
  const priced = calls.some(call => call.costUsd !== undefined);
  const cost = formatNumber(analysis.costUsd, language, '::.00');
  return format(strings.summaryLine, {
    findings: analysis.findings.filter(finding => finding.outcome === 'fail').length, proposals: analysis.proposals.length,
    judgments: analysis.findings.length + analysis.confirmations.length, calls: calls.length,
    cached: calls.filter(call => call.status === 'cached').length,
    costPart: priced ? format(strings.costPart, { cost }, language) : '',
  }, language);
}

/**
 * The message of a model finding in `language`. One that confirms a code candidate reads the candidate's message,
 * values included. Any other has only the model's reason code, so it reads its rule's template only when that needs
 * no value, rather than show a placeholder.
 */
export function aiFindingMessage(finding: AiFinding, findings: readonly ReportFinding[], language: Language): string | undefined {
  const complete = (text: string | undefined) => (text !== undefined && placeholders(text).length === 0 ? text : undefined);
  const candidate = finding.candidateId === undefined ? undefined : findings.find(entry => entry.id === finding.candidateId);
  if (candidate) return filledMessage(language, candidate.ruleId, 'fail', candidate.reason, candidate.params) ?? complete(candidate.message);
  return filledMessage(language, finding.ruleId, 'fail', finding.reason, finding.params) ?? complete(finding.message);
}

function aiFindingLines(finding: AiFinding, language: Language, findings: readonly ReportFinding[]): string[] {
  const t = ui(language);
  const rule = catalogRule(finding.ruleId);
  const title = rule ? ruleTexts(language, rule).title : finding.title;
  const lines = [`- **[${t.severities[finding.severity ?? 'info']}] ${markdownText(title)}** (\`${finding.ruleId}\`) · ${untrustedInline(scopeLabel(finding.scope), 160)} · ${t.analysis.verification[finding.verification]}`];
  const text = aiFindingMessage(finding, findings, language);
  if (text) lines.push(`  ${markdownText(text, 600)}`);
  for (const quote of finding.quotes.slice(0, 3)) lines.push(`  - ${t.analysis.quote} (${markdownText(quote.evidenceId, 40)}): ${untrustedInline(quote.text, 240)}`);
  if (finding.notes[language]) lines.push(`  - ${t.analysis.notes}: ${untrustedInline(finding.notes[language], 240)}`);
  return lines;
}

/** The model analysis: verified findings, decisions on code candidates, proposals, and what was dropped or not run. */
function analysisLines(analysis: ReportAnalysis, language: Language, findings: readonly ReportFinding[]): string[] {
  const t = ui(language);
  const a = t.analysis;
  const lines = [`## ${a.title}`, '', a.intro, ''];
  lines.push(format(a.by, {
    analyst: markdownText(providerLabel(analysis.provider.analyst, a.nobody)), verifier: markdownText(providerLabel(analysis.provider.verifier, a.nobody)),
    pages: analysis.pages.map(page => untrustedInline(page, 120)).join(', ') || '-',
  }, language), '', cleanLine(analysisSummary(analysis, language)), '');
  lines.push(`### ${a.verified}`, '');
  const failures = analysis.findings.filter(finding => finding.outcome === 'fail');
  if (failures.length === 0) lines.push(a.none);
  for (const finding of failures) lines.push(...aiFindingLines(finding, language, findings));
  lines.push('');
  if (analysis.confirmations.length > 0) {
    lines.push(`### ${a.decisions}`, '');
    for (const decision of analysis.confirmations) {
      const rule = catalogRule(decision.ruleId);
      lines.push(`- ${markdownText(rule ? ruleTexts(language, rule).title : decision.ruleId)} (\`${decision.ruleId}\`) · ${untrustedInline(scopeLabel(decision.scope), 160)}: ${a.decision[decision.decision]}, ${a.verification[decision.verification]}`);
    }
    lines.push('');
  }
  if (analysis.proposals.length > 0) {
    lines.push(`### ${a.proposals}`, '');
    for (const proposal of analysis.proposals) {
      lines.push(`- **${a.proposalKinds[proposal.kind]}** · ${untrustedInline(proposal.scope, 160)}`);
      if (proposal.kind === 'json-ld') {
        lines.push('', untrustedBlock(proposal.jsonLd, 6000), '');
      } else {
        lines.push(`  ${untrustedInline(proposal.text, 400)}`);
        if (proposal.current) lines.push(`  - ${a.current}: ${untrustedInline(proposal.current, 400)}`);
      }
      if (proposal.notes[language]) lines.push(`  - ${a.notes}: ${untrustedInline(proposal.notes[language], 240)}`);
    }
    if (analysis.proposals.some(proposal => proposal.placeholders > 0)) lines.push('', a.ownerToSupply);
    lines.push('');
  }
  if (analysis.injectionCandidates.length > 0) {
    lines.push(`### ${a.injection}`, '', a.injectionIntro, '');
    for (const candidate of analysis.injectionCandidates) lines.push(`- ${untrustedInline(candidate.page, 160)} · ${markdownText(localizeValue(language, 'aiItem', candidate.where))}: ${untrustedInline(candidate.excerpt, 240)}`);
    lines.push('');
  }
  const unverified = analysis.unverified.filter(finding => finding.outcome === 'fail');
  if (unverified.length > 0) {
    lines.push(`### ${a.unverified}`, '', a.unverifiedIntro, '');
    for (const finding of unverified) lines.push(...aiFindingLines(finding, language, findings));
    lines.push('');
  }
  if (analysis.dropped.length > 0) {
    const byReason = new Map<string, number>();
    for (const claim of analysis.dropped) byReason.set(claim.reason, (byReason.get(claim.reason) ?? 0) + 1);
    lines.push(`### ${a.dropped}`, '', ...[...byReason].sort((x, y) => y[1] - x[1]).map(([reason, count]) => `- \`${cleanLine(reason)}\`: ${count}`), '');
  }
  if (analysis.skipped.length > 0) {
    lines.push(`### ${a.skipped}`, '', ...analysis.skipped.map(entry => `- ${cleanLine(entry.pass)} · ${untrustedInline(entry.page, 160)}: ${untrustedInline(entry.reason)}`), '');
  }
  if (analysis.warnings.length > 0) lines.push(`**${t.warnings}:**`, ...analysis.warnings.map(warning => `- ${markdownText(localizeValue(language, 'warning', warning))}`), '');
  return lines;
}

/** Failed checks to list: code findings, and candidates the model analysis confirmed. */
export function listedFailures(findings: readonly ReportFinding[]): ReportFinding[] {
  return findings.filter(finding => finding.outcome === 'fail' && (!finding.needsJudgment || finding.judgment === 'confirmed'))
    .sort((a, b) => severityWeights[b.severity ?? 'info'] - severityWeights[a.severity ?? 'info'] || a.ruleId.localeCompare(b.ruleId));
}

export function renderMarkdown(report: Report, language: Language): string {
  const t = ui(language);
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  const lines: string[] = [];
  const date = report.run.startedAt.slice(0, 10);
  lines.push(`# ${format(t.reportTitle, { site: cleanLine(new URL(report.target.origin).host) }, language)}`, '');
  lines.push(`${t.audited}: ${untrustedInline(report.target.url)} · ${format(t.generated, { version: report.tool.version, date }, language)}`, '');

  lines.push(`## ${t.summary}`, '', `| | ${t.score} |`, '| --- | --- |');
  lines.push(`| **${t.overall}** | ${report.score.overall ?? t.notScored} |`);
  for (const entry of report.score.categories) lines.push(`| ${t.categories[entry.category]} | ${entry.score ?? t.notScored} |`);
  lines.push('', `**${t.indexability}:** ${t.indexabilityStates[report.score.indexability]}`, '');
  lines.push(`**${t.coverage}:** ${format(t.coverageLine, { evaluated: report.coverage.evaluated, notEvaluated: report.coverage.notEvaluated, notApplicable: report.coverage.notApplicable }, language)}`);
  const missing = Object.entries(report.coverage.missingInputs);
  if (missing.length > 0) lines.push('', `${t.missingInputs}: ${missing.map(([input, count]) => `\`${input}\` (${count})`).join(', ')}`);
  if (report.run.warnings.length > 0) lines.push('', `**${t.warnings}:**`, ...report.run.warnings.map(warning => `- ${markdownText(localizeValue(language, 'warning', warning))}`));
  lines.push('');

  lines.push(`## ${t.topActions}`, '');
  if (report.tasks.length === 0) lines.push(t.noActions);
  for (const task of report.tasks.slice(0, 10)) {
    const rule = catalogRule(task.ruleId);
    const title = rule ? ruleTexts(language, rule).title : task.title;
    lines.push(`${task.priority}. **[${t.severities[task.severity]}]** ${markdownText(title)} · ${task.scopes.length} · \`${task.id}\``);
  }
  lines.push('');

  lines.push(`## ${t.findings}`, '');
  const failures = listedFailures(report.findings);
  for (const category of categories as readonly Category[]) {
    lines.push(`### ${t.categories[category]}`, '');
    const inCategory = failures.filter(finding => finding.category === category);
    if (inCategory.length === 0) lines.push(t.noFindings, '');
    for (const finding of inCategory) {
      const rule = catalogRule(finding.ruleId);
      const texts = rule ? ruleTexts(language, rule) : { title: finding.title, fix: '', why: '' };
      const mark = finding.judgment === 'confirmed' ? ` · ${t.analysis.confirmedMark}` : '';
      lines.push(`- **[${t.severities[finding.severity ?? 'info']}] ${markdownText(texts.title)}** (\`${finding.ruleId}\`) · ${untrustedInline(scopeLabel(finding.scope), 160)}${mark}`);
      lines.push(`  ${markdownText(message(language, finding), 600)}`);
      for (const id of finding.evidence.slice(0, 4)) {
        const item = evidence.get(id);
        if (item) lines.push(`  - ${t.evidence}: ${evidenceLine(item, language)}`);
      }
      if (texts.fix) lines.push(`  - ${t.fix}: ${markdownText(texts.fix, 700)}`);
      for (const source of rule?.sources.slice(0, 2) ?? []) lines.push(`  - ${t.source}: <${source.url}> (${format(t.verified, { date: source.verified }, language)})`);
    }
    if (inCategory.length > 0) lines.push('');
  }

  const pending = report.findings.filter(finding => finding.needsJudgment && finding.judgment === undefined);
  if (pending.length > 0) {
    lines.push(`## ${t.pendingReview}`, '', t.pendingReviewIntro, '');
    for (const finding of pending) lines.push(`- ${markdownText(ruleTitle(language, finding.ruleId, finding.title))} (\`${finding.ruleId}\`) · ${untrustedInline(scopeLabel(finding.scope), 160)}`);
    lines.push('');
  }
  if (report.ai) lines.push(...analysisLines(report.ai, language, report.findings));

  const notEvaluated = report.findings.filter(finding => finding.outcome === 'not_evaluated');
  if (notEvaluated.length > 0) {
    lines.push(`## ${t.notEvaluated}`, '');
    const byReason = new Map<string, number>();
    for (const finding of notEvaluated) byReason.set(finding.reason ?? 'unknown', (byReason.get(finding.reason ?? 'unknown') ?? 0) + 1);
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) lines.push(`- ${untrustedInline(reason)}: ${count}`);
    lines.push('');
  }

  lines.push(`## ${t.pages}`, '', `| ${t.page} | ${t.status} | ${t.type} | ${t.rendered} |`, '| --- | --- | --- | --- |');
  for (const page of report.pages) lines.push(`| ${untrustedInline(page.finalUrl, 160)} | ${page.status ?? '-'} | ${cleanLine(pageTypeText(page.pageType, language))} | ${page.rendered ? t.yes : t.no} |`);
  lines.push('', `## ${t.method}`, '', t.methodIntro, '', markdownText(formulaText(report, language), 1200), '');
  lines.push(`${format(t.mythsLine, { count: myths.length }, language)} <${mythsListUrl}>`, '');
  const catalog = format(t.catalogLine, { hash: `\`${cleanLine(report.catalog.hash.slice(0, 12))}\``, implemented: report.catalog.implemented, rules: report.catalog.rules }, language);
  lines.push(`${catalog} · Node ${report.run.versions.node}${report.run.versions.chrome ? ` · ${markdownText(report.run.versions.chrome)}` : ''}${report.run.versions.lighthouse ? ` · Lighthouse ${markdownText(report.run.versions.lighthouse)}` : ''}`, '');
  return lines.join('\n');
}

function verifyHint(task: Task, language: Language): string {
  const base = `altimeter verify report.json --task ${task.id}`;
  return task.verifiableBy === 'local' ? `${base} --static <${ui(language).buildDirectory}>` : base;
}

function taskBody(report: Report, task: Task, language: Language, evidenceBudget: number): string {
  const t = ui(language);
  const rule = catalogRule(task.ruleId);
  const texts = rule ? ruleTexts(language, rule) : undefined;
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  // For a rule the catalog does not have, the title and desired state come from report.json, which anyone can edit.
  const lines: string[] = [`## ${task.id} · [${t.severities[task.severity]}] ${texts ? cleanLine(texts.title) : untrustedInline(task.title, 160)}`, ''];
  lines.push(`- ${t.rule}: \`${task.ruleId}\` (${t.categories[task.category]})`);
  lines.push(`- ${task.scopes.every(scope => scope.kind === 'site') ? t.site : t.page}: ${task.scopes.map(scope => untrustedInline(scopeLabel(scope), 160)).join(', ')}`);
  lines.push(`- ${t.whereToFix}: ${t.fixLocations[task.fixLocation]}`);
  lines.push(`- ${t.howToVerify}: ${t.verifications[task.verifiableBy]}`);
  lines.push(`- ${t.verifyCommand}: \`${verifyHint(task, language)}\``, '');
  const problem = findingMessage(language, task.ruleId, 'fail', task.reason, task.params) ?? task.problem;
  lines.push(`### ${t.problem}`, '', untrustedBlock(problem, 1500), '');
  if (texts?.why) lines.push(cleanLine(texts.why, 700), '');
  lines.push(`### ${t.evidence}`, '');
  let used = 0;
  for (const id of task.evidence) {
    const item = evidence.get(id);
    if (!item) continue;
    const where = evidenceWhereMarkdown(item, language);
    const block = item.excerpt === undefined ? '' : `\n\n${untrustedBlock(item.excerpt, 1200)}`;
    const label = quotedEvidenceLabel(language, item, value => untrustedInline(value, 200));
    const entry = `- \`${item.id}\` ${label}${where ? ` (${where})` : ''}${block}`;
    if (used + entry.length > evidenceBudget) {
      lines.push(`- ${format(t.moreEvidence, { count: task.evidence.length }, language)}`);
      break;
    }
    used += entry.length;
    lines.push(entry);
  }
  lines.push('', `### ${t.desiredState}`, '', texts ? cleanLine(texts.fix, 700) : untrustedBlock(task.desired, 1500), '');
  if (task.files?.length || task.mustNotChange?.length) {
    lines.push(`### ${t.whereToLook}`, '');
    for (const file of task.files ?? []) lines.push(`- ${untrustedInline(file.path, 200)} · ${t.fileConfidence[file.confidence]} · ${cleanLine(fileReasonText(file.reason, language), 200)}`);
    for (const path of task.mustNotChange ?? []) lines.push(`- ${untrustedInline(path, 200)} · ${t.dataFile}`);
    lines.push('');
  }
  lines.push(`### ${t.acceptance}`, '');
  for (const check of task.acceptance) lines.push(`- ${format(t.acceptanceLine, { rule: check.ruleId, scope: untrustedInline(scopeLabel(check.scope), 160) }, language)}`);
  if (task.mustRemainPassing.length > 0) {
    lines.push('', `### ${t.keepPassing}`, '');
    for (const check of task.mustRemainPassing) lines.push(`- \`${check.ruleId}\` · ${untrustedInline(scopeLabel(check.scope), 160)}`);
  }
  lines.push('', `### ${t.source}`, '');
  for (const source of task.sources) lines.push(`- <${source.url}> (${format(t.verified, { date: source.verified }, language)})`);
  return lines.join('\n');
}

/** FIXES.md: every task in priority order, with the handling rules for untrusted text first. */
export function renderFixPlan(report: Report, language: Language): string {
  const t = ui(language);
  const header = [`# ${format(t.fixPlanTitle, { site: cleanLine(new URL(report.target.origin).host) }, language)}`, '',
    format(t.generated, { version: report.tool.version, date: report.run.startedAt.slice(0, 10) }, language), '', ...t.fixPlanIntro.map(line => `- ${line}`)].join('\n');
  if (report.tasks.length === 0) return `${header}\n\n${t.noActions}\n`;
  return `${[header, ...report.tasks.map(task => taskBody(report, task, language, 6000))].join('\n\n')}\n`;
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
  return `${intro}\n\n## ${task.id}\n\n${t.taskInReport}\n`;
}
