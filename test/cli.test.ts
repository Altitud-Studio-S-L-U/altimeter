import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
}

test('prints the package version', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
});

test('prints help when no command is given', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Altimeter \d+\.\d+\.\d+: evidence-based SEO audits\./u);
  assert.match(result.stdout, /--version/u);
});

test('rejects an unknown command with exit code 2', () => {
  const result = run('launch');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: launch/u);
});

test('rejects an unknown option with exit code 2', () => {
  const result = run('--colour');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});
