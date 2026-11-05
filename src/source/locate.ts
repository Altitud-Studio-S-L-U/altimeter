import { readdir } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { EvidenceItem } from '../core/evidence.ts';
import { readRegularFile } from '../core/files.ts';
import type { Report } from '../report/model.ts';
import type { FileCandidate, Task } from '../report/tasks.ts';

/** Folders that hold dependencies, builds or caches rather than the site's own sources. */
const skippedFolders = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.astro', '.svelte-kit', '.vercel', '.netlify',
  '.wrangler', '.turbo', '.cache', 'coverage', 'vendor', '.idea', '.vscode',
]);
const codeExtensions = new Set(['.astro', '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.vue', '.svelte', '.html', '.htm', '.php', '.njk', '.liquid', '.hbs', '.erb', '.twig', '.ejs']);
const dataExtensions = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.md', '.mdx', '.csv', '.txt']);
/** Files that configure how the platform answers: redirects, headers, trailing slashes and sitemaps. */
const platformFiles = new Set([
  'astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'nuxt.config.ts', 'nuxt.config.js',
  'svelte.config.js', 'gatsby-config.js', 'vercel.json', 'netlify.toml', 'wrangler.json', 'wrangler.jsonc', 'wrangler.toml', '_headers', '_redirects', '.htaccess',
]);
/** Tests and project documentation describe the site; the fix is never in them. */
const testFolder = /(?:^|\/)(?:tests?|__tests__|spec|e2e|cypress|playwright|docs|\.github)\//u;
const testFile = /\.(?:test|spec)\.[a-z]+$/u;
const testPath = (path: string) => testFolder.test(path) || testFile.test(path);
const projectDocument = /^(?:readme|changelog|contributing|license|security|code_of_conduct|claude|agents|gemini)(?:\.[a-z]+)?$/iu;
const maxFileBytes = 512 * 1024;
const maxFiles = 20_000;
const nul = String.fromCharCode(0);

interface SourceFile {
  readonly path: string;
  readonly name: string;
  readonly text: string;
  readonly kind: 'code' | 'data' | 'platform';
}

/** Reads the repository's source files, read-only, skipping dependencies, builds, secrets, binaries and symbolic links. */
async function sourceFiles(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedFolders.has(entry.name)) await visit(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith('.env') || projectDocument.test(entry.name)) continue;
      if (testPath(relative(root, full).split(sep).join('/'))) continue;
      const extension = extname(entry.name).toLowerCase();
      const kind = platformFiles.has(entry.name) ? 'platform' : codeExtensions.has(extension) ? 'code' : dataExtensions.has(extension) ? 'data' : undefined;
      if (!kind) continue;
      const read = await readRegularFile(full, maxFileBytes);
      if ('problem' in read || read.text.includes(nul)) continue;
      files.push({ path: relative(root, full).split(sep).join('/'), name: entry.name, text: read.text, kind });
    }
  };
  await visit(root);
  return files;
}

/** Markup and configuration words that point to where a rule's fix is written. */
const ruleTokens: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^schema-breadcrumb/u, ['BreadcrumbList', 'itemListElement']],
  [/^schema-organization/u, ['Organization', 'sameAs']],
  [/^schema-site-name/u, ['WebSite', 'alternateName']],
  [/^schema-faqpage/u, ['FAQPage']],
  [/^schema-localbusiness/u, ['LocalBusiness']],
  [/^schema-/u, ['application/ld+json']],
  [/sitemap/u, ['@astrojs/sitemap', 'sitemap', 'lastmod']],
  [/canonical/u, ['rel="canonical"', 'canonical']],
  [/^(crawl-host-variant|crawl-redirect|tech-http-to-https|tech-https)/u, ['trailingSlash', 'trailing_slash', 'html_handling', 'redirect']],
  [/^(crawl-robots|ai-robots)/u, ['robots.txt', 'User-agent']],
  [/^(crawl-meta-robots|crawl-noindex|crawl-snippet)/u, ['noindex', 'X-Robots-Tag']],
  [/^intl-hreflang/u, ['hreflang']],
  [/^tech-(hsts|security|framing)/u, ['Strict-Transport-Security', 'Content-Security-Policy', 'X-Frame-Options']],
  [/^tech-social/u, ['og:image', 'og:title', 'twitter:card']],
  [/^tech-favicon/u, ['apple-touch-icon', 'rel="icon"']],
  [/^tech-viewport/u, ['name="viewport"']],
  [/^content-meta-description/u, ['name="description"']],
  [/^perf-lcp/u, ['fetchpriority', 'loading=']],
];

/** Rule families whose fix usually lives in the platform's configuration rather than in a template. */
const platformRules = /^(crawl-host-variant|crawl-redirect|tech-http-to-https|tech-https|tech-hsts|tech-security|tech-framing)/u;
/** Text that appears in more files than this, such as the site's name, does not tell them apart. */
const commonText = 5;
/** Utility classes that name a style, not a component, so they never point to a file. */
const utilityClass = /^(?:[a-z]{1,3}-|block$|flex$|grid$|hidden$|relative$|absolute$|container$|w-|h-|max-|min-|text-|bg-|mx-|my-|px-|py-|mt-|mb-|gap-)/u;
const separators = /\s+[|\u2013\u2014\u00b7:-]\s+/u;

function literalNeedles(items: readonly EvidenceItem[]): string[] {
  const needles = new Set<string>();
  for (const item of items) {
    for (const line of (item.excerpt ?? '').split('\n')) {
      const text = line.trim();
      if (/^https?:\/\//u.test(text) || /^[\d\s.,:%-]+$/u.test(text)) continue;
      if (text.length >= 12 && text.length <= 200) needles.add(text);
      for (const segment of text.split(separators)) if (segment.trim().length >= 8 && segment.trim() !== text) needles.add(segment.trim());
    }
  }
  return [...needles].slice(0, 20);
}

/** Component-like class and id names from the selectors and markup the evidence cites. */
function componentNames(items: readonly EvidenceItem[]): string[] {
  const names = new Set<string>();
  for (const item of items) {
    const fromPath = (item.path ?? '').match(/[.#][A-Za-z][\w-]{3,}/gu) ?? [];
    const fromMarkup = [...(item.excerpt ?? '').matchAll(/\b(?:class|id)="([^"]+)"/gu)].flatMap(match => match[1]!.split(/\s+/u));
    for (const name of [...fromPath.map(entry => entry.slice(1)), ...fromMarkup]) {
      if (name.length >= 4 && !utilityClass.test(name) && /[-_]|[a-z][A-Z]/u.test(name)) names.add(name);
    }
  }
  return [...names].slice(0, 10);
}

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, '');

interface Score {
  score: number;
  readonly reasons: string[];
  structural: boolean;
  literal: boolean;
}

function locate(task: Task, items: readonly EvidenceItem[], files: readonly SourceFile[]): { files: FileCandidate[]; mustNotChange: string[] } {
  const tokens = ruleTokens.filter(([pattern]) => pattern.test(task.ruleId)).flatMap(([, list]) => list);
  const literals = literalNeedles(items).filter(needle => files.filter(file => file.text.includes(needle)).length <= commonText);
  const components = componentNames(items);
  const scores = new Map<SourceFile, Score>();
  const credit = (file: SourceFile, points: number, reason: string, structural = false, literal = false) => {
    const entry = scores.get(file) ?? { score: 0, reasons: [], structural: false, literal: false };
    // Build and check scripts mention the markup they verify, so they count for half.
    entry.score += file.path.startsWith('scripts/') ? points / 2 : points;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    entry.structural ||= structural;
    entry.literal ||= literal;
    scores.set(file, entry);
  };
  for (const file of files) {
    for (const token of tokens) if (file.text.includes(token)) credit(file, file.kind === 'data' ? 1 : 3, `contains ${token}`, file.kind !== 'data');
    for (const needle of literals) if (file.text.includes(needle)) credit(file, 2, 'contains the observed text', false, true);
    for (const name of components) {
      if (squash(basename(file.name, extname(file.name))) === squash(name)) credit(file, 4, `named after .${name}`, true);
      else if (file.kind === 'code' && file.text.includes(name)) credit(file, 1, `uses ${name}`, true);
    }
    if (file.kind === 'platform' && platformRules.test(task.ruleId)) credit(file, 3, 'configures how the platform answers', true);
  }
  const ranked = [...scores].sort((a, b) => b[1].score - a[1].score || a[0].path.localeCompare(b[0].path));
  // When code emits the markup, a data file that only holds the observed text is the input, not the fix.
  const codeHolds = task.fixLocation === 'repo' && ranked.some(([file, score]) => file.kind !== 'data' && score.structural);
  const mustNotChange = codeHolds ? ranked.filter(([file, score]) => file.kind === 'data' && score.literal && !score.structural).map(([file]) => file.path).slice(0, 3) : [];
  const chosen = ranked.filter(([file, score]) => score.score >= 3 && !mustNotChange.includes(file.path)).slice(0, 5);
  return {
    files: chosen.map(([file, score]) => ({ path: file.path, confidence: score.score >= 6 ? 'high' : score.score >= 4 ? 'medium' : 'low', reason: score.reasons.slice(0, 3).join('; ') })),
    mustNotChange,
  };
}

/**
 * Adds to each task the files of the site's repository that most likely hold its fix. The repository is only read:
 * nothing is written there and no file content leaves the machine. Paths are relative to the repository.
 */
export async function locateFixes(report: Report, root: string): Promise<Report> {
  const files = await sourceFiles(root);
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  const tasks = report.tasks.map(task => {
    const found = locate(task, task.evidence.map(id => evidence.get(id)).filter((item): item is EvidenceItem => item !== undefined), files);
    return { ...task, ...(found.files.length > 0 ? { files: found.files } : {}), ...(found.mustNotChange.length > 0 ? { mustNotChange: found.mustNotChange } : {}) };
  });
  return { ...report, tasks };
}
