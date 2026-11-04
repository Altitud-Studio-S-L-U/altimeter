import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { hostPort } from '../src/fetch/ip-guard.ts';
import { inspectTls } from '../src/fetch/tls.ts';

test('refuses to connect to blocked addresses', async () => {
  const facts = await inspectTls('127.0.0.1', { port: 443 });
  assert.equal(facts.authorized, false);
  assert.equal(facts.error, 'BLOCKED_ADDRESS');
});

test('reports a connection that is not TLS as unauthorized', async () => {
  const server = createServer(socket => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const facts = await inspectTls('127.0.0.1', { port, policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) }, timeoutMs: 3000 });
  server.close();
  assert.equal(facts.authorized, false);
  assert.ok(facts.error, 'an error code is recorded');
  assert.equal(facts.chainLength, 0);
});

test('reaches a host of privateOrigins only on its port', async () => {
  const server = createServer(socket => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const loopback = ((_host: string, _options: unknown, callback: (error: null, addresses: LookupAddress[]) => void) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as never;
  try {
    for (const host of ['127.0.0.1', 'site.test']) {
      const policy = { allowPrivate: false, privateOrigins: new Set([hostPort(host, port)]) };
      const reached = await inspectTls(host, { port, policy, lookup: loopback, timeoutMs: 3000 });
      const elsewhere = await inspectTls(host, { port: 443, policy, lookup: loopback, timeoutMs: 3000 });
      assert.notEqual(reached.error, 'BLOCKED_ADDRESS', host);
      assert.equal(elsewhere.error, 'BLOCKED_ADDRESS', host);
    }
  } finally {
    server.close();
  }
});
