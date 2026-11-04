import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Launcher } from 'chrome-launcher';
import { findChrome, launchAuditBrowser, renderPage, type AuditBrowser } from '../src/render/chrome.ts';

const chrome = findChrome();
if (!chrome && process.env.CI) throw new Error('Chrome is required on CI');

test('findChrome reports a missing Chrome instead of throwing, as chrome-launcher does on Linux', t => {
  const saved = process.env.CHROME_PATH;
  delete process.env.CHROME_PATH;
  t.after(() => {
    if (saved !== undefined) process.env.CHROME_PATH = saved;
  });
  t.mock.method(Launcher, 'getFirstInstallation', () => {
    throw new Error('The CHROME_PATH environment variable must be set to a Chrome/Chromium executable no older than Chrome stable.');
  });
  assert.equal(findChrome(), undefined);
});

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

const overlayPage = `<!doctype html><html lang="en"><head><title>Overlays</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { overflow: hidden; margin: 0; }
  header { position: sticky; top: 0; height: 60px; }
  #promo { position: fixed; inset: 0; z-index: 1000; background: white; }
  #cookies { position: fixed; bottom: 0; left: 0; right: 0; height: 120px; z-index: 2000; }
  #later { position: fixed; top: 0; display: none; }
  .fade { opacity: 0; }
</style></head>
<body>
<header>Site header</header>
<div id="promo" role="dialog" aria-modal="true"><p>Subscribe to our newsletter</p></div>
<div id="cookies">We use cookies <button>Accept</button></div>
<div id="later">Never shown</div>
<main>
  <section class="fade" id="stalled">Stalled reveal text</section>
  <p style="opacity:0">Plain hidden text</p>
  <div data-aos="fade-up" style="opacity:0"><p>Animated on scroll text</p></div>
  <ul style="display:flex;overflow-x:auto;width:300px;padding:0;margin:0">
    <li style="flex:0 0 300px">First slide text</li><li style="flex:0 0 300px">Second slide text</li><li style="flex:0 0 300px">Third slide text</li>
    <li style="flex:0 0 300px">Fourth slide text</li><li style="flex:0 0 300px">Fifth slide text</li>
  </ul>
  <p style="position:absolute;left:-3000px">Pushed aside text</p>
</main>
<script>new IntersectionObserver(() => {}).observe(document.getElementById('stalled'));</script>
</body></html>`;

let server: Server;
let base: string;
let audit: AuditBrowser | undefined;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/no-viewport') return void res.writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Desktop layout</title><div style="height:5000px">Tall desktop page</div><p>End</p>');
    if (req.url === '/overlays') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(overlayPage);
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

  test('the user render lists what covers the first screen at load and whether scrolling is locked', async () => {
    const result = await renderPage(audit!, `${base}/overlays`, { mode: 'user', userAgent });
    assert.equal(result.scrollLocked, true);
    assert.deepEqual(result.overlays?.map(overlay => [overlay.selector, overlay.position, overlay.zIndex, overlay.dialog]), [
      ['html > body > header', 'sticky', undefined, false],
      ['div#promo', 'fixed', 1000, true],
      ['div#cookies', 'fixed', 2000, false],
    ]);
    const promo = result.overlays!.find(overlay => overlay.selector === 'div#promo')!;
    assert.deepEqual([promo.coverage, promo.box.width, promo.text], [1, 412, 'Subscribe to our newsletter']);
    assert.ok(result.overlays!.find(overlay => overlay.selector === 'div#cookies')!.coverage < 0.2);
  });

  test('marks hidden text that waits for a scroll reveal, and only that', async () => {
    const result = await renderPage(audit!, `${base}/overlays`, { mode: 'googlebot', userAgent });
    const block = (text: string) => result.textBlocks.find(entry => entry.text === text);
    assert.deepEqual([block('Stalled reveal text')?.hidden, block('Stalled reveal text')?.revealOnScroll], ['opacity-zero', true]);
    assert.deepEqual([block('Animated on scroll text')?.hidden, block('Animated on scroll text')?.revealOnScroll], ['opacity-zero', true]);
    assert.deepEqual([block('Plain hidden text')?.hidden, block('Plain hidden text')?.revealOnScroll], ['opacity-zero', undefined]);
    assert.deepEqual([block('Fifth slide text')?.hidden, block('Fifth slide text')?.inScroller], ['offscreen', true]);
    assert.deepEqual([block('Pushed aside text')?.hidden, block('Pushed aside text')?.inScroller], ['offscreen', undefined]);
    assert.equal(result.overlays, undefined, 'overlays are measured in the user render only');
  });

  test('pages cannot reach blocked addresses through the browser', async () => {
    const result = await renderPage(audit!, 'http://169.254.169.254/latest/meta-data/', { mode: 'user', userAgent, timeoutMs: 15_000 });
    assert.ok(result.error !== undefined || result.status !== 200);
    assert.ok(audit!.proxy.refused.some(decision => decision.host === '169.254.169.254'));
  });
});
