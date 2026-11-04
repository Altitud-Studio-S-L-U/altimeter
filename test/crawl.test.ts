import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { collect } from '../src/collect/index.ts';

let server: Server;
let origin: string;

const page = (title: string, links: string[]) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${links.map(href => `<a href="${href}">${href}</a>`).join(' ')}</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`);
    if (path === '/sitemap.xml') return void res.writeHead(200, { 'content-type': 'application/xml' })
      .end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/orphan/</loc></url></urlset>`);
    if (path === '/') return void html(page('Home', ['/a/', '/b/', '/private/secret/', '/shop/?color=red', '/shop/?color=blue', '/shop/?color=green', '/shop/?color=black', '/file.pdf', 'https://external.example/']));
    if (path === '/a/') return void html(page('A', ['/', '/c/']));
    if (path === '/b/') return void html(page('B', ['/']));
    if (path === '/c/') return void html(page('C', ['/d/']));
    if (path === '/d/') return void html(page('D', []));
    if (path === '/orphan/') return void html(page('Orphan', []));
    if (path.startsWith('/shop/')) return void html(page('Shop', []));
    res.writeHead(404, { 'content-type': 'text/html' }).end(page('Missing', []));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const policy = { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) };

describe('crawl', () => {
  test('follows internal links and sitemap URLs, respects robots.txt and limits facets', async () => {
    const { site } = await collect({ url: `${origin}/`, policy, render: false, crawl: true, maxPages: 50, crawlDelayMs: 0 });
    const paths = [...site.pages.values()].map(entry => new URL(entry.fetch.finalUrl).pathname + new URL(entry.fetch.finalUrl).search).sort();
    assert.equal(site.crawled, true);
    for (const expected of ['/', '/a/', '/b/', '/c/', '/d/', '/orphan/']) assert.ok(paths.includes(expected), `${expected} crawled`);
    assert.equal(paths.filter(path => path.startsWith('/shop/')).length, 3, 'three query variants of one path at most');
    assert.ok(!paths.some(path => path.startsWith('/private/')));
    assert.deepEqual(site.crawlBlocked, [`${origin}/private/secret/`]);
    assert.ok(!paths.includes('/file.pdf'));
  });

  test('stops at the page limit and counts what it left out', async () => {
    const { site } = await collect({ url: `${origin}/`, policy, render: false, crawl: true, maxPages: 3, crawlDelayMs: 0 });
    assert.equal(site.pages.size, 3);
    assert.ok((site.crawlSkipped ?? 0) > 0);
  });
});
