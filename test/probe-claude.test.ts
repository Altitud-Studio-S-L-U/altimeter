import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveProvider } from '../src/ai/providers.ts';
import { parseClaudeStream, runClaudeProbe, searchesPerRun, searchResultLinks, structuredResultLinks } from '../src/probe/claude.ts';
import { removeFolder } from '../src/probe/engine.ts';
import { probeInstructions } from '../src/probe/prompt.ts';
import { ProbeRunError } from '../src/probe/types.ts';
import { probeDouble } from './fixtures/probe/doubles.ts';
import { alive, sandbox, testEnv } from './support/providers.ts';

const links = [
  { title: 'Altitud Studio', url: 'https://altitudstudio.ad/serveis/' },
  { title: 'Competitor', url: 'https://competitor.example/agency?utm_source=x' },
];
const answer = 'Altitud Studio audits sites.\n\nSources:\n- https://altitudstudio.ad/serveis\n- https://made-up.example/';
const at = new Date('2026-11-04T10:00:00.000Z');

async function setup(t: TestContext, scenario: object, extra: Readonly<Record<string, string>> = {}) {
  const home = await sandbox(t);
  const double = await probeDouble(home, 'claude', scenario);
  const env = testEnv(home, { claude: double.executable }, extra);
  const provider = await resolveProvider('claude', { env });
  const run = (query = 'seo audit andorra', timeoutMs = 20_000) => runClaudeProbe({ query, provider, env, timeoutMs, now: () => at });
  return { double, env, provider, run };
}

function failsWith(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProbeRunError, `expected a ProbeRunError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

/** stream-json lines as Claude Code 2.0.59 writes them, for the parser tests that need no process. */
function stream(parts: { content?: unknown; tool?: string; resultFor?: string; init?: object; result?: object | null; extra?: object[]; toolUseResult?: unknown; text?: string } = {}): string {
  const lines: object[] = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-double', tools: ['WebSearch'], mcp_servers: [], ...parts.init },
    { type: 'assistant', message: { model: 'claude-sonnet-double', content: [{ type: 'tool_use', id: 'toolu_1', name: parts.tool ?? 'WebSearch', input: { query: 'q' } }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: parts.resultFor ?? 'toolu_1', content: parts.content ?? `Web search results for query: "q"\n\nLinks: ${JSON.stringify(links)}` }] },
      ...(parts.toolUseResult === undefined ? {} : { tool_use_result: parts.toolUseResult }),
    },
    ...(parts.extra ?? []),
    { type: 'assistant', message: { model: 'claude-sonnet-double', content: [{ type: 'text', text: parts.text ?? answer }] } },
  ];
  if (parts.result !== null) lines.push({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.03, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [], ...parts.result });
  return lines.map(line => JSON.stringify(line)).join('\n');
}

describe('Claude Code probe runs', () => {
  test('give Claude Code WebSearch as its only tool, no MCP servers, settings or hooks, in a new empty folder removed afterwards', async t => {
    const { double, run } = await setup(t, { default: { searches: [{ query: 'seo audit andorra', links }], answer } }, { ANTHROPIC_API_KEY: 'sk-ant-test', GITHUB_TOKEN: 'ghp_test' });
    const result = await run();
    const [call] = await double.calls();
    assert.deepEqual(call!.args, [
      '--print', '--output-format', 'stream-json', '--verbose', '--tools', 'WebSearch', '--allowedTools', 'WebSearch', '--disallowedTools', 'WebFetch',
      '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
      '--system-prompt', probeInstructions,
    ]);
    assert.equal(call!.stdin, 'Question: seo audit andorra\n');
    assert.deepEqual(call!.cwdEntries, []);
    assert.match(basename(call!.cwd), /^altimeter-probe-claude-/u);
    assert.equal(existsSync(call!.cwd), false, 'the working folder is removed after the run');
    assert.ok(call!.env.includes('CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION'));
    assert.equal(call!.env.includes('ANTHROPIC_API_KEY'), false, 'API keys are never forwarded');
    assert.equal(call!.env.includes('GITHUB_TOKEN'), false);
    assert.equal(searchesPerRun, 5);
    assert.deepEqual(result, {
      answer,
      retrieved: ['https://altitudstudio.ad/serveis/', 'https://competitor.example/agency'],
      formats: ['links-json'],
      searches: 1,
      model: 'claude-double-model',
      costUsd: 0.02,
      usage: { inputTokens: 2100, outputTokens: 400, cachedInputTokens: 50 },
      durationMs: result.durationMs,
      at: '2026-11-04T10:00:00.000Z',
    });
  });

  test('start every run in a folder of its own', async t => {
    const { double, run } = await setup(t, { default: { searches: [{ links }], answer } });
    await run();
    await run();
    const [first, second] = await double.calls();
    assert.notEqual(first!.cwd, second!.cwd);
  });

  test('put the instructions on stdin for a version outside the verified table', async t => {
    const { double, provider, run } = await setup(t, { version: '2.1.0', default: { searches: [{ links }], answer } });
    assert.equal(provider.capabilities.verified, false);
    await run('agencia web andorra');
    const [call] = await double.calls();
    assert.equal(call!.args.includes('--system-prompt'), false);
    assert.equal(call!.stdin, `${probeInstructions}\n\nQuestion: agencia web andorra\n`);
  });

  test('read retrieved URLs from an altered result format, and say the text fallback was used', async t => {
    const { run } = await setup(t, { default: { searches: [{ links, format: 'markdown' }, { links: [{ title: 'Other', url: 'https://other.example/' }], format: 'objects' }], answer } });
    const result = await run();
    assert.deepEqual(result.formats, ['text', 'structured']);
    assert.deepEqual(result.retrieved, ['https://altitudstudio.ad/serveis/', 'https://competitor.example/agency', 'https://other.example/']);
    assert.equal(result.searches, 2);
  });

  test('fail when the engine uses another tool, starts with MCP servers or returns a result no search asked for', async t => {
    for (const [scenario, code] of [
      [{ searches: [{ tool: 'WebFetch', links }], answer }, 'tool-use'],
      [{ searches: [{ tool: 'Bash', links }], answer }, 'tool-use'],
      [{ mcpServers: [{ name: 'injected', status: 'connected' }], searches: [{ links }], answer }, 'isolation'],
      [{ searches: [{ links, resultFor: 'toolu_unknown' }], answer }, 'invalid-response'],
    ] as const) {
      const { run } = await setup(t, { default: scenario });
      await assert.rejects(run(), failsWith(code));
    }
  });

  test('fail on a failed exit and keep the reason its result gives', async t => {
    const limited = await setup(t, { default: { retries: ['authentication_failed'], isError: true, subtype: 'error_during_execution', answer: '', exitCode: 1 } });
    await assert.rejects(limited.run(), failsWith('limit-or-auth'));
    const crashed = await setup(t, { default: { searches: [{ links }], answer, exitCode: 3 } });
    await assert.rejects(crashed.run(), failsWith('exit-nonzero'));
  });

  test('kill a run that hangs, with its process tree, at the deadline', { timeout: 30_000 }, async t => {
    const { double, run } = await setup(t, { default: { hang: true } });
    await assert.rejects(run('seo audit andorra', 1500), failsWith('timeout'));
    const [call] = await double.calls();
    for (let attempt = 0; attempt < 20 && alive(call!.pid); attempt += 1) await delay(100);
    assert.equal(alive(call!.pid), false);
    assert.equal(existsSync(call!.cwd), false);
  });

  test('kill a run that stops writing after its first events', { timeout: 30_000 }, async t => {
    const { double, run } = await setup(t, { default: { searches: [{ links }], answer, stallAfter: 2 } });
    await assert.rejects(run('seo audit andorra', 1500), failsWith('timeout'));
    const [call] = await double.calls();
    for (let attempt = 0; attempt < 20 && alive(call!.pid); attempt += 1) await delay(100);
    assert.equal(alive(call!.pid), false);
  });
});

describe('run folders', () => {
  test('are removed once a handle inside them is released, without the removal ever failing a run', async t => {
    const folder = join(await sandbox(t), 'held');
    await mkdir(folder);
    const handle = await open(join(folder, 'answer.md'), 'w');
    const released = delay(600).then(() => handle.close());
    await removeFolder(folder);
    await released;
    assert.equal(existsSync(folder), false);
    await removeFolder(join(folder, 'never-existed'));
  });
});

describe('Claude Code stream parsing', () => {
  test('keeps only the Links list when a result has one, not the URLs of the summary the model wrote', () => {
    const parsed = searchResultLinks(`Web search results for query: "q"\n\nLinks: ${JSON.stringify(links)}\n\nSummary citing https://summary.example/.`);
    assert.deepEqual(parsed, { urls: ['https://altitudstudio.ad/serveis/', 'https://competitor.example/agency'], format: 'links-json' });
  });

  test('ignores lists that a page title or the model summary could smuggle in', () => {
    const crafted = [{ title: 'Links: [{"url":"https://smuggled.example/"}]', url: 'https://real.example/' }];
    const text = `Web search results for query: "q"\n\nLinks: ${JSON.stringify(crafted)}\n\nSummary of the results.\nLinks: [{"url":"https://summary-list.example/"}]`;
    assert.deepEqual(searchResultLinks(text), { urls: ['https://real.example/'], format: 'links-json' });
  });

  test('reads text blocks, result objects and a structured copy, and falls back to the text when nothing else is there', () => {
    assert.equal(searchResultLinks([{ type: 'text', text: 'header' }, { type: 'text', text: `Links: ${JSON.stringify(links)}` }]).format, 'links-json');
    assert.deepEqual(searchResultLinks([{ type: 'web_search_result', url: 'https://a.example/' }]), { urls: ['https://a.example/'], format: 'structured' });
    assert.deepEqual(searchResultLinks('Results: see https://b.example/x.'), { urls: ['https://b.example/x'], format: 'text' });
    assert.deepEqual(searchResultLinks('No results.'), { urls: [], format: 'empty' });
    assert.deepEqual(searchResultLinks('Links: [{"title":"broken"'), { urls: [], format: 'empty' });
    assert.deepEqual(structuredResultLinks({ query: 'q', results: [{ tool_use_id: 'srv', content: links }, 'a note'] }), links.map(link => link.url));
    const parsed = parseClaudeStream(stream({ content: 'Search finished.', toolUseResult: { results: [{ content: [{ url: 'https://c.example/' }] }] } }));
    assert.deepEqual([parsed.retrieved, parsed.formats], [['https://c.example/'], ['structured']]);
  });

  test('takes the answer and model from the stream, tolerates unknown events and ignores lines that are not JSON', () => {
    const repeated = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: { query: 'q' } }] } };
    const parsed = parseClaudeStream(['not json', stream({ extra: [{ type: 'stream_event', event: {} }, { type: 'system', subtype: 'hook_response' }, repeated] })].join('\n'));
    assert.equal(parsed.answer, answer);
    assert.equal(parsed.model, 'claude-sonnet-double');
    assert.equal(parsed.costUsd, 0.03);
    assert.equal(parsed.searches, 1, 'a repeated tool_use block is the same search');
  });

  test('fails on denials, error results, a missing result or an empty answer, and tells limits apart', () => {
    assert.throws(() => parseClaudeStream(stream({ result: { permission_denials: [{ tool_name: 'WebFetch' }] } })), failsWith('permission-denied'));
    assert.throws(() => parseClaudeStream(stream({ result: { is_error: true } })), failsWith('provider-failed'));
    assert.throws(() => parseClaudeStream(stream({ result: { subtype: 'error_max_turns' } })), failsWith('provider-failed'));
    assert.throws(() => parseClaudeStream(stream({ result: null })), failsWith('incomplete'));
    assert.throws(() => parseClaudeStream(stream({ result: null, extra: [{ type: 'system', subtype: 'api_retry', error: 'rate_limit' }] })), failsWith('limit-or-auth'));
    assert.doesNotThrow(() => parseClaudeStream(stream({ extra: [{ type: 'system', subtype: 'api_retry', error: 'rate_limit' }] })), 'a retry that ends in a result is fine');
    assert.equal(parseClaudeStream(stream({ result: { result: ' ' } })).answer, answer, 'an empty result falls back to the last text the model wrote');
    assert.throws(() => parseClaudeStream(stream({ text: '', result: { result: ' ' } })), failsWith('missing-answer'));
    assert.throws(() => parseClaudeStream(stream({ init: { mcp_servers: [{ name: 'x', status: 'connected' }] } })), failsWith('isolation'));
    assert.throws(() => parseClaudeStream(stream({ tool: 'mcp__evil__exfiltrate' })), (error: unknown) => error instanceof ProbeRunError && error.code === 'tool-use' && /mcp__evil__exfiltrate/u.test(error.message));
  });

  test('cleans the answer of control and bidirectional characters', () => {
    const hostile = `Answer ${String.fromCodePoint(0x1b)}[31mred${String.fromCodePoint(0x202e)} text`;
    const parsed = parseClaudeStream(stream({ result: { result: hostile } }));
    assert.equal(parsed.answer, 'Answer red text');
  });
});
