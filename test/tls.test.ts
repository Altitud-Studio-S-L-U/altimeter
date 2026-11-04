import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
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
