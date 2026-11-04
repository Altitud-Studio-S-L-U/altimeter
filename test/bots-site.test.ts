import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { isAllowed } from '../src/fetch/robots.ts';
import { botSiteInput, fetchSiteFacts } from '../src/owner/bots/site.ts';
import { loopbackClient } from './support/bots.ts';

let primary: Server;
let moved: Server;
let primaryOrigin: string;
let movedOrigin: string;

const urlset = (origin: string, paths: string[]) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;

before(async () => {
  moved = createServer((request, response) => {
    if (request.url === '/robots.txt') return void response.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nDisallow: /private/\nSitemap: ${movedOrigin}/sitemap.xml\n`);
    if (request.url === '/sitemap.xml') return void response.writeHead(200, { 'content-type': 'application/xml' }).end(urlset(movedOrigin, ['/en/']));
    response.writeHead(404).end();
  });
  primary = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      return void response.writeHead(200, { 'content-type': 'text/plain', 'last-modified': 'Tue, 01 Sep 2026 10:00:00 GMT' })
        .end(`User-agent: GPTBot\nDisallow: /\n\nSitemap: ${primaryOrigin}/sitemap-index.xml\n`);
    }
    if (request.url === '/sitemap-index.xml') {
      return void response.writeHead(200, { 'content-type': 'application/xml' })
        .end(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${primaryOrigin}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
    }
    if (request.url === '/sitemap-0.xml') return void response.writeHead(200, { 'content-type': 'application/xml' }).end(urlset(primaryOrigin, ['/en/', '/en/about/']));
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => moved.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => primary.listen(0, '127.0.0.1', resolve));
  movedOrigin = `http://127.0.0.1:${(moved.address() as AddressInfo).port}`;
  primaryOrigin = `http://127.0.0.1:${(primary.address() as AddressInfo).port}`;
});

after(async () => {
  for (const server of [primary, moved]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

describe('site facts for the bots command', () => {
  test('reads robots.txt, its Last-Modified date and the sitemap URLs through an index', async () => {
    const client = loopbackClient();
    const facts = await fetchSiteFacts(client, primaryOrigin);
    await client.close();
    assert.equal(facts.origin, primaryOrigin);
    assert.deepEqual(facts.sitemaps.map(entry => entry.source), ['robots', 'index']);
    const input = botSiteInput(facts);
    assert.deepEqual(input.sitemapUrls, [`${primaryOrigin}/en/`, `${primaryOrigin}/en/about/`]);
    assert.equal(input.robots?.lastModified, 'Tue, 01 Sep 2026 10:00:00 GMT');
    assert.equal(isAllowed(input.robots!.file, ['gptbot'], '/en/').allowed, false);
  });

  test('takes the host robots.txt redirects to as the site when it is the same site', async () => {
    const redirecting = createServer((request, response) => {
      response.writeHead(301, { location: `${movedOrigin}${request.url ?? '/'}` }).end();
    });
    await new Promise<void>(resolve => redirecting.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
    const client = loopbackClient();
    try {
      const facts = await fetchSiteFacts(client, origin);
      assert.equal(facts.origin, movedOrigin);
      assert.deepEqual(botSiteInput(facts).sitemapUrls, [`${movedOrigin}/en/`]);
    } finally {
      await client.close();
      redirecting.closeAllConnections();
      await new Promise(resolve => redirecting.close(resolve));
    }
  });

  test('treats a missing robots.txt as no rules and an unreachable one as unknown', async () => {
    const client = loopbackClient();
    const fetched = await fetchSiteFacts(client, primaryOrigin);
    await client.close();
    assert.ok(fetched.robots);
    const missing = { ...fetched, robots: { ...fetched.robots, availability: { kind: 'unrestricted' as const, status: 404 } } };
    assert.equal(isAllowed(botSiteInput(missing).robots!.file, ['gptbot'], '/anything').allowed, true);
    const unreachable = { ...fetched, robots: { ...fetched.robots, availability: { kind: 'unreachable' as const, status: 503 } } };
    assert.equal(botSiteInput(unreachable).robots, undefined);
  });
});
