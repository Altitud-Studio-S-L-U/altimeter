import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import zlib from 'node:zlib';
import { HttpClient, headerValue } from '../src/fetch/http.ts';
import { hostPort } from '../src/fetch/ip-guard.ts';

let server: Server;
let port: number;
const html = '<!doctype html><title>ok</title>';

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/ok') return void res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (path === '/gzip') return void res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync(html));
    if (path === '/br') return void res.writeHead(200, { 'content-encoding': 'br' }).end(zlib.brotliCompressSync(html));
    if (path === '/big') return void res.writeHead(200).end('x'.repeat(5000));
    if (path === '/unknown-encoding') return void res.writeHead(200, { 'content-encoding': 'compress' }).end('x');
    if (path === '/hop-1') return void res.writeHead(301, { location: '/hop-2' }).end();
    if (path === '/hop-2') return void res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` }).end();
    if (path === '/loop-a') return void res.writeHead(307, { location: '/loop-b' }).end();
    if (path === '/loop-b') return void res.writeHead(308, { location: '/loop-a' }).end();
    if (path.startsWith('/chain-')) {
      const n = Number(path.slice('/chain-'.length));
      return void res.writeHead(301, { location: n > 0 ? `/chain-${n - 1}` : '/ok' }).end();
    }
    if (path === '/to-ftp') return void res.writeHead(301, { location: 'ftp://example.com/file' }).end();
    if (path.startsWith('/redirect?to=')) return void res.writeHead(302, { location: decodeURIComponent(path.slice('/redirect?to='.length)) }).end();
    if (path === '/agent') return void res.writeHead(200).end(req.headers['user-agent'] ?? '');
    if (path === '/slow') return void setTimeout(() => res.writeHead(200).end('late'), 2000);
    res.writeHead(404).end('missing');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const loopbackLookup = ((_hostname: string, _options: unknown, callback: (error: null, addresses: LookupAddress[]) => void) => {
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
}) as never;

function localClient(options: { maxHosts?: string[] } = {}) {
  return new HttpClient({ policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1', ...(options.maxHosts ?? [])]) }, lookup: loopbackLookup });
}

describe('HttpClient', () => {
  test('fetches a page and records the hop', async () => {
    const client = localClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/ok`);
    await client.close();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), html);
    assert.equal(headerValue(result.headers, 'Content-Type'), 'text/html');
    assert.equal(result.hops.length, 1);
    assert.ok(result.hops[0]!.ttfbMs >= 0);
  });

  test('decodes gzip and brotli bodies', async () => {
    const client = localClient();
    const gzip = await client.fetch(`http://127.0.0.1:${port}/gzip`);
    const br = await client.fetch(`http://127.0.0.1:${port}/br`);
    await client.close();
    assert.equal(gzip.body.toString(), html);
    assert.equal(br.body.toString(), html);
    assert.ok(gzip.transferBytes > 0);
  });

  test('cuts the body at maxBytes and says so', async () => {
    const client = localClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1000 });
    await client.close();
    assert.equal(result.truncated, true);
    assert.equal(result.body.length, 1000);
  });

  test('reports an unsupported content encoding', async () => {
    const client = localClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/unknown-encoding`);
    await client.close();
    assert.equal(result.error?.code, 'decode');
  });

  test('follows redirects and keeps every hop', async () => {
    const client = localClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/hop-1`);
    await client.close();
    assert.deepEqual(result.hops.map(hop => hop.status), [301, 302, 200]);
    assert.equal(result.hops[0]!.location, `http://127.0.0.1:${port}/hop-2`);
    assert.equal(result.finalUrl, `http://127.0.0.1:${port}/ok`);
  });

  test('can stop at the first redirect', async () => {
    const client = localClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/hop-1`, { followRedirects: false });
    await client.close();
    assert.equal(result.status, 301);
    assert.equal(result.hops.length, 1);
  });

  test('detects redirect loops and long chains', async () => {
    const client = localClient();
    const loop = await client.fetch(`http://127.0.0.1:${port}/loop-a`);
    const chain = await client.fetch(`http://127.0.0.1:${port}/chain-12`, { maxRedirects: 10 });
    const short = await client.fetch(`http://127.0.0.1:${port}/chain-3`, { maxRedirects: 5 });
    await client.close();
    assert.equal(loop.error?.code, 'redirect-loop');
    assert.equal(chain.error?.code, 'too-many-redirects');
    assert.equal(short.status, 200);
  });

  test('refuses redirects to other protocols', async () => {
    const client = localClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/to-ftp`);
    await client.close();
    assert.equal(result.error?.code, 'unsupported-protocol');
  });

  test('sends its own user agent unless one is given', async () => {
    const client = localClient();
    const own = await client.fetch(`http://127.0.0.1:${port}/agent`);
    const given = await client.fetch(`http://127.0.0.1:${port}/agent`, { headers: { 'user-agent': 'Probe/1.0' } });
    await client.close();
    assert.match(own.body.toString(), /^Mozilla\/5\.0 \(compatible; Altimeter\/\d/u);
    assert.equal(given.body.toString(), 'Probe/1.0');
  });

  test('times out slow responses', async () => {
    const client = localClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/slow`, { timeoutMs: 200 });
    await client.close();
    assert.equal(result.error?.code, 'timeout');
  });
});

describe('network policy', () => {
  test('refuses loopback literals by default', async () => {
    const client = new HttpClient();
    const result = await client.fetch(`http://127.0.0.1:${port}/ok`);
    await client.close();
    assert.equal(result.error?.code, 'blocked-address');
    assert.equal(result.hops.length, 0);
  });

  test('refuses host names that resolve to private addresses', async () => {
    const client = new HttpClient({ lookup: loopbackLookup });
    const result = await client.fetch(`http://rebind.test:${port}/ok`);
    await client.close();
    assert.equal(result.error?.code, 'blocked-address');
  });

  test('allows a private host named in the policy', async () => {
    const client = localClient({ maxHosts: ['site.test'] });
    const result = await client.fetch(`http://site.test:${port}/ok`);
    await client.close();
    assert.equal(result.status, 200);
  });

  test('checks every redirect hop against the policy', async () => {
    const client = new HttpClient({ policy: { allowPrivate: false, privateHosts: new Set(['site.test']) }, lookup: loopbackLookup });
    const result = await client.fetch(`http://site.test:${port}/hop-2`);
    await client.close();
    assert.equal(result.hops[0]!.status, 302);
    assert.equal(result.error?.code, 'blocked-address');
  });

  test('exempts a host of privateOrigins only on its port, on every hop', async () => {
    let reached = 0;
    const other = createServer((_req, res) => {
      reached += 1;
      res.writeHead(200).end('another local service');
    });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as AddressInfo).port;
    const client = new HttpClient({ policy: { allowPrivate: false, privateOrigins: new Set([hostPort('127.0.0.1', port), hostPort('site.test', port)]) }, lookup: loopbackLookup });
    try {
      assert.equal((await client.fetch(`http://127.0.0.1:${port}/ok`)).status, 200);
      assert.equal((await client.fetch(`http://site.test:${port}/ok`)).status, 200);
      assert.equal((await client.fetch(`http://127.0.0.1:${otherPort}/`)).error?.code, 'blocked-address');
      assert.equal((await client.fetch(`http://site.test:${otherPort}/`)).error?.code, 'blocked-address');
      const redirected = await client.fetch(`http://site.test:${port}/redirect?to=${encodeURIComponent(`http://site.test:${otherPort}/`)}`);
      assert.deepEqual([redirected.hops.map(hop => hop.status), redirected.error?.code], [[302], 'blocked-address']);
      assert.equal(reached, 0);
    } finally {
      await client.close();
      other.closeAllConnections();
      await new Promise(resolve => other.close(resolve));
    }
  });
});
