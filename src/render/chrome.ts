import { randomBytes } from 'node:crypto';
import type { lookup as dnsLookup } from 'node:dns';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Launcher } from 'chrome-launcher';
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core';
import type { NetworkPolicy } from '../fetch/ip-guard.ts';
import { spkiHashes } from '../fetch/tls.ts';
import { startGuardedProxy, type GuardedProxy } from './proxy.ts';

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

/** Googlebot Smartphone renders at this width, emulating a current mid-range Android phone. */
export const mobileViewport: Viewport = { width: 412, height: 823, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true };
export const desktopViewport: Viewport = { width: 1350, height: 940, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
/** Cap for the tall-viewport render; content below it is treated as not rendered. */
export const maxRenderHeight = 16_384;

export type RenderMode = 'googlebot' | 'user' | 'unblocked';

export interface TextBlock {
  readonly selector: string;
  readonly text: string;
  /** Why the text is not visible, or undefined when it is. */
  readonly hidden?: 'display-none' | 'visibility-hidden' | 'opacity-zero' | 'zero-size' | 'offscreen' | 'visually-hidden' | 'tiny-font' | 'same-color';
  /**
   * Set on a block hidden by opacity or visibility whose element or an ancestor waits for scrolling to appear: it is
   * watched by an IntersectionObserver or carries a scroll-reveal attribute or class. Such a block is usually an
   * entrance animation that has not run, not text hidden from readers.
   */
  readonly revealOnScroll?: true;
  /**
   * Set on an off-screen block inside a container the reader scrolls sideways (overflow-x auto or scroll, wider than
   * its box) or inside a marked carousel: the text is one swipe or slide control away, not hidden.
   */
  readonly inScroller?: true;
  readonly fontSize: number;
  readonly top: number;
  readonly inMain: boolean;
}

/** A fixed or sticky element over the first screen of the user render, measured right after load. */
export interface Overlay {
  readonly selector: string;
  readonly position: 'fixed' | 'sticky';
  /** Bounding box in CSS pixels, relative to the viewport. */
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The computed z-index; absent for auto. */
  readonly zIndex?: number;
  /** Share of the viewport the element covers, from 0 to 1. */
  readonly coverage: number;
  /** Its visible text, shortened, so rules can tell a consent banner from a promotion. */
  readonly text: string;
  /** An open dialog element, role dialog or alertdialog, or aria-modal="true". */
  readonly dialog: boolean;
}

export interface RenderResult {
  readonly mode: RenderMode;
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number | undefined;
  readonly html: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly documentHeight: number;
  readonly scrollWidth: number;
  readonly innerWidth: number;
  readonly console: readonly { readonly type: 'error' | 'pageerror'; readonly text: string }[];
  readonly failed: readonly { readonly url: string; readonly error: string }[];
  readonly blockedByRobots: readonly string[];
  /** Measured only in the user render: Chrome does not score shifts while the viewport is resized. */
  readonly layoutShifts: readonly { readonly value: number; readonly time: number; readonly sources: readonly string[] }[];
  readonly lcp: { readonly time: number; readonly size: number; readonly selector?: string; readonly url?: string; readonly tag?: string } | undefined;
  readonly textBlocks: readonly TextBlock[];
  /** Fixed and sticky elements over the first screen right after load, before scrolling; user render only. */
  readonly overlays?: readonly Overlay[];
  /** Whether html or body stopped the page from scrolling right after load (overflow hidden or clip); user render only. */
  readonly scrollLocked?: boolean;
  readonly durationMs: number;
  readonly error?: { readonly code: 'timeout' | 'navigation'; readonly message: string };
}

export function findChrome(): string | undefined {
  return process.env.CHROME_PATH || Launcher.getFirstInstallation();
}

export interface AuditBrowser {
  readonly browser: Browser;
  readonly proxy: GuardedProxy;
  readonly version: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  readonly policy: NetworkPolicy;
  readonly executablePath?: string;
  readonly lookup?: typeof dnsLookup;
  /**
   * Extra CA certificates (PEM). Chrome takes no CA by flag, so it accepts any chain the server sends that includes
   * one of these certificates; a server that sends only its leaf is still refused.
   */
  readonly ca?: string;
}

/** Launches Chrome over a pipe (no debugging port), with all traffic through the guarded proxy. */
export async function launchAuditBrowser(options: LaunchOptions): Promise<AuditBrowser> {
  const executablePath = options.executablePath ?? findChrome();
  if (!executablePath) throw new Error('Chrome or Chromium was not found. Install it or set CHROME_PATH.');
  const trusted = options.ca === undefined ? [] : spkiHashes(options.ca);
  if (options.ca !== undefined && trusted.length === 0) throw new Error('The extra CA holds no PEM certificate.');
  const proxy = await startGuardedProxy(options.policy, options.lookup);
  const userDataDir = await mkdtemp(join(tmpdir(), 'altimeter-chrome-'));
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      pipe: true,
      userDataDir,
      args: [
        `--proxy-server=${proxy.url}`,
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        '--hide-scrollbars',
        '--lang=en-US',
        // Honoured only with --user-data-dir, which the userDataDir option adds.
        ...(trusted.length > 0 ? [`--ignore-certificate-errors-spki-list=${trusted.join(',')}`] : []),
      ],
    });
  } catch (error) {
    await proxy.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  await session.detach();
  return {
    browser,
    proxy,
    version: await browser.version(),
    close: async () => {
      await browser.close().catch(() => {});
      await proxy.close();
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

function observerScript(key: string): string {
  return `(() => {
  const store = { shifts: [], lcp: null, observed: new WeakSet() };
  Object.defineProperty(window, ${JSON.stringify(key)}, { value: store, configurable: false, enumerable: false, writable: false });
  try {
    // Remember what the page watches for intersection, which is how most scroll-reveal effects start.
    const observe = IntersectionObserver.prototype.observe;
    IntersectionObserver.prototype.observe = function (target) {
      if (target && target.nodeType === 1) store.observed.add(target);
      return observe.apply(this, arguments);
    };
  } catch {}
  const describe = (node) => {
    const parts = [];
    for (let el = node; el && el.nodeType === 1 && parts.length < 4; el = el.parentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + '#' + el.id); break; }
      const classes = [...el.classList].slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        store.shifts.push({ value: entry.value, time: entry.startTime,
          sources: (entry.sources || []).map((source) => source.node ? describe(source.node) : '').filter(Boolean).slice(0, 5) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const entry = entries[entries.length - 1];
      if (entry) store.lcp = { time: entry.renderTime || entry.loadTime || entry.startTime, size: entry.size,
        selector: entry.element ? describe(entry.element) : undefined, url: entry.url || undefined,
        tag: entry.element ? entry.element.tagName.toLowerCase() : undefined };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
})();`;
}

/** Runs in the page: every element that directly holds text, with the reason it is not visible. */
function collectTextBlocks(limit: number, storeKey: string): TextBlock[] {
  const observed = (window as unknown as Record<string, { observed?: WeakSet<Element> } | undefined>)[storeKey]?.observed;
  const revealMarker = '[data-reveal], [data-aos], [data-sal], [data-scroll], [data-scroll-reveal], [data-animate], .wow, .reveal';
  const revealsOnScroll = (el: Element) => {
    for (let current: Element | null = el; current; current = current.parentElement) {
      if (observed?.has(current) || current.matches(revealMarker)) return true;
    }
    return false;
  };
  const carouselMarker = '[aria-roledescription*="carousel" i], [aria-roledescription*="slide" i], .swiper, .splide, .glide, .slick-slider, .flickity-enabled, .embla, .carousel';
  const inScroller = (el: Element) => {
    for (let current = el.parentElement; current && current !== document.body; current = current.parentElement) {
      const overflow = getComputedStyle(current).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && current.scrollWidth > current.clientWidth + 1) return true;
      if (current.matches(carouselMarker)) return true;
    }
    return false;
  };
  const describe = (node: Element) => {
    const parts: string[] = [];
    for (let el: Element | null = node; el && parts.length < 4; el = el.parentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(`${part}#${el.id}`); break; }
      const classes = [...el.classList].slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const transparent = (color: string) => color === 'transparent' || /rgba\([^)]*,\s*0\)$/u.test(color);
  const background = (el: Element | null): string => {
    for (let current = el; current; current = current.parentElement) {
      const color = getComputedStyle(current).backgroundColor;
      if (!transparent(color)) return color;
    }
    return 'rgb(255, 255, 255)';
  };
  const reason = (el: Element): TextBlock['hidden'] => {
    for (let current: Element | null = el; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none') return 'display-none';
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'visibility-hidden';
      if (Number(style.opacity) === 0) return 'opacity-zero';
    }
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const clipped = style.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(\s*(50|100)%/u.test(style.clipPath);
    if (clipped || (rect.width <= 1 && rect.height <= 1 && style.overflow === 'hidden')) return 'visually-hidden';
    if (rect.width === 0 || rect.height === 0) return 'zero-size';
    if (rect.right + scrollX < 0 || rect.bottom + scrollY < 0 || rect.left > document.documentElement.scrollWidth + 500) return 'offscreen';
    if (Number.parseFloat(style.fontSize) < 2) return 'tiny-font';
    if (style.color === background(el)) return 'same-color';
    return undefined;
  };
  const blocks: TextBlock[] = [];
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && blocks.length < limit) {
    const text = (walker.currentNode.textContent ?? '').replace(/\s+/gu, ' ').trim();
    const el = walker.currentNode.parentElement;
    if (text.length < 2 || !el || seen.has(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
    seen.add(el);
    const hidden = reason(el);
    blocks.push({
      selector: describe(el),
      text: text.slice(0, 300),
      ...(hidden ? { hidden } : {}),
      ...((hidden === 'opacity-zero' || hidden === 'visibility-hidden') && revealsOnScroll(el) ? { revealOnScroll: true as const } : {}),
      ...(hidden === 'offscreen' && inScroller(el) ? { inScroller: true as const } : {}),
      fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
      top: Math.round(el.getBoundingClientRect().top + scrollY),
      inMain: el.closest('main, [role="main"], article') !== null,
    });
  }
  return blocks;
}

/** Runs in the page: fixed and sticky elements that cover part of the viewport, and whether scrolling is locked. */
function collectOverlays(limit: number): { overlays: Overlay[]; scrollLocked: boolean } {
  const describe = (node: Element) => {
    const parts: string[] = [];
    for (let el: Element | null = node; el && parts.length < 4; el = el.parentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(`${part}#${el.id}`); break; }
      const classes = [...el.classList].slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const transparentAncestor = (el: Element) => {
    for (let current = el.parentElement; current; current = current.parentElement) if (Number(getComputedStyle(current).opacity) === 0) return true;
    return false;
  };
  const area = innerWidth * innerHeight;
  const outer: Element[] = [];
  const overlays: Overlay[] = [];
  const elements = document.querySelectorAll('body *');
  for (let index = 0; index < Math.min(elements.length, 20_000) && overlays.length < limit; index += 1) {
    const el = elements[index]!;
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    if (outer.some(parent => parent.contains(el))) continue;
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || transparentAncestor(el)) continue;
    const rect = el.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    if (width * height === 0) continue;
    outer.push(el);
    const zIndex = Number.parseInt(style.zIndex, 10);
    overlays.push({
      selector: describe(el),
      position: style.position,
      box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      ...(Number.isNaN(zIndex) ? {} : { zIndex }),
      coverage: area > 0 ? Math.round((width * height / area) * 1000) / 1000 : 0,
      text: ((el as HTMLElement).innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200),
      dialog: (el instanceof HTMLDialogElement && el.open) || ['dialog', 'alertdialog'].includes(el.getAttribute('role') ?? '') || el.getAttribute('aria-modal') === 'true',
    });
  }
  const locked = (el: Element | null) => el !== null && ['hidden', 'clip'].includes(getComputedStyle(el).overflowY);
  return { overlays, scrollLocked: locked(document.documentElement) || locked(document.body) };
}

async function settle(page: Page, idleMs = 500, timeoutMs = 5000): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: idleMs, timeout: timeoutMs }).catch(() => {});
  // Let CSS transitions and animations started by observers finish, so revealed content is measured revealed.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ])).catch(() => {});
}

export interface RenderOptions {
  readonly mode: RenderMode;
  readonly userAgent: string;
  readonly acceptLanguage?: string;
  readonly viewport?: Viewport;
  /** Decides whether Googlebot may fetch a subresource; used by the googlebot mode. */
  readonly robotsAllows?: (url: string) => Promise<boolean>;
  readonly timeoutMs?: number;
  readonly textBlockLimit?: number;
}

export async function renderPage(audit: AuditBrowser, url: string, options: RenderOptions): Promise<RenderResult> {
  const started = performance.now();
  const viewport = options.viewport ?? mobileViewport;
  const key = `__altimeter_${randomBytes(6).toString('hex')}`;
  const context = await audit.browser.createBrowserContext();
  const page = await context.newPage();
  const consoleMessages: Array<{ type: 'error' | 'pageerror'; text: string }> = [];
  const failed: Array<{ url: string; error: string }> = [];
  const blockedByRobots: string[] = [];
  let currentViewport: Viewport = { ...viewport };
  try {
    await page.setBypassServiceWorker(true);
    await page.setUserAgent(options.userAgent);
    await page.setExtraHTTPHeaders({ 'accept-language': options.acceptLanguage ?? 'en-US,en;q=0.9' });
    await page.emulateTimezone('UTC');
    await page.setViewport(currentViewport);
    await page.evaluateOnNewDocument(observerScript(key));
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    page.on('popup', popup => void popup?.close().catch(() => {}));
    page.on('console', message => {
      if (message.type() === 'error' && consoleMessages.length < 50) consoleMessages.push({ type: 'error', text: message.text().slice(0, 500) });
    });
    page.on('pageerror', error => {
      if (consoleMessages.length < 50) consoleMessages.push({ type: 'pageerror', text: String((error as Error).message ?? error).slice(0, 500) });
    });
    page.on('requestfailed', request => {
      const reason = request.failure()?.errorText ?? 'failed';
      if (reason.includes('ERR_BLOCKED_BY_CLIENT')) return;
      if (failed.length < 100) failed.push({ url: request.url(), error: reason });
    });
    if (options.mode === 'googlebot' && options.robotsAllows) {
      const allows = options.robotsAllows;
      await page.setRequestInterception(true);
      page.on('request', (request: HTTPRequest) => {
        const target = request.url();
        const isDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (isDocument || !/^https?:/u.test(target)) return void request.continue().catch(() => {});
        void allows(target).then(allowed => {
          if (allowed) return request.continue();
          blockedByRobots.push(target);
          return request.abort('blockedbyclient');
        }).catch(() => request.continue().catch(() => {}));
      });
    }

    const deadline = options.timeoutMs ?? 45_000;
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: deadline });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Navigation failed';
      return finish({ error: { code: /timeout/iu.test(message) ? 'timeout' : 'navigation', message } });
    }
    await settle(page);
    let atLoad: { overlays: Overlay[]; scrollLocked: boolean } | undefined;
    if (options.mode === 'user') {
      atLoad = await page.evaluate(collectOverlays, 50).catch(() => undefined);
      // Scroll like a person, one viewport at a time, so scroll-triggered content loads.
      for (let step = 0; step < 30; step += 1) {
        const atBottom = await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight);
          return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
        });
        await new Promise(resolve => setTimeout(resolve, 250));
        if (atBottom) break;
      }
      await settle(page);
    } else {
      // Googlebot renders with a tall viewport instead of scrolling; grow it until the layout stops growing.
      // Without a viewport meta tag the layout viewport is wider than the device, so convert to device pixels.
      for (let round = 0; round < 3; round += 1) {
        const layout = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, width: window.innerWidth }));
        const next = Math.min(Math.ceil(layout.height * (currentViewport.width / Math.max(layout.width, 1))), maxRenderHeight);
        if (next <= currentViewport.height) break;
        currentViewport = { ...currentViewport, height: next };
        await page.setViewport(currentViewport);
        await settle(page);
      }
    }
    const [html, metrics, textBlocks] = await Promise.all([
      page.content(),
      page.evaluate(storeKey => {
        const store = (window as unknown as Record<string, { shifts: unknown[]; lcp: unknown }>)[storeKey];
        return {
          documentHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          shifts: store?.shifts ?? [],
          lcp: store?.lcp ?? null,
        };
      }, key),
      page.evaluate(collectTextBlocks, options.textBlockLimit ?? 2000, key),
    ]);
    return finish({
      status: response?.status(),
      html,
      documentHeight: metrics.documentHeight,
      scrollWidth: metrics.scrollWidth,
      innerWidth: metrics.innerWidth,
      layoutShifts: options.mode === 'user' ? metrics.shifts as RenderResult['layoutShifts'] : [],
      lcp: (metrics.lcp ?? undefined) as RenderResult['lcp'],
      textBlocks,
      ...(atLoad ?? {}),
    });
  } finally {
    await context.close().catch(() => {});
  }

  function finish(extra: Partial<RenderResult>): RenderResult {
    return {
      mode: options.mode,
      url,
      finalUrl: page.url() || url,
      status: undefined,
      html: '',
      viewport: { width: currentViewport.width, height: currentViewport.height },
      documentHeight: 0,
      scrollWidth: 0,
      innerWidth: 0,
      console: consoleMessages,
      failed,
      blockedByRobots,
      layoutShifts: [],
      lcp: undefined,
      textBlocks: [],
      durationMs: performance.now() - started,
      ...extra,
    };
  }
}
