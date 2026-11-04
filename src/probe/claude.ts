import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { childEnvironment, ProcessError, runProcess } from '../ai/process.ts';
import type { Capabilities } from '../ai/providers.ts';
import type { Usage } from '../ai/types.ts';
import { cleanText } from '../report/sanitize.ts';
import { asRunError, isRecord, list, modelName, removeFolder, toolName, type EngineCall } from './engine.ts';
import { probeInput, probeInstructions } from './prompt.ts';
import { answerLimit, ProbeRunError, type RawRun, type RetrievalFormat } from './types.ts';
import { canonicalList, urlsInText } from './urls.ts';

/** A few searches with their summaries stay far below this; a run that writes more is stopped. */
const maxStreamBytes = 8 * 1024 * 1024;
/** Retrieved URLs kept for one run; WebSearch returns about ten per search. */
const maxRetrieved = 200;

/**
 * WebSearch calls one run may make. Claude Code reads CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, per turn in
 * print mode; a version that does not know it ignores it. A tool convention: a question needs one to three.
 */
export const searchesPerRun = 5;

/**
 * Claude Code with WebSearch as its only tool: --tools limits the built-in tools to it, --allowedTools approves
 * it, WebFetch is denied by name, and dontAsk denies anything else that would need approval. No MCP servers, no
 * setting sources (so no user or project settings, hooks or permission rules) and hooks disabled.
 */
export function claudeProbeArguments(capabilities: Capabilities): string[] {
  return [
    '--print',
    '--output-format', 'stream-json',
    // Print mode writes stream-json only with --verbose.
    '--verbose',
    '--tools', 'WebSearch',
    '--allowedTools', 'WebSearch',
    '--disallowedTools', 'WebFetch',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}',
    ...(capabilities.extras.has('system-prompt') ? ['--system-prompt', probeInstructions] : []),
  ];
}

// system/api_retry categories after which the account cannot go on: sign-in, plan, billing or rate limits.
const blockingRetryErrors = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'rate_limit']);

/** Index of the bracket that closes the array or object opening at `start`, honouring JSON strings, or -1. */
function closingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) return character === ']' ? index : -1;
    }
  }
  return -1;
}

/**
 * The JSON list after "Links:" in a result text, the form WebSearch results take in Claude Code 2.0.59. Only the
 * first one that starts a line counts: a page title inside the list cannot hold a line break, and the summary the
 * model writes from the results comes after the list, so neither can add URLs of its own.
 */
function linksList(text: string): unknown[] | undefined {
  const match = /(?:^|\n)Links:[ \t]*\[/u.exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  const end = closingBracket(text, start);
  if (end === -1) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value) ? value : undefined;
  } catch {
    // Not JSON after all; the text fallback still reads its URLs.
    return undefined;
  }
}

const urlsOf = (entries: readonly unknown[]): string[] => entries.flatMap(entry => (isRecord(entry) && typeof entry.url === 'string' ? [entry.url] : []));

export interface SearchResultLinks {
  readonly urls: readonly string[];
  readonly format: RetrievalFormat;
}

/**
 * The URLs of one WebSearch result, read from whichever shape it has: text with a "Links:" JSON list, blocks or
 * objects that carry a url, or, failing both, any URL in its text. The text also holds a summary the model
 * wrote from the results, so the last form is reported as a fallback. Nothing else is read from a result.
 */
export function searchResultLinks(content: unknown): SearchResultLinks {
  const texts: string[] = [];
  const structured: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) for (const entry of value) visit(entry, depth + 1);
    else if (isRecord(value)) {
      if (typeof value.text === 'string') texts.push(value.text);
      if (typeof value.url === 'string') structured.push(value.url);
      if (value.content !== undefined) visit(value.content, depth + 1);
    }
  };
  visit(content, 0);
  const lists = texts.map(linksList).filter((entry): entry is unknown[] => entry !== undefined);
  if (lists.length > 0) return { urls: canonicalList([...lists.flatMap(urlsOf), ...structured], maxRetrieved), format: 'links-json' };
  if (structured.length > 0) return { urls: canonicalList(structured, maxRetrieved), format: 'structured' };
  const fromText = texts.flatMap(text => urlsInText(text, maxRetrieved));
  return fromText.length > 0 ? { urls: canonicalList(fromText, maxRetrieved), format: 'text' } : { urls: [], format: 'empty' };
}

/** URLs in the structured tool_use_result some Claude Code versions attach to a WebSearch result message. */
export function structuredResultLinks(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return list(value.results).flatMap(entry => (isRecord(entry) ? urlsOf(list(entry.content)) : []));
}

export interface ClaudeStream {
  readonly answer: string;
  readonly searches: number;
  readonly retrieved: readonly string[];
  readonly formats: readonly RetrievalFormat[];
  readonly model?: string;
  readonly costUsd?: number;
  readonly usage?: Usage;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input = count(value.input_tokens);
  const output = count(value.output_tokens);
  const cached = count(value.cache_read_input_tokens);
  if (input === undefined && output === undefined) return undefined;
  return { ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }), ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
}

/**
 * Reads Claude Code's stream-json output, which is not a documented contract, as tolerantly as is safe. Unknown
 * events are skipped, but any tool other than WebSearch, an MCP server, a tool result no search asked for, a
 * permission denial, an error result or a missing result fails the run.
 */
export function parseClaudeStream(stdout: string): ClaudeStream {
  const searchIds = new Set<string>();
  const retrieved: string[] = [];
  const formats: RetrievalFormat[] = [];
  let searches = 0;
  let model: string | undefined;
  let lastText = '';
  let result: Record<string, unknown> | undefined;
  let blocked = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === 'system') {
      if (event.subtype === 'init') {
        model ??= modelName(event.model);
        if (list(event.mcp_servers).length > 0) throw new ProbeRunError('isolation', 'Claude Code started with MCP servers, although the probe gives it none.');
      } else if (event.subtype === 'api_retry' && typeof event.error === 'string' && blockingRetryErrors.has(event.error)) {
        blocked = true;
      }
      continue;
    }
    if (event.type === 'result') {
      result = event;
      continue;
    }
    const message = isRecord(event.message) ? event.message : undefined;
    if (!message || (event.type !== 'assistant' && event.type !== 'user')) continue;
    if (event.type === 'assistant') {
      model ??= modelName(message.model);
      const texts: string[] = [];
      for (const block of list(message.content)) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          const name = typeof block.name === 'string' ? block.name : '';
          if (name !== 'WebSearch' && name !== 'web_search') throw new ProbeRunError('tool-use', `Claude Code used ${toolName(name)}, which the probe does not allow.`);
          // A block repeated in a later event is the same search.
          if (typeof block.id !== 'string') searches += 1;
          else if (!searchIds.has(block.id)) {
            searchIds.add(block.id);
            searches += 1;
          }
        } else if (block.type === 'web_search_tool_result') {
          const links = searchResultLinks(block.content);
          retrieved.push(...links.urls);
          formats.push(links.format);
        } else if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) lastText = texts.join('\n');
      continue;
    }
    const results = list(message.content).filter(block => isRecord(block) && block.type === 'tool_result') as Array<Record<string, unknown>>;
    for (const block of results) {
      if (typeof block.tool_use_id !== 'string' || !searchIds.has(block.tool_use_id)) {
        throw new ProbeRunError('invalid-response', 'Claude Code returned a tool result that no web search of this run asked for.');
      }
      if (block.is_error === true) continue;
      const links = searchResultLinks(block.content);
      // The structured copy belongs to the result only when the message carries a single one.
      const extra = results.length === 1 ? structuredResultLinks(event.tool_use_result) : [];
      if ((links.format === 'text' || links.format === 'empty') && extra.length > 0) {
        retrieved.push(...extra);
        formats.push('structured');
      } else {
        retrieved.push(...links.urls, ...extra);
        formats.push(links.format);
      }
    }
  }
  if (!result) {
    throw blocked
      ? new ProbeRunError('limit-or-auth', 'Claude Code stopped at a sign-in, plan or rate limit.')
      : new ProbeRunError('incomplete', 'Claude Code ended without a result.');
  }
  if (list(result.permission_denials).length > 0) throw new ProbeRunError('permission-denied', 'Claude Code reported a denied operation; no approval is inferred.');
  if (result.is_error !== false || result.subtype !== 'success') {
    throw blocked
      ? new ProbeRunError('limit-or-auth', 'Claude Code stopped at a sign-in, plan or rate limit.')
      : new ProbeRunError('provider-failed', 'Claude Code did not complete the run.');
  }
  const text = typeof result.result === 'string' && result.result.trim() !== '' ? result.result : lastText;
  const answer = cleanText(text, answerLimit).trim();
  if (answer === '') throw new ProbeRunError('missing-answer', 'Claude Code returned no answer.');
  model ??= Object.keys(isRecord(result.modelUsage) ? result.modelUsage : {}).map(modelName).find(name => name !== undefined);
  const costUsd = count(result.total_cost_usd);
  const usage = usageOf(result.usage);
  return {
    answer,
    searches,
    retrieved: canonicalList(retrieved, maxRetrieved),
    formats,
    ...(model ? { model } : {}),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(usage ? { usage } : {}),
  };
}

/**
 * One Claude Code run: the question on stdin, in a new empty temporary folder that is removed afterwards, with
 * the environment the CLI needs and nothing else. API keys are never forwarded, so only the user's own sign-in
 * is used. The process tree is killed at the deadline.
 */
export async function runClaudeProbe(call: EngineCall): Promise<RawRun> {
  const started = performance.now();
  const capabilities = call.provider.capabilities;
  const directory = await mkdtemp(join(tmpdir(), 'altimeter-probe-claude-'));
  try {
    // Files in the working folder, such as a CLAUDE.md, would be read as instructions.
    if ((await readdir(directory)).length > 0) throw new ProbeRunError('unsafe-directory', 'The new working folder was not empty.');
    let stdout: string;
    try {
      const result = await runProcess({
        executable: call.provider.command.executable,
        args: [...call.provider.command.prefix, ...claudeProbeArguments(capabilities)],
        cwd: directory,
        env: { ...childEnvironment(call.env), CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: String(searchesPerRun) },
        input: probeInput(call.query, !capabilities.extras.has('system-prompt')),
        timeoutMs: call.timeoutMs,
        maxOutputBytes: maxStreamBytes,
        ...(call.signal ? { signal: call.signal } : {}),
      });
      stdout = result.stdout;
    } catch (error) {
      // A failed exit can still carry a result that says why, such as a usage limit.
      if (error instanceof ProcessError && error.code === 'exit-nonzero' && error.stdout) parseClaudeStream(error.stdout);
      throw asRunError(error);
    }
    const stream = parseClaudeStream(stdout);
    return {
      answer: stream.answer,
      retrieved: stream.retrieved,
      formats: stream.formats,
      searches: stream.searches,
      ...(stream.model ? { model: stream.model } : {}),
      ...(stream.costUsd === undefined ? {} : { costUsd: stream.costUsd }),
      ...(stream.usage ? { usage: stream.usage } : {}),
      durationMs: Math.round(performance.now() - started),
      at: (call.now ?? (() => new Date()))().toISOString(),
    };
  } finally {
    await removeFolder(directory);
  }
}
