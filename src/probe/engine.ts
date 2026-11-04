import { ProcessError } from '../ai/process.ts';
import type { Environment, ResolvedProvider } from '../ai/providers.ts';
import { ProbeRunError } from './types.ts';

/** One run of one engine: the question, the resolved CLI and the environment it may see. */
export interface EngineCall {
  readonly query: string;
  readonly provider: ResolvedProvider;
  readonly env: Environment;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/[\]@-]{0,127}$/u;

/** A model identifier as an engine reported it, or undefined when it is not a plain identifier. */
export function modelName(value: unknown): string | undefined {
  return typeof value === 'string' && modelPattern.test(value) ? value : undefined;
}

/** A tool or item name from engine output, reduced to safe characters for an error message. */
export function toolName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.:-]/gu, '').slice(0, 40);
  return cleaned === '' ? 'an unnamed tool' : cleaned;
}

/** Any failure of a run as a ProbeRunError; process failures keep their code, and nothing from stderr is kept. */
export function asRunError(error: unknown): ProbeRunError {
  if (error instanceof ProbeRunError) return error;
  if (error instanceof ProcessError) return new ProbeRunError(error.code, error.message);
  return new ProbeRunError('provider-failed', 'The run failed unexpectedly.');
}
