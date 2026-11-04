import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { audit, type AuditOptions } from '../src/audit.ts';
import { listServer, logFixture, loopbackClient, now, scriptedResolver } from './support/bots.ts';

let server: Server;
let origin: string;
let lists: Awaited<ReturnType<typeof listServer>>;
let work: string;

const sitemapPaths = ['/en/', '/en/about/', '/en/services/', '/en/contact/'];

before(async () => {
  lists = await listServer();
  work = await mkdtemp(join(tmpdir(), 'altimeter-audit-owner-'));
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /en/about/\n\nSitemap: ${origin}/sitemap.xml\n`);
    }
    if (req.url === '/sitemap.xml') {
      const urls = sitemapPaths.map(path => `<url><loc>${origin}${path}</loc></url>`).join('');
      return void res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><title>Services</title></head><body><h1>Services</h1></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await lists.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
});

const local = (options: Partial<AuditOptions>): AuditOptions => ({ url: `${origin}/en/`, policy: { allowPrivate: true }, render: false, lighthouse: false, ...options });

describe('audit with crawler activity', () => {
  test('adds the requests the site received, compared with the robots.txt and sitemap the audit collected', async () => {
    const resolver = scriptedResolver({ '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'] }, { 'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'] });
    const client = loopbackClient();
    try {
      const { report, collected } = await audit(local({
        bots: { logs: [logFixture('combined.log')], now, client, dns: resolver, ipLists: { cacheDirectory: join(work, 'lists'), urls: lists.urls } },
      }));
      const bots = collected.site.owner?.bots;
      assert.ok(bots, 'the activity is part of the owner data');
      assert.equal(bots.site?.origin, origin);
      assert.equal(bots.site?.sitemapUrls, sitemapPaths.length, 'the sitemap the audit read is the one compared');
      assert.equal(bots.site?.robots?.url, `${origin}/robots.txt`);
      const outcome = (id: string) => report.findings.filter(finding => finding.ruleId === id).map(finding => finding.outcome);
      assert.deepEqual(outcome('ai-bots-crawl-activity'), ['fail'], 'AI crawler requests are reported, as information');
      assert.ok(outcome('crawl-bots-spoofed-crawlers').length > 0);
      for (const finding of report.findings.filter(entry => entry.ruleId.includes('-bots-'))) {
        assert.notEqual(finding.reason, 'robots-not-compared', `${finding.ruleId} compares with the collected robots.txt`);
      }
      assert.ok(report.run.warnings.every(warning => !warning.startsWith('Crawler activity was not read')), report.run.warnings.join('\n'));
    } finally {
      await client.close();
    }
  });

  test('turns a source it cannot read into a warning and audits the rest', async () => {
    const { report, collected } = await audit(local({ bots: { now, env: {} } }));
    assert.equal(collected.site.owner?.bots, undefined);
    assert.ok(report.run.warnings.some(warning => warning.startsWith('Crawler activity was not read: ')), report.run.warnings.join('\n'));
    const evaluated = report.findings.filter(finding => finding.ruleId.includes('-bots-'));
    assert.deepEqual(evaluated, [], 'the crawler rules need the owner data and are skipped without it');
  });
});

describe('audit with Bing Webmaster Tools', () => {
  test('warns when no key is set and leaves the owner data out', async () => {
    const saved = process.env.BING_WEBMASTER_API_KEY;
    delete process.env.BING_WEBMASTER_API_KEY;
    try {
      const { report, collected } = await audit(local({ bing: {} }));
      assert.equal(collected.site.owner?.bing, undefined);
      assert.ok(report.run.warnings.some(warning => warning.includes('BING_WEBMASTER_API_KEY is not set')), report.run.warnings.join('\n'));
    } finally {
      if (saved !== undefined) process.env.BING_WEBMASTER_API_KEY = saved;
    }
  });
});
