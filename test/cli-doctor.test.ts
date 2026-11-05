import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { providerDouble, sandbox, testEnv } from './support/providers.ts';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { env, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.on('close', status => resolve({ status, stdout }));
  });
}

test('doctor --probe sends each CLI it finds one tiny request, and plain doctor sends none', async t => {
  const home = await sandbox(t);
  const double = await providerDouble(home, 'claude', { default: { answer: { ok: true, language: 'en', words: ['ready'] } } });
  const env = testEnv(home, { claude: double.executable });
  const plain = await run(['doctor'], env);
  assert.match(plain.stdout, /^Claude Code: 2\.0\.59, a verified version/mu);
  assert.match(plain.stdout, /^Codex: not found/mu);
  assert.equal((await double.calls()).length, 0);
  const probed = await run(['doctor', '--probe'], env);
  assert.equal(probed.status, 0, probed.stdout);
  assert.match(probed.stdout, /probe: answered with claude-double-model, USD 0\.0125/u);
  assert.equal((await double.calls()).length, 1);
});
