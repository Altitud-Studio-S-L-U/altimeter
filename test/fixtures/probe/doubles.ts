/**
 * Synthetic answer engines for the probe tests. Each double is a small script started through
 * ALTIMETER_CLAUDE_EXECUTABLE or ALTIMETER_CODEX_EXECUTABLE in an environment whose PATH is an empty folder, so
 * the real Claude Code or Codex CLI can never be reached.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtures = fileURLToPath(new URL('./', import.meta.url));

export interface ProbeCall {
  readonly args: string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly cwdEntries: string[];
  readonly env: string[];
  readonly pid: number;
  readonly version?: boolean;
}

export interface ProbeDouble {
  readonly executable: string;
  setScenario(scenario: object): Promise<void>;
  /** Every start, --version included. */
  starts(): Promise<ProbeCall[]>;
  /** Starts that asked a question. */
  calls(): Promise<ProbeCall[]>;
}

export async function probeDouble(home: string, name: 'claude' | 'codex', scenario: object): Promise<ProbeDouble> {
  const directory = await mkdtemp(join(home, `${name}-probe-double-`));
  const executable = join(directory, `${name}.mjs`);
  const fixture = pathToFileURL(join(fixtures, `${name}.mjs`)).href;
  await writeFile(executable, `import { run } from ${JSON.stringify(fixture)};\nawait run(new URL('./scenario.json', import.meta.url));\n`);
  const setScenario = async (value: object) => {
    await writeFile(join(directory, 'scenario.json'), JSON.stringify(value));
    await rm(join(directory, 'counter.json'), { force: true });
  };
  await setScenario(scenario);
  const starts = async () => {
    try {
      return (await readFile(join(directory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as ProbeCall);
    } catch {
      return [];
    }
  };
  return { executable, setScenario, starts, calls: async () => (await starts()).filter(call => call.version !== true) };
}
