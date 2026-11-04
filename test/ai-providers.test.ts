import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { capabilitiesFor, compareVersions, describeProviders, findProvider, providerWorkingDirectory, resolveProvider, userCacheDirectory, versionFrom, type ProviderCommand } from '../src/ai/providers.ts';
import { providerDouble, sandbox, testEnv } from './support/providers.ts';

describe('version handling', () => {
  test('orders versions with prereleases below their release', () => {
    const sorted = ['0.166.0', '0.166.0-alpha.10', '0.165.9', '0.166.0-alpha.5.1', '0.166.0-alpha.9', 'garbage', '0.167.0-alpha.1', '0.166.0-alpha.5'].sort(compareVersions);
    assert.deepEqual(sorted, ['garbage', '0.165.9', '0.166.0-alpha.5', '0.166.0-alpha.5.1', '0.166.0-alpha.9', '0.166.0-alpha.10', '0.166.0', '0.167.0-alpha.1']);
  });

  test('reads versions from CLI output', () => {
    assert.equal(versionFrom('2.0.59 (Claude Code)\n'), '2.0.59');
    assert.equal(versionFrom('codex-cli 0.166.0-alpha.5.1\n'), '0.166.0-alpha.5.1');
    assert.equal(versionFrom('no version here'), undefined);
  });

  test('gates extra flags on verified versions and on later builds of a verified Codex line', () => {
    assert.deepEqual([...capabilitiesFor('claude', '2.0.59').extras], ['system-prompt']);
    assert.deepEqual([...capabilitiesFor('codex', '0.166.0-alpha.5.1').extras].sort(), ['feature-overrides', 'ignore-rules']);
    assert.deepEqual([capabilitiesFor('codex', '0.166.0-alpha.6').verified, capabilitiesFor('codex', '0.166.0-alpha.6').extras.size], [true, 3]);
    // A later build of the 0.166 line keeps its flags but is not called verified.
    for (const version of ['0.166.0-alpha.7', '0.166.0', '0.166.2']) {
      const capabilities = capabilitiesFor('codex', version);
      assert.deepEqual([capabilities.verified, capabilities.extras.has('tool-feature-overrides')], [false, true], version);
    }
    for (const [name, version] of [['claude', '2.0.60'], ['codex', '0.167.0'], ['codex', '0.166.0-alpha.5']] as const) {
      const capabilities = capabilitiesFor(name, version);
      assert.equal(capabilities.verified, false);
      assert.equal(capabilities.extras.size, 0, `${name} ${version}`);
    }
  });
});

describe('cache folders', () => {
  test('follow each platform convention', () => {
    assert.equal(userCacheDirectory({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'), 'C:\\Users\\u\\AppData\\Local\\altimeter');
    assert.equal(providerWorkingDirectory({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'), 'C:\\Users\\u\\AppData\\Local\\altimeter\\provider-cwd');
    assert.equal(userCacheDirectory({ HOME: '/Users/u' }, 'darwin'), '/Users/u/Library/Caches/altimeter');
    assert.equal(userCacheDirectory({ HOME: '/home/u', XDG_CACHE_HOME: '/var/cache/u' }, 'linux'), '/var/cache/u/altimeter');
    assert.equal(userCacheDirectory({ HOME: '/home/u', XDG_CACHE_HOME: 'relative' }, 'linux'), '/home/u/.cache/altimeter');
  });
});

describe('discovery', () => {
  test('uses ALTIMETER_*_EXECUTABLE when it is absolute, and runs JavaScript entry points with Node.js', async t => {
    const home = await sandbox(t);
    const claude = await providerDouble(home, 'claude', {});
    const command = await findProvider('claude', { env: testEnv(home, { claude: claude.executable }) });
    assert.equal(command?.source, 'env');
    assert.equal(command?.executable, process.execPath);
    assert.deepEqual(command?.prefix.length, 1);
    await assert.rejects(findProvider('claude', { env: testEnv(home, {}, { ALTIMETER_CLAUDE_EXECUTABLE: 'claude.mjs' }) }), { code: 'invalid-input' });
    await assert.rejects(findProvider('claude', { env: testEnv(home, {}, { ALTIMETER_CLAUDE_EXECUTABLE: join(home, 'missing.mjs') }) }), { code: 'unavailable' });
  });

  test('searches PATH, skipping folders that no longer exist', async t => {
    const home = await sandbox(t);
    const bin = join(home, 'npm-bin');
    await mkdir(bin);
    if (process.platform === 'win32') {
      await writeFile(join(bin, 'claude.cmd'), '@echo off\r\n');
      const entry = join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, 'cli.js'), '');
      const command = await findProvider('claude', { env: testEnv(home, {}, { PATH: `${join(home, 'gone')};${bin}` }) });
      assert.equal(command?.source, 'path');
      assert.equal(command?.executable, process.execPath, 'an npm wrapper runs its entry point, never cmd.exe');
      assert.equal(command?.prefix[0], join(entry, 'cli.js'));
    } else {
      await writeFile(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      const command = await findProvider('claude', { env: testEnv(home, {}, { PATH: `${join(home, 'gone')}:${bin}` }) });
      assert.equal(command?.path, join(bin, 'claude'));
    }
    assert.equal(await findProvider('claude', { env: testEnv(home) }), undefined);
  });

  test('finds the newest Codex in the desktop app folder by --version', async t => {
    const home = await sandbox(t);
    const versions = new Map([['aaa', '0.166.0-alpha.5'], ['bbb', '0.166.0-alpha.10'], ['ccc', '0.165.2']]);
    for (const folder of versions.keys()) {
      await mkdir(join(home, 'OpenAI', 'Codex', 'bin', folder), { recursive: true });
      await writeFile(join(home, 'OpenAI', 'Codex', 'bin', folder, 'codex.exe'), '');
    }
    const probed: string[] = [];
    const probeVersion = async (command: ProviderCommand) => {
      probed.push(command.path);
      return [...versions].find(([folder]) => command.path.includes(join('bin', folder)))?.[1];
    };
    const command = await findProvider('codex', { env: testEnv(home), platform: 'win32', probeVersion });
    assert.equal(command?.source, 'app');
    assert.match(command?.path ?? '', /bbb/u);
    assert.equal(probed.length, 3);
  });
});

describe('resolveProvider and describeProviders', () => {
  test('reads the version and warns about versions outside the verified table', async t => {
    const home = await sandbox(t);
    const verified = await providerDouble(home, 'claude', {});
    const resolved = await resolveProvider('claude', { env: testEnv(home, { claude: verified.executable }) });
    assert.equal(resolved.version, '2.0.59');
    assert.equal(resolved.capabilities.verified, true);
    assert.deepEqual(resolved.warnings, []);
    const newer = await providerDouble(home, 'codex', { version: '0.170.0' });
    const unknown = await resolveProvider('codex', { env: testEnv(home, { codex: newer.executable }) });
    assert.equal(unknown.capabilities.verified, false);
    assert.match(unknown.warnings[0]!, /not a verified version/u);
  });

  test('describes both providers for doctor without sending a prompt', async t => {
    const home = await sandbox(t);
    const claude = await providerDouble(home, 'claude', {});
    const described = await describeProviders({ env: testEnv(home, { claude: claude.executable }), platform: process.platform });
    assert.equal(described[0]!.found, true);
    assert.equal(described[0]!.version, '2.0.59');
    assert.equal(described[1]!.found, false);
    assert.match(described[1]!.problem ?? '', /Codex CLI was not found/u);
    assert.deepEqual(await claude.calls(), [], 'only --version ran');
  });
});
