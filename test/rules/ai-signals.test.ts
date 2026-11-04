import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentProbe } from '../../src/core/facts.ts';
import { browserAgent, probeAgents } from '../../src/data/agents.ts';
import type { Finding, RuleImplementation } from '../../src/rules/engine.ts';
import { implementations } from '../../src/rules/ai/index.ts';
import { usagePreferenceProblems } from '../../src/rules/ai/robots-signals.ts';
import { evaluate, page, response, site, type ResponseSpec, type SiteSpec } from '../support/facts.ts';

const rule = (id: string): RuleImplementation => {
  const found = implementations.find(entry => entry.id === id);
  if (!found) throw new Error(`${id} is not implemented`);
  return found;
};

const only = (findings: readonly Finding[]): Finding => {
  assert.equal(findings.length, 1, JSON.stringify(findings));
  return findings[0]!;
};

const homeUrl = 'https://example.com/';
const home = (spec: ResponseSpec = {}) => page(homeUrl, { html: '<!doctype html><title>Home</title><h1>Home</h1>', ...spec });
const run = (id: string, spec: Partial<SiteSpec>) => evaluate(rule(id), site({ pages: [home()], ...spec }));

const managedBlock = [
  '# As a condition of accessing this website, you agree to abide by the following content signals:',
  '# BEGIN Cloudflare Managed content',
  '',
  'User-Agent: *',
  'Content-signal: search=yes,ai-train=no',
  'Allow: /',
  '',
  'User-agent: Amazonbot',
  'Disallow: /',
  '',
  'User-agent: GPTBot',
  'Disallow: /',
  '',
  '# END Cloudflare Managed Content',
  '',
  'User-agent: *',
  'Disallow: /admin/',
].join('\n');

describe('ai-cdn-cloudflare-managed-robots', () => {
  test('a block that lists only training tokens is info', () => {
    const { findings, evidence } = run('ai-cdn-cloudflare-managed-robots', { robots: managedBlock });
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason], ['info', 'training-blocked']);
    assert.equal(evidence.get(finding.evidence[0]!)?.excerpt, '# BEGIN Cloudflare Managed content');
    assert.equal(evidence.get(finding.evidence[0]!)?.line, 2);
    assert.ok(finding.evidence.some(id => evidence.get(id)?.excerpt === 'User-agent: GPTBot' && evidence.get(id)?.line === 11));
  });

  test('an AI search crawler in the block is low and a search engine is medium', () => {
    const answer = only(run('ai-cdn-cloudflare-managed-robots', { robots: managedBlock.replace('User-agent: GPTBot', 'User-agent: OAI-SearchBot') }).findings);
    assert.deepEqual([answer.severity, answer.reason, answer.params?.agents], ['low', 'answer-crawler-blocked', 'OAI-SearchBot']);
    const engine = only(run('ai-cdn-cloudflare-managed-robots', { robots: managedBlock.replace('User-agent: GPTBot', 'User-agent: Googlebot') }).findings);
    assert.deepEqual([engine.severity, engine.reason], ['medium', 'search-engine-blocked']);
  });

  test('rules outside the block are ignored, and a block without disallows passes', () => {
    const empty = managedBlock.replace(/User-agent: Amazonbot\nDisallow: \/\n\nUser-agent: GPTBot\nDisallow: \/\n/u, '');
    assert.equal(only(run('ai-cdn-cloudflare-managed-robots', { robots: `${empty}\nUser-agent: Bingbot\nDisallow: /\n` }).findings).outcome, 'pass');
  });

  test('no managed block is not applicable', () => {
    const finding = only(run('ai-cdn-cloudflare-managed-robots', { robots: 'User-agent: *\nDisallow:\n' }).findings);
    assert.deepEqual([finding.outcome, finding.reason], ['not_applicable', 'no-managed-block']);
  });
});

describe('ai-content-signal-lines', () => {
  test('the common managed signals pass', () => {
    assert.equal(only(run('ai-content-signal-lines', { robots: managedBlock }).findings).outcome, 'pass');
  });

  test('unknown keys or values are info with the line quoted', () => {
    const { findings, evidence } = run('ai-content-signal-lines', { robots: 'User-agent: *\nContent-Signal: search=yes, ai-training=no\nAllow: /\n' });
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.pairs], ['info', 'invalid', 'ai-training=no']);
    assert.equal(evidence.get(finding.evidence[0]!)?.excerpt, 'Content-Signal: search=yes, ai-training=no');
  });

  test('ai-input=no is reported as a stated preference', () => {
    const finding = only(run('ai-content-signal-lines', { robots: 'User-agent: *\ncontent-signal: ai-input=no\nAllow: /\n' }).findings);
    assert.deepEqual([finding.severity, finding.reason], ['info', 'ai-input-no']);
  });

  test('robots.txt without signals is not applicable', () => {
    const finding = only(run('ai-content-signal-lines', { robots: 'User-agent: *\nDisallow:\n' }).findings);
    assert.deepEqual([finding.outcome, finding.reason], ['not_applicable', 'no-content-signal']);
  });
});

describe('ai-aipref-signals', () => {
  test('parses usage preferences as RFC 9651 dictionaries', () => {
    assert.deepEqual(usagePreferenceProblems('train-ai=n, search=y'), []);
    assert.deepEqual(usagePreferenceProblems('train-ai=n, future-key=y'), []);
    assert.deepEqual(usagePreferenceProblems('train-ai=no'), ['train-ai needs y or n']);
    assert.deepEqual(usagePreferenceProblems('Train-AI=n'), ['invalid key "Train-AI"']);
    assert.deepEqual(usagePreferenceProblems('train-ai'), ['train-ai needs y or n']);
  });

  test('valid robots.txt and header signals pass with evidence', () => {
    const { findings, evidence } = evaluate(rule('ai-aipref-signals'), site({
      pages: [home({ headers: { 'content-usage': 'train-ai=n' } })],
      robots: 'User-agent: *\nContent-Usage: /blog/ train-ai=n\nAllow: /\n',
    }));
    const finding = only(findings);
    assert.equal(finding.outcome, 'pass');
    assert.deepEqual(finding.evidence.map(id => evidence.get(id)?.excerpt), ['Content-Usage: /blog/ train-ai=n', 'train-ai=n']);
  });

  test('an invalid value is info', () => {
    const { findings, evidence } = run('ai-aipref-signals', { robots: 'User-agent: *\nContent-Usage: train-ai=no\nAllow: /\n' });
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.problems], ['info', 'parse-error', 'train-ai needs y or n']);
    assert.equal(evidence.get(finding.evidence[0]!)?.excerpt, 'Content-Usage: train-ai=no');
  });

  test('lists a problem that every response repeats once, and cites each response', () => {
    const pages = ['', 'a', 'b', 'c'].map(path => page(`${homeUrl}${path}`, { html: '<!doctype html><title>Page</title>', headers: { 'content-usage': 'search=maybe, train-ai=n' } }));
    const finding = only(evaluate(rule('ai-aipref-signals'), site({ pages })).findings);
    assert.equal(finding.params?.problems, 'search needs y or n');
    assert.equal(finding.evidence.length, 4);
  });

  test('no signal is not applicable, and missing X-Robots-Tag or Link headers are normal', () => {
    const finding = only(run('ai-aipref-signals', { robots: 'User-agent: *\nDisallow:\n' }).findings);
    assert.deepEqual([finding.outcome, finding.reason], ['not_applicable', 'no-aipref']);
  });
});

describe('ai-llms-txt', () => {
  const llms = (spec: ResponseSpec) => ({ url: 'https://example.com/llms.txt', purpose: 'llms-txt' as const, ...spec });

  test('a well-formed file passes', () => {
    const body = '# Example\n\n> A short summary.\n\n## Docs\n\n- [Guide](https://example.com/guide): how to start\n';
    const { findings, evidence } = run('ai-llms-txt', { resources: [llms({ body, headers: { 'content-type': 'text/markdown; charset=utf-8' } })] });
    const finding = only(findings);
    assert.equal(finding.outcome, 'pass');
    assert.equal(evidence.get(finding.evidence[0]!)?.label, 'llms.txt response, served as text/markdown; charset=utf-8');
    assert.match(evidence.get(finding.evidence[0]!)?.excerpt ?? '', /^# Example/u);
  });

  test('absence and an HTML page for every path are not findings', () => {
    const absent = only(run('ai-llms-txt', { resources: [llms({ status: 404 })] }).findings);
    assert.deepEqual([absent.outcome, absent.reason], ['not_applicable', 'no-llms-txt']);
    const soft = only(run('ai-llms-txt', { resources: [llms({ body: '<!doctype html><title>Home</title>' })] }).findings);
    assert.deepEqual([soft.outcome, soft.reason], ['not_applicable', 'html-response']);
  });

  test('a present file with layout problems and a wrong type is info', () => {
    const body = 'Example site\n# One\n# Two\n';
    const findings = run('ai-llms-txt', { resources: [llms({ body, headers: { 'content-type': 'application/octet-stream' } })] }).findings;
    assert.deepEqual(findings.map(entry => [entry.severity, entry.reason]), [['info', 'content-type'], ['info', 'structure']]);
    assert.match(String(findings[1]!.params?.problems), /first line is not an H1/u);
  });

  test('links to paths robots.txt disallows for search crawlers are info', () => {
    const body = '# Example\n\n## Docs\n\n- [Private](/private/notes)\n- [Elsewhere](https://other.example/x)\n';
    const { findings, evidence } = run('ai-llms-txt', {
      robots: 'User-agent: *\nDisallow: /private/\n',
      resources: [llms({ body, headers: { 'content-type': 'text/plain' } })],
    });
    const finding = only(findings);
    assert.deepEqual([finding.reason, finding.params?.count], ['disallowed-links', 1]);
    assert.deepEqual([evidence.get(finding.evidence[0]!)?.excerpt, evidence.get(finding.evidence[0]!)?.line], ['/private/notes', 5]);
  });

  test('not evaluated when resources were not fetched', () => {
    const finding = only(run('ai-llms-txt', {}).findings);
    assert.deepEqual([finding.outcome, finding.reason], ['not_evaluated', 'missing-input:resources']);
  });
});

const probe = (token: string, spec: ResponseSpec = {}): AgentProbe => {
  const agent = token === '*' ? browserAgent : probeAgents.find(entry => entry.token === token)!;
  return { agent, url: homeUrl, fetch: response(homeUrl, spec) };
};

const article = `<!doctype html><title>Home</title><main>${Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ')}</main>`;

describe('ai-edge-ua-block-probe', () => {
  test('a 403 for an AI search agent that robots.txt allows is low, even when robots.txt names it', () => {
    const { findings, evidence } = run('ai-edge-ua-block-probe', {
      robots: 'User-agent: OAI-SearchBot\nAllow: /\n',
      agentProbes: [probe('*', { body: article }), probe('oai-searchbot', { status: 403, body: 'Forbidden' })],
    });
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.agent, finding.params?.status], ['low', 'ua-blocked', 'OAI-SearchBot', 403]);
    assert.deepEqual(finding.evidence.map(id => evidence.get(id)?.excerpt), ['HTTP 403', 'HTTP 200']);
  });

  test('a challenge for an agent allowed by default is low; one robots.txt disallows is info', () => {
    const challenge = probe('claude-searchbot', { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<title>Just a moment...</title>' });
    const low = only(run('ai-edge-ua-block-probe', { robots: 'User-agent: *\nAllow: /\n', agentProbes: [probe('*', { body: article }), challenge] }).findings);
    assert.deepEqual([low.severity, low.reason], ['low', 'ua-blocked']);
    const info = only(run('ai-edge-ua-block-probe', { robots: 'User-agent: Claude-SearchBot\nDisallow: /\n', agentProbes: [probe('*', { body: article }), challenge] }).findings);
    assert.deepEqual([info.severity, info.reason], ['info', 'blocked-as-robots-says']);
  });

  test('a page whose text barely overlaps the browser page is low', () => {
    const other = `<!doctype html><main>${Array.from({ length: 80 }, (_, index) => `other${index}`).join(' ')}</main>`;
    const finding = only(run('ai-edge-ua-block-probe', { agentProbes: [probe('*', { body: article }), probe('perplexitybot', { body: other })] }).findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.similarity], ['low', 'content-differs', 0]);
  });

  test('Googlebot and Bingbot blocks are left to crawl-bot-blocking, 402 to the pay-per-crawl rule', () => {
    const findings = run('ai-edge-ua-block-probe', {
      agentProbes: [probe('*', { body: article }), probe('googlebot', { status: 403 }), probe('bingbot', { status: 403 }), probe('claude-user', { status: 402 }), probe('applebot', { body: article })],
    }).findings;
    assert.equal(only(findings).outcome, 'pass');
  });

  test('a challenge script the browser page also carries is not a challenge', () => {
    const withScript = `${article}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`;
    assert.equal(only(run('ai-edge-ua-block-probe', { agentProbes: [probe('*', { body: withScript }), probe('oai-searchbot', { body: withScript })] }).findings).outcome, 'pass');
  });

  test('not evaluated without probes or when the browser baseline fails', () => {
    assert.deepEqual([only(run('ai-edge-ua-block-probe', {}).findings).reason], ['missing-input:ua-probe']);
    const failed = only(run('ai-edge-ua-block-probe', { agentProbes: [probe('*', { status: 503 }), probe('oai-searchbot', { status: 403 })] }).findings);
    assert.deepEqual([failed.outcome, failed.reason], ['not_evaluated', 'baseline-not-ok']);
  });
});

describe('ai-pay-per-crawl-402', () => {
  test('a 402 for a search or answer agent is medium and keeps the crawler-* headers', () => {
    const { findings, evidence } = run('ai-pay-per-crawl-402', {
      agentProbes: [probe('*', { body: article }), probe('claude-searchbot', { status: 402, headers: { 'crawler-price': 'USD 0.01' } })],
    });
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.agent], ['medium', 'search-agent-charged', 'Claude-SearchBot']);
    assert.equal(evidence.get(finding.evidence[0]!)?.excerpt, 'HTTP 402\ncrawler-price: USD 0.01');
  });

  test('a 402 for an agent robots.txt disallows is info', () => {
    const finding = only(run('ai-pay-per-crawl-402', {
      robots: 'User-agent: PerplexityBot\nDisallow: /\n',
      agentProbes: [probe('*', { body: article }), probe('perplexitybot', { status: 402 })],
    }).findings);
    assert.deepEqual([finding.severity, finding.reason], ['info', 'training-or-disallowed']);
  });

  test('passes without 402 responses, and is not evaluated when the baseline is not 2xx', () => {
    assert.equal(only(run('ai-pay-per-crawl-402', { agentProbes: [probe('*', { body: article }), probe('oai-searchbot', { body: article })] }).findings).outcome, 'pass');
    const paywall = only(run('ai-pay-per-crawl-402', { agentProbes: [probe('*', { status: 402 }), probe('oai-searchbot', { status: 402 })] }).findings);
    assert.deepEqual([paywall.outcome, paywall.reason], ['not_evaluated', 'baseline-not-ok']);
  });
});

describe('ai-cdn-cloudflare-detected', () => {
  test('a Cloudflare server header is info context', () => {
    const { findings, evidence } = evaluate(rule('ai-cdn-cloudflare-detected'), site({ pages: [home({ headers: { server: 'cloudflare', 'cf-ray': '8f00aa-MAD' } })] }));
    const finding = only(findings);
    assert.deepEqual([finding.severity, finding.reason], ['info', 'cloudflare']);
    assert.equal(evidence.get(finding.evidence[0]!)?.excerpt, 'server: cloudflare');
  });

  test('other servers are not applicable, and no pages means not evaluated', () => {
    const other = only(evaluate(rule('ai-cdn-cloudflare-detected'), site({ pages: [home({ headers: { server: 'nginx' } })] })).findings);
    assert.deepEqual([other.outcome, other.reason], ['not_applicable', 'no-cloudflare']);
    const none = only(evaluate(rule('ai-cdn-cloudflare-detected'), site({ pages: [] })).findings);
    assert.deepEqual([none.outcome, none.reason], ['not_evaluated', 'missing-input:http']);
  });
});
