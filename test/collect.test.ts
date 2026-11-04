import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { collect } from '../src/collect/index.ts';
import { findChrome } from '../src/render/chrome.ts';
import { createTestCertificates } from './support/certificates.ts';

let server: Server;
let origin: string;

const layout = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${head}</head>
<body><nav><a href="/en/">Home</a> <a href="/en/about/">About</a> <a href="/en/services/">Services</a> <a href="/en/legal/">Legal</a></nav>
<main>${body}</main><script src="/private/tracker.js"></script></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    const html = (status: number, body: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap-index.xml\n`);
    if (path === '/sitemap-index.xml') return void res.writeHead(200, { 'content-type': 'application/xml' })
      .end(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
    if (path === '/sitemap-0.xml') return void res.writeHead(200, { 'content-type': 'application/xml' })
      .end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/en/', '/en/about/', '/en/services/'].map(p => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`);
    if (path === '/') return void res.writeHead(302, { location: '/en/' }).end();
    if (path === '/en/') return void html(200, layout('Example studio', '<h1>Example studio</h1><p>Home page.</p>'));
    if (path === '/en/about/') return void html(200, layout('About the studio', '<h1>About</h1><p>Who we are.</p>',
      '<link rel="alternate" hreflang="en" href="/en/about/"><link rel="alternate" hreflang="ca" href="/ca/sobre/">'));
    if (path === '/ca/sobre/') return void html(200, layout("Sobre l'estudi", '<h1>Sobre nosaltres</h1>'));
    if (path === '/en/services/') return void html(200, layout('Services', '<h1>Services</h1>'));
    if (path === '/en/legal/') return void html(200, layout('Legal notice', '<h1>Legal notice</h1>'));
    if (path === '/en/about') return void res.writeHead(301, { location: '/en/about/' }).end();
    if (path === '/private/tracker.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end("document.title += ' (tracked)';");
    html(404, layout('Not found', '<h1>Page not found</h1>'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const policy = { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) };

describe('collect', () => {
  test('gathers the page, its home page and the site context without a browser', async () => {
    const { site, warnings } = await collect({ url: `${origin}/en/about/`, policy, render: false });
    assert.deepEqual(warnings, []);
    assert.equal(site.robots?.availability.kind, 'parsed');
    assert.deepEqual(site.sitemaps.map(entry => [entry.source, entry.document?.kind]), [['robots', 'sitemapindex'], ['index', 'urlset']]);
    assert.equal(site.sitemaps[1]?.document?.urls.length, 3);
    const target = site.pages.get(`${origin}/en/about/`);
    const home = site.pages.get(`${origin}/`);
    assert.equal(target?.pageType, 'about');
    assert.equal(home?.fetch.finalUrl, `${origin}/en/`);
    assert.equal(home?.pageType, 'home');
    assert.equal(site.homeUrl, `${origin}/en/`);
    const slash = site.variants.find(variant => variant.label === 'trailing-slash');
    assert.deepEqual(slash?.fetch.hops.map(hop => hop.status), [301, 200]);
    assert.equal(site.notFound?.fetch.status, 404);
    assert.equal(site.notFound && 'parsed' in site.notFound ? site.notFound.parsed?.titles[0]?.text : undefined, 'Not found');
    assert.deepEqual(site.siblings.map(sibling => new URL(sibling.url).pathname), ['/en/services/', '/en/legal/']);
    assert.equal(target?.rendered, undefined);
    assert.deepEqual(site.resources.map(resource => [resource.purpose, new URL(resource.url).pathname, resource.fetch.status]),
      [['favicon', '/favicon.ico', 404], ['llms-txt', '/llms.txt', 404]]);
    assert.equal(site.localeProbes.length, 12);
    assert.deepEqual(site.localeProbes.filter(probe => probe.url === `${origin}/`).map(probe => probe.label),
      ['accept-language:none', 'accept-language:en', 'accept-language:es', 'accept-language:ca', 'accept-language:fr', 'accept-language:de']);
    assert.equal(site.agentProbes.length, 11);
    assert.deepEqual(site.alternates?.map(alternate => [new URL(alternate.url).pathname, alternate.fetch.status]), [['/ca/sobre/', 200]]);
    assert.equal(site.tls, undefined);
    assert.deepEqual(target?.uaProbes?.map(probe => probe.agent.name), ['Googlebot Smartphone', 'Chrome (mobile)']);
  });

  test('renders like Googlebot and records what robots.txt blocks', { skip: findChrome() ? false : 'Chrome is not installed', timeout: 120_000 }, async () => {
    const { site, versions } = await collect({ url: `${origin}/en/about/`, policy, lighthouse: false });
    assert.match(versions.chrome ?? '', /Chrome\//u);
    const target = site.pages.get(`${origin}/en/about/`);
    assert.deepEqual(target?.rendered?.result.blockedByRobots, [`${origin}/private/tracker.js`]);
    assert.equal(target?.rendered?.parsed.titles[0]?.text, 'About the studio');
    assert.equal(target?.unblockedRender?.parsed.titles[0]?.text, 'About the studio (tracked)');
    assert.ok(target?.userRender);
  });
});

describe('collect with an extra CA', () => {
  const { ca, leaf } = createTestCertificates(['site.test', 'www.site.test']);
  const lookup = ((_host: string, _options: unknown, callback: (error: null, addresses: LookupAddress[]) => void) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as never;
  const sitePolicy = { allowPrivate: false, privateHosts: new Set(['site.test', 'www.site.test']) };
  let secure: ReturnType<typeof createHttpsServer>;
  let port: number;

  before(async () => {
    secure = createHttpsServer({ key: leaf.key, cert: leaf.chain }, (req, res) => {
      if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Private CA', '<h1>Staging home</h1>'));
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Not found', '<h1>Not found</h1>'));
    });
    await new Promise<void>(resolve => secure.listen(0, '127.0.0.1', resolve));
    port = (secure.address() as AddressInfo).port;
  });

  after(async () => {
    secure.closeAllConnections();
    await new Promise(resolve => secure.close(resolve));
  });

  test('fetches and probes a site whose certificate chains to the CA', async () => {
    const { site } = await collect({ url: `https://site.test:${port}/`, policy: sitePolicy, lookup, ca: ca.cert, render: false });
    const home = site.pages.get(`https://site.test:${port}/`);
    assert.equal(home?.fetch.status, 200);
    assert.equal(home?.raw?.parsed.titles[0]?.text, 'Private CA');
    assert.equal(site.tls?.authorized, true);
    assert.equal(site.counterpartTls?.host, 'www.site.test');
    assert.equal(site.counterpartTls?.authorized, true);
  });

  test('without the CA the same site fails verification, as before', async () => {
    const { site } = await collect({ url: `https://site.test:${port}/`, policy: sitePolicy, lookup, render: false });
    assert.equal(site.pages.get(`https://site.test:${port}/`)?.fetch.error?.code, 'tls');
    assert.equal(site.tls?.authorized, false);
    assert.equal(site.tls?.error, 'SELF_SIGNED_CERT_IN_CHAIN');
  });
});
