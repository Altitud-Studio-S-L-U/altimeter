import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gscCommand, type GscCommandContext } from '../src/cli/main.ts';
import { HttpClient } from '../src/fetch/http.ts';
import { deleteLogin, loginStatus, saveLogin, stateDirectory } from '../src/owner/credential-store.ts';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
// Every variable the login store's folder can come from, so the tests never read or delete a real login.
const stateVariables = ['LOCALAPPDATA', 'XDG_STATE_HOME', 'HOME'] as const;
const saved = new Map<string, string | undefined>();
let work: string;
let server: Server;
let base: string;
let closedPort: string;
let client: HttpClient;
let answer: { status: number; body: unknown };
const requests: Array<{ path: string | undefined; type: string | undefined; form: URLSearchParams }> = [];

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'altimeter-gsc-cli-'));
  for (const name of stateVariables) {
    saved.set(name, process.env[name]);
    process.env[name] = work;
  }
  assert.ok(stateDirectory().startsWith(work), 'the login store is inside the test folder');
  server = createServer((req, res) => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      requests.push({ path: req.url, type: req.headers['content-type'], form: new URLSearchParams(text) });
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  closedPort = String((closed.address() as AddressInfo).port);
  await new Promise(resolve => closed.close(resolve));
  client = new HttpClient({ policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) } });
});

after(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await client.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
});

beforeEach(async () => {
  await deleteLogin();
  requests.length = 0;
  answer = { status: 200, body: {} };
});

function context(endpoint = `${base}/revoke`): GscCommandContext & { readonly output: () => string } {
  let output = '';
  return { client, revokeEndpoint: endpoint, stdout: text => void (output += text), output: () => output };
}

const storeLogin = () => saveLogin({ clientId: 'cid', clientSecret: 'client-secret', refreshToken: 'refresh-1', createdAt: '2026-11-04T10:00:00.000Z' }, 'file');

/** A login file whose payload is not JSON; JSON.parse would quote its start in its message. */
async function storeDamagedLogin(): Promise<void> {
  await mkdir(stateDirectory(), { recursive: true });
  await writeFile(join(stateDirectory(), 'search-console-login.json'), JSON.stringify({ mode: 'file', createdAt: '2026-11-04T10:00:00.000Z', clientId: 'cid', payload: 'refresh 1//secret-token' }));
}

describe('altimeter gsc logout', () => {
  test('says when no login is stored and sends nothing', async () => {
    const run = context();
    assert.equal(await gscCommand(['logout'], run), 0);
    assert.equal(run.output(), 'No Search Console login is stored.\n');
    assert.equal(requests.length, 0);
  });

  test('revokes the refresh token at Google, then deletes the login', async () => {
    await storeLogin();
    const run = context();
    assert.equal(await gscCommand(['logout'], run), 0);
    assert.equal(run.output(), 'The stored Search Console login was revoked and deleted.\n');
    assert.deepEqual(requests.map(entry => [entry.path, entry.type, entry.form.get('token')]), [['/revoke', 'application/x-www-form-urlencoded', 'refresh-1']]);
    assert.equal((await loginStatus()).stored, false);
  });

  test('deletes a login that Google reports as already expired or revoked', async () => {
    await storeLogin();
    answer = { status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } };
    const run = context();
    assert.equal(await gscCommand(['logout'], run), 0);
    assert.equal(run.output(), 'Google reports that the stored Search Console login had already expired or been revoked; it was deleted.\n');
    assert.equal((await loginStatus()).stored, false);
  });

  test('keeps the login and fails when Google does not confirm the revocation', async () => {
    await storeLogin();
    answer = { status: 503, body: { error: 'backend_error' } };
    const run = context();
    await assert.rejects(gscCommand(['logout'], run), {
      message: 'The Search Console login was not revoked (Google answered 503 backend_error) and is still stored. Run "altimeter gsc logout" again, or revoke it at https://myaccount.google.com/permissions.',
    });
    assert.equal(run.output(), '');
    assert.equal((await loginStatus()).stored, true);
  });

  test('keeps the login and fails when Google cannot be reached', async () => {
    await storeLogin();
    const run = context(`http://127.0.0.1:${closedPort}/revoke`);
    await assert.rejects(gscCommand(['logout'], run), /^Error: The Search Console login was not revoked \(Google could not be reached: connection\) and is still stored\./u);
    assert.equal(run.output(), '');
    assert.equal((await loginStatus()).stored, true);
  });

  test('deletes a login it cannot read without claiming it was revoked, and never quotes the file', async () => {
    await storeDamagedLogin();
    const run = context();
    await assert.rejects(gscCommand(['logout'], run), {
      message: 'The stored login is damaged. It was deleted without being revoked; revoke it at https://myaccount.google.com/permissions.',
    });
    assert.equal(requests.length, 0);
    assert.equal((await loginStatus()).stored, false);
  });

  test('exits with status 2 and says why when the login was not revoked', async () => {
    await storeDamagedLogin();
    const result = spawnSync(process.execPath, [cli, 'gsc', 'logout'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LOCALAPPDATA: work, XDG_STATE_HOME: work, HOME: work } });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^The stored login is damaged\. It was deleted without being revoked/u);
    assert.doesNotMatch(result.stderr, /secret/u);
  });
});
