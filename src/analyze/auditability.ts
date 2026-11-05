import type { FetchResult } from '../fetch/http.ts';
import { headerValue } from '../fetch/http.ts';

const challengeMarkers = [
  /<title>\s*just a moment\.{0,3}\s*<\/title>/iu,
  /<title>\s*attention required!?\s*\|\s*cloudflare\s*<\/title>/iu,
  /cf-chl-|challenge-platform|__cf_chl_/iu,
  /<title>[^<]*(access denied|request blocked|are you a robot|verify you are human)[^<]*<\/title>/iu,
  /g-recaptcha|h-captcha|hcaptcha\.com\/1\/api\.js|captcha-delivery\.com|perimeterx|px-captcha/iu,
];

/**
 * Tells a firewall challenge or bot wall apart from the page itself. When it returns a reason, the response is not
 * the page the site serves to visitors and crawlers it trusts, so auditing it would report problems that do not exist.
 */
export function notAuditableReason(fetch: FetchResult, html: string | undefined): string | undefined {
  if (fetch.error) return `fetch-${fetch.error.code}`;
  if (fetch.status === undefined) return 'no-response';
  const mitigated = headerValue(fetch.headers, 'cf-mitigated');
  if (mitigated) return `challenge-${mitigated.toLowerCase().replace(/[^a-z0-9-]/gu, '')}`;
  const blockingStatus = fetch.status === 401 || fetch.status === 403 || fetch.status === 429 || fetch.status === 503;
  const head = (html ?? fetch.body.subarray(0, 64 * 1024).toString('utf8')).slice(0, 64 * 1024);
  if (blockingStatus && challengeMarkers.some(marker => marker.test(head))) return 'challenge-page';
  if (fetch.status === 401) return 'authentication-required';
  return undefined;
}
