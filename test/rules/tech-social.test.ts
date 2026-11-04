import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Finding } from '../../src/rules/engine.ts';
import { socialOgImage, socialOgImageMeta, socialOgRequired, socialOgUrlCanonical } from '../../src/rules/tech/social.ts';
import { evaluate, outcomeOn, page, site } from '../support/facts.ts';

const url = 'https://example.com/services/audit';
const doc = (head = '', body = '<p>Body</p>') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title>${head}</head><body>${body}</body></html>`;
const og = (overrides: Record<string, string> = {}) => Object.entries({
  'og:title': 'Audit service', 'og:type': 'website', 'og:image': 'https://example.com/share.png', 'og:url': url, 'og:description': 'What the audit covers.', ...overrides,
}).map(([property, content]) => `<meta property="${property}" content="${content}">`).join('');

function excerpt(result: ReturnType<typeof evaluate>, finding: Finding, index = 0): string | undefined {
  return result.evidence.get(finding.evidence[index]!)?.excerpt;
}

function png(width: number, height: number, size = 33): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const image = (body: Buffer, status = 200, imageUrl = 'https://example.com/share.png') => ({ url: imageUrl, purpose: 'og-image' as const, referencedBy: url, body, status, headers: { 'content-type': 'image/png' } });

describe('tech-social-og-required', () => {
  test('passes complete Open Graph tags in the raw HTML', () => {
    const result = evaluate(socialOgRequired, site({ pages: [page(url, { html: doc(og()) })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.equal(finding.outcome, 'pass');
    assert.match(excerpt(result, finding)!, /og:title=Audit service/u);
  });

  test('fails low on a missing tag and reports tags added only by JavaScript', () => {
    const partial = og().replace('<meta property="og:description" content="What the audit covers.">', '');
    const result = evaluate(socialOgRequired, site({ pages: [page(url, { html: doc(partial), rendered: doc(og()) })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'low', 'rendered-only']);
    assert.equal(excerpt(result, finding), '<meta property="og:description" content="What the audit covers.">');
    const missing = outcomeOn(evaluate(socialOgRequired, site({ pages: [page(url, { html: doc(partial) })] })).findings, url)!;
    assert.deepEqual([missing.reason, missing.params?.tags], ['missing', 'og:description']);
  });

  test('accepts Facebook object types and name= attributes', () => {
    const html = doc(og({ 'og:type': 'product' }).replace('property="og:title"', 'name="og:title"'));
    assert.equal(outcomeOn(evaluate(socialOgRequired, site({ pages: [page(url, { html })] })).findings, url)?.outcome, 'pass');
  });

  test('is not applicable to legal pages', () => {
    const legal = 'https://example.com/legal/privacy';
    const finding = outcomeOn(evaluate(socialOgRequired, site({ pages: [page(legal, { html: doc('<meta name="robots" content="noindex,follow">') })] })).findings, legal)!;
    assert.deepEqual([finding.outcome, finding.reason], ['not_applicable', 'page-type:legal']);
  });
});

describe('tech-social-og-image', () => {
  test('passes a 1200x630 PNG', () => {
    const result = evaluate(socialOgImage, site({ pages: [page(url, { html: doc(og()) })], resources: [image(png(1200, 630))] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.equal(finding.outcome, 'pass');
    assert.match(excerpt(result, finding)!, /^200 image\/png png 1200x630/u);
  });

  test('passes when several pages share one image', () => {
    const other = 'https://example.com/about';
    const facts = site({ pages: [page(url, { html: doc(og()) }), page(other, { html: doc(og({ 'og:url': other })) })], resources: [image(png(1200, 630))] });
    assert.ok(evaluate(socialOgImage, facts).findings.every(finding => finding.outcome === 'pass'));
  });

  test('fails low on a broken or tiny image and reports a small one as info', () => {
    const broken = outcomeOn(evaluate(socialOgImage, site({ pages: [page(url, { html: doc(og()) })], resources: [image(Buffer.from('nope'), 404)] })).findings, url)!;
    assert.deepEqual([broken.outcome, broken.severity, broken.reason], ['fail', 'low', 'not-200']);
    assert.equal(outcomeOn(evaluate(socialOgImage, site({ pages: [page(url, { html: doc(og()) })], resources: [image(png(100, 100))] })).findings, url)?.reason, 'too-small');
    const small = outcomeOn(evaluate(socialOgImage, site({ pages: [page(url, { html: doc(og()) })], resources: [image(png(800, 420))] })).findings, url)!;
    assert.deepEqual([small.severity, small.reason], ['info', 'below-recommended']);
  });

  test('is not applicable without og:image and not evaluated when the image was not fetched', () => {
    const noImage = doc(og().replace('<meta property="og:image" content="https://example.com/share.png">', ''));
    assert.equal(outcomeOn(evaluate(socialOgImage, site({ pages: [page(url, { html: noImage })], resources: [image(png(1, 1), 200, 'https://example.com/other.png')] })).findings, url)?.reason, 'no-og-image');
    assert.equal(outcomeOn(evaluate(socialOgImage, site({ pages: [page(url, { html: doc(og()) })], resources: [image(png(1, 1), 200, 'https://example.com/other.png')] })).findings, url)?.reason, 'og-image-not-fetched');
  });
});

describe('tech-social-og-image-meta', () => {
  const meta = '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Audit report cover">';

  test('passes declared alt and matching dimensions', () => {
    const result = evaluate(socialOgImageMeta, site({ pages: [page(url, { html: doc(og() + meta) })], resources: [image(png(1200, 630))] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), '<meta property="og:image:width" content="1200">');
  });

  test('fails low on dimensions that differ from the file, and info on missing properties', () => {
    const mismatch = outcomeOn(evaluate(socialOgImageMeta, site({ pages: [page(url, { html: doc(og() + meta) })], resources: [image(png(600, 315))] })).findings, url)!;
    assert.deepEqual([mismatch.outcome, mismatch.severity, mismatch.reason, mismatch.params?.actual], ['fail', 'low', 'dimension-mismatch', '600x315']);
    const missing = outcomeOn(evaluate(socialOgImageMeta, site({ pages: [page(url, { html: doc(og()) })] })).findings, url)!;
    assert.deepEqual([missing.severity, missing.reason], ['info', 'missing']);
  });

  test('is not applicable without og:image', () => {
    assert.equal(outcomeOn(evaluate(socialOgImageMeta, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'no-og-image');
  });
});

describe('tech-social-og-url-canonical', () => {
  test('passes when og:url equals the canonical after normalization', () => {
    const html = doc(og({ 'og:url': 'HTTPS://EXAMPLE.COM:443/services/audit' }) + `<link rel="canonical" href="${url}">`);
    assert.equal(outcomeOn(evaluate(socialOgUrlCanonical, site({ pages: [page(url, { html })] })).findings, url)?.outcome, 'pass');
  });

  test('fails low on a templated og:url pointing at the home page', () => {
    const result = evaluate(socialOgUrlCanonical, site({ pages: [page(url, { html: doc(og({ 'og:url': 'https://example.com/' })) })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.ogUrl], ['fail', 'low', 'https://example.com/']);
    assert.equal(excerpt(result, finding), '<meta property="og:url" content="https://example.com/">');
  });

  test('passes a locale home whose og:url names the root that redirects by locale', () => {
    const es = 'https://example.com/es/';
    const hreflang = '<link rel="alternate" hreflang="es" href="https://example.com/es/"><link rel="alternate" hreflang="en" href="https://example.com/en/">';
    const facts = site({
      pages: [page(es, { html: doc(og({ 'og:url': 'https://example.com/' }) + hreflang) })],
      localeProbes: [{ label: 'accept-language:es', url: 'https://example.com/', redirects: [[302, '/es/']] }],
    });
    assert.equal(outcomeOn(evaluate(socialOgUrlCanonical, facts).findings, es)?.outcome, 'pass');
  });

  test('is not applicable without og:url', () => {
    assert.equal(outcomeOn(evaluate(socialOgUrlCanonical, site({ pages: [page(url, { html: doc() })] })).findings, url)?.reason, 'no-og-url');
  });
});
