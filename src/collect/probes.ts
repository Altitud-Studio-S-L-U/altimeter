import { randomBytes } from 'node:crypto';

export interface UrlVariant {
  readonly label: 'trailing-slash' | 'index-file' | 'uppercase' | 'tracking-parameter' | 'double-slash' | 'http' | 'www';
  readonly url: string;
}

/**
 * Variants of a URL that should consolidate to it: each should redirect permanently to the canonical form,
 * or serve the same content with a canonical link to it.
 */
export function urlVariants(input: string): UrlVariant[] {
  const url = new URL(input);
  const variants: UrlVariant[] = [];
  const add = (label: UrlVariant['label'], value: URL) => {
    if (value.href !== url.href && !variants.some(variant => variant.url === value.href)) variants.push({ label, url: value.href });
  };
  const path = url.pathname;
  const lastSegment = path.split('/').at(-1) ?? '';
  if (!lastSegment.includes('.')) {
    const toggled = new URL(url);
    toggled.pathname = path.endsWith('/') ? (path === '/' ? '/' : path.replace(/\/+$/u, '')) : `${path}/`;
    add('trailing-slash', toggled);
    const index = new URL(url);
    index.pathname = `${path.endsWith('/') ? path : `${path}/`}index.html`;
    add('index-file', index);
  }
  if (/[a-z]/u.test(path)) {
    const upper = new URL(url);
    upper.pathname = path.toUpperCase();
    add('uppercase', upper);
  }
  const tracked = new URL(url);
  tracked.searchParams.set('utm_source', 'altimeter');
  add('tracking-parameter', tracked);
  if (path !== '/') {
    const doubled = new URL(url);
    doubled.pathname = path.replace(/^\//u, '//');
    add('double-slash', doubled);
  }
  if (url.protocol === 'https:') {
    const insecure = new URL(url);
    insecure.protocol = 'http:';
    add('http', insecure);
  }
  const host = new URL(url);
  host.hostname = url.hostname.startsWith('www.') ? url.hostname.slice(4) : `www.${url.hostname}`;
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname) && url.hostname.includes('.')) add('www', host);
  return variants;
}

/** A path that should not exist, to observe how the site answers unknown URLs. */
export function notFoundProbeUrl(origin: string): string {
  return new URL(`/altimeter-probe-${randomBytes(6).toString('hex')}/`, origin).href;
}
