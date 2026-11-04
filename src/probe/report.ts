import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format, type Language } from '../i18n/messages.ts';
import { cleanLine, untrustedInline } from '../report/sanitize.ts';
import { runFolderName, safeFolderName } from '../report/write.ts';
import { probeStrings, type ProbeStrings } from './i18n.ts';
import { engineNames, stoppingFailures } from './run.ts';
import type { Count, EngineNotice, EngineSection, PlanNote, PlannedQuery, ProbePlan, ProbeReport, QueryMetrics, RunRecord, SiteNotice } from './types.ts';

/** The folder of one probe: <base>/<host>/ai-probe-<UTC time>, next to the host's audit reports. */
export function probeDirectory(base: string, origin: string, startedAt: Date): string {
  return join(base, safeFolderName(new URL(origin).host), `ai-probe-${runFolderName(startedAt)}`);
}

function originText(t: ProbeStrings, query: PlannedQuery): string {
  const origin = query.origin;
  switch (origin.kind) {
    case 'keyword':
      return t.origins.keyword;
    case 'search-console':
      return format(t.origins.searchConsole, { impressions: origin.impressions, clicks: origin.clicks, position: origin.position.toFixed(1), start: origin.start, end: origin.end });
    case 'inferred':
      return format(t.origins.inferred, { element: t.elements[origin.element], page: untrustedInline(origin.page, 200) });
    case 'brand':
      return format(t.origins.brand, { language: t.languageNames[origin.language] });
  }
}

export function planNoteText(t: ProbeStrings, note: PlanNote): string {
  switch (note.code) {
    case 'brand-left-out':
      return note.reason === 'no-name' ? t.brandNoName : note.reason === 'names-domain' ? t.brandNamesDomain : t.brandNoRoom;
    case 'search-console-failed':
      return format(t.searchConsoleFailed, { message: cleanLine(note.message, 300) });
    case 'search-console-empty':
      return t.searchConsoleEmpty;
    case 'inferred-fallback':
      return t.inferredFallback;
  }
}

/** A notice about the site; `url` writes the URL the home page redirects to, which the probed site chose. */
export function siteNoticeText(t: ProbeStrings, notice: SiteNotice, domain: string, url: (value: string) => string = value => cleanLine(value, 200)): string {
  return notice.code === 'home-unreadable'
    ? format(t.homeUnreadable, { reason: cleanLine(notice.reason, 100) })
    : format(t.homeRedirects, { to: url(notice.to), domain });
}

function engineNoticeText(t: ProbeStrings, notice: EngineNotice, section: EngineSection): string {
  const engine = engineNames[section.engine];
  switch (notice.code) {
    case 'unverified-version':
      return format(t.unverifiedVersion, { engine, version: cleanLine(notice.version, 60) });
    case 'stopped':
      return stoppingFailures.has(notice.reason)
        ? format(t.stopped, { engine, reason: t.failures[notice.reason] })
        : format(t.stoppedRepeated, { engine, count: notice.consecutive });
    case 'unrecognised-results':
      return format(t.unrecognisedResults, { runs: notice.runs });
  }
}

/** The label every section carries: engine, CLI version, model, search mode, locale, dates and runs per query. */
export function sectionLabel(t: ProbeStrings, section: EngineSection): string {
  const dates = section.firstRun === undefined ? t.noRuns : section.firstRun === section.lastRun ? section.firstRun : format(t.dateRange, { first: section.firstRun, last: section.lastRun ?? section.firstRun });
  return format(t.label, {
    engine: engineNames[section.engine],
    version: cleanLine(section.cliVersion ?? '?', 60),
    model: section.models.length > 0 ? section.models.map(model => cleanLine(model, 128)).join(', ') : t.modelNotReported,
    mode: t.modes[section.searchMode],
    locale: t.locales[section.locale],
    dates,
    runs: section.runsPerQuery,
  });
}

function caveats(t: ProbeStrings, section: EngineSection): string[] {
  return [
    t.notRepresentative,
    ...(section.engine === 'claude' ? [t.claudeLocale] : []),
    section.provenance === 'retrieval' ? t.claudeProvenance : t.codexProvenance,
  ];
}

function countTable(t: ProbeStrings, title: string, counts: readonly Count[], completed: number): string[] {
  if (counts.length === 0) return [];
  return [
    '',
    `| ${title} | ${t.runsColumn} |`,
    '| --- | --- |',
    ...counts.map(count => `| ${untrustedInline(count.value, 300)} | ${format(t.ofRuns, { k: count.runs, n: completed })} |`),
  ];
}

function queryBlock(t: ProbeStrings, query: PlannedQuery, metrics: QueryMetrics, section: EngineSection): string[] {
  const n = metrics.completed;
  const lines = [
    `#### ${query.id} · ${untrustedInline(query.text, 200)}`,
    '',
    `- ${format(t.runsLine, { completed: n, planned: metrics.planned, fromCache: metrics.fromCache, failed: metrics.failed, skipped: metrics.skipped })}`,
  ];
  if (n > 0) {
    lines.push(`- ${format(section.provenance === 'retrieval' ? t.citedRetrieval : t.citedReported, { k: metrics.cited, n })}`);
    if (metrics.citedUnconfirmed !== undefined && metrics.citedUnconfirmed > 0) lines.push(`- ${format(t.citedUnconfirmed, { k: metrics.citedUnconfirmed, n })}`);
    lines.push(`- ${format(t.mentioned, { k: metrics.brandMentioned, n })}`, `- ${format(t.searched, { k: metrics.searched, n })}`);
  }
  if (metrics.insufficientSample) lines.push(`- ${t.insufficient}`);
  lines.push(
    ...countTable(t, t.siteUrls, metrics.siteUrls, n),
    ...countTable(t, t.retrievedNotCited, metrics.retrievedNotCited ?? [], n),
    ...countTable(t, t.competitors, metrics.competitors, n),
    ...countTable(t, t.citedNotRetrieved, metrics.citedNotRetrieved ?? [], n),
    '',
  );
  return lines;
}

function runDetail(t: ProbeStrings, run: RunRecord): string {
  if (run.error) return `${t.failures[run.error.code]} (\`${run.error.code}\`)`;
  if (run.skipped) return t.skips[run.skipped];
  return run.mention ? format(t.mentionDetail, { text: untrustedInline(run.mention, 200) }) : '';
}

function engineBlock(t: ProbeStrings, report: ProbeReport, section: EngineSection): string[] {
  const lines = [`## ${engineNames[section.engine]}`, ''];
  if (section.status === 'unavailable') {
    return [...lines, format(t.unavailable, { engine: engineNames[section.engine], problem: cleanLine(section.problem ?? '', 300) }), ''];
  }
  const label = sectionLabel(t, section);
  lines.push(label, '', caveats(t, section).map(text => `> ${text}`).join('\n>\n'), '');
  for (const notice of section.notices) lines.push(`- ${engineNoticeText(t, notice, section)}`);
  if (section.notices.length > 0) lines.push('');
  const groups = [
    { title: t.visibility, queries: report.queries.filter(query => query.class !== 'brand'), intro: undefined },
    { title: t.brandSection, queries: report.queries.filter(query => query.class === 'brand'), intro: t.brandIntro },
  ];
  for (const group of groups) {
    if (group.queries.length === 0) continue;
    lines.push(`### ${group.title}`, '', label, '');
    if (group.intro) lines.push(group.intro, '');
    for (const query of group.queries) {
      const metrics = section.queries.find(entry => entry.queryId === query.id);
      if (metrics) lines.push(...queryBlock(t, query, metrics, section));
    }
  }
  lines.push(`### ${t.runs}`, '', label, '', `| ${t.runTable.join(' | ')} |`, `| ${t.runTable.map(() => '---').join(' | ')} |`);
  for (const run of section.runs) {
    lines.push(`| ${run.queryId} | ${run.run} | ${t.statuses[run.status]} | ${run.at?.slice(0, 10) ?? ''} | ${run.searches ?? ''} | ${runDetail(t, run)} |`);
  }
  lines.push('');
  if (section.costUsd !== undefined) {
    const calls = section.runs.filter(run => run.status === 'ok').length;
    lines.push(format(t.cost, { cost: section.costUsd.toFixed(2), calls }), '');
  }
  return lines;
}

/**
 * The probe as Markdown. Every value that came from an engine, the web, Search Console or the site is cleaned and
 * written as inline code, so no link is clickable and nothing can open a heading, a table cell or an HTML tag.
 */
export function renderProbeMarkdown(report: ProbeReport, language: Language): string {
  const t = probeStrings(language);
  const lines = [
    `# ${format(t.title, { site: cleanLine(new URL(report.site.origin).host, 200) })}`,
    '',
    format(t.generated, { version: report.tool.version, date: report.generatedAt.slice(0, 10), prompt: report.promptVersion }),
    '',
    t.intro,
    '',
    t.untrusted,
    '',
    `## ${t.queries}`,
    '',
    `| ${t.queryTable.join(' | ')} |`,
    '| --- | --- | --- | --- |',
    ...report.queries.map(query => `| ${query.id} | ${untrustedInline(query.text, 200)} | ${t.classes[query.class]} | ${originText(t, query)} |`),
    '',
  ];
  const notes = [...report.notes.map(note => planNoteText(t, note)), ...report.siteNotices.map(notice => siteNoticeText(t, notice, report.site.domain, url => untrustedInline(url, 200)))];
  if (notes.length > 0) lines.push(`### ${t.notesTitle}`, '', ...notes.map(note => `- ${note}`), '');
  for (const section of report.engines) lines.push(...engineBlock(t, report, section));
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

/** Writes probe.json and probe.md. The files hold no local path: runs point to cache entries by key. */
export async function writeProbeReport(directory: string, report: ProbeReport, language: Language): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  const files: Array<[string, string]> = [
    ['probe.json', `${JSON.stringify(report, null, 2)}\n`],
    ['probe.md', renderProbeMarkdown(report, language)],
  ];
  for (const [name, content] of files) await writeFile(join(directory, name), content, 'utf8');
  return files.map(([name]) => name);
}

/** The plan as the terminal shows it before anything is sent. Queries are cleaned to one line each. */
export function renderPlan(plan: ProbePlan, language: Language): string {
  const t = probeStrings(language);
  const lines = [
    format(t.title, { site: cleanLine(new URL(plan.site.origin).host, 200) }),
    format(t.planEngines, { engines: plan.engines.map(engine => engineNames[engine]).join(', ') }),
    format(t.planRuns, { runs: plan.runsPerQuery }),
    t.planQueries,
    ...plan.queries.map(query => `  ${query.id} [${t.classes[query.class]}] ${cleanLine(query.text, 200)}`),
    ...plan.notes.map(note => `  ${planNoteText(t, note)}`),
    ...plan.site.notices.map(notice => `  ${siteNoticeText(t, notice, plan.site.domain)}`),
    format(t.planCalls, { calls: plan.calls, queries: plan.queries.length, runs: plan.runsPerQuery, engines: plan.engines.length }),
    t.planQuota,
    ...(plan.queries.some(query => query.class === 'search-console') ? [t.planSearchConsole] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/** One line per engine for the terminal once the probe has run, with what the report explains about it. */
export function renderSummary(report: ProbeReport, language: Language): string {
  const t = probeStrings(language);
  return `${report.engines.flatMap(section => {
    const engine = engineNames[section.engine];
    if (section.status === 'unavailable') return [format(t.summaryUnavailable, { engine, problem: cleanLine(section.problem ?? '', 200) })];
    const count = (status: RunRecord['status']) => section.runs.filter(run => run.status === status).length;
    return [
      format(t.summary, { engine, completed: count('ok') + count('cached'), planned: section.runs.length, fromCache: count('cached'), failed: count('failed'), skipped: count('skipped') }),
      ...section.notices.map(notice => `  ! ${engineNoticeText(t, notice, section)}`),
    ];
  }).join('\n')}\n`;
}
