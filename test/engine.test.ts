import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evidenceLabel, EvidenceStore } from '../src/core/evidence.ts';
import type { PageFacts, SiteFacts } from '../src/core/facts.ts';
import type { RuleMeta } from '../src/core/types.ts';
import type { FetchResult } from '../src/fetch/http.ts';
import { parseHtml } from '../src/parse/html.ts';
import { extractStructuredData } from '../src/parse/structured-data.ts';
import { runRules, type RuleImplementation } from '../src/rules/engine.ts';

function fetched(url: string, status = 200): FetchResult {
  return { requestedUrl: url, finalUrl: url, hops: [{ url, status, headers: {}, ttfbMs: 1 }], status, headers: {}, body: Buffer.alloc(0),
    transferBytes: 0, truncated: false, durationMs: 1 };
}

function page(url: string, html: string, pageType: PageFacts['pageType'] = 'other'): PageFacts {
  const parsed = parseHtml(html);
  return { url, fetch: fetched(url), pageType, pageTypeReason: 'test', raw: { html, parsed, data: extractStructuredData(parsed) } };
}

function site(pages: PageFacts[]): SiteFacts {
  return { origin: 'https://example.com', sitemaps: [], variants: [], siblings: [], pages: new Map(pages.map(entry => [entry.url, entry])), crawled: false, agentProbes: [], resources: [], localeProbes: [] };
}

const meta = (overrides: Partial<RuleMeta>): RuleMeta => ({
  id: 'content-test-title', category: 'content', title: 'Title present', why: 'Why.', fix: 'Fix.', maxSeverity: 'medium',
  method: 'deterministic', scope: 'page', inputs: ['raw-html'], appliesTo: 'all', exemptWhen: [], fpRisk: 'low', scored: true,
  evidenceLevel: 'official-google', thresholds: 'Fails without a title.', sources: [{ url: 'https://developers.google.com/search', verified: '2026-11-03' }],
  status: 'v1', ...overrides,
});

const titleRule: RuleImplementation = {
  id: 'content-test-title',
  evaluate({ page, evidence }) {
    const titles = page!.raw!.parsed.titles;
    if (titles.length > 0) return { outcome: 'pass', evidence: [evidence.add({ kind: 'html', url: page!.url, label: evidenceLabel('title element'), excerpt: titles[0]!.text, line: titles[0]!.line })] };
    return { outcome: 'fail', severity: 'critical', evidence: [evidence.add({ kind: 'html', url: page!.url, label: evidenceLabel('no title element in the raw HTML') })] };
  },
};

describe('runRules', () => {
  const pages = [
    page('https://example.com/a', '<!doctype html><title>A page</title>'),
    page('https://example.com/b', '<!doctype html><p>No title</p>'),
    page('https://example.com/privacy', '<!doctype html><p>No title</p>', 'legal'),
  ];

  test('evaluates page rules on every page and caps severity at the catalog maximum', () => {
    const evidence = new EvidenceStore();
    const findings = runRules({ rules: [meta({})], implementations: new Map([[titleRule.id, titleRule]]), site: site(pages), evidence });
    assert.deepEqual(findings.map(f => [f.scope.kind === 'page' ? f.scope.url : '', f.outcome, f.severity]), [
      ['https://example.com/a', 'pass', undefined],
      ['https://example.com/b', 'fail', 'medium'],
      ['https://example.com/privacy', 'fail', 'medium'],
    ]);
    assert.equal(evidence.get(findings[0]!.evidence[0]!)?.excerpt, 'A page');
  });

  test('respects appliesTo and reports missing inputs as not evaluated', () => {
    const evidence = new EvidenceStore();
    const scoped = meta({ appliesTo: ['other'] });
    const needsRender = meta({ id: 'content-test-render', inputs: ['rendered-dom'] });
    const findings = runRules({
      rules: [scoped, needsRender],
      implementations: new Map([[scoped.id, titleRule], [needsRender.id, { ...titleRule, id: needsRender.id }]]),
      site: site(pages),
      evidence,
    });
    const legal = findings.find(f => f.ruleId === scoped.id && f.scope.kind === 'page' && f.scope.url.endsWith('/privacy'));
    assert.deepEqual([legal?.outcome, legal?.reason], ['not_applicable', 'page-type:legal']);
    assert.ok(findings.filter(f => f.ruleId === needsRender.id).every(f => f.outcome === 'not_evaluated' && f.reason === 'missing-input:rendered-dom'));
  });

  test('counts a page input as available to a site rule when an auditable page has it', () => {
    const siteRule = meta({ id: 'content-test-site', scope: 'site', inputs: ['raw-html'] });
    const counter: RuleImplementation = { id: siteRule.id, evaluate: () => ({ outcome: 'pass' }) };
    const outcome = (facts: SiteFacts) => runRules({ rules: [siteRule], implementations: new Map([[counter.id, counter]]), site: facts, evidence: new EvidenceStore() })[0];
    assert.equal(outcome(site(pages))?.outcome, 'pass');
    const withoutHtml = pages.map(({ raw: _raw, ...rest }) => rest);
    assert.deepEqual([outcome(site(withoutHtml))?.outcome, outcome(site(withoutHtml))?.reason], ['not_evaluated', 'missing-input:raw-html']);
    const blocked = pages.map(entry => ({ ...entry, notAuditable: 'challenge' }));
    assert.equal(outcome(site(blocked))?.outcome, 'not_evaluated');
  });

  test('skips planned rules and rules without an implementation', () => {
    const findings = runRules({ rules: [meta({ status: 'planned' }), meta({ id: 'content-unimplemented' })], implementations: new Map([[titleRule.id, titleRule]]),
      site: site(pages), evidence: new EvidenceStore() });
    assert.deepEqual(findings, []);
  });

  test('marks hybrid candidates as needing judgment with low confidence', () => {
    const candidate: RuleImplementation = { id: 'content-test-title', evaluate: ({ evidence, page }) => ({ outcome: 'fail', severity: 'medium', needsJudgment: true,
      evidence: [evidence.add({ kind: 'html', url: page!.url, label: evidenceLabel('candidate') })] }) };
    const findings = runRules({ rules: [meta({})], implementations: new Map([[candidate.id, candidate]]), site: site(pages.slice(0, 1)), evidence: new EvidenceStore() });
    assert.deepEqual([findings[0]?.needsJudgment, findings[0]?.confidence], [true, 'low']);
  });

  test('turns a crashing rule into not evaluated instead of failing the audit', () => {
    const broken: RuleImplementation = { id: 'content-test-title', evaluate: () => { throw new Error('boom'); } };
    const findings = runRules({ rules: [meta({})], implementations: new Map([[broken.id, broken]]), site: site(pages.slice(0, 1)), evidence: new EvidenceStore() });
    assert.deepEqual([findings[0]?.outcome, findings[0]?.reason], ['not_evaluated', 'rule-error:boom']);
  });

  test('gives the same finding the same signature across runs', () => {
    const first = runRules({ rules: [meta({})], implementations: new Map([[titleRule.id, titleRule]]), site: site(pages), evidence: new EvidenceStore() });
    const second = runRules({ rules: [meta({})], implementations: new Map([[titleRule.id, titleRule]]), site: site([...pages].reverse()), evidence: new EvidenceStore() });
    const signature = (findings: typeof first, url: string) => findings.find(f => f.scope.kind === 'page' && f.scope.url === url)?.evidenceSignature;
    assert.equal(signature(first, 'https://example.com/b'), signature(second, 'https://example.com/b'));
    assert.notEqual(signature(first, 'https://example.com/a'), signature(first, 'https://example.com/b'));
  });
});
