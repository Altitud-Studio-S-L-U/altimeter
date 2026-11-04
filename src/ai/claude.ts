import { childEnvironment, ProcessError, runProcess } from './process.ts';
import { assertModel, fromProcessError, prepareWorkingDirectory, providerWorkingDirectory, resolveProvider, type Capabilities, type ProviderCallInput } from './providers.ts';
import type { Schema } from './schema.ts';
import { systemPrompt } from './system-prompt.ts';
import { ProviderError, type CallResult, type Usage } from './types.ts';

export function claudeArguments(options: { readonly schema: Schema; readonly model?: string; readonly capabilities: Capabilities }): string[] {
  return [
    '--print',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(options.schema),
    // No built-in tools, MCP servers, settings files or hooks: the call can only read stdin and answer.
    '--tools', '',
    '--permission-mode', 'plan',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}',
    ...(options.capabilities.extras.has('system-prompt') ? ['--system-prompt', systemPrompt] : []),
    ...(options.model ? ['--model', options.model] : []),
  ];
}

/** Versions without a verified --system-prompt flag get the same text at the top of stdin. */
export function claudeInput(prompt: string, capabilities: Capabilities): string {
  return capabilities.extras.has('system-prompt') ? prompt : `${systemPrompt}\n\n${prompt}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageOf(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const input = finiteNumber(record.input_tokens);
  const output = finiteNumber(record.output_tokens);
  const cached = finiteNumber(record.cache_read_input_tokens);
  if (input === undefined && output === undefined) return undefined;
  return { ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }), ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
}

/**
 * Reads Claude's --output-format json envelope. Only a successful result with structured output and no
 * permission denials counts; retries exhausted on the schema, any denial or a missing structured_output fail.
 */
export function decodeClaude(stdout: string): Omit<CallResult, 'cliVersion'> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new ProviderError('invalid-response', 'Claude did not return a complete result envelope.', 'claude');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || (envelope as Record<string, unknown>).type !== 'result') {
    throw new ProviderError('invalid-response', 'Claude returned something other than a result envelope.', 'claude');
  }
  const record = envelope as Record<string, unknown>;
  if (record.subtype === 'error_max_structured_output_retries') {
    throw new ProviderError('structured-output-retries', 'Claude could not produce output that matches the schema.', 'claude');
  }
  if (Array.isArray(record.permission_denials) && record.permission_denials.length > 0) {
    throw new ProviderError('permission-denied', 'Claude reported a denied operation; no approval is inferred.', 'claude');
  }
  if (record.is_error !== false || record.subtype !== 'success') throw new ProviderError('provider-failed', 'Claude did not complete the request.', 'claude');
  const value = record.structured_output;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('missing-output', 'Claude did not return structured output.', 'claude');
  const costUsd = finiteNumber(record.total_cost_usd);
  const usage = usageOf(record.usage);
  // Claude Code also runs a small model for housekeeping; the answer comes from the model that cost the most.
  const models = record.modelUsage && typeof record.modelUsage === 'object' ? Object.entries(record.modelUsage as Record<string, unknown>) : [];
  const costOf = (entry: unknown) => finiteNumber(entry && typeof entry === 'object' ? (entry as Record<string, unknown>).costUSD : undefined) ?? 0;
  const model = [...models].sort((a, b) => costOf(b[1]) - costOf(a[1]))[0]?.[0];
  return {
    value,
    ...(model ? { model } : {}),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(usage ? { usage } : {}),
  };
}

/** One Claude Code call: the prompt on stdin, the schema inline, no tools, in the stable empty working directory. */
export async function call(input: ProviderCallInput): Promise<CallResult> {
  assertModel(input.model, 'claude');
  const env = input.env ?? process.env;
  const provider = input.provider ?? await resolveProvider('claude', { env });
  const cwd = input.workingDirectory ?? providerWorkingDirectory(env);
  await prepareWorkingDirectory(cwd);
  const args = [...provider.command.prefix, ...claudeArguments({ schema: input.schema, ...(input.model ? { model: input.model } : {}), capabilities: provider.capabilities })];
  let stdout: string;
  try {
    const result = await runProcess({
      executable: provider.command.executable,
      args,
      cwd,
      env: childEnvironment(env, { useApiKeys: input.useApiKeys === true }),
      input: claudeInput(input.prompt, provider.capabilities),
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    stdout = result.stdout;
  } catch (error) {
    // A failed exit may still carry an envelope that says why, such as exhausted schema retries.
    if (error instanceof ProcessError && error.code === 'exit-nonzero' && error.stdout) {
      try {
        decodeClaude(error.stdout);
      } catch (reason) {
        if (reason instanceof ProviderError && reason.code !== 'invalid-response') throw reason;
      }
    }
    throw fromProcessError(error, 'claude');
  }
  return { ...decodeClaude(stdout), cliVersion: provider.version };
}
