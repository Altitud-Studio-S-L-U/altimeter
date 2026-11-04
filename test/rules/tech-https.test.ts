import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SiteFacts } from '../../src/core/facts.ts';
import type { TlsFacts } from '../../src/fetch/tls.ts';
import type { Finding } from '../../src/rules/engine.ts';
import { framingProtection, securityHeadersInfo } from '../../src/rules/tech/headers.ts';
import { hstsHeader, hstsPreloadEligibility, httpToHttpsRedirect, httpsFinalUrl, httpsToHttpDowngrade, tlsCertificateValid } from '../../src/rules/tech/https.ts';
import { internalLinksToHttp, mixedContentActive, mixedContentPassive } from '../../src/rules/tech/mixed-content.ts';
import { evaluate, outcomeOn, page, response, site } from '../support/facts.ts';

const home = 'https://example.com/';
const doc = (body = '', head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title>${head}</head><body>${body}</body></html>`;

function only(findings: readonly Finding[]): Finding {
  assert.equal(findings.length, 1, JSON.stringify(findings));
  return findings[0]!;
}

function excerpt(result: ReturnType<typeof evaluate>, finding: Finding, index = 0): string | undefined {
  return result.evidence.get(finding.evidence[index]!)?.excerpt;
}

const validTls: TlsFacts = {
  host: 'example.com', port: 443, authorized: true, protocol: 'TLSv1.3', validFrom: '2026-09-01T00:00:00.000Z', validTo: '2026-11-30T00:00:00.000Z',
  daysRemaining: 26, subjectAltNames: ['example.com', 'www.example.com'], issuer: 'Example CA', chainLength: 3,
};

describe('tech-https-final-url', () => {
  test('passes when every audited page ends on https', () => {
    const result = evaluate(httpsFinalUrl, site({ pages: [page(home, { html: doc() })] }));
    const finding = only(result.findings);
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), home);
  });

  test('fails high when the page ends on http', () => {
    const facts = site({ pages: [page('https://example.com/a', { html: doc(), redirects: [[301, 'http://example.com/a']] })] });
    const result = evaluate(httpsFinalUrl, facts);
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'high', 'served-over-http']);
    assert.match(excerpt(result, finding)!, /301 https:\/\/example\.com\/a -> http:\/\/example\.com\/a/u);
  });

  test('is not applicable to a private host and not evaluated without a response', () => {
    assert.equal(only(evaluate(httpsFinalUrl, site({ pages: [page('http://localhost:3000/', { html: doc() })] })).findings).reason, 'private-host');
    const offline = site({ pages: [{ ...page(home), fetch: { ...response(home), status: undefined, hops: [] } }] });
    assert.equal(only(evaluate(httpsFinalUrl, offline).findings).outcome, 'not_evaluated');
  });
});

describe('tech-tls-certificate-valid', () => {
  const withTls = (tls: TlsFacts) => site({ pages: [page(home, { html: doc() })], tls });

  test('passes a valid certificate with time left', () => {
    const result = evaluate(tlsCertificateValid, withTls(validTls));
    const finding = only(result.findings);
    assert.equal(finding.outcome, 'pass');
    assert.match(excerpt(result, finding)!, /authorized=true/u);
  });

  test('fails critical on an expired certificate', () => {
    const result = evaluate(tlsCertificateValid, withTls({ ...validTls, authorized: false, error: 'CERT_HAS_EXPIRED' }));
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'critical', 'expired']);
    assert.match(excerpt(result, finding)!, /error=CERT_HAS_EXPIRED/u);
  });

  test('names an incomplete chain as such, below critical', () => {
    const finding = only(evaluate(tlsCertificateValid, withTls({ ...validTls, authorized: false, error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).findings);
    assert.deepEqual([finding.severity, finding.reason], ['high', 'incomplete-chain']);
  });

  test('warns when a long-lived certificate is close to expiry', () => {
    const finding = only(evaluate(tlsCertificateValid, withTls({ ...validTls, daysRemaining: 5 })).findings);
    assert.deepEqual([finding.severity, finding.reason, finding.params?.days], ['medium', 'expires-soon', 5]);
  });

  test('does not warn about a short-lived certificate renewing on schedule', () => {
    const shortLived = { ...validTls, validFrom: '2026-11-01T00:00:00.000Z', validTo: '2026-11-07T00:00:00.000Z', daysRemaining: 3 };
    assert.equal(only(evaluate(tlsCertificateValid, withTls(shortLived)).findings).outcome, 'pass');
  });

  test('is not evaluated when the connection failed or no certificate was collected', () => {
    const timeout: TlsFacts = { host: 'example.com', port: 443, authorized: false, error: 'TIMEOUT', subjectAltNames: [], chainLength: 0 };
    assert.deepEqual([only(evaluate(tlsCertificateValid, withTls(timeout)).findings).reason], ['tls-unreachable']);
    assert.equal(only(evaluate(tlsCertificateValid, site({ pages: [page(home, { html: doc() })] })).findings).reason, 'missing-input:tls');
  });
});

describe('tech-http-to-https-redirect', () => {
  const withVariant = (spec: Parameters<typeof site>[0]['variants']) => site({ pages: [page('https://example.com/a', { html: doc() })], variants: spec ?? [] });

  test('passes a permanent same-path upgrade, including a second hop to the canonical host', () => {
    assert.equal(only(evaluate(httpToHttpsRedirect, withVariant([{ label: 'http', url: 'http://example.com/a', redirects: [[301, 'https://example.com/a']] }])).findings).outcome, 'pass');
    const preloadStyle = withVariant([{ label: 'http', url: 'http://example.com/a', redirects: [[301, 'https://example.com/a'], [301, 'https://www.example.com/a']] }]);
    assert.equal(only(evaluate(httpToHttpsRedirect, preloadStyle).findings).outcome, 'pass');
  });

  test('fails high when HTTP answers 200', () => {
    const result = evaluate(httpToHttpsRedirect, withVariant([{ label: 'http', url: 'http://example.com/a', status: 200 }]));
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'high', 'served-over-http']);
    assert.equal(excerpt(result, finding), '200 http://example.com/a');
  });

  test('fails high when the path is dropped and low on a temporary upgrade', () => {
    const dropped = only(evaluate(httpToHttpsRedirect, withVariant([{ label: 'http', url: 'http://example.com/a', redirects: [[301, 'https://example.com/']] }])).findings);
    assert.deepEqual([dropped.severity, dropped.reason], ['high', 'path-dropped']);
    const temporary = only(evaluate(httpToHttpsRedirect, withVariant([{ label: 'http', url: 'http://example.com/a', redirects: [[302, 'https://example.com/a']] }])).findings);
    assert.deepEqual([temporary.severity, temporary.reason], ['low', 'temporary-redirect']);
  });

  test('is not applicable when port 80 is closed or the site is not on https', () => {
    const facts = withVariant([]);
    const closed: SiteFacts = { ...facts, variants: [{ label: 'http', url: 'http://example.com/a', fetch: { ...response('http://example.com/a'), status: undefined, hops: [], error: { code: 'connection', message: 'refused' } } }] };
    assert.deepEqual([only(evaluate(httpToHttpsRedirect, closed).findings).outcome, only(evaluate(httpToHttpsRedirect, closed).findings).reason], ['not_applicable', 'port-80-closed']);
    const plain = site({ pages: [page('http://example.com/a', { html: doc() })], variants: [{ label: 'www', url: 'http://www.example.com/a' }] });
    assert.equal(only(evaluate(httpToHttpsRedirect, plain).findings).reason, 'not-https-site');
  });
});

describe('tech-https-to-http-downgrade', () => {
  test('passes when no observed redirect goes to http', () => {
    const facts = site({ pages: [page(home, { html: doc() })], variants: [{ label: 'http', url: 'http://example.com/', redirects: [[301, home]] }] });
    assert.equal(only(evaluate(httpsToHttpDowngrade, facts).findings).outcome, 'pass');
  });

  test('fails high on an https-to-http hop even when it returns to https', () => {
    const facts = site({ pages: [page('https://example.com/a', { html: doc(), redirects: [[301, 'http://example.com/a/'], [301, 'https://example.com/a/']] })] });
    const result = evaluate(httpsToHttpDowngrade, facts);
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity], ['fail', 'high']);
    assert.equal(excerpt(result, finding), '301 https://example.com/a -> http://example.com/a/');
  });

  test('is not evaluated without any response', () => {
    assert.equal(only(evaluate(httpsToHttpDowngrade, site({ pages: [] })).findings).reason, 'missing-input:redirects');
  });
});

describe('tech-hsts-header and tech-hsts-preload-eligibility', () => {
  const hsts = (value?: string) => site({
    pages: [page(home, { html: doc(), headers: value === undefined ? {} : { 'strict-transport-security': value } })],
    variants: [{ label: 'http', url: 'http://example.com/', redirects: [[301, home]] }],
  });

  test('passes a strong policy and reports a weak or missing one as info', () => {
    assert.equal(only(evaluate(hstsHeader, hsts('max-age=31536000; includeSubDomains')).findings).outcome, 'pass');
    const weak = evaluate(hstsHeader, hsts('max-age=300'));
    const finding = only(weak.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.reason], ['fail', 'info', 'short-max-age']);
    assert.equal(excerpt(weak, finding), 'Strict-Transport-Security: max-age=300');
    assert.equal(only(evaluate(hstsHeader, hsts()).findings).reason, 'missing');
  });

  test('is not applicable on an http site', () => {
    assert.equal(only(evaluate(hstsHeader, site({ pages: [page('http://example.com/', { html: doc() })] })).findings).reason, 'not-https');
  });

  test('checks preload requirements only when preload is declared', () => {
    assert.equal(only(evaluate(hstsPreloadEligibility, hsts('max-age=31536000')).findings).reason, 'no-preload-directive');
    assert.equal(only(evaluate(hstsPreloadEligibility, hsts('max-age=31536000; includeSubDomains; preload')).findings).outcome, 'pass');
    const result = evaluate(hstsPreloadEligibility, hsts('max-age=86400; preload'));
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity], ['fail', 'info']);
    assert.match(String(finding.params?.unmet), /max-age of at least 31536000; includeSubDomains/u);
    assert.equal(excerpt(result, finding), 'Strict-Transport-Security: max-age=86400; preload');
  });
});

describe('tech-security-headers-info', () => {
  test('inventories present and absent headers without failing on absence', () => {
    const facts = site({ pages: [page(home, { html: doc(), headers: { 'x-content-type-options': 'nosniff' } })] });
    const result = evaluate(securityHeadersInfo, facts);
    const finding = only(result.findings);
    assert.equal(finding.outcome, 'pass');
    assert.equal(excerpt(result, finding), 'x-content-type-options: nosniff');
    assert.match(excerpt(result, finding, 1)!, /content-security-policy/u);
  });

  test('reports an unknown nosniff value as info', () => {
    const result = evaluate(securityHeadersInfo, site({ pages: [page(home, { html: doc(), headers: { 'x-content-type-options': 'yes' } })] }));
    const finding = only(result.findings);
    assert.deepEqual([finding.severity, finding.reason], ['info', 'invalid-nosniff']);
    assert.equal(excerpt(result, finding), 'x-content-type-options: yes');
  });

  test('never reports missing X-Robots-Tag, Content-Language or Link headers', () => {
    const result = evaluate(securityHeadersInfo, site({ pages: [page(home, { html: doc() })] }));
    const finding = only(result.findings);
    assert.equal(finding.outcome, 'pass');
    assert.doesNotMatch(result.evidence.all().map(item => item.excerpt).join(' '), /x-robots-tag|content-language|\blink\b/u);
  });

  test('is not evaluated without any response', () => {
    assert.equal(only(evaluate(securityHeadersInfo, site({ pages: [] })).findings).outcome, 'not_evaluated');
  });
});

describe('tech-framing-protection', () => {
  const withHeaders = (headers: Record<string, string>) => site({ pages: [page(home, { html: doc(), headers })] });

  test('passes SAMEORIGIN and a restrictive frame-ancestors', () => {
    assert.equal(only(evaluate(framingProtection, withHeaders({ 'x-frame-options': 'SAMEORIGIN' })).findings).outcome, 'pass');
    assert.equal(only(evaluate(framingProtection, withHeaders({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self' https://partner.example" })).findings).outcome, 'pass');
  });

  test('reports missing or permissive controls as info', () => {
    const result = evaluate(framingProtection, withHeaders({ 'content-security-policy': 'frame-ancestors *' }));
    const finding = only(result.findings);
    assert.deepEqual([finding.severity, finding.reason], ['info', 'permissive-frame-ancestors']);
    assert.equal(excerpt(result, finding), 'frame-ancestors *');
    assert.equal(only(evaluate(framingProtection, withHeaders({})).findings).reason, 'missing');
  });

  test('is not evaluated without any response', () => {
    assert.equal(only(evaluate(framingProtection, site({ pages: [] })).findings).outcome, 'not_evaluated');
  });
});

describe('tech-mixed-content-active', () => {
  const url = 'https://example.com/a';

  test('passes https and loopback subresources', () => {
    const facts = site({ pages: [page(url, { html: doc('<script src="https://cdn.example.net/app.js"></script><script src="http://localhost:8080/dev.js"></script>') })] });
    assert.equal(outcomeOn(evaluate(mixedContentActive, facts).findings, url)?.outcome, 'pass');
  });

  test('fails high on an http script and cites the element', () => {
    const facts = site({ pages: [page(url, { html: doc('<p>Text</p>', '<script src="http://cdn.example.net/app.js"></script>') })] });
    const result = evaluate(mixedContentActive, facts);
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity], ['fail', 'high']);
    assert.equal(excerpt(result, finding), '<script src="http://cdn.example.net/app.js">');
  });

  test('counts a stylesheet injected only in the rendered DOM', () => {
    const facts = site({ pages: [page(url, { html: doc(), rendered: doc('', '<link rel="stylesheet" href="http://cdn.example.net/a.css">') })] });
    assert.equal(outcomeOn(evaluate(mixedContentActive, facts).findings, url)?.severity, 'high');
  });

  test('passes when the page upgrades insecure requests', () => {
    const facts = site({ pages: [page(url, { html: doc('<script src="http://cdn.example.net/app.js"></script>'), headers: { 'content-security-policy': 'upgrade-insecure-requests' } })] });
    assert.equal(outcomeOn(evaluate(mixedContentActive, facts).findings, url)?.outcome, 'pass');
  });

  test('is not applicable on http pages and not evaluated without HTML', () => {
    assert.equal(outcomeOn(evaluate(mixedContentActive, site({ pages: [page('http://example.com/a', { html: doc('<script src="http://x.example/a.js"></script>') })] })).findings, 'http://example.com/a')?.reason, 'not-https');
    assert.equal(outcomeOn(evaluate(mixedContentActive, site({ pages: [page(url)] })).findings, url)?.reason, 'missing-input:raw-html');
  });
});

describe('tech-mixed-content-passive', () => {
  const url = 'https://example.com/a';

  test('passes https images', () => {
    assert.equal(outcomeOn(evaluate(mixedContentPassive, site({ pages: [page(url, { html: doc('<img src="/a.png" alt="">') })] })).findings, url)?.outcome, 'pass');
  });

  test('fails low on an http image in srcset', () => {
    const result = evaluate(mixedContentPassive, site({ pages: [page(url, { html: doc('<img src="/a.png" srcset="http://img.example.net/a-2x.png 2x" alt="A">') })] }));
    const finding = outcomeOn(result.findings, url)!;
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.urls], ['fail', 'low', 'http://img.example.net/a-2x.png']);
    assert.equal(excerpt(result, finding), '<img src="/a.png" srcset="http://img.example.net/a-2x.png 2x" alt="A">');
  });

  test('is not applicable on http pages', () => {
    assert.equal(outcomeOn(evaluate(mixedContentPassive, site({ pages: [page('http://example.com/a', { html: doc('<img src="http://x.example/a.png">') })] })).findings, 'http://example.com/a')?.outcome, 'not_applicable');
  });
});

describe('tech-internal-links-to-http', () => {
  test('passes https, relative and external http links', () => {
    const facts = site({ pages: [page(home, { html: doc('<a href="/a">A</a><a href="https://www.example.com/b">B</a><a href="http://other.example/">Other</a>') })] });
    assert.equal(only(evaluate(internalLinksToHttp, facts).findings).outcome, 'pass');
  });

  test('fails medium on an internal http link, including the www host', () => {
    const result = evaluate(internalLinksToHttp, site({ pages: [page(home, { html: doc('<footer><a href="http://www.example.com/contact">Contact</a></footer>') })] }));
    const finding = only(result.findings);
    assert.deepEqual([finding.outcome, finding.severity, finding.params?.count], ['fail', 'medium', 1]);
    assert.equal(excerpt(result, finding), '<a href="http://www.example.com/contact">');
  });

  test('is not applicable on an http site', () => {
    assert.equal(only(evaluate(internalLinksToHttp, site({ pages: [page('http://example.com/', { html: doc('<a href="http://example.com/a">A</a>') })] })).findings).reason, 'not-https');
  });
});
