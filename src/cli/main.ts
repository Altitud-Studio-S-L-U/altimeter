#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { audit, auditExitCode } from '../audit.ts';
import { rule as catalogRule, rules as catalogRules } from '../catalog/index.ts';
import { categories, type Category } from '../core/types.ts';
import { ruleTexts, type Language } from '../i18n/messages.ts';
import { ui } from '../i18n/ui.ts';
import { findChrome } from '../render/chrome.ts';
import { compareReports } from '../report/compare.ts';
import type { Report } from '../report/model.ts';
import { cleanLine } from '../report/sanitize.ts';
import { reportDirectory, writeReport } from '../report/write.ts';
import { version } from '../version.ts';

export const help = `Altimeter ${version}: evidence-based SEO audits.

Usage:
  altimeter audit <url> [options]                  Audit a page and its site context.
  altimeter render <report.json> --lang <en|es|ca>  Write a report again in another language.
  altimeter compare <before.json> <after.json>     Show fixed, new and remaining problems.
  altimeter rules [--category <name>] [--stale]    List the rule catalog.
  altimeter explain <rule-id>                      Show a rule and its sources.
  altimeter doctor                                 Check Node.js and Chrome.
  altimeter --version                              Print the version.

Audit options:
  --lang <en|es|ca>          Report language (default en).
  --out <dir>                Parent folder for reports (default ./altimeter-report).
  --no-render                Skip Chrome rendering and Lighthouse.
  --no-lighthouse            Skip Lighthouse.
  --lab-runs <1-7>           Lighthouse runs; the median run is kept (default 3).
  --fail-on <level>          Exit 1 when a check fails at critical, high, medium or low (default none).
  --allow-private-network    Allow private and loopback addresses, for local or staging sites.
  --quiet                    Print only the report folder.

Field data from the Chrome UX Report is queried when ALTIMETER_GOOGLE_API_KEY holds a Google Cloud API key
with the Chrome UX Report API enabled. The key is sent in a header to Google only.

Exit status: 0 done, 1 a check failed at --fail-on or above, 2 error, 3 the page could not be audited.
`;

const languages: readonly Language[] = ['en', 'es', 'ca'];
const failLevels = ['critical', 'high', 'medium', 'low', 'none'] as const;

class UsageError extends Error {}

function language(value: string | undefined): Language {
  const chosen = (value ?? 'en') as Language;
  if (!languages.includes(chosen)) throw new UsageError('--lang must be en, es or ca.');
  return chosen;
}

async function readReport(path: string): Promise<Report> {
  const report = JSON.parse(await readFile(path, 'utf8')) as Report;
  if (report?.schemaVersion !== 1 || report.tool?.name !== 'altimeter') throw new UsageError(`${path} is not an Altimeter report.`);
  return report;
}

async function auditCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      lang: { type: 'string' }, out: { type: 'string' }, 'no-render': { type: 'boolean' }, 'no-lighthouse': { type: 'boolean' },
      'lab-runs': { type: 'string' }, 'fail-on': { type: 'string' }, 'allow-private-network': { type: 'boolean' }, quiet: { type: 'boolean' },
    },
  });
  if (positionals.length !== 1) throw new UsageError('audit needs exactly one URL.');
  let url: URL;
  try {
    url = new URL(positionals[0]!);
  } catch {
    throw new UsageError('The URL must be absolute, for example https://example.com/.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('Only http and https URLs can be audited.');
  const failOn = (values['fail-on'] ?? 'none') as (typeof failLevels)[number];
  if (!failLevels.includes(failOn)) throw new UsageError('--fail-on must be critical, high, medium, low or none.');
  const labRuns = values['lab-runs'] === undefined ? 3 : Number(values['lab-runs']);
  if (!Number.isInteger(labRuns) || labRuns < 1 || labRuns > 7) throw new UsageError('--lab-runs must be a whole number from 1 to 7.');
  const lang = language(values.lang);
  const quiet = values.quiet === true;
  const log = quiet ? undefined : (message: string) => process.stderr.write(`· ${cleanLine(message)}\n`);
  const recordedOptions = { render: values['no-render'] !== true, lighthouse: values['no-lighthouse'] !== true && values['no-render'] !== true, labRuns, failOn, allowPrivateNetwork: values['allow-private-network'] === true };
  const result = await audit({
    url: url.href,
    language: lang,
    ...(values['allow-private-network'] ? { policy: { allowPrivate: true } } : {}),
    render: values['no-render'] !== true,
    lighthouse: recordedOptions.lighthouse,
    labRuns,
    ...(process.env.ALTIMETER_GOOGLE_API_KEY ? { cruxKey: process.env.ALTIMETER_GOOGLE_API_KEY } : {}),
    ...(log ? { log } : {}),
    recordedOptions,
  });
  const directory = reportDirectory(resolve(values.out ?? 'altimeter-report'), result.report.target.origin, new Date(result.report.run.startedAt));
  await writeReport(directory, result.report, lang);
  const shown = relative(process.cwd(), directory) || '.';
  if (quiet) {
    process.stdout.write(`${shown}\n`);
  } else {
    const t = ui(lang);
    const { score, coverage, tasks } = result.report;
    process.stdout.write(`\nAltimeter ${version} · ${cleanLine(result.report.target.url)}\n`);
    process.stdout.write(`${t.score} ${score.overall ?? t.notScored} · ${t.indexability}: ${t.indexabilityStates[score.indexability]}\n`);
    process.stdout.write(`${cleanLine(`${coverage.evaluated} / ${coverage.notEvaluated} / ${coverage.notApplicable}`)} (${t.coverage.toLowerCase()})\n`);
    if (tasks.length > 0) process.stdout.write(`\n${t.topActions}:\n`);
    for (const task of tasks.slice(0, 5)) {
      const rule = catalogRule(task.ruleId);
      process.stdout.write(`  ${task.priority}. [${t.severities[task.severity]}] ${cleanLine(rule ? ruleTexts(lang, rule).title : task.title, 120)} (${task.id})\n`);
    }
    for (const warning of result.report.run.warnings) process.stderr.write(`! ${cleanLine(warning)}\n`);
    process.stdout.write(`\n${shown}${process.platform === 'win32' ? '\\' : '/'}report.md\n`);
  }
  return auditExitCode(result, failOn);
}

async function renderCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { lang: { type: 'string' }, out: { type: 'string' } } });
  if (positionals.length !== 1) throw new UsageError('render needs the path of a report.json.');
  const path = resolve(positionals[0]!);
  const report = await readReport(path);
  const lang = language(values.lang);
  const directory = values.out ? resolve(values.out) : dirname(path);
  await writeReport(directory, { ...report, run: { ...report.run, language: lang } }, lang);
  process.stdout.write(`${relative(process.cwd(), directory) || '.'}\n`);
  return 0;
}

async function compareCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
  if (positionals.length !== 2) throw new UsageError('compare needs two report.json paths: before and after.');
  const comparison = compareReports(await readReport(resolve(positionals[0]!)), await readReport(resolve(positionals[1]!)));
  const list = (label: string, findings: typeof comparison.fixed) => {
    process.stdout.write(`${label}: ${findings.length}\n`);
    for (const finding of findings) process.stdout.write(`  ${finding.ruleId} · ${cleanLine(finding.scope.kind === 'page' ? finding.scope.url : finding.scope.origin, 160)}\n`);
  };
  list('Fixed', comparison.fixed);
  list('New', comparison.introduced);
  list('Remaining', comparison.remaining);
  if (comparison.notComparable.length > 0) list('Not comparable (evaluated in only one report)', comparison.notComparable);
  return comparison.introduced.length > 0 ? 1 : 0;
}

function rulesCommand(args: string[]): number {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { category: { type: 'string' }, stale: { type: 'boolean' }, lang: { type: 'string' } } });
  const lang = language(values.lang);
  if (values.category !== undefined && !categories.includes(values.category as Category)) throw new UsageError(`--category must be one of ${categories.join(', ')}.`);
  const cutoff = Date.now() - 180 * 86_400_000;
  for (const entry of catalogRules) {
    if (values.category && entry.category !== values.category) continue;
    if (values.stale && !entry.sources.some(source => Date.parse(source.verified) < cutoff)) continue;
    process.stdout.write(`${entry.id}\t${entry.maxSeverity}\t${entry.status}\t${ruleTexts(lang, entry).title}\n`);
  }
  return 0;
}

function explainCommand(args: string[]): number {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { lang: { type: 'string' } } });
  if (positionals.length !== 1) throw new UsageError('explain needs a rule id, for example crawl-meta-robots-noindex.');
  const entry = catalogRule(positionals[0]!);
  if (!entry) throw new UsageError(`No rule ${positionals[0]}. List them with "altimeter rules".`);
  const texts = ruleTexts(language(values.lang), entry);
  process.stdout.write([
    `${entry.id} · ${entry.category} · max ${entry.maxSeverity} · ${entry.status}`,
    texts.title, '', texts.why, '', `Fix: ${texts.fix}`, '', `Thresholds: ${entry.thresholds}`, '',
    ...entry.sources.map(source => `Source: ${source.url} (verified ${source.verified})`), '',
  ].join('\n'));
  return 0;
}

function doctorCommand(): number {
  const chrome = findChrome();
  const major = Number(process.versions.node.split('.')[0]);
  process.stdout.write(`Node.js ${process.versions.node}${major >= 24 ? '' : ' (Altimeter needs 24 or newer)'}\n`);
  process.stdout.write(`Chrome: ${chrome ? 'found' : 'not found; set CHROME_PATH to enable rendering and Lighthouse'}\n`);
  process.stdout.write(`Chrome UX Report key: ${process.env.ALTIMETER_GOOGLE_API_KEY ? 'set' : 'not set (lab data only)'}\n`);
  return major >= 24 ? 0 : 2;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
      process.stdout.write(help);
      return 0;
    }
    if (command === '--version' || command === '-v') {
      process.stdout.write(`${version}\n`);
      return 0;
    }
    switch (command) {
      case 'audit': return await auditCommand(rest);
      case 'render': return await renderCommand(rest);
      case 'compare': return await compareCommand(rest);
      case 'rules': return rulesCommand(rest);
      case 'explain': return explainCommand(rest);
      case 'doctor': return doctorCommand();
      default:
        throw new UsageError(`Unknown command: ${command}. Run "altimeter --help".`);
    }
  } catch (error) {
    const message = error instanceof UsageError || error instanceof TypeError ? error.message : error instanceof Error ? error.message : 'Unexpected error';
    process.stderr.write(`${cleanLine(message, 500)}\n`);
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) process.exitCode = await main();
