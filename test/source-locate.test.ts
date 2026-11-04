import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { CollectResult } from '../src/collect/index.ts';
import { EvidenceStore, type EvidenceItem } from '../src/core/evidence.ts';
import { buildReport, type Report } from '../src/report/model.ts';
import type { Task } from '../src/report/tasks.ts';
import { locateFixes } from '../src/source/locate.ts';
import { site } from './support/facts.ts';

let repo: string;

const files: Readonly<Record<string, string>> = {
  'src/components/seo/JsonLd.astro': "---\nconst { title } = Astro.props;\nconst breadcrumb = { '@type': 'BreadcrumbList', itemListElement: [{ name: 'Altitud Studio' }, { name: title }] };\n---\n<script type=\"application/ld+json\" set:html={JSON.stringify(breadcrumb)} />\n",
  'src/messages/en.json': '{ "services": { "cto": { "seoTitle": "Fractional CTO Services in Europe" } } }\n',
  'astro.config.mjs': "import sitemap from '@astrojs/sitemap';\nexport default { integrations: [sitemap()] };\n",
  'src/components/ui/LiveSystem.astro': '<figure class="live-system" data-live-system><canvas></canvas></figure>\n',
  'node_modules/schema/BreadcrumbList.js': "export const type = 'BreadcrumbList';\n",
  '.env': 'SECRET=BreadcrumbList\n',
};

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'altimeter-source-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

const base = (): Report => {
  const collected: CollectResult = { site: site({ pages: [] }), versions: {}, warnings: [], durationMs: 1 };
  return buildReport({ collected, findings: [], evidence: new EvidenceStore(), implemented: 0, language: 'en', startedAt: new Date('2026-11-04T10:00:00Z'), targetUrl: 'https://example.com/', options: {} });
};

const task = (id: string, ruleId: string, evidence: string[], overrides: Partial<Task> = {}): Task => ({
  id, ruleId, category: 'schema', title: ruleId, severity: 'low', priority: 1, scopes: [{ kind: 'site', origin: 'https://example.com' }], problem: 'p',
  desired: 'd', evidence, fixLocation: 'repo', verifiableBy: 'local', agentReady: true, acceptance: [], mustRemainPassing: [], sources: [], ...overrides,
});

const item = (id: string, excerpt: string, path?: string): EvidenceItem => ({ id, kind: 'structured-data', label: 'l', excerpt, ...(path ? { path } : {}), complete: true });

describe('locateFixes', () => {
  test('points the breadcrumb task at the code that emits the markup and keeps the data file out', async () => {
    const report = { ...base(), evidence: [item('E1', 'Fractional CTO Services in Europe | Altitud Studio', 'jsonld[0].itemListElement[1].name')], tasks: [task('T-1', 'schema-breadcrumb', ['E1'])] };
    const located = (await locateFixes(report, repo)).tasks[0]!;
    assert.equal(located.files?.[0]?.path, 'src/components/seo/JsonLd.astro');
    assert.equal(located.files?.[0]?.confidence, 'high');
    assert.deepEqual(located.mustNotChange, ['src/messages/en.json']);
    assert.ok(!located.files?.some(file => file.path.startsWith('node_modules') || file.path === '.env'));
  });

  test('finds the sitemap integration and the component a selector names', async () => {
    const report = {
      ...base(),
      evidence: [item('E1', '3 URLs, none with lastmod'), item('E2', '<figure class="live-system" data-live-system="">', 'main > figure.live-system')],
      tasks: [task('T-1', 'crawl-sitemap-lastmod', ['E1']), task('T-2', 'perf-lcp-fetchpriority', ['E2'])],
    };
    const [sitemap, lcp] = (await locateFixes(report, repo)).tasks;
    assert.equal(sitemap?.files?.[0]?.path, 'astro.config.mjs');
    assert.equal(lcp?.files?.[0]?.path, 'src/components/ui/LiveSystem.astro');
  });

  test('lets a content task change the data that holds the text', async () => {
    const report = { ...base(), evidence: [item('E1', 'Fractional CTO Services in Europe | Altitud Studio')], tasks: [task('T-1', 'content-title-width', ['E1'], { fixLocation: 'content' })] };
    const located = (await locateFixes(report, repo)).tasks[0]!;
    assert.equal(located.mustNotChange, undefined);
    assert.ok(located.files === undefined || located.files.every(file => file.path !== '.env'));
  });
});
