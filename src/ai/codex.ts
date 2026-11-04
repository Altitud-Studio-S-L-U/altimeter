import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment, ProcessError, runProcess } from './process.ts';
import { assertModel, fromProcessError, resolveProvider, type Capabilities, type ProviderCallInput, type ResolvedProvider } from './providers.ts';
import { systemPrompt } from './system-prompt.ts';
import { ProviderError, type CallResult, type Usage } from './types.ts';

const maxAnswerBytes = 512 * 1024;
const maxStreamBytes = 8 * 1024 * 1024;

export function codexArguments(options: { readonly schemaFile: string; readonly answerFile: string; readonly model?: string; readonly capabilities: Capabilities }): string[] {
  const verified = options.capabilities.extras;
  return [
    '--no-daemon',
    '-a', 'never',
    'exec',
    '--ignore-user-config',
    ...(verified.has('ignore-rules') ? ['--ignore-rules'] : []),
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', 'features.shell_tool=false',
    // Every tool surface the verified build enables by default is switched off; the event check below still
    // fails the call if one is used anyway.
    ...(verified.has('feature-overrides')
      ? ['-c', 'features.unified_exec=false', '-c', 'features.apps=false', '-c', 'plugins._default.enabled=false', '-c', 'web_search="disabled"']
      : []),
    '--json',
    '--color', 'never',
    '--output-schema', options.schemaFile,
    '--output-last-message', options.answerFile,
    ...(options.model ? ['-m', options.model] : []),
    // The prompt arrives on stdin. Nothing that takes several values, such as --image, may come right before this.
    '-',
  ];
}

const dataItems = new Set(['reasoning', 'agent_message', 'todo_list']);

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageOf(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const input = count(record.input_tokens);
  const output = count(record.output_tokens);
  const cached = count(record.cached_input_tokens);
  if (input === undefined && output === undefined) return undefined;
  return { ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }), ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
}

/**
 * Checks Codex's JSONL event stream: one started and completed turn, and only reasoning, agent messages and
 * task lists in between. A command, file change, MCP call, web search or any unknown item fails the call, so an
 * incompatible CLI change is detected instead of trusted.
 */
export function validateCodexEvents(stdout: string): Usage | undefined {
  let started = false;
  let completed = false;
  let usage: Usage | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new ProviderError('invalid-response', 'Codex emitted an incomplete event stream.', 'codex');
    }
    if (!event || typeof event !== 'object' || typeof (event as Record<string, unknown>).type !== 'string') {
      throw new ProviderError('invalid-response', 'Codex emitted an event Altimeter does not recognise.', 'codex');
    }
    const record = event as Record<string, unknown>;
    const type = record.type as string;
    if (type === 'error' || type === 'turn.failed') throw new ProviderError('provider-failed', 'Codex reported a failed turn.', 'codex');
    if (completed) throw new ProviderError('invalid-response', 'Codex emitted events after its completed turn.', 'codex');
    if (type === 'thread.started' && !started) continue;
    if (type === 'turn.started' && !started) {
      started = true;
      continue;
    }
    if (type === 'turn.completed' && started) {
      completed = true;
      usage = usageOf(record.usage);
      continue;
    }
    if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') && started) {
      const item = record.item as Record<string, unknown> | undefined;
      if (!item || typeof item.type !== 'string') throw new ProviderError('invalid-response', 'Codex emitted an item without a type.', 'codex');
      if (!dataItems.has(item.type)) throw new ProviderError('tool-use', `Codex used ${item.type.slice(0, 40)}, which this call does not allow.`, 'codex');
      continue;
    }
    throw new ProviderError('invalid-response', 'Codex emitted an unexpected event or turn sequence.', 'codex');
  }
  if (!completed) throw new ProviderError('invalid-response', 'Codex did not complete its turn.', 'codex');
  return usage;
}

async function readAnswer(file: string): Promise<unknown> {
  let size: number;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new ProviderError('invalid-response', 'The Codex answer is not a regular file.', 'codex');
    size = info.size;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('missing-output', 'Codex did not write a final answer.', 'codex');
  }
  if (size > maxAnswerBytes) throw new ProviderError('invalid-response', 'The Codex answer exceeds its size limit.', 'codex');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new ProviderError('invalid-response', 'The Codex answer is not complete JSON.', 'codex');
  }
}

async function attempt(input: ProviderCallInput, provider: ResolvedProvider): Promise<CallResult> {
  // A fresh private folder per call holds the schema and the answer and is the working directory; it is removed
  // whatever happens.
  const directory = await mkdtemp(join(tmpdir(), 'altimeter-codex-'));
  try {
    const schemaFile = join(directory, 'schema.json');
    const answerFile = join(directory, 'answer.json');
    await writeFile(schemaFile, JSON.stringify(input.schema), { flag: 'wx', mode: 0o600 });
    const args = [...provider.command.prefix, ...codexArguments({ schemaFile, answerFile, ...(input.model ? { model: input.model } : {}), capabilities: provider.capabilities })];
    const env = input.env ?? process.env;
    const result = await runProcess({
      executable: provider.command.executable,
      args,
      cwd: directory,
      env: childEnvironment(env, { useApiKeys: input.useApiKeys === true }),
      input: `${systemPrompt}\n\n${input.prompt}`,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: maxStreamBytes,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const usage = validateCodexEvents(result.stdout);
    const value = await readAnswer(answerFile);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('invalid-response', 'The Codex answer is not a JSON object.', 'codex');
    return { value, ...(input.model ? { model: input.model } : {}), ...(usage ? { usage } : {}), cliVersion: provider.version };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** One Codex call: read-only sandbox, no tools, an ephemeral session and a strict output schema. */
export async function call(input: ProviderCallInput): Promise<CallResult> {
  assertModel(input.model, 'codex');
  const env = input.env ?? process.env;
  let provider = input.provider ?? await resolveProvider('codex', { env });
  try {
    return await attempt(input, provider);
  } catch (error) {
    // The desktop app replaces its versioned folder on update; find the new executable once and retry.
    const vanished = error instanceof ProcessError && error.code === 'start-failed' && error.systemCode === 'ENOENT';
    if (!vanished || provider.command.source === 'env') throw fromProcessError(error, 'codex');
    provider = await resolveProvider('codex', { env });
    try {
      return await attempt(input, provider);
    } catch (retryError) {
      throw fromProcessError(retryError, 'codex');
    }
  }
}
