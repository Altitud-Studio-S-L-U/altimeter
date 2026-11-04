import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Language } from '../i18n/messages.ts';
import { renderHtml } from './html.ts';
import { renderFixPlan, renderMarkdown, renderTaskFile } from './markdown.ts';
import type { Report } from './model.ts';

const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/** A folder name for a host that is valid on Windows, macOS and Linux. */
export function safeFolderName(value: string): string {
  const cleaned = value.toLowerCase().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 100) || 'site';
  return reservedNames.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function runFolderName(startedAt: Date): string {
  return startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z').replace('T', '-');
}

export function reportDirectory(base: string, origin: string, startedAt: Date): string {
  return join(base, safeFolderName(new URL(origin).host), runFolderName(startedAt));
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export interface WrittenReport {
  readonly directory: string;
  readonly files: readonly string[];
}

/** Writes report.json, report.md, FIXES.md and one file per task. Paths in the files are never absolute. */
export async function writeReport(directory: string, report: Report, language: Language): Promise<WrittenReport> {
  await mkdir(join(directory, 'tasks'), { recursive: true });
  const files: Array<[string, string]> = [
    ['report.json', `${JSON.stringify(report, null, 2)}\n`],
    ['report.html', renderHtml(report, language)],
    ['report.md', renderMarkdown(report, language)],
    ['FIXES.md', renderFixPlan(report, language)],
    ...report.tasks.map(task => [join('tasks', `${task.id}.md`), renderTaskFile(report, task, language)] as [string, string]),
  ];
  for (const [name, content] of files) await writeFile(join(directory, name), content, 'utf8');
  return { directory, files: files.map(([name]) => name) };
}
