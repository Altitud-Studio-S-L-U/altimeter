import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { findChrome, launchAuditBrowser, type AuditBrowser } from '../src/render/chrome.ts';
import { lighthouseCategories, runLighthouse } from '../src/render/lighthouse.ts';

const chrome = findChrome();
if (!chrome && process.env.CI) throw new Error('Chrome is required on CI');

let server: Server;
let base: string;
let audit: AuditBrowser | undefined;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Lighthouse fixture</title>
<meta name="description" content="A small page used to check the Lighthouse runner."></head>
<body><main><h1>Lighthouse fixture</h1><p>Plain content.</p><a href="/next">Next page</a></main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (chrome) audit = await launchAuditBrowser({ policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) } });
});

after(async () => {
  await audit?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

describe('runLighthouse', { skip: chrome ? false : 'Chrome is not installed' }, () => {
  test('runs the selected categories and keeps a trimmed median result', { timeout: 180_000 }, async () => {
    const outcome = await runLighthouse(audit!, `${base}/`, { runs: 1 });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
    if (!outcome.ok) return;
    const { summary } = outcome;
    assert.match(summary.lighthouseVersion, /^13\./u);
    assert.deepEqual(Object.keys(summary.categories).sort(), [...lighthouseCategories].sort());
    assert.equal(summary.settings.formFactor, 'mobile');
    assert.equal(summary.settings.throttlingMethod, 'simulate');
    assert.equal(typeof summary.audits['largest-contentful-paint']?.numericValue, 'number');
    assert.equal(summary.audits['document-title']?.score, 1);
    assert.equal(summary.audits['final-screenshot'], undefined);
    assert.ok(summary.audits['network-requests']?.details, 'network requests are kept for page weight and protocol checks');
    assert.equal(summary.validRuns, 1);
  });
});

test('opens each run in a new context of the audit browser, where downloads are denied, and closes it', async () => {
  const contexts: string[] = [];
  const browser = {
    browser: { createBrowserContext: async () => { throw new Error('a context without the download policy of the audit browser'); } },
    newContext: async () => {
      contexts.push('opened');
      return { newPage: async () => { throw new Error('no page in this test'); }, close: async () => { contexts.push('closed'); } };
    },
  } as unknown as AuditBrowser;
  assert.deepEqual(await runLighthouse(browser, 'http://127.0.0.1:9/', { runs: 2 }), { ok: false, error: 'no page in this test' });
  assert.deepEqual(contexts, ['opened', 'closed', 'opened', 'closed']);
});
