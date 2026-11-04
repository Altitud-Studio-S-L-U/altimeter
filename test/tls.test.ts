import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createServer as createTlsServer, getCACertificates } from 'node:tls';
import { hostPort } from '../src/fetch/ip-guard.ts';
import { inspectTls, spkiHashes, trustedRoots } from '../src/fetch/tls.ts';
import { createTestCertificates } from './support/certificates.ts';

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

const loopback = ((_host: string, _options: unknown, callback: (error: null, addresses: LookupAddress[]) => void) => {
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
}) as never;

test('verifies a chain against an extra CA without dropping the default roots', async () => {
  const { ca, leaf } = createTestCertificates(['site.test']);
  const server = createTlsServer({ key: leaf.key, cert: leaf.chain }, socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const options = { port, policy: { allowPrivate: false, privateHosts: new Set(['site.test']) }, lookup: loopback, timeoutMs: 3000 };
  try {
    const trusted = await inspectTls('site.test', { ...options, ca: trustedRoots(ca.cert) });
    assert.equal(trusted.authorized, true);
    assert.equal(trusted.error, undefined);
    assert.deepEqual(trusted.subjectAltNames, ['site.test']);
    assert.equal(trusted.chainLength, 2);
    assert.equal(trusted.issuer, 'Altimeter Test CA');
    const untrusted = await inspectTls('site.test', options);
    assert.equal(untrusted.authorized, false);
    assert.equal(untrusted.error, 'SELF_SIGNED_CERT_IN_CHAIN');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const roots = trustedRoots(ca.cert);
  assert.equal(roots.at(-1), ca.cert);
  assert.deepEqual(roots.slice(0, -1), getCACertificates('default'));
});

test('hashes the public key of every certificate in a PEM bundle', () => {
  const { ca, leaf } = createTestCertificates(['site.test']);
  assert.deepEqual(spkiHashes(ca.cert), [ca.spki]);
  assert.deepEqual(spkiHashes(`${leaf.cert}\n${ca.cert}`), [leaf.spki, ca.spki]);
  assert.deepEqual(spkiHashes('not a certificate'), []);
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
