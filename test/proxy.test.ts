import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startGuardedProxy } from '../src/render/proxy.ts';

let origin: Server;
let originPort: number;

before(async () => {
  origin = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(`origin saw ${req.headers.host} ${req.url}`));
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as AddressInfo).port;
});

after(async () => {
  origin.closeAllConnections();
  await new Promise(resolve => origin.close(resolve));
});

const loopback = ((_host: string, _options: unknown, callback: (error: null, addresses: LookupAddress[]) => void) => {
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
}) as never;

function viaProxy(proxyUrl: string, target: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: proxy.hostname, port: proxy.port, path: target, headers: { host: new URL(target).host } }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function tunnel(proxyUrl: string, authority: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.once('data', chunk => {
      resolve(chunk.toString().split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

describe('guarded proxy', () => {
  test('forwards plain HTTP to allowed hosts and keeps the Host header', async () => {
    const proxy = await startGuardedProxy({ allowPrivate: false, privateHosts: new Set(['site.test']) }, loopback);
    const result = await viaProxy(proxy.url, `http://site.test:${originPort}/page?q=1`);
    await proxy.close();
    assert.equal(result.status, 200);
    assert.equal(result.body, `origin saw site.test:${originPort} /page?q=1`);
  });

  test('refuses plain HTTP to hosts that resolve to private addresses', async () => {
    const proxy = await startGuardedProxy({ allowPrivate: false }, loopback);
    const result = await viaProxy(proxy.url, `http://rebind.test:${originPort}/`);
    const refused = [...proxy.refused];
    await proxy.close();
    assert.equal(result.status, 403);
    assert.deepEqual(refused, [{ host: 'rebind.test', port: originPort, allowed: false, reason: 'blocked-address' }]);
  });

  test('tunnels CONNECT only to allowed addresses', async () => {
    const proxy = await startGuardedProxy({ allowPrivate: false, privateHosts: new Set(['site.test']) }, loopback);
    const allowed = await tunnel(proxy.url, `site.test:${originPort}`);
    const literal = await tunnel(proxy.url, `127.0.0.1:${originPort}`);
    const metadata = await tunnel(proxy.url, '169.254.169.254:80');
    await proxy.close();
    assert.equal(allowed, 'HTTP/1.1 200 Connection Established');
    assert.equal(literal, 'HTTP/1.1 403 Forbidden');
    assert.equal(metadata, 'HTTP/1.1 403 Forbidden');
  });
});
