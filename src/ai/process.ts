import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/** Windows rejects command lines over 32,767 characters; staying well below leaves room for quoting differences. */
export const maxCommandLineLength = 30_000;
export const defaultOutputLimit = 4 * 1024 * 1024;

export type ProcessErrorCode = 'command-too-long' | 'start-failed' | 'timeout' | 'cancelled' | 'output-limit' | 'termination-failed' | 'exit-nonzero';

export class ProcessError extends Error {
  readonly code: ProcessErrorCode;
  readonly exitCode: number | undefined;
  /** The operating system's code when the executable could not start, such as ENOENT. */
  readonly systemCode: string | undefined;
  /** Standard output of a process that exited unsuccessfully, so adapters can classify the failure. Stderr is never kept. */
  readonly stdout: string | undefined;

  constructor(code: ProcessErrorCode, message: string, details: { exitCode?: number; systemCode?: string; stdout?: string } = {}) {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
    this.exitCode = details.exitCode;
    this.systemCode = details.systemCode;
    this.stdout = details.stdout;
  }
}

const forwardedVariables = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LANG', 'LC_ALL', 'SHELL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH',
  // Corporate networks need these for the CLIs to reach their services at all.
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

const apiKeyVariables = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY']);

/**
 * The environment a provider CLI receives: what it needs to start, find its own login and reach the network.
 * API keys are withheld unless the caller opts in, so a key exported for another tool is never spent silently.
 */
export function childEnvironment(source: Readonly<Record<string, string | undefined>> = process.env, options: { readonly useApiKeys?: boolean } = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = name.toUpperCase();
    if (forwardedVariables.has(key) || (options.useApiKeys === true && apiKeyVariables.has(key))) result[name] = value;
  }
  return result;
}

/** Quotes one argument the way libuv does when Node builds a Windows command line. */
export function quoteWindowsArgument(argument: string): string {
  if (argument === '') return '""';
  if (!/[ \t"]/u.test(argument)) return argument;
  if (!/["\\]/u.test(argument)) return `"${argument}"`;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    quoted += character === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/** Length of the command line Windows would receive for this executable and arguments. */
export function windowsCommandLineLength(executable: string, args: readonly string[]): number {
  return [executable, ...args].map(quoteWindowsArgument).join(' ').length;
}

async function terminateTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid < 1) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise<void>(resolve => {
      const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Calls running in a POSIX process group of their own, each with the function that stops its tree. */
const groups = new Set<() => void>();
// Node resets at startup a SIGHUP that nohup ignores, so a hang-up ends Altimeter whether or not it listens.
const endingSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function stopGroups(): void {
  for (const stop of [...groups]) stop();
}

function unwatchGroups(): void {
  for (const signal of endingSignals) process.removeListener(signal, onEndingSignal);
  process.removeListener('exit', stopGroups);
}

/**
 * A detached group receives none of the signals sent to Altimeter, so Ctrl+C or a closed terminal would leave the
 * CLI running and spending quota. When no other listener takes the signal, it would end the process: the trees are
 * stopped first and the signal is raised again, so it still ends Altimeter. A caller that listens for it decides by itself.
 */
function onEndingSignal(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) > 1) return;
  stopGroups();
  groups.clear();
  unwatchGroups();
  process.kill(process.pid, signal);
}

/** Keeps a call's group from outliving Altimeter, whether a signal ends it or it exits; returns the release. */
function watchGroup(stop: () => void): () => void {
  if (groups.size === 0) {
    // First in line, so a caller's listener added with once still counts when the signal arrives.
    for (const signal of endingSignals) process.prependListener(signal, onEndingSignal);
    process.on('exit', stopGroups);
  }
  groups.add(stop);
  return () => {
    if (groups.delete(stop) && groups.size === 0) unwatchGroups();
  };
}

export interface RunProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly timeoutMs: number;
  /** Shared budget for stdout and stderr together. */
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly exitCode: number;
  readonly outputBytes: number;
  readonly durationMs: number;
}

/** How long to wait for pipes to close after the tree was killed before giving up on them. */
const closeGraceMs = 5000;
/** How long killing the tree may take before that grace period starts anyway; taskkill can be slow under load. */
const terminationLimitMs = 30_000;

/**
 * Removes a call's working folder. On Windows a CLI killed at its deadline can still hold the folder while its
 * process tree is torn down, so removal is retried for up to ten seconds, and a folder that still cannot be
 * removed never replaces the call's own result.
 */
export async function removeFolder(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await delay(200);
    }
  }
}

/**
 * Runs an executable with explicit arguments and no shell. Stdin carries the input; stdout is kept, stderr is
 * counted against the same output budget but never kept, because it can echo credentials or raw responses.
 * A deadline, an abort, the output budget, or Ctrl+C, a hang-up, a termination signal or an exit that ends
 * Altimeter, kills the whole process tree that this call started.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new ProcessError('cancelled', 'The call was cancelled before it started.'));
  const length = windowsCommandLineLength(options.executable, options.args);
  if (length > maxCommandLineLength) {
    return Promise.reject(new ProcessError('command-too-long', `The command line would be ${length} characters long; the limit is ${maxCommandLineLength}.`));
  }
  const limit = options.maxOutputBytes ?? defaultOutputLimit;
  const started = performance.now();
  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        // A POSIX process group lets one signal reach every descendant; Windows uses taskkill /T instead.
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new ProcessError('start-failed', 'The provider executable could not start.', { systemCode: (error as NodeJS.ErrnoException).code ?? 'unknown' }));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: ProcessError | undefined;
    let termination: Promise<void> | undefined;
    let settled = false;
    let exited = false;
    let grace: NodeJS.Timeout | undefined;
    let terminationWait: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(terminationWait);
      options.signal?.removeEventListener('abort', onAbort);
      release?.();
    };
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      outcome();
    };
    const startGrace = () => {
      if (settled || grace) return;
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(() => reject(failure));
      }, closeGraceMs);
    };
    const fail = (error: ProcessError) => {
      failure ??= error;
      // Once a Windows process has exited its id can be reused, so it is never signalled again; a POSIX group id
      // stays reserved while any member lives.
      if (!exited || process.platform !== 'win32') {
        termination ??= terminateTree(child).catch(() => {
          failure = new ProcessError('termination-failed', 'The provider process tree could not be terminated.');
          child.kill('SIGKILL');
        });
      }
      if (terminationWait) return;
      // The grace period starts once the tree is gone, so the call never ends while its processes still hold the
      // working folder; a termination that hangs starts it after a limit.
      terminationWait = setTimeout(startGrace, terminationLimitMs);
      void (termination ?? Promise.resolve()).then(startGrace);
    };
    const onAbort = () => fail(new ProcessError('cancelled', 'The call was cancelled.'));
    const timer = setTimeout(() => fail(new ProcessError('timeout', `The provider did not finish within ${options.timeoutMs} ms.`)), options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const release = process.platform === 'win32' ? undefined : watchGroup(onAbort);

    const capture = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.length;
      if (bytes > limit) {
        fail(new ProcessError('output-limit', `The provider wrote more than ${limit} bytes.`));
        return;
      }
      if (keep && failure === undefined) chunks.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, false));
    child.stdin?.on('error', () => {});
    child.once('error', error => {
      const startFailure = new ProcessError('start-failed', 'The provider executable could not start.', { systemCode: (error as NodeJS.ErrnoException).code ?? 'unknown' });
      if (child.pid === undefined) settle(() => reject(startFailure));
      else failure ??= startFailure;
    });
    child.once('exit', () => {
      exited = true;
    });
    child.once('close', (code, signal) => {
      void (async () => {
        if (termination) await termination;
        const stdout = Buffer.concat(chunks).toString('utf8');
        if (failure) {
          settle(() => reject(failure));
          return;
        }
        if (code !== 0 || signal !== null) {
          settle(() => reject(new ProcessError('exit-nonzero', `The provider exited with ${code ?? signal}.`, { ...(code === null ? {} : { exitCode: code }), stdout })));
          return;
        }
        settle(() => resolve({ stdout, exitCode: 0, outputBytes: bytes, durationMs: performance.now() - started }));
      })();
    });
    child.stdin?.end(options.input ?? '');
  });
}
