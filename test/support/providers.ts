/**
 * Synthetic provider CLIs for the analysis tests. Every test runs with an environment whose PATH is an empty
 * folder and whose cache folders are temporary, so the real Claude Code or Codex CLI can never be reached.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtures = fileURLToPath(new URL('../fixtures/providers/', import.meta.url));

export interface RecordedCall {
  readonly args: string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly env: string[];
  readonly pid: number;
  readonly schema?: unknown;
}

export interface ProviderDouble {
  readonly directory: string;
  readonly executable: string;
  setScenario(scenario: object): Promise<void>;
  calls(): Promise<RecordedCall[]>;
}

/** A temporary home folder removed after the test. */
export async function sandbox(t: TestContext): Promise<string> {
  const parent = await realpath(tmpdir());
  const home = await mkdtemp(join(parent, 'altimeter-ai-test-'));
  await mkdir(join(home, 'empty-bin'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

export async function providerDouble(home: string, name: 'claude' | 'codex', scenario: object): Promise<ProviderDouble> {
  const directory = await mkdtemp(join(home, `${name}-double-`));
  const executable = join(directory, `${name}.mjs`);
  const fixture = pathToFileURL(join(fixtures, `${name}.mjs`)).href;
  await writeFile(executable, `import { run } from ${JSON.stringify(fixture)};\nawait run(new URL('./scenario.json', import.meta.url));\n`);
  const setScenario = async (value: object) => {
    await writeFile(join(directory, 'scenario.json'), JSON.stringify(value));
    await rm(join(directory, 'counter.json'), { force: true });
  };
  await setScenario(scenario);
  return {
    directory,
    executable,
    setScenario,
    async calls() {
      try {
        return (await readFile(join(directory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordedCall);
      } catch {
        return [];
      }
    },
  };
}

const kept = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC']);

/** An environment that reaches only the given doubles. */
export function testEnv(home: string, doubles: { readonly claude?: string; readonly codex?: string } = {}, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && kept.has(name.toUpperCase())) env[name] = value;
  return {
    ...env,
    PATH: join(home, 'empty-bin'),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home,
    XDG_CACHE_HOME: home,
    ...(doubles.claude ? { ALTIMETER_CLAUDE_EXECUTABLE: doubles.claude } : {}),
    ...(doubles.codex ? { ALTIMETER_CODEX_EXECUTABLE: doubles.codex } : {}),
    ...extra,
  };
}

/** True when a process with this id is still running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
