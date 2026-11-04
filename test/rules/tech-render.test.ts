import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TextBlock } from '../../src/render/chrome.ts';
import type { LighthouseAudit, LighthouseOutcome } from '../../src/render/lighthouse.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { cmpBlocksContent, consentModeOrdering } from '../../src/rules/tech/consent.ts';
import { chromeBestPracticesTrust, lighthouseA11yOverlap, lighthouseSeoCategory } from '../../src/rules/tech/lighthouse.ts';
import { maintenance503 } from '../../src/rules/tech/maintenance.ts';
import { consoleErrors, failedRenderRequests } from '../../src/rules/tech/render.ts';
import { contentFitsViewport, legibleFontSize, tapTargetSize, viewportMeta, viewportZoomAllowed } from '../../src/rules/tech/viewport.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';

const url = 'https://example.com/a';
const doc = (body = '<p>Body</p>', head = '<meta name="viewport" content="width=device-width, initial-scale=1">') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title>${head}</head><body>${body}</body></html>`;
const words = (count: number, prefix = 'word') => Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');

function only(findings: readonly Finding[]): Finding {
  assert.equal(findings.length, 1, JSON.stringify(findings));
  return findings[0]!;
}

function excerpt(result: ReturnType<typeof evaluate>, finding: Finding, index = 0): string | undefined {
  return result.evidence.get(finding.evidence[index]!)?.excerpt;
}

function lighthouse(categories: Record<string, number | null>, audits: Record<string, Partial<LighthouseAudit>>): LighthouseOutcome {
  const full = Object.fromEntries(Object.entries(audits).map(([id, audit]) => [id, { title: id, score: 1, scoreDisplayMode: 'binary', ...audit }]));
  return {
    ok: true,
    summary: {
      lighthouseVersion: '13.6.0', fetchTime: '2026-11-04T00:00:00.000Z', finalUrl: url, runs: 1, validRuns: 1, runWarnings: [], categories, audits: full,
      settings: { formFactor: 'mobile', throttlingMethod: 'simulate', throttling: {}, screenEmulation: {} }, benchmarkIndex: undefined, lcpRangeMs: undefined,
    },
  };
}

const block = (text: string, fontSize: number, extra: Partial<TextBlock> = {}): TextBlock => ({ selector: 'main > p', text, fontSize, top: 100, inMain: true, ...extra });

describe('tech-viewport-meta', () => {
  test('passes width=device-width with or without initial-scale', () => {
    const result = evaluate(viewportMeta, site({ pages: [page(url, { html: doc() })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '<meta name="viewport" content="width=device-width, initial-scale=1">');
    assert.equal(outcomeOn(evaluate(viewportMeta, site({ pages: [page(url, { html: doc('<p>x</p>', '<meta name="viewport" content="width=device-width">') })] })).findings, url)?.outcome, 'pass');
    assert.equal(outcomeOn(evaluate(viewportMeta, site({ pages: [page(url, { html: doc('<p>x</p>', '<meta name="viewport" content="initial-scale=1">') })] })).findings, url)?.outcome, 'pass');
  });

  test('fails high without a viewport or with a fixed width', () => {
    const missing = evaluate(viewportMeta, site({ pages: [page(url, { html: doc('<p>x</p>', '') })] }));
    const finding = outcomeOn(missing.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'high', 'missing']);
    assert.equal(excerpt(missing, finding), '<meta name="viewport"> (absent)');
    assert.equal(outcomeOn(evaluate(viewportMeta, site({ pages: [page(url, { html: doc('<p>x</p>', '<meta name="viewport" content="width=1024">') })] })).findings, url)?.reason, 'fixed-width');
  });

  test('is not evaluated without HTML', () => {
    assert.equal(outcomeOn(evaluate(viewportMeta, site({ pages: [page(url)] })).findings, url)?.reason, 'missing-input:raw-html');
  });
});

describe('tech-viewport-zoom-allowed', () => {
  const zoom = (content: string) => outcomeOn(evaluate(viewportZoomAllowed, site({ pages: [page(url, { html: doc('<p>x</p>', `<meta name="viewport" content="${content}">`) })] })).findings, url)!;

  test('passes a viewport that allows zoom', () => {
    assert.equal(zoom('width=device-width, initial-scale=1').outcome, 'pass');
  });

  test('fails low when zoom is disabled and reports a limit below 5 as info', () => {
    const disabled = evaluate(viewportZoomAllowed, site({ pages: [page(url, { html: doc('<p>x</p>', '<meta name="viewport" content="width=device-width, user-scalable=no">') })] }));
    const finding = outcomeOn(disabled.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'low', 'user-scalable-no']);
    assert.equal(excerpt(disabled, finding), '<meta name="viewport" content="width=device-width, user-scalable=no">');
    assert.equal(zoom('width=device-width, maximum-scale=1').reason, 'maximum-scale');
    assert.deepEqual([zoom('width=device-width, maximum-scale=3').severity, zoom('width=device-width, maximum-scale=3').reason], ['info', 'maximum-scale-below-5']);
  });

  test('is not applicable without a viewport', () => {
    assert.equal(zoom('').outcome, 'pass');
    assert.equal(outcomeOn(evaluate(viewportZoomAllowed, site({ pages: [page(url, { html: doc('<p>x</p>', '') })] })).findings, url)?.reason, 'no-viewport');
  });
});

describe('tech-content-fits-viewport', () => {
  test('passes when the document is as wide as the viewport', () => {
    assert.equal(outcomeOn(evaluate(contentFitsViewport, site({ pages: [page(url, { html: doc(), userRender: { html: doc() } })] })).findings, url)?.outcome, 'pass');
  });

  test('fails low on horizontal overflow', () => {
    const result = evaluate(contentFitsViewport, site({ pages: [page(url, { html: doc(), userRender: { html: doc(), scrollWidth: 520, innerWidth: 412 } })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.overflow], ['fail', 'low', 108]);
    assert.equal(excerpt(result, finding), 'scrollWidth=520 innerWidth=412');
  });

  test('is not evaluated without the phone render', () => {
    assert.equal(outcomeOn(evaluate(contentFitsViewport, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'missing-input:user-render');
  });
});

describe('tech-legible-font-size', () => {
  const body = 'Readable paragraph text that is long enough to count toward the share of legible text on the page. '.repeat(3);

  test('passes when most text is 12px or larger, ignoring hidden reveal sections', () => {
    const blocks = [block(body, 16), block('Legal footnote', 10), block(body, 9, { hidden: 'opacity-zero' })];
    assert.equal(outcomeOn(evaluate(legibleFontSize, site({ pages: [page(url, { html: doc(), userRender: { html: doc(), textBlocks: blocks } })] })).findings, url)?.outcome, 'pass');
  });

  test('fails low when most visible text is small', () => {
    const result = evaluate(legibleFontSize, site({ pages: [page(url, { html: doc(), userRender: { html: doc(), textBlocks: [block(body, 10), block('Heading', 20)] } })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity], ['fail', 'low']);
    assert.match(excerpt(result, finding)!, /^\d+% of \d+ characters$/u);
  });

  test('is not applicable without a mobile viewport or with little text', () => {
    assert.equal(outcomeOn(evaluate(legibleFontSize, site({ pages: [page(url, { html: doc('<p>x</p>', ''), userRender: { html: doc(), textBlocks: [block(body, 8)] } })] })).findings, url)?.reason, 'viewport-not-mobile-optimized');
    assert.equal(outcomeOn(evaluate(legibleFontSize, site({ pages: [page(url, { html: doc(), userRender: { html: doc(), textBlocks: [block('Short', 8)] } })] })).findings, url)?.reason, 'too-little-text');
  });
});

describe('tech-tap-target-size', () => {
  test('passes when Lighthouse target-size passes', () => {
    assert.equal(outcomeOn(evaluate(tapTargetSize, site({ pages: [page(url, { html: doc(), lighthouse: lighthouse({ accessibility: 1 }, { 'target-size': {} }) })] })).findings, url)?.outcome, 'pass');
  });

  test('fails low with the offending nodes', () => {
    const audit = { score: 0, details: { items: [{ node: { snippet: '<a href="/x" class="icon">', selector: 'nav > a.icon' } }] } };
    const result = evaluate(tapTargetSize, site({ pages: [page(url, { html: doc(), lighthouse: lighthouse({ accessibility: 0.9 }, { 'target-size': audit }) })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.count], ['fail', 'low', 1]);
    assert.equal(excerpt(result, finding), '<a href="/x" class="icon">');
  });

  test('is not applicable when no targets were audited, and not evaluated without Lighthouse', () => {
    assert.equal(outcomeOn(evaluate(tapTargetSize, site({ pages: [page(url, { html: doc(), lighthouse: lighthouse({}, { 'target-size': { score: null, scoreDisplayMode: 'notApplicable' } }) })] })).findings, url)?.outcome, 'not_applicable');
    assert.equal(outcomeOn(evaluate(tapTargetSize, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'missing-input:lighthouse');
  });
});

describe('Lighthouse category context rules', () => {
  test('pass when no mapped audit fails', () => {
    const outcome = lighthouse({ seo: 1, accessibility: 1, 'best-practices': 1 }, { 'document-title': {}, 'image-alt': {} });
    const facts = site({ pages: [page(url, { html: doc(), lighthouse: outcome })] });
    for (const rule of [lighthouseSeoCategory, lighthouseA11yOverlap, chromeBestPracticesTrust]) assert.equal(outcomeOn(evaluate(rule, facts).findings, url)?.outcome, 'pass');
  });

  test('report failing audits as info only', () => {
    const outcome = lighthouse({ seo: 0.83, accessibility: 0.7, 'best-practices': 0.9 }, { 'meta-description': { score: 0 }, 'color-contrast': { score: 0 }, 'image-alt': { score: 0 }, 'is-on-https': { score: 0 } });
    const facts = site({ pages: [page(url, { html: doc(), lighthouse: outcome })] });
    const seo = evaluate(lighthouseSeoCategory, facts);
    const finding = outcomeOn(seo.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.audits, finding.params?.score], ['fail', 'info', 'meta-description, image-alt', 83]);
    assert.equal(excerpt(seo, finding), 'seo=83');
    const a11y = outcomeOn(evaluate(lighthouseA11yOverlap, facts).findings, url)!;
    assert.deepEqual([a11y.params?.searchAudits, a11y.params?.otherAudits], ['image-alt', 'color-contrast']);
    assert.equal(outcomeOn(evaluate(chromeBestPracticesTrust, facts).findings, url)?.params?.audits, 'is-on-https');
  });

  test('are not evaluated without a category score or without Lighthouse', () => {
    const facts = site({ pages: [page(url, { html: doc(), lighthouse: lighthouse({ seo: null }, {}) })] });
    assert.equal(outcomeOn(evaluate(lighthouseSeoCategory, facts).findings, url)?.reason, 'no-seo-category');
    assert.equal(outcomeOn(evaluate(lighthouseA11yOverlap, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'missing-input:lighthouse');
  });
});

describe('tech-cmp-blocks-content', () => {
  const banner = '<div id="onetrust-banner-sdk"><p>We use cookies</p><button>Accept</button></div>';

  test('passes a banner that overlays content present in the DOM', () => {
    const html = doc(`<main><p>${words(200)}</p></main>`);
    const result = evaluate(cmpBlocksContent, site({ pages: [page(url, { html, rendered: doc(`<main><p>${words(200)}</p></main>${banner}`) })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '<div id="onetrust-banner-sdk">');
  });

  test('fails high when the pre-consent render withholds the served content', () => {
    const result = evaluate(cmpBlocksContent, site({ pages: [page(url, { html: doc(`<main><p>${words(200)}</p></main>`), rendered: doc(`<div class="cookie-wall">${words(10)}</div>${banner}`) })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'high', 'content-withheld']);
    assert.equal(excerpt(result, finding, 1), 'raw=200 rendered=14');
  });

  test('fails high on a redirect to a consent wall', () => {
    const facts = site({ pages: [page(url, { html: doc(), redirects: [[302, 'https://consent.example.net/?continue=https%3A%2F%2Fexample.com%2Fa']], rendered: doc() })] });
    const result = evaluate(cmpBlocksContent, facts);
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.severity, finding.reason], ['high', 'consent-redirect']);
    assert.match(excerpt(result, finding)!, /^302 https:\/\/example\.com\/a -> https:\/\/consent\.example\.net\//u);
  });

  test('passes a locale redirect at the root, which is not a consent redirect', () => {
    const facts = site({ pages: [page('https://example.com/', { html: doc(), redirects: [[302, '/es/']], rendered: doc() })] });
    assert.equal(outcomeOn(evaluate(cmpBlocksContent, facts).findings, 'https://example.com/')?.outcome, 'pass');
  });

  test('is not evaluated without a render', () => {
    assert.equal(outcomeOn(evaluate(cmpBlocksContent, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'missing-input:rendered-dom');
  });
});

describe('tech-consent-mode-ordering', () => {
  const gtag = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script><script>gtag(\'config\', \'G-X\');</script>';
  const defaults = '<script>gtag(\'consent\', \'default\', { ad_storage: \'denied\' });</script>';

  test('passes when consent defaults run before the Google tag', () => {
    const result = evaluate(consentModeOrdering, site({ pages: [page(url, { html: doc('<p>x</p>', defaults + gtag) })] }));
    const finding = only(result.findings);
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '<script src="https://www.googletagmanager.com/gtag/js?id=G-X">');
  });

  test('reports defaults after the tag as info', () => {
    const result = evaluate(consentModeOrdering, site({ pages: [page(url, { html: doc('<p>x</p>', gtag + defaults) })] }));
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'info', 'default-after-tags']);
  });

  test('is not applicable when analytics is injected only after consent', () => {
    const finding = only(evaluate(consentModeOrdering, site({ pages: [page(url, { html: doc('<p>x</p>', '<script src="/cmp.js"></script>'), rendered: doc('<p>x</p>', gtag) })] })).findings);
    assert.deepEqual([finding.outcome, finding.reason], ['not_applicable', 'no-google-tags']);
  });
});

describe('tech-console-errors', () => {
  test('passes without script errors, ignoring resource and blocked third-party errors', () => {
    const rendered = {
      html: doc(`<p>${words(150)}</p>`),
      console: [
        { type: 'error' as const, text: 'Failed to load resource: the server responded with a status of 404 ()' },
        { type: 'pageerror' as const, text: 'ReferenceError: gtag is not defined at https://www.googletagmanager.com/gtm.js?id=GTM-X:1:2' },
      ],
    };
    assert.equal(outcomeOn(evaluate(consoleErrors, site({ pages: [page(url, { html: doc(`<p>${words(150)}</p>`), rendered })] })).findings, url)?.outcome, 'pass');
  });

  test('fails low on an error with an intact render and medium when content is lost', () => {
    const error = { type: 'pageerror' as const, text: 'TypeError: Cannot read properties of undefined (reading \'map\')' };
    const intact = evaluate(consoleErrors, site({ pages: [page(url, { html: doc(`<p>${words(150)}</p>`), rendered: { html: doc(`<p>${words(150)}</p>`), console: [error] } })] }));
    const finding = outcomeOn(intact.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'low', undefined]);
    assert.equal(excerpt(intact, finding), error.text);
    const lost = outcomeOn(evaluate(consoleErrors, site({ pages: [page(url, { html: doc(`<p>${words(150)}</p>`), rendered: { html: doc('<div id="root"></div>'), console: [error] } })] })).findings, url)!;
    assert.deepEqual([lost.severity, lost.reason], ['medium', 'content-missing']);
  });

  test('is not evaluated without a render', () => {
    assert.equal(outcomeOn(evaluate(consoleErrors, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'missing-input:rendered-dom');
  });
});

describe('tech-failed-render-requests', () => {
  test('passes when only analytics or aborted requests failed', () => {
    const rendered = { html: doc(), failed: [
      { url: 'https://www.google-analytics.com/g/collect?v=2', error: 'net::ERR_FAILED' },
      { url: 'https://example.com/video.mp4', error: 'net::ERR_ABORTED' },
    ] };
    assert.equal(outcomeOn(evaluate(failedRenderRequests, site({ pages: [page(url, { html: doc(), rendered })] })).findings, url)?.outcome, 'pass');
  });

  test('fails high on a failed first-party stylesheet', () => {
    const html = doc('<p>x</p>', '<link rel="stylesheet" href="/assets/site.css">');
    const result = evaluate(failedRenderRequests, site({ pages: [page(url, { html, rendered: { html, failed: [{ url: 'https://example.com/assets/site.css', error: 'net::ERR_CONNECTION_RESET' }] } })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity], ['fail', 'high']);
    assert.equal(excerpt(result, finding), 'https://example.com/assets/site.css (net::ERR_CONNECTION_RESET)');
  });

  test('reports a 404 font from the Lighthouse log as low', () => {
    const outcome = lighthouse({}, { 'network-requests': { details: { items: [{ url: 'https://example.com/fonts/a.woff2', statusCode: 404, resourceType: 'Font' }] } } });
    const finding = outcomeOn(evaluate(failedRenderRequests, site({ pages: [page(url, { html: doc(), rendered: doc(), lighthouse: outcome })] })).findings, url)!;
    assert.deepEqual([finding.severity, finding.reason], ['low', 'non-critical']);
  });

  test('passes a first-party API that answers 401 to an anonymous visitor', () => {
    const outcome = lighthouse({}, { 'network-requests': { details: { items: [{ url: 'https://example.com/api/me', statusCode: 401, resourceType: 'Fetch' }] } } });
    assert.equal(outcomeOn(evaluate(failedRenderRequests, site({ pages: [page(url, { html: doc(), rendered: doc(), lighthouse: outcome })] })).findings, url)?.outcome, 'pass');
  });

  test('is not evaluated without a render', () => {
    assert.equal(outcomeOn(evaluate(failedRenderRequests, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'missing-input:rendered-dom');
  });
});

describe('tech-maintenance-503', () => {
  test('passes a 503 with Retry-After and an ordinary page about maintenance services', () => {
    const outage = page('https://example.com/', { html: doc('<h1>Down for maintenance</h1>'), status: 503, headers: { 'retry-after': '3600' } });
    const article = page(url, { html: doc(`<h1>Scheduled maintenance plans</h1><p>${words(400)}</p>`) });
    const result = evaluate(maintenance503, site({ pages: [outage, article] }));
    const finding = only(result.findings);
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '503; Retry-After: 3600');
  });

  test('fails low on a 503 without Retry-After', () => {
    const result = evaluate(maintenance503, site({ pages: [page(url, { html: doc(), status: 503 })] }));
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'low', 'missing-retry-after']);
    assert.equal(excerpt(result, finding), '503; Retry-After: (absent)');
  });

  test('hands a short maintenance page served with 200 to the analyst', () => {
    const finding = only(evaluate(maintenance503, site({ pages: [page(url, { html: '<!doctype html><title>Under maintenance</title><h1>We\'ll be back soon</h1>' })] })).findings);
    assert.deepEqual([finding.severity, finding.reason, finding.needsJudgment], ['medium', 'maintenance-page-200', true]);
  });

  test('is not evaluated without any response', () => {
    assert.equal(only(evaluate(maintenance503, site({ pages: [] })).findings).reason, 'missing-input:http');
  });
});
