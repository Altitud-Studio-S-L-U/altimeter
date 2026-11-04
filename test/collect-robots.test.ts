import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { collect } from '../src/collect/index.ts';

let server: Server;
let origin: string;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    const html = (status: number, body: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    if (path === '/robots.txt') return void res.writeHead(301, { location: '/robots.txt/' }).end();
    if (path === '/robots.txt/') return void res.writeHead(301, { location: '/robots.txt' }).end();
    if (path === '/') return void html(200, page('Home', '<a href="/about/">About</a>'));
    if (path === '/about/') return void html(200, page('About', '<p>Who we are.</p>'));
    html(404, page('Not found', '<p>Not found.</p>'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const policy = { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) };

describe('collect with a robots.txt that redirects in a loop', () => {
  test('reads it as a missing file, as Google does, so the crawl is not blocked', async () => {
    const { site } = await collect({ url: `${origin}/`, policy, render: false, crawl: true, maxPages: 5, crawlDelayMs: 0 });
    assert.equal(site.robots?.fetch.error?.code, 'redirect-loop');
    assert.equal(site.robots?.availability.kind, 'unrestricted');
    assert.deepEqual(site.crawlBlocked, []);
    assert.ok(site.pages.has(`${origin}/about/`));
  });
});
