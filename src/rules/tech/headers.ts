import type { PageFacts, SiteFacts } from '../../core/facts.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { auditedPages, citer, fail, firstHeader, notApplicable, pass } from './shared.ts';

const inventory = [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'x-frame-options',
] as const;

/** The HTML response the inventory describes: the first audited page that answered with HTML. */
function htmlResponse(site: SiteFacts): PageFacts | undefined {
  return auditedPages(site).find(page => page.raw !== undefined) ?? auditedPages(site)[0];
}

/** Script sources that make browsers ignore 'unsafe-inline' (CSP Level 2 and later), as Lighthouse's csp-xss reads them. */
const inlineOverride = /^'(?:nonce-|sha256-|sha384-|sha512-|strict-dynamic')/iu;

/**
 * The script directive that lets inline scripts run: every enforced policy that restricts scripts (through script-src,
 * or default-src without it) allows 'unsafe-inline' with no nonce, hash or 'strict-dynamic'. Undefined when no policy
 * restricts scripts or one of them blocks inline scripts.
 */
function inlineScriptDirective(csp: string | undefined): string | undefined {
  let allowing: string | undefined;
  for (const policy of (csp ?? '').split(',')) {
    const directives = policy.split(';').map(part => part.trim()).filter(Boolean);
    const directive = directives.find(part => /^script-src(?:\s|$)/iu.test(part)) ?? directives.find(part => /^default-src(?:\s|$)/iu.test(part));
    if (directive === undefined) continue;
    const sources = directive.split(/\s+/u).slice(1);
    if (!sources.some(source => source.toLowerCase() === "'unsafe-inline'") || sources.some(source => inlineOverride.test(source))) return undefined;
    allowing ??= directive;
  }
  return allowing;
}

export const securityHeadersInfo: RuleImplementation = {
  id: 'tech-security-headers-info',
  evaluate(context) {
    const page = htmlResponse(context.site);
    if (!page) return notApplicable('no-html-response');
    const cite = citer(context);
    const url = page.fetch.finalUrl;
    const present = inventory.filter(name => firstHeader(page.fetch.headers, name) !== undefined);
    const absent = inventory.filter(name => !present.includes(name));
    const evidence = present.map(name => cite({ kind: 'header', url, label: 'security header on the HTML response', excerpt: `${name}: ${firstHeader(page.fetch.headers, name)}` }));
    if (absent.length > 0) evidence.push(cite({ kind: 'header', url, label: 'security headers the HTML response does not send', excerpt: absent.join(', ') }));
    const results: RuleResult[] = [];
    const nosniff = firstHeader(page.fetch.headers, 'x-content-type-options');
    if (nosniff !== undefined && nosniff.trim().toLowerCase() !== 'nosniff') results.push(fail('info', evidence, 'invalid-nosniff', { value: nosniff }));
    const inline = inlineScriptDirective(firstHeader(page.fetch.headers, 'content-security-policy'));
    if (inline !== undefined) results.push(fail('info', evidence, 'csp-inline-scripts', { directive: inline }));
    return results.length > 0 ? results : pass(evidence);
  },
};

/** frame-ancestors from enforced policies only; report-only and meta policies do not restrict framing. */
function frameAncestors(csp: string | undefined): string | undefined {
  if (csp === undefined) return undefined;
  for (const policy of csp.split(',')) {
    const directive = policy.split(';').map(part => part.trim()).find(part => /^frame-ancestors(\s|$)/iu.test(part));
    if (directive !== undefined) return directive;
  }
  return undefined;
}

export const framingProtection: RuleImplementation = {
  id: 'tech-framing-protection',
  evaluate(context) {
    const page = htmlResponse(context.site);
    if (!page) return notApplicable('no-html-response');
    const cite = citer(context);
    const url = page.fetch.finalUrl;
    const xfo = firstHeader(page.fetch.headers, 'x-frame-options');
    const ancestors = frameAncestors(firstHeader(page.fetch.headers, 'content-security-policy'));
    const evidence = [
      ...(xfo === undefined ? [] : [cite({ kind: 'header', url, label: 'X-Frame-Options header', excerpt: `X-Frame-Options: ${xfo}` })]),
      ...(ancestors === undefined ? [] : [cite({ kind: 'header', url, label: 'frame-ancestors directive of the enforced Content-Security-Policy', excerpt: ancestors })]),
    ];
    // frame-ancestors takes precedence over X-Frame-Options in browsers that support both.
    if (ancestors !== undefined) {
      const sources = ancestors.split(/\s+/u).slice(1);
      if (sources.length > 0 && !sources.includes('*') && !sources.some(source => /^(https?:|wss?:)$/iu.test(source))) return pass(evidence);
      return fail('info', evidence, 'permissive-frame-ancestors', { value: ancestors });
    }
    const xfoValue = xfo?.split(',')[0]?.trim().toLowerCase();
    if (xfoValue === 'deny' || xfoValue === 'sameorigin') return pass(evidence);
    if (xfoValue !== undefined) return fail('info', evidence, 'unsupported-x-frame-options', { value: xfo! });
    return fail('info', [cite({ kind: 'header', url, label: 'HTML response without X-Frame-Options or a CSP frame-ancestors directive', excerpt: 'X-Frame-Options: (absent); Content-Security-Policy frame-ancestors: (absent)' })], 'missing');
  },
};
