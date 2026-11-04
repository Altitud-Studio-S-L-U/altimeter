import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { connect, createServer, type TLSSocket } from 'node:tls';
import { spkiHashes } from '../src/fetch/tls.ts';
import { createTestCa, createTestCertificates } from './support/certificates.ts';

const day = 86_400_000;

test('issues a CA and a server leaf with the extensions TLS clients check', () => {
  const { ca, leaf } = createTestCertificates(['site.test', 'www.site.test']);
  const root = new X509Certificate(ca.cert);
  const server = new X509Certificate(leaf.cert);
  assert.equal(root.ca, true);
  assert.equal(root.checkIssued(root), true);
  assert.equal(server.ca, false);
  assert.equal(server.checkIssued(root), true);
  assert.equal(server.verify(root.publicKey), true);
  assert.equal(server.subjectAltName, 'DNS:site.test, DNS:www.site.test');
  assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(server.checkHost('www.site.test'), 'www.site.test');
  assert.equal(server.checkHost('other.test'), undefined);
  for (const certificate of [root, server]) {
    assert.ok(Math.abs(Date.parse(certificate.validFrom) - (Date.now() - day)) < 60_000, 'valid from yesterday');
    assert.ok(Math.abs(Date.parse(certificate.validTo) - (Date.now() + 7 * day)) < 60_000, 'valid for a week');
  }
  assert.equal(leaf.chain, `${leaf.cert}${ca.cert}`);
  assert.deepEqual(spkiHashes(leaf.chain), [leaf.spki, ca.spki]);
  assert.match(leaf.key, /^-----BEGIN PRIVATE KEY-----\n/u);
});

test('puts an IPv4 literal in the subjectAltName as an IP address', () => {
  const server = new X509Certificate(createTestCertificates(['127.0.0.1', 'localhost']).leaf.cert);
  assert.equal(server.subjectAltName, 'IP Address:127.0.0.1, DNS:localhost');
  assert.equal(server.checkIP('127.0.0.1'), '127.0.0.1');
});

test('issues leaves with a chosen validity from the same CA', () => {
  const ca = createTestCa();
  const expired = new X509Certificate(ca.issue(['old.test'], { notBefore: new Date(Date.now() - 30 * day), notAfter: new Date(Date.now() - day) }).cert);
  assert.equal(expired.checkIssued(new X509Certificate(ca.cert)), true);
  assert.ok(Date.parse(expired.validTo) < Date.now());
  assert.throws(() => ca.issue([]), /at least one DNS name/u);
});

async function handshake(port: number, ca: string | undefined): Promise<{ authorized: boolean; error: string | undefined }> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = connect({ host: '127.0.0.1', port, servername: 'site.test', rejectUnauthorized: false, ...(ca ? { ca } : {}) }, () => {
      const error = socket.authorizationError as (Error & { code?: string }) | null;
      resolve({ authorized: socket.authorized, error: error ? String(error.code ?? error) : undefined });
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

test('a TLS server with the chain is accepted with the CA and refused without it', async () => {
  const { ca, leaf } = createTestCertificates(['site.test']);
  const server = createServer({ key: leaf.key, cert: leaf.chain }, socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.deepEqual(await handshake(port, ca.cert), { authorized: true, error: undefined });
    assert.deepEqual(await handshake(port, undefined), { authorized: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' });
    assert.deepEqual(await handshake(port, createTestCertificates(['site.test']).ca.cert), { authorized: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
