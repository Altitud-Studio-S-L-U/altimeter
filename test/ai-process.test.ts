import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnvironment, maxCommandLineLength, ProcessError, quoteWindowsArgument, runProcess, windowsCommandLineLength } from '../src/ai/process.ts';
import { alive, sandbox } from './support/providers.ts';

const node = process.execPath;
const env = childEnvironment(process.env);

function script(source: string) {
  return { executable: node, args: ['-e', source], cwd: process.cwd(), env };
}

describe('runProcess', () => {
  test('passes stdin and returns stdout, even when UTF-8 is split across chunks', async () => {
    const result = await runProcess({ ...script('let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const b=Buffer.from(s+"A\u00e9Z");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),50)})'), input: 'in:', timeoutMs: 10_000 });
    assert.equal(result.stdout, `in:A${String.fromCodePoint(0xe9)}Z`);
    assert.equal(result.exitCode, 0);
  });

  test('counts stderr against the budget but never keeps it', async () => {
    const result = await runProcess({ ...script('process.stderr.write("secret-token-from-provider");process.stdout.write("ok")'), timeoutMs: 10_000 });
    assert.equal(result.stdout, 'ok');
    assert.ok(result.outputBytes > 2);
    await assert.rejects(
      runProcess({ ...script('process.stdout.write("x".repeat(40));process.stderr.write("y".repeat(40));setInterval(()=>{},1000)'), timeoutMs: 10_000, maxOutputBytes: 64 }),
      (error: unknown) => error instanceof ProcessError && error.code === 'output-limit',
    );
  });

  test('a failed exit is typed and its stderr does not leak into the error', async () => {
    await assert.rejects(runProcess({ ...script('process.stderr.write("private-token");process.stdout.write("partial");process.exit(7)'), timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ProcessError);
      assert.equal(error.code, 'exit-nonzero');
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdout, 'partial');
      assert.doesNotMatch(error.message, /private-token/u);
      return true;
    });
  });

  test('kills a process that hangs without output, with its whole tree, at the deadline', { timeout: 30_000 }, async t => {
    const home = await sandbox(t);
    const pidFile = join(home, 'pids.json');
    const child = 'setInterval(()=>{},1000)';
    const parent = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)`;
    const started = Date.now();
    // Long enough for the parent to start its child and write both ids on a loaded machine.
    await assert.rejects(runProcess({ ...script(parent), timeoutMs: 4000 }), (error: unknown) => error instanceof ProcessError && error.code === 'timeout');
    // Ending the tree takes seconds on a machine busy with the whole suite, but never the 30-second termination limit.
    assert.ok(Date.now() - started < 22_000, `${Date.now() - started} ms`);
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
    for (let attempt = 0; attempt < 20 && pids.some(alive); attempt += 1) await delay(100);
    for (const pid of pids) assert.equal(alive(pid), false, `process ${pid} survived`);
  });

  // On Windows the CLI is not detached: it stays in the job that closes with Altimeter.
  test('Ctrl+C, a hang-up, a termination signal or an exit stops the detached tree of a running call first', { skip: process.platform === 'win32' && 'POSIX process groups only', timeout: 60_000 }, async t => {
    const home = await sandbox(t);
    const pidFile = join(home, 'cli.pid');
    const cli = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`;
    const parent = (then: string) => `import { childEnvironment, runProcess } from ${JSON.stringify(new URL('../src/ai/process.ts', import.meta.url).href)};
void runProcess({ executable: process.execPath, args: ['-e', ${JSON.stringify(cli)}], cwd: process.cwd(), env: childEnvironment(process.env), timeoutMs: 60000 }).catch(() => {});
const { readFileSync } = await import('node:fs');
const started = () => { try { return Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8')) > 0; } catch { return false; } };
while (!started()) await new Promise(resolve => setTimeout(resolve, 50));
${then}`;
    const cases = [
      { name: 'SIGINT', then: 'setInterval(() => {}, 1000);', signal: 'SIGINT' as const, ends: [null, 'SIGINT'] },
      { name: 'SIGTERM', then: 'setInterval(() => {}, 1000);', signal: 'SIGTERM' as const, ends: [null, 'SIGTERM'] },
      { name: 'SIGHUP', then: 'setInterval(() => {}, 1000);', signal: 'SIGHUP' as const, ends: [null, 'SIGHUP'] },
      { name: 'exit', then: 'process.exit(3);', ends: [3, null] },
    ];
    for (const entry of cases) {
      await rm(pidFile, { force: true });
      const runner = spawn(process.execPath, ['--input-type=module', '-e', parent(entry.then)], { stdio: 'ignore', windowsHide: true });
      const ended = once(runner, 'exit');
      let pid = 0;
      for (let attempt = 0; attempt < 400 && !(pid > 0); attempt += 1) {
        pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
        if (!(pid > 0)) await delay(50);
      }
      assert.ok(pid > 0, `the CLI of the ${entry.name} case started`);
      if (entry.signal) runner.kill(entry.signal);
      assert.deepEqual(await ended, entry.ends, `the ${entry.name} case still ends Altimeter as before`);
      for (let attempt = 0; attempt < 40 && alive(pid); attempt += 1) await delay(100);
      const survived = alive(pid);
      // A tree that was not stopped must not outlive the test either.
      if (survived) process.kill(pid, 'SIGKILL');
      assert.equal(survived, false, `the CLI outlived ${entry.name}`);
    }
  });

  test('an abort stops a running call, and an aborted signal never starts one', async () => {
    const controller = new AbortController();
    const running = runProcess({ ...script('setInterval(()=>{},1000)'), timeoutMs: 20_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(running, (error: unknown) => error instanceof ProcessError && error.code === 'cancelled');
    await assert.rejects(runProcess({ executable: 'definitely-not-a-program', args: [], cwd: process.cwd(), env, timeoutMs: 1000, signal: controller.signal }), { code: 'cancelled' });
  });

  test('reports a missing executable as start-failed with the system code', async () => {
    await assert.rejects(runProcess({ executable: join(process.cwd(), 'missing-provider.exe'), args: [], cwd: process.cwd(), env, timeoutMs: 5000 }), (error: unknown) => {
      return error instanceof ProcessError && error.code === 'start-failed' && error.systemCode === 'ENOENT';
    });
  });

  test('refuses a command line Windows would reject, before starting anything', async () => {
    const huge = 'x'.repeat(maxCommandLineLength);
    await assert.rejects(runProcess({ executable: node, args: ['-e', huge], cwd: process.cwd(), env, timeoutMs: 1000 }), { code: 'command-too-long' });
  });
});

describe('Windows command lines', () => {
  test('quote arguments as libuv does', () => {
    const backslash = String.fromCharCode(92);
    assert.equal(quoteWindowsArgument(''), '""');
    assert.equal(quoteWindowsArgument('plain'), 'plain');
    assert.equal(quoteWindowsArgument('two words'), '"two words"');
    assert.equal(quoteWindowsArgument('say "hi"'), `"say ${backslash}"hi${backslash}""`);
    assert.equal(quoteWindowsArgument(`hello${backslash}world`), `hello${backslash}world`);
    assert.equal(quoteWindowsArgument(`a b${backslash}`), `"a b${backslash}${backslash}"`);
    assert.equal(quoteWindowsArgument(`a${backslash}"b`), `"a${backslash}${backslash}${backslash}"b"`);
    assert.equal(windowsCommandLineLength('C:/Program Files/node.exe', ['--json-schema', '{"a":1}']), '"C:/Program Files/node.exe" --json-schema "{\\"a\\":1}"'.length);
  });
});

describe('childEnvironment', () => {
  const source = {
    Path: '/bin', SystemRoot: 'C:/Windows', HOME: '/home/u', CODEX_HOME: '/codex', https_proxy: 'http://proxy:8080', HTTP_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem', SSL_CERT_FILE: '/ca.pem', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CODEX_API_KEY: 'codex', GITHUB_TOKEN: 'ghp_x', NODE_OPTIONS: '--require evil.js', AWS_SECRET_ACCESS_KEY: 'aws',
  };

  test('forwards what the CLIs need, including proxies and CA certificates', () => {
    const result = childEnvironment(source);
    assert.deepEqual(Object.keys(result).sort(), ['CODEX_HOME', 'HOME', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'Path', 'SSL_CERT_FILE', 'SystemRoot', 'https_proxy']);
  });

  test('withholds API keys unless the caller opts in, and never forwards other secrets', () => {
    const withKeys = childEnvironment(source, { useApiKeys: true });
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY']) {
      assert.equal(childEnvironment(source)[key], undefined);
      assert.equal(withKeys[key], source[key as keyof typeof source]);
    }
    for (const key of ['GITHUB_TOKEN', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY']) assert.equal(withKeys[key], undefined);
  });
});
