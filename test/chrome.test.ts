import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { findChrome, launchAuditBrowser, renderPage, type AuditBrowser } from '../src/render/chrome.ts';

const chrome = findChrome();
if (!chrome && process.env.CI) throw new Error('Chrome is required on CI');

const page = `<!doctype html><html lang="en"><head><title>Render test</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  .reveal { opacity: 0; transition: opacity 0.3s; }
  .reveal.shown { opacity: 1; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style></head>
<body>
<main>
  <h1>Server text</h1>
  <p id="hidden" style="display:none">Hidden paragraph</p>
  <span class="sr-only">Screen reader label</span>
  <div style="height: 3000px">Spacer block</div>
  <section class="reveal" id="late">Revealed section text</section>
</main>
<script>
  document.querySelector('main').insertAdjacentHTML('afterbegin', '<p id="injected">Injected by script</p>');
  new IntersectionObserver(entries => entries.forEach(entry => entry.isIntersecting && entry.target.classList.add('shown')))
    .observe(document.getElementById('late'));
  console.error('intentional test error');
  setTimeout(() => document.body.insertAdjacentHTML('afterbegin', '<div style="height:120px">Late banner</div>'), 600);
</script>
<script src="/blocked.js"></script>
</body></html>`;

let server: Server;
let base: string;
let audit: AuditBrowser | undefined;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/no-viewport') return void res.writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Desktop layout</title><div style="height:5000px">Tall desktop page</div><p>End</p>');
    if (req.url === '/blocked.js') return void res.writeHead(200, { 'content-type': 'text/javascript' })
      .end("document.querySelector('main').insertAdjacentHTML('beforeend', '<p id=\"from-blocked\">From blocked script</p>');");
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
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

const robotsAllows = async (url: string) => !url.endsWith('/blocked.js');
const userAgent = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 (compatible; Altimeter-test)';

describe('renderPage', { skip: chrome ? false : 'Chrome is not installed' }, () => {
  test('renders like Googlebot: scripts run, the tall viewport reveals late content, robots-blocked scripts do not run', async () => {
    const result = await renderPage(audit!, `${base}/`, { mode: 'googlebot', userAgent, robotsAllows });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 200);
    assert.match(result.html, /Injected by script/u);
    assert.doesNotMatch(result.html, /From blocked script/u);
    assert.deepEqual(result.blockedByRobots, [`${base}/blocked.js`]);
    assert.ok(result.viewport.height > 3000, `viewport grew to ${result.viewport.height}`);
    const late = result.textBlocks.find(block => block.text === 'Revealed section text');
    assert.equal(late?.hidden, undefined, 'the IntersectionObserver reveal completed in the tall viewport');
    assert.equal(result.textBlocks.find(block => block.text === 'Hidden paragraph')?.hidden, 'display-none');
    assert.equal(result.textBlocks.find(block => block.text === 'Screen reader label')?.hidden, 'visually-hidden');
    assert.ok(result.textBlocks.find(block => block.text === 'Server text')?.inMain);
    assert.ok(result.console.some(entry => entry.text.includes('intentional test error')));
    assert.deepEqual(result.layoutShifts, [], 'shifts are not scored while the viewport grows');
    assert.ok(result.lcp && result.lcp.size > 0);
  });

  test('without a viewport meta tag the tall viewport converges on the document height', async () => {
    const result = await renderPage(audit!, `${base}/no-viewport`, { mode: 'googlebot', userAgent });
    assert.ok(result.innerWidth > result.viewport.width * 2, 'the page is laid out at the desktop default width');
    const coveredLayoutHeight = result.viewport.height * (result.innerWidth / result.viewport.width);
    assert.ok(coveredLayoutHeight >= result.documentHeight - 2, `${coveredLayoutHeight} covers ${result.documentHeight}`);
    assert.ok(result.viewport.height < 4000, `viewport stayed at ${result.viewport.height}`);
  });

  test('the unblocked diagnostic render runs scripts that robots.txt blocks', async () => {
    const result = await renderPage(audit!, `${base}/`, { mode: 'unblocked', userAgent, robotsAllows });
    assert.match(result.html, /From blocked script/u);
    assert.deepEqual(result.blockedByRobots, []);
  });

  test('the user render scrolls a phone-sized viewport', async () => {
    const result = await renderPage(audit!, `${base}/`, { mode: 'user', userAgent });
    assert.equal(result.viewport.height, 823);
    assert.equal(result.textBlocks.find(block => block.text === 'Revealed section text')?.hidden, undefined);
    assert.ok(result.layoutShifts.some(shift => shift.value > 0), 'the late banner shifted the layout');
  });

  test('pages cannot reach blocked addresses through the browser', async () => {
    const result = await renderPage(audit!, 'http://169.254.169.254/latest/meta-data/', { mode: 'user', userAgent, timeoutMs: 15_000 });
    assert.ok(result.error !== undefined || result.status !== 200);
    assert.ok(audit!.proxy.refused.some(decision => decision.host === '169.254.169.254'));
  });
});
