import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { ProbeFacts, SiteFacts } from '../../core/facts.ts';
import type { FetchResult, Hop } from '../../fetch/http.ts';
import type { TlsFacts } from '../../fetch/tls.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { sameSite } from '../helpers.ts';
import { auditedPages, citer, fail, firstHeader, hostOf, isHttps, notApplicable, notEvaluated, pass, type Cite } from './shared.ts';

function isPrivateHost(url: string): boolean {
  const host = hostOf(url) ?? '';
  return host === 'localhost' || host.endsWith('.localhost') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host) || host === '[::1]';
}

function chainText(fetch: FetchResult): string {
  return fetch.hops.map(hop => `${hop.status} ${hop.url}${hop.location ? ` -> ${hop.location}` : ''}`).join('\n');
}

export const httpsFinalUrl: RuleImplementation = {
  id: 'tech-https-final-url',
  evaluate(context) {
    const cite = citer(context);
    const responded = auditedPages(context.site);
    if (responded.length === 0) return notEvaluated('no-response');
    const pages = responded.filter(page => !isPrivateHost(page.fetch.finalUrl));
    if (pages.length === 0) return notApplicable('private-host');
    const insecure = pages.filter(page => !isHttps(page.fetch.finalUrl));
    if (insecure.length === 0) {
      return pass(pages.map(page => cite({ kind: 'http', url: page.url, label: evidenceLabel('final URL of the audited page'), excerpt: page.fetch.finalUrl })));
    }
    const evidence = insecure.map(page => cite({ kind: 'redirect', url: page.url, label: evidenceLabel('redirect chain ending on an http URL'), excerpt: chainText(page.fetch) }));
    return fail('high', evidence, 'served-over-http', { url: insecure[0]!.fetch.finalUrl, count: insecure.length });
  },
};

/** Connection failures say nothing about the certificate. */
const unreachableCodes = new Set(['TIMEOUT', 'BLOCKED_ADDRESS', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'TLS_ERROR']);
const criticalCodes: Readonly<Record<string, string>> = {
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'not-yet-valid',
  ERR_TLS_CERT_ALTNAME_INVALID: 'hostname-mismatch',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed',
  CERT_REVOKED: 'revoked',
};
const chainCodes = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT']);

/** A connection that never completed a handshake says nothing about the certificate. */
const unreachable = (tls: TlsFacts) => !tls.authorized && (unreachableCodes.has(tls.error ?? 'UNKNOWN') || tls.chainLength === 0);

export const tlsCertificateValid: RuleImplementation = {
  id: 'tech-tls-certificate-valid',
  evaluate(context) {
    const cite = citer(context);
    const results = [certificateResult(context.site.tls!, cite)];
    // Many sites have no www or apex counterpart, so an unreachable one is left out rather than reported.
    const counterpart = context.site.counterpartTls;
    if (counterpart && !unreachable(counterpart)) results.push(certificateResult(counterpart, cite));
    return results;
  },
};

function certificateResult(tls: TlsFacts, cite: Cite): RuleResult {
  const excerpt = [
    `authorized=${tls.authorized}`,
    ...(tls.error ? [`error=${tls.error}`] : []),
    ...(tls.validFrom ? [`validFrom=${tls.validFrom}`] : []),
    ...(tls.validTo ? [`validTo=${tls.validTo}`] : []),
    ...(tls.issuer ? [`issuer=${tls.issuer}`] : []),
    `subjectAltNames=${tls.subjectAltNames.length > 0 ? tls.subjectAltNames.join(' ') : '[]'}`,
    `chainLength=${tls.chainLength}`,
  ].join('; ');
  const evidence = [cite({ kind: 'probe', url: `https://${tls.host}:${tls.port}/`, label: evidenceLabel('TLS certificate presented to a client that sends SNI'), excerpt })];
  if (unreachable(tls)) return notEvaluated('tls-unreachable');
  if (!tls.authorized) {
    const code = tls.error ?? 'UNKNOWN';
    const params = { host: tls.host, code, issuer: tls.issuer ?? 'unknown' };
    const critical = criticalCodes[code];
    if (critical) return fail('critical', evidence, critical, params);
    // Some browsers fetch missing intermediates themselves; Node does not, so the defect is named precisely.
    if (chainCodes.has(code)) return fail('high', evidence, 'incomplete-chain', params);
    // A private root is also what an intercepting proxy on the auditing network looks like.
    if (code === 'SELF_SIGNED_CERT_IN_CHAIN') return fail('high', evidence, 'untrusted-root', params);
    return fail('high', evidence, 'verification-failed', params);
  }
  if (tls.daysRemaining !== undefined && tls.validFrom && tls.validTo) {
    const lifetimeDays = (Date.parse(tls.validTo) - Date.parse(tls.validFrom)) / 86_400_000;
    // Short-lived certificates renew close to expiry by design, so only a late share of the lifetime is a warning.
    if (tls.daysRemaining < 14 && tls.daysRemaining < lifetimeDays / 4) {
      return fail('medium', evidence, 'expires-soon', { host: tls.host, days: tls.daysRemaining, validTo: tls.validTo });
    }
  }
  return pass(evidence);
}

function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function httpVariants(site: SiteFacts): ProbeFacts[] {
  return site.variants.filter(variant => variant.label === 'http');
}

/** The URL the variant should reach: the https page it was derived from. */
function expectedTarget(variant: ProbeFacts): string {
  const target = new URL(variant.url);
  target.protocol = 'https:';
  return target.href;
}

function evaluateHttpVariant(variant: ProbeFacts, cite: Cite): RuleResult {
  const { fetch } = variant;
  const chain = cite({ kind: 'redirect', url: variant.url, label: evidenceLabel('response chain for the http:// version of an audited URL'), excerpt: chainText(fetch) || fetch.error?.message });
  const first = fetch.hops[0];
  if (!first) return fetch.error?.code === 'connection' ? notApplicable('port-80-closed') : notEvaluated('http-probe-failed');
  if (first.location === undefined) {
    if (first.status >= 200 && first.status < 300) return fail('high', [chain], 'served-over-http', { url: variant.url, status: first.status });
    return pass([chain]);
  }
  const expected = expectedTarget(variant);
  const final = fetch.finalUrl;
  const finalOk = fetch.status !== undefined && fetch.status >= 200 && fetch.status < 300;
  const redirects = fetch.hops.filter(hop => hop.location !== undefined).length;
  const expectedPath = pathAndQuery(expected);
  if (final !== expected && expectedPath !== '/' && isHttps(final) && new URL(final).pathname === '/') {
    return fail('high', [chain], 'path-dropped', { url: variant.url, target: final });
  }
  if (!isHttps(final)) return fail('high', [chain], 'served-over-http', { url: variant.url, status: fetch.status ?? 0 });
  if (first.status !== 301 && first.status !== 308) return fail('low', [chain], 'temporary-redirect', { url: variant.url, status: first.status });
  // HSTS preload requires the upgrade on the same host first, so one more hop to the canonical host is expected.
  const firstHttps = first.location.startsWith('https:') && pathAndQuery(first.location) === expectedPath;
  if (!firstHttps) return fail('low', [chain], 'indirect-upgrade', { url: variant.url, target: first.location });
  if (redirects > 2 || !finalOk) return fail('low', [chain], 'long-chain', { url: variant.url, hops: redirects });
  return pass([chain]);
}

export const httpToHttpsRedirect: RuleImplementation = {
  id: 'tech-http-to-https-redirect',
  evaluate(context) {
    const variants = httpVariants(context.site);
    if (variants.length === 0) return notApplicable('not-https-site');
    const cite = citer(context);
    const results = variants.map(variant => evaluateHttpVariant(variant, cite));
    const fails = results.filter(result => result.outcome === 'fail');
    if (fails.length > 0) return fails;
    const passes = results.filter(result => result.outcome === 'pass');
    if (passes.length > 0) return pass(passes.flatMap(result => (result.outcome === 'pass' ? result.evidence ?? [] : [])));
    return results[0]!;
  },
};

interface Chain {
  /** The label of a redirect from https to http in this chain. */
  readonly downgrade: EvidenceLabel;
  readonly fetch: FetchResult;
}

function observedChains(site: SiteFacts): Chain[] {
  const chains: Chain[] = [];
  for (const page of site.pages.values()) {
    chains.push({ downgrade: evidenceLabel('redirect from https to http in the audited page chain'), fetch: page.fetch });
    for (const probe of page.uaProbes ?? []) {
      chains.push({ downgrade: evidenceLabel('redirect from https to http in the page fetched as {agent} chain', { agent: probe.agent.name }), fetch: probe.fetch });
    }
  }
  for (const variant of site.variants) {
    chains.push({ downgrade: evidenceLabel('redirect from https to http in the URL variant ({variant}) chain', { variant: variant.label }), fetch: variant.fetch });
  }
  for (const probe of site.localeProbes) {
    chains.push({ downgrade: evidenceLabel('redirect from https to http in the language probe ({probe}) chain', { probe: probe.label }), fetch: probe.fetch });
  }
  for (const probe of site.agentProbes) {
    chains.push({ downgrade: evidenceLabel('redirect from https to http in the home page fetched as {agent} chain', { agent: probe.agent.name }), fetch: probe.fetch });
  }
  for (const page of site.siblings) chains.push({ downgrade: evidenceLabel('redirect from https to http in the sibling page chain'), fetch: page.fetch });
  return chains.filter(chain => sameSite(chain.fetch.requestedUrl, site.origin));
}

function downgrades(fetch: FetchResult): Hop[] {
  return fetch.hops.filter(hop => hop.location !== undefined && isHttps(hop.url) && hop.location.startsWith('http:'));
}

export const httpsToHttpDowngrade: RuleImplementation = {
  id: 'tech-https-to-http-downgrade',
  evaluate(context) {
    const cite = citer(context);
    const seen = new Set<string>();
    const evidence: string[] = [];
    for (const chain of observedChains(context.site)) {
      for (const hop of downgrades(chain.fetch)) {
        const key = `${hop.url} ${hop.location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push(cite({ kind: 'redirect', url: hop.url, label: chain.downgrade, excerpt: `${hop.status} ${hop.url} -> ${hop.location}` }));
      }
    }
    if (evidence.length === 0) return pass();
    const first = [...seen][0]!.split(' ');
    return fail('high', evidence, undefined, { from: first[0]!, to: first[1]!, count: evidence.length });
  },
};

export interface HstsPolicy {
  readonly raw: string;
  readonly maxAge: number | undefined;
  readonly includeSubDomains: boolean;
  readonly preload: boolean;
}

export function parseHsts(value: string | undefined): HstsPolicy | undefined {
  if (value === undefined) return undefined;
  // Only the first header counts when several are sent (RFC 6797 section 8.1).
  const first = value.split(/,(?=\s*max-age)/iu)[0] ?? value;
  const directives = first.split(';').map(part => part.trim().toLowerCase()).filter(Boolean);
  const maxAge = directives.find(part => part.startsWith('max-age'))?.split('=')[1]?.replace(/"/gu, '').trim();
  return {
    raw: value,
    maxAge: maxAge !== undefined && /^\d+$/u.test(maxAge) ? Number(maxAge) : undefined,
    includeSubDomains: directives.includes('includesubdomains'),
    preload: directives.includes('preload'),
  };
}

const strongMaxAge = 31_536_000;

function finalHtmlResponse(site: SiteFacts) {
  return auditedPages(site).find(page => isHttps(page.fetch.finalUrl) && page.fetch.status !== undefined && page.fetch.status < 400);
}

export const hstsHeader: RuleImplementation = {
  id: 'tech-hsts-header',
  evaluate(context) {
    const page = finalHtmlResponse(context.site);
    if (!page) return notApplicable('not-https');
    const cite = citer(context);
    const value = firstHeader(page.fetch.headers, 'strict-transport-security');
    const policy = parseHsts(value);
    if (!policy) return fail('info', [cite({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('HTTPS response without a Strict-Transport-Security header') })], 'missing');
    const evidence = [cite({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('Strict-Transport-Security header on the HTTPS response'), excerpt: `Strict-Transport-Security: ${policy.raw}` })];
    const params = { maxAge: policy.maxAge ?? 'invalid', includeSubDomains: policy.includeSubDomains ? 'yes' : 'no', preload: policy.preload ? 'yes' : 'no' };
    if (policy.maxAge === undefined) return fail('info', evidence, 'invalid', params);
    if (policy.maxAge === 0) return fail('info', evidence, 'disabled', params);
    if (policy.maxAge < strongMaxAge) return fail('info', evidence, 'short-max-age', params);
    return pass(evidence);
  },
};

export const hstsPreloadEligibility: RuleImplementation = {
  id: 'tech-hsts-preload-eligibility',
  evaluate(context) {
    const { site } = context;
    const page = finalHtmlResponse(site);
    if (!page) return notApplicable('not-https');
    const policy = parseHsts(firstHeader(page.fetch.headers, 'strict-transport-security'));
    if (!policy?.preload) return notApplicable('no-preload-directive');
    const cite = citer(context);
    const evidence = [cite({ kind: 'header', url: page.fetch.finalUrl, label: evidenceLabel('Strict-Transport-Security header on the HTTPS response'), excerpt: `Strict-Transport-Security: ${policy.raw}` })];
    const unmet: string[] = [];
    if ((policy.maxAge ?? 0) < strongMaxAge) unmet.push('max-age of at least 31536000');
    if (!policy.includeSubDomains) unmet.push('includeSubDomains');
    if (site.tls && !site.tls.authorized) unmet.push('a valid certificate');
    const host = hostOf(page.fetch.finalUrl);
    for (const variant of httpVariants(site)) {
      const first = variant.fetch.hops[0];
      if (!first?.location) continue;
      if (!(first.location.startsWith('https:') && hostOf(first.location) === hostOf(variant.url))) {
        unmet.push('the http redirect goes to https on the same host first');
        evidence.push(cite({ kind: 'redirect', url: variant.url, label: evidenceLabel('first redirect of the http:// version'), excerpt: `${first.status} ${first.url} -> ${first.location}` }));
      }
    }
    const www = site.variants.find(variant => variant.label === 'www' && hostOf(variant.url) === `www.${host}`);
    if (www && www.fetch.error && www.fetch.error.code !== 'dns') {
      unmet.push('the www subdomain is served over HTTPS');
      evidence.push(cite({ kind: 'probe', url: www.url, label: evidenceLabel('HTTPS request to the www host'), excerpt: `${www.fetch.error.code}: ${www.fetch.error.message}` }));
    }
    const redirectsWithoutHsts = [...site.variants.map(variant => variant.fetch), page.fetch]
      .flatMap(fetch => fetch.hops)
      .filter(hop => hop.location !== undefined && isHttps(hop.url) && hostOf(hop.url) === host && firstHeader(hop.headers, 'strict-transport-security') === undefined);
    if (redirectsWithoutHsts.length > 0) {
      unmet.push('the HSTS header on HTTPS redirects');
      const hop = redirectsWithoutHsts[0]!;
      evidence.push(cite({ kind: 'header', url: hop.url, label: evidenceLabel('HTTPS redirect response without Strict-Transport-Security'), excerpt: `${hop.status} ${hop.url} -> ${hop.location}` }));
    }
    const unique = [...new Set(unmet)];
    if (unique.length === 0) return pass(evidence);
    return fail('info', evidence, undefined, { unmet: unique.join('; '), count: unique.length });
  },
};
