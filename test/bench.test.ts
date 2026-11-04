import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import { connect } from 'node:tls';
import { route, loopbackLookup, loopbackPolicy } from '../bench/support/scenario.ts';
import { startVirtualHosts } from '../bench/support/server.ts';
import { HttpClient } from '../src/fetch/http.ts';
import { trustedRoots } from '../src/fetch/tls.ts';
import { createTestCa } from './support/certificates.ts';

const day = 86_400_000;

test('one loopback port answers plain HTTP and HTTPS, routed by Host and with the certificate SNI asks for', async () => {
  const ca = createTestCa();
  const leaf = ca.issue(['site.example', 'www.site.example']);
  const expired = ca.issue(['www.site.example'], { notBefore: new Date(Date.now() - 10 * day), notAfter: new Date(Date.now() - day) });
  const origins = {
    'http://site.example': () => ({ status: 301, headers: { location: 'https://site.example/' }, body: '' }),
    'https://site.example': { routes: { '/': { headers: { 'content-type': 'text/html' }, body: `<!doctype html><title>Home</title>${'text '.repeat(500)}` } } },
  };
  const server = await startVirtualHosts({
    tls: { key: leaf.key, cert: leaf.chain },
    hostTls: { 'www.site.example': { key: expired.key, cert: expired.chain } },
    handle: request => route(origins, request),
  });
  const hosts = ['site.example', 'www.site.example'];
  const client = new HttpClient({ policy: loopbackPolicy(hosts), lookup: loopbackLookup(hosts), ca: trustedRoots(ca.cert) });
  try {
    const plain = await client.fetch(`http://site.example:${server.port}/`, { followRedirects: false });
    assert.equal(plain.status, 301);
    const secure = await client.fetch(`https://site.example:${server.port}/`);
    assert.equal(secure.status, 200);
    assert.equal(secure.headers['content-encoding']?.[0], 'br');
    assert.match(secure.body.toString(), /<title>Home<\/title>/u);
    const unknown = await client.fetch(`https://site.example:${server.port}/missing`);
    assert.equal(unknown.status, 404);
    const certificate = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: server.port, servername: 'www.site.example', rejectUnauthorized: false }, () => {
        resolve(new X509Certificate(socket.getPeerCertificate().raw).validTo);
        socket.destroy();
      });
      socket.on('error', reject);
    });
    assert.ok(Date.parse(certificate) < Date.now(), 'www gets its own, expired certificate');
    assert.deepEqual(server.requests.map(request => [request.secure, request.host, request.path]),
      [[false, 'site.example', '/'], [true, 'site.example', '/'], [true, 'site.example', '/missing']]);
    assert.equal(server.requests[1]?.sni, 'site.example');
  } finally {
    await client.close();
    await server.close();
  }
});

test('the loopback lookup resolves only the scenario hosts, and the policy admits only those names', async () => {
  const lookup = loopbackLookup(['site.example']);
  const resolve = (host: string) => new Promise<{ error: string | undefined; addresses: LookupAddress[] }>(done => {
    (lookup as unknown as (host: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void)(
      host, { all: true }, (error, addresses) => done({ error: error?.code, addresses }));
  });
  assert.deepEqual(await resolve('SITE.example'), { error: undefined, addresses: [{ address: '127.0.0.1', family: 4 }] });
  assert.deepEqual(await resolve('example.com'), { error: 'ENOTFOUND', addresses: [] });
  assert.deepEqual([...loopbackPolicy(['Site.Example']).privateHosts ?? []], ['site.example']);
  assert.equal(loopbackPolicy(['site.example']).allowPrivate, false);
});
