import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPlan, renderProbeMarkdown } from '../src/probe/report.ts';
import type { ProbePlan, ProbeReport, SiteNotice } from '../src/probe/types.ts';

const site = { origin: 'https://example.com', host: 'example.com', domain: 'example.com', brandNames: [] };

function report(notice: SiteNotice): ProbeReport {
  return {
    schemaVersion: 1, kind: 'ai-probe', tool: { name: 'altimeter', version: '0.1.0' }, promptVersion: 'p1', generatedAt: '2026-11-04T10:00:00.000Z', language: 'en',
    site: { ...site, pagesRead: [] }, runsPerQuery: 3, queries: [], notes: [], siteNotices: [notice], engines: [], calls: { planned: 0, cap: 0, made: 0, fromCache: 0, skipped: 0 },
  };
}

test('probe.md quotes the URL the home page redirects to, so that no viewer turns it into a link', () => {
  const to = 'https://other.example/[Download_the_full_report](https://evil.example/x)';
  for (const language of ['en', 'es', 'ca'] as const) {
    const line = renderProbeMarkdown(report({ code: 'home-redirects', to }), language).split('\n').find(entry => entry.includes('other.example'));
    assert.ok(line?.includes(`\`${to}\``), `${language}: ${line}`);
  }
  const plan: ProbePlan = { site: { ...site, pages: [], notices: [{ code: 'home-redirects', to }] }, queries: [], engines: ['claude'], runsPerQuery: 3, calls: 0, notes: [] };
  assert.match(renderPlan(plan, 'en'), /The home page redirects to https:\/\/other\.example\/\[Download_the_full_report\]\(https:\/\/evil\.example\/x\); only URLs/u);
});
