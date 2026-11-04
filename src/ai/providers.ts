import { access, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, posix, win32 } from 'node:path';
import { childEnvironment, ProcessError, runProcess } from './process.ts';
import type { Schema } from './schema.ts';
import { ProviderError, type ProviderName } from './types.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface DiscoveryOptions {
  readonly env?: Environment;
  readonly platform?: NodeJS.Platform;
  /** Reads a CLI's version; tests replace it to avoid starting real executables. */
  readonly probeVersion?: (command: ProviderCommand) => Promise<string | undefined>;
}

export interface ProviderCommand {
  readonly name: ProviderName;
  /** The program to start: the CLI itself, or Node.js for an npm-installed JavaScript entry point. */
  readonly executable: string;
  readonly prefix: readonly string[];
  /** The resolved CLI file, for display. */
  readonly path: string;
  /** How it was found: an ALTIMETER_*_EXECUTABLE variable, PATH, or the Codex desktop app's folder. */
  readonly source: 'env' | 'path' | 'app';
}

export type CapabilityFlag = 'system-prompt' | 'ignore-rules' | 'feature-overrides';

export interface Capabilities {
  /** True when this exact CLI version was verified with the flags below. */
  readonly verified: boolean;
  /** Flags beyond the minimal set that every supported version accepts. */
  readonly extras: ReadonlySet<CapabilityFlag>;
}

export interface ResolvedProvider {
  readonly command: ProviderCommand;
  readonly version: string;
  readonly capabilities: Capabilities;
  readonly warnings: readonly string[];
}

/**
 * Versions whose flags were checked against the installed CLI's help on Windows 11. Any other version runs with
 * the minimal flag set that forge verified live (no system prompt flag for Claude; no --ignore-rules or feature
 * overrides for Codex) and the run reports a warning.
 */
const verifiedVersions: Readonly<Record<ProviderName, Readonly<Record<string, readonly CapabilityFlag[]>>>> = {
  claude: { '2.0.59': ['system-prompt'] },
  codex: { '0.166.0-alpha.5.1': ['ignore-rules', 'feature-overrides'] },
};

const displayNames: Readonly<Record<ProviderName, string>> = { claude: 'Claude Code', codex: 'Codex CLI' };

export function capabilitiesFor(name: ProviderName, version: string): Capabilities {
  const flags = verifiedVersions[name][version];
  return { verified: flags !== undefined, extras: new Set(flags ?? []) };
}

/** Reads a variable the way the platform does: case-insensitively on Windows. */
export function envValue(env: Environment, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (platform !== 'win32') return undefined;
  const wanted = name.toUpperCase();
  return Object.entries(env).find(([key]) => key.toUpperCase() === wanted)?.[1];
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Altimeter's folder in the user's cache directory: %LOCALAPPDATA%\altimeter on Windows,
 * ~/Library/Caches/altimeter on macOS and $XDG_CACHE_HOME/altimeter (default ~/.cache/altimeter) elsewhere.
 */
export function userCacheDirectory(env: Environment = process.env, platform: NodeJS.Platform = process.platform): string {
  const paths = pathApi(platform);
  const home = envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform) ?? homedir();
  if (platform === 'win32') return paths.join(envValue(env, 'LOCALAPPDATA', platform) ?? paths.join(home, 'AppData', 'Local'), 'altimeter');
  if (platform === 'darwin') return paths.join(home, 'Library', 'Caches', 'altimeter');
  const xdg = envValue(env, 'XDG_CACHE_HOME', platform);
  return paths.join(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, '.cache'), 'altimeter');
}

/**
 * The working directory for Claude Code calls. Claude stores sessions per working directory, so every call runs
 * in this one stable, empty folder instead of the audited project or a new folder each time.
 */
export function providerWorkingDirectory(env: Environment = process.env, platform: NodeJS.Platform = process.platform): string {
  return pathApi(platform).join(userCacheDirectory(env, platform), 'provider-cwd');
}

/** Creates the provider working directory if needed and refuses it when anything was put inside it. */
export async function prepareWorkingDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProviderError('unsafe-directory', `${directory} must be a plain folder.`);
  // Files here, such as a CLAUDE.md, would be read by Claude as project instructions.
  if ((await readdir(directory)).length > 0) throw new ProviderError('unsafe-directory', `${directory} must be empty; remove what is inside it and run again.`);
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    const target = await realpath(path);
    return (await lstat(target)).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

const npmEntryPoints: Readonly<Record<ProviderName, string>> = {
  claude: join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  codex: join('node_modules', '@openai', 'codex', 'bin', 'codex.js'),
};

/** Turns a resolved CLI file into something that can be started without a shell. */
async function commandFor(name: ProviderName, path: string, source: ProviderCommand['source'], platform: NodeJS.Platform): Promise<ProviderCommand> {
  const extension = extname(path).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(extension)) return { name, executable: process.execPath, prefix: [path], path, source };
  if (platform === 'win32' && extension === '.cmd') {
    // npm's .cmd wrappers need cmd.exe, which would re-parse the arguments; run the package's entry point instead.
    const entry = join(dirname(path), npmEntryPoints[name]);
    try {
      await access(entry);
    } catch {
      throw new ProviderError('unavailable', `${displayNames[name]} was installed by npm but its entry point ${entry} is missing.`, name);
    }
    return { name, executable: process.execPath, prefix: [entry], path: entry, source };
  }
  if (platform === 'win32' && extension !== '.exe') throw new ProviderError('unavailable', `${path} is neither an .exe nor a JavaScript entry point.`, name);
  return { name, executable: path, prefix: [], path, source };
}

const overrideVariables: Readonly<Record<ProviderName, string>> = { claude: 'ALTIMETER_CLAUDE_EXECUTABLE', codex: 'ALTIMETER_CODEX_EXECUTABLE' };

async function onPath(name: ProviderName, env: Environment, platform: NodeJS.Platform): Promise<ProviderCommand | undefined> {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  const separator = platform === 'win32' ? ';' : ':';
  for (const directory of (envValue(env, 'PATH', platform) ?? '').split(separator)) {
    const cleaned = directory.trim().replace(/^"|"$/gu, '');
    // A PATH entry can point to a folder an updater already removed; it is skipped like any other miss.
    if (cleaned === '' || !isAbsolute(cleaned)) continue;
    for (const candidate of names) {
      const file = await existingFile(join(cleaned, candidate));
      if (file) return commandFor(name, file, 'path', platform);
    }
  }
  return undefined;
}

export function versionFrom(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output)?.[1];
}

function parseVersion(version: string): { core: number[]; pre: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/** Semantic version order, with prereleases below their release; unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 0; index < 3; index += 1) if (left.core[index] !== right.core[index]) return left.core[index]! - right.core[index]!;
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Runs `<cli> --version`; this never sends a prompt or spends quota. */
export async function readVersion(command: ProviderCommand, env: Environment = process.env): Promise<string | undefined> {
  try {
    const result = await runProcess({
      executable: command.executable,
      args: [...command.prefix, '--version'],
      cwd: tmpdir(),
      env: childEnvironment(env),
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
    });
    return versionFrom(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * The Codex desktop app installs its CLI under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe and replaces the
 * folder on update, so the newest version among those folders is chosen.
 */
async function fromCodexApp(env: Environment, platform: NodeJS.Platform, probe: (command: ProviderCommand) => Promise<string | undefined>): Promise<ProviderCommand | undefined> {
  if (platform !== 'win32') return undefined;
  const local = envValue(env, 'LOCALAPPDATA', platform);
  if (!local) return undefined;
  const root = join(local, 'OpenAI', 'Codex', 'bin');
  let folders: string[];
  try {
    folders = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return undefined;
  }
  let best: { command: ProviderCommand; version: string } | undefined;
  for (const folder of folders.sort()) {
    const file = await existingFile(join(root, folder, 'codex.exe'));
    if (!file) continue;
    const command: ProviderCommand = { name: 'codex', executable: file, prefix: [], path: file, source: 'app' };
    const version = await probe(command);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { command, version };
  }
  return best?.command;
}

/** Finds a provider CLI: its ALTIMETER_*_EXECUTABLE variable (absolute), then PATH, then, for Codex, the desktop app. */
export async function findProvider(name: ProviderName, options: DiscoveryOptions = {}): Promise<ProviderCommand | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = envValue(env, overrideVariables[name], platform);
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured)) throw new ProviderError('invalid-input', `${overrideVariables[name]} must be an absolute path.`, name);
    const file = await existingFile(configured);
    if (!file) throw new ProviderError('unavailable', `${overrideVariables[name]} does not point to a file.`, name);
    return commandFor(name, file, 'env', platform);
  }
  const found = await onPath(name, env, platform);
  if (found) return found;
  if (name === 'codex') return fromCodexApp(env, platform, options.probeVersion ?? (command => readVersion(command, env)));
  return undefined;
}

/** Finds a provider and reads its version, choosing the flag set that version supports. */
export async function resolveProvider(name: ProviderName, options: DiscoveryOptions = {}): Promise<ResolvedProvider> {
  const command = await findProvider(name, options);
  if (!command) throw new ProviderError('unavailable', `${displayNames[name]} was not found. Install it or set ${overrideVariables[name]}.`, name);
  const version = await (options.probeVersion ?? (entry => readVersion(entry, options.env ?? process.env)))(command);
  if (!version) throw new ProviderError('unavailable', `${displayNames[name]} at ${command.path} did not report a version.`, name);
  const capabilities = capabilitiesFor(name, version);
  const warnings = capabilities.verified ? [] : [`${displayNames[name]} ${version} is not a verified version; it runs with the minimal flag set.`];
  return { command, version, capabilities, warnings };
}

export interface ProviderDescription {
  readonly name: ProviderName;
  readonly found: boolean;
  readonly path?: string;
  readonly source?: ProviderCommand['source'];
  readonly version?: string;
  readonly verified: boolean;
  readonly problem?: string;
  readonly warnings: readonly string[];
}

/** What `altimeter doctor` reports about each provider. It only runs `--version`. */
export async function describeProviders(options: DiscoveryOptions = {}): Promise<ProviderDescription[]> {
  const results: ProviderDescription[] = [];
  for (const name of ['claude', 'codex'] as const) {
    try {
      const resolved = await resolveProvider(name, options);
      results.push({ name, found: true, path: resolved.command.path, source: resolved.command.source, version: resolved.version, verified: resolved.capabilities.verified, warnings: resolved.warnings });
    } catch (error) {
      results.push({ name, found: false, verified: false, problem: error instanceof Error ? error.message : 'unknown problem', warnings: [] });
    }
  }
  return results;
}

export interface ProviderCallInput {
  readonly prompt: string;
  readonly schema: Schema;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** The resolved CLI; discovered from the environment when absent. */
  readonly provider?: ResolvedProvider;
  readonly env?: Environment;
  /** Forward ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, CODEX_API_KEY and OPENAI_API_KEY to the CLI. */
  readonly useApiKeys?: boolean;
  /** Overrides the stable working directory; tests only. */
  readonly workingDirectory?: string;
}

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/u;

export function assertModel(model: string | undefined, provider: 'claude' | 'codex'): void {
  if (model !== undefined && !modelPattern.test(model)) throw new ProviderError('invalid-input', 'The model must be a plain identifier such as sonnet or gpt-5.', provider);
}

export function fromProcessError(error: unknown, provider: 'claude' | 'codex'): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof ProcessError) return new ProviderError(error.code, error.message, provider);
  return new ProviderError('provider-failed', 'The provider call failed unexpectedly.', provider);
}
