import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Finding, RuleImplementation } from '../../src/rules/engine.ts';
import { implementations } from '../../src/rules/ai/index.ts';
import { evaluate, page, site, type SiteSpec } from '../support/facts.ts';

const rule = (id: string): RuleImplementation => {
  const found = implementations.find(entry => entry.id === id);
  if (!found) throw new Error(`${id} is not implemented`);
  return found;
};

const home = page('https://example.com/', { html: '<!doctype html><title>Home</title><h1>Home</h1>' });

function run(id: string, robots: SiteSpec['robots'], extra: Partial<SiteSpec> = {}) {
  return evaluate(rule(id), site({ pages: [home], ...(robots === undefined ? {} : { robots }), ...extra }));
}

const fails = (findings: readonly Finding[]) => findings.filter(finding => finding.outcome === 'fail');
const only = (findings: readonly Finding[]): Finding => {
  assert.equal(findings.length, 1, JSON.stringify(findings));
  return findings[0]!;
};

const noAiGroups = 'User-agent: *\nDisallow: /admin/\n\nSitemap: https://example.com/sitemap.xml\n';

describe('per-crawler robots.txt rules', () => {
  test('OAI-SearchBot inheriting a disallow from * fails at low with the deciding line', () => {
    const { findings, evidence } = run('ai-robots-oai-searchbot', 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
    const finding = only(findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'low', 'blocked-by-inheritance']);
    const excerpts = finding.evidence.map(id => evidence.get(id)?.excerpt);
    assert.ok(excerpts.includes('Disallow: /'));
    assert.ok(excerpts.includes('User-agent: *'));
    assert.equal(finding.params?.agent, 'OAI-SearchBot');
  });

  test('a group that names OAI-SearchBot and disallows it is a deliberate choice reported as info', () => {
    const finding = only(run('ai-robots-oai-searchbot', 'User-agent: OAI-SearchBot\nDisallow: /\n').findings);
    assert.deepEqual([finding.severity, finding.reason], ['info', 'blocked-by-name']);
  });

  test('robots.txt without AI crawler groups is a policy choice and never fails', () => {
    for (const id of ['ai-robots-oai-searchbot', 'ai-robots-claude-searchbot', 'ai-robots-claude-user', 'ai-robots-perplexitybot', 'ai-robots-gptbot',
      'ai-robots-chatgpt-user', 'ai-robots-claudebot', 'ai-robots-google-extended', 'ai-robots-applebot', 'ai-robots-amazon', 'ai-robots-meta',
      'ai-robots-duckassistbot', 'ai-robots-mistral', 'ai-robots-training-only-crawlers', 'ai-robots-policy-coherence', 'ai-robots-legacy-tokens',
      'ai-robots-wildcard-disallow-all']) {
      const { findings } = run(id, noAiGroups);
      assert.deepEqual(fails(findings), [], id);
      assert.ok(findings.every(finding => finding.outcome === 'pass'), id);
    }
  });

  test('a missing robots.txt is not applicable and an uncollected one is not evaluated', () => {
    const missing = only(run('ai-robots-claude-searchbot', { status: 404 }).findings);
    assert.deepEqual([missing.outcome, missing.reason], ['not_applicable', 'no-robots-rules']);
    const uncollected = only(run('ai-robots-claude-searchbot', undefined).findings);
    assert.deepEqual([uncollected.outcome, uncollected.reason], ['not_evaluated', 'missing-input:robots']);
    const unreachable = only(run('ai-robots-gptbot', 'unreachable').findings);
    assert.deepEqual([unreachable.outcome, unreachable.reason], ['not_evaluated', 'robots-unreachable']);
  });

  test('more than 20% of the sampled paths blocked fails even when / is allowed', () => {
    const pages = [home, page('https://example.com/blog/a', { html: '<p>a</p>' }), page('https://example.com/blog/b', { html: '<p>b</p>' })];
    const { findings, evidence } = evaluate(rule('ai-robots-perplexitybot'), site({ pages, robots: 'User-agent: *\nDisallow: /blog/\n' }));
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.blocked, finding.params?.sampled], ['low', 'blocked-by-inheritance', 2, 3]);
    assert.ok(finding.evidence.some(id => evidence.get(id)?.excerpt === '/blog/a\n/blog/b'));
  });

  test('a small blocked share of the sample passes', () => {
    const pages = [home, ...['a', 'b', 'c', 'd', 'e'].map(slug => page(`https://example.com/${slug}`, { html: '<p>x</p>' })), page('https://example.com/private/x', { html: '<p>x</p>' })];
    const { findings } = evaluate(rule('ai-robots-oai-searchbot'), site({ pages, robots: 'User-agent: *\nDisallow: /private/\n' }));
    assert.equal(only(findings).outcome, 'pass');
  });

  test('Claude-User only fails on /', () => {
    assert.equal(only(run('ai-robots-claude-user', 'User-agent: *\nDisallow: /account/\n').findings).outcome, 'pass');
    const finding = only(run('ai-robots-claude-user', 'User-agent: *\nDisallow: /\n').findings);
    assert.deepEqual([finding.severity, finding.reason], ['low', 'blocked-by-inheritance']);
  });

  test('training crawlers blocked are reported as info', () => {
    const finding = only(run('ai-robots-gptbot', 'User-agent: GPTBot\nDisallow: /\n').findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason, finding.params?.agent], ['fail', 'info', 'disallowed', 'GPTBot']);
    const training = fails(run('ai-robots-training-only-crawlers', 'User-agent: CCBot\nUser-agent: Bytespider\nDisallow: /\n').findings);
    assert.deepEqual(training.map(entry => [entry.severity, entry.params?.agent]), [['info', 'CCBot'], ['info', 'Bytespider']]);
    assert.equal(only(run('ai-robots-claudebot', 'User-agent: ClaudeBot\nDisallow: /\n').findings).severity, 'info');
    assert.equal(only(run('ai-robots-chatgpt-user', 'User-agent: ChatGPT-User\nDisallow: /\n').findings).severity, 'info');
  });

  test('Google-Extended and the shared training token are info', () => {
    const extended = only(run('ai-robots-google-extended', 'User-agent: Google-Extended\nDisallow: /\n').findings);
    assert.deepEqual([extended.severity, extended.reason], ['info', 'disallowed']);
    const { findings, evidence } = run('ai-robots-google-extended', 'User-agent: __usage_ai-training\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
    const usage = only(findings);
    assert.deepEqual([usage.severity, usage.reason], ['info', 'usage-ai-training']);
    assert.equal(evidence.get(usage.evidence[0]!)?.excerpt, 'User-agent: __usage_ai-training');
  });

  test('Applebot follows the Googlebot group before *', () => {
    // Applebot-Extended has no fallback, so it still inherits the * block and is reported on its own as info.
    const allowed = run('ai-robots-applebot', 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n').findings;
    assert.deepEqual(allowed.map(entry => [entry.severity, entry.reason, entry.params?.agent]), [['info', 'disallowed', 'Applebot-Extended']]);
    const inherited = only(run('ai-robots-applebot', 'User-agent: Googlebot\nDisallow: /\n').findings);
    assert.deepEqual([inherited.severity, inherited.reason], ['low', 'blocked-by-inheritance']);
  });

  test('Applebot-Extended blocked alone is info and Applebot passes', () => {
    const finding = only(run('ai-robots-applebot', 'User-agent: Applebot-Extended\nDisallow: /\n').findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.agent], ['info', 'disallowed', 'Applebot-Extended']);
  });

  test('Amzn-SearchBot counts as blocked only when every group it may follow blocks it', () => {
    const followsGooglebot = run('ai-robots-amazon', 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n').findings;
    assert.deepEqual(followsGooglebot.map(entry => [entry.severity, entry.params?.agent]), [['info', 'Amazonbot'], ['info', 'Amzn-User']]);
    const blocked = only(run('ai-robots-amazon', 'User-agent: *\nDisallow: /\n').findings.filter(entry => entry.reason !== 'disallowed'));
    assert.deepEqual([blocked.severity, blocked.reason], ['low', 'blocked-by-inheritance']);
    const amazonbot = only(run('ai-robots-amazon', 'User-agent: Amazonbot\nDisallow: /\n').findings);
    assert.deepEqual([amazonbot.severity, amazonbot.params?.agent], ['info', 'Amazonbot']);
  });

  test('Meta, DuckDuckGo and Mistral search crawlers grade by how they are blocked', () => {
    const meta = run('ai-robots-meta', 'User-agent: meta-externalagent\nDisallow: /\n\nUser-agent: meta-webindexer\nDisallow: /\n').findings;
    assert.deepEqual(meta.map(entry => [entry.severity, entry.reason, entry.params?.agent]), [
      ['info', 'blocked-by-name', 'meta-webindexer'], ['info', 'disallowed', 'meta-externalagent'],
    ]);
    const duck = only(run('ai-robots-duckassistbot', 'User-agent: *\nDisallow: /\n').findings);
    assert.deepEqual([duck.severity, duck.reason], ['low', 'blocked-by-inheritance']);
    assert.equal(only(run('ai-robots-mistral', 'User-agent: MistralAI-Training\nDisallow: /\n').findings).severity, 'info');
  });
});

describe('ai-robots-wildcard-disallow-all', () => {
  test('fails at medium when AI search crawlers inherit a global disallow that search engines escape', () => {
    const { findings, evidence } = run('ai-robots-wildcard-disallow-all', 'User-agent: Googlebot\nUser-agent: Bingbot\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason], ['medium', 'ai-search-inherits-block']);
    assert.match(String(finding.params?.agents), /OAI-SearchBot/u);
    assert.ok(finding.evidence.some(id => evidence.get(id)?.excerpt === 'Disallow: /'));
  });

  test('a site closed to every crawler is left to the crawl rules', () => {
    const finding = only(run('ai-robots-wildcard-disallow-all', 'User-agent: *\nDisallow: /\n').findings);
    assert.deepEqual([finding.outcome, finding.reason], ['not_applicable', 'whole-site-blocked']);
  });

  test('a staging host is exempt', () => {
    const staging = page('https://staging.example.com/', { html: '<p>x</p>' });
    const { findings } = evaluate(rule('ai-robots-wildcard-disallow-all'), site({ pages: [staging], robots: 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n' }));
    assert.deepEqual([only(findings).outcome, only(findings).reason], ['not_applicable', 'staging-host']);
  });

  test('passes when every AI search crawler has its own group', () => {
    const groups = ['OAI-SearchBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Applebot', 'Amzn-SearchBot', 'DuckAssistBot', 'MistralAI-Index', 'meta-webindexer']
      .map(token => `User-agent: ${token}`).join('\n');
    assert.equal(only(run('ai-robots-wildcard-disallow-all', `${groups}\nAllow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n`).findings).outcome, 'pass');
  });
});

describe('ai-robots-policy-coherence', () => {
  test('search blocked with training allowed by inheritance fails at low', () => {
    const { findings, evidence } = run('ai-robots-policy-coherence', 'User-agent: OAI-SearchBot\nDisallow: /\n');
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason], ['low', 'search-blocked-training-allowed']);
    assert.match(String(finding.params?.operators), /OpenAI \(OAI-SearchBot blocked, GPTBot allowed\)/u);
    assert.ok(finding.evidence.some(id => evidence.get(id)?.excerpt === 'User-agent: OAI-SearchBot'));
  });

  test('naming both crawlers is explicit and reported as info', () => {
    const finding = only(run('ai-robots-policy-coherence', 'User-agent: Claude-SearchBot\nDisallow: /\n\nUser-agent: ClaudeBot\nAllow: /\n').findings);
    assert.equal(finding.severity, 'info');
  });

  test('blocking training while allowing search is coherent', () => {
    assert.equal(only(run('ai-robots-policy-coherence', 'User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n').findings).outcome, 'pass');
  });
});

describe('ai-robots-legacy-tokens', () => {
  test('a legacy token without its current group fails at low', () => {
    const { findings, evidence } = run('ai-robots-legacy-tokens', 'User-agent: anthropic-ai\nDisallow: /\n');
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.current], ['low', 'legacy-token', 'ClaudeBot']);
    assert.equal(evidence.get(finding.evidence[0]!)?.excerpt, 'User-agent: anthropic-ai');
    assert.equal(evidence.get(finding.evidence[0]!)?.line, 1);
  });

  test('a legacy token next to the current one passes', () => {
    assert.equal(only(run('ai-robots-legacy-tokens', 'User-agent: anthropic-ai\nUser-agent: ClaudeBot\nDisallow: /\n').findings).outcome, 'pass');
  });

  test('spelling variants are flagged, including a space that turns the line into an Applebot group', () => {
    const findings = run('ai-robots-legacy-tokens', 'User-agent: GPT-Bot\nDisallow: /\n\nUser-agent: Applebot Extended\nDisallow: /\n').findings;
    assert.deepEqual(findings.map(entry => [entry.reason, entry.params?.token, entry.params?.current]), [
      ['near-miss-token', 'GPT-Bot', 'GPTBot'], ['near-miss-token', 'Applebot Extended', 'Applebot-Extended'],
    ]);
  });

  test('unrelated crawlers and versioned tokens are not misspellings', () => {
    const robots = 'User-agent: DotBot\nUser-agent: Googlebot-Image\nUser-agent: Claude-SearchBot/1.0\nUser-agent: AhrefsBot\nUser-agent: facebot\nDisallow: /\n';
    assert.equal(only(run('ai-robots-legacy-tokens', robots).findings).outcome, 'pass');
  });
});
