import { lstat, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { childEnvironment, ProcessError, runProcess } from '../ai/process.ts';
import type { Capabilities } from '../ai/providers.ts';
import type { Usage } from '../ai/types.ts';
import { cleanText } from '../report/sanitize.ts';
import { asRunError, isRecord, removeFolder, toolName, type EngineCall } from './engine.ts';
import { probeInput } from './prompt.ts';
import { answerLimit, ProbeRunError, type RawRun } from './types.ts';

const maxStreamBytes = 8 * 1024 * 1024;
const maxAnswerBytes = 512 * 1024;

/**
 * codex exec with live web search and nothing else: user configuration ignored (so no user MCP servers or
 * model), an ephemeral session, the read-only sandbox, the shell, unified exec, apps and plugins switched off.
 * The configuration reference says unified exec ignores user opt-outs, which is why the event check below fails
 * the run on any command, file change or MCP call instead of trusting the switches.
 */
export function codexProbeArguments(answerFile: string, capabilities: Capabilities): string[] {
  return [
    '--no-daemon',
    '-a', 'never',
    'exec',
    '--ignore-user-config',
    ...(capabilities.extras.has('ignore-rules') ? ['--ignore-rules'] : []),
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', 'features.shell_tool=false',
    '-c', 'features.unified_exec=false',
    '-c', 'features.apps=false',
    '-c', 'plugins._default.enabled=false',
    '-c', 'web_search="live"',
    '--json',
    '--color', 'never',
    '--output-last-message', answerFile,
    // The question arrives on stdin.
    '-',
  ];
}

/** The only items a probe run may contain; command_execution, file_change, mcp_tool_call and anything new fail it. */
const dataItems = new Set(['reasoning', 'agent_message', 'todo_list', 'web_search']);

export interface CodexStream {
  readonly searches: number;
  /** The text of the last agent message, used when the answer file is missing. */
  readonly lastMessage?: string;
  readonly usage?: Usage;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input = count(value.input_tokens);
  const output = count(value.output_tokens);
  const cached = count(value.cached_input_tokens);
  if (input === undefined && output === undefined) return undefined;
  return { ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }), ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
}

/**
 * Checks Codex's JSONL events: one started and completed turn with only reasoning, agent messages, task lists
 * and web searches in between. A command, file change or MCP call fails the run, and so does any item type the
 * probe does not know, so a changed CLI is detected instead of trusted. Web search items carry the query but no
 * results, so nothing in them can confirm a citation.
 */
export function parseCodexStream(stdout: string): CodexStream {
  let started = false;
  let completed = false;
  let searches = 0;
  let lastMessage: string | undefined;
  let usage: Usage | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new ProbeRunError('invalid-response', 'Codex emitted an incomplete event stream.');
    }
    if (!isRecord(event) || typeof event.type !== 'string') throw new ProbeRunError('invalid-response', 'Codex emitted an event Altimeter does not recognise.');
    const type = event.type;
    if (type === 'error' || type === 'turn.failed') throw new ProbeRunError('provider-failed', 'Codex reported a failed turn.');
    if (completed) throw new ProbeRunError('invalid-response', 'Codex emitted events after its completed turn.');
    if (type === 'thread.started' && !started) continue;
    if (type === 'turn.started' && !started) {
      started = true;
      continue;
    }
    if (type === 'turn.completed' && started) {
      completed = true;
      usage = usageOf(event.usage);
      continue;
    }
    if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') && started) {
      const item = event.item;
      if (!isRecord(item) || typeof item.type !== 'string') throw new ProbeRunError('invalid-response', 'Codex emitted an item without a type.');
      if (!dataItems.has(item.type)) throw new ProbeRunError('tool-use', `Codex used ${toolName(item.type)}, which the probe does not allow.`);
      if (type === 'item.completed' && item.type === 'web_search') searches += 1;
      if (type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text;
      continue;
    }
    throw new ProbeRunError('invalid-response', 'Codex emitted an unexpected event or turn sequence.');
  }
  if (!completed) throw new ProbeRunError('incomplete', 'Codex did not complete its turn.');
  return { searches, ...(lastMessage === undefined ? {} : { lastMessage }), ...(usage ? { usage } : {}) };
}

async function readAnswer(file: string): Promise<string | undefined> {
  let size: number;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new ProbeRunError('invalid-response', 'The Codex answer is not a regular file.');
    size = info.size;
  } catch (error) {
    if (error instanceof ProbeRunError) throw error;
    return undefined;
  }
  if (size > maxAnswerBytes) throw new ProbeRunError('invalid-response', 'The Codex answer exceeds its size limit.');
  return readFile(file, 'utf8');
}

/**
 * One Codex run in a new empty temporary folder, which also receives the final answer and is removed afterwards.
 * API keys are never forwarded, so only the user's own sign-in is used.
 */
export async function runCodexProbe(call: EngineCall): Promise<RawRun> {
  const started = performance.now();
  const directory = await mkdtemp(join(tmpdir(), 'altimeter-probe-codex-'));
  try {
    if ((await readdir(directory)).length > 0) throw new ProbeRunError('unsafe-directory', 'The new working folder was not empty.');
    const answerFile = join(directory, 'answer.md');
    let stdout: string;
    try {
      const result = await runProcess({
        executable: call.provider.command.executable,
        args: [...call.provider.command.prefix, ...codexProbeArguments(answerFile, call.provider.capabilities)],
        cwd: directory,
        env: childEnvironment(call.env),
        input: probeInput(call.query, true),
        timeoutMs: call.timeoutMs,
        maxOutputBytes: maxStreamBytes,
        ...(call.signal ? { signal: call.signal } : {}),
      });
      stdout = result.stdout;
    } catch (error) {
      // A failed exit can still carry the events that say why.
      if (error instanceof ProcessError && error.code === 'exit-nonzero' && error.stdout) parseCodexStream(error.stdout);
      throw asRunError(error);
    }
    const stream = parseCodexStream(stdout);
    const text = (await readAnswer(answerFile)) ?? stream.lastMessage ?? '';
    const answer = cleanText(text, answerLimit).trim();
    if (answer === '') throw new ProbeRunError('missing-answer', 'Codex returned no answer.');
    return {
      answer,
      searches: stream.searches,
      ...(stream.usage ? { usage: stream.usage } : {}),
      durationMs: Math.round(performance.now() - started),
      at: (call.now ?? (() => new Date()))().toISOString(),
    };
  } finally {
    await removeFolder(directory);
  }
}
