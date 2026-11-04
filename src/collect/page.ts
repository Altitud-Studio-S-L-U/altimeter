import { classifyPage, ownLanguages } from '../analyze/page-type.ts';
import type { DocumentFacts, PageFacts } from '../core/facts.ts';
import { headerValue, type FetchResult, type HeaderMap, type HttpClient } from '../fetch/http.ts';
import { metaContent, parseHtml } from '../parse/html.ts';
import { extractStructuredData } from '../parse/structured-data.ts';

/** Googlebot for Search reads the first 2 MB of uncompressed HTML; Altimeter keeps a little more to show what is cut. */
export const htmlFetchLimit = 4 * 1024 * 1024;

export function isHtmlResponse(headers: HeaderMap, body: Buffer): boolean {
  const type = (headerValue(headers, 'content-type') ?? '').toLowerCase();
  if (type.includes('text/html') || type.includes('application/xhtml+xml')) return true;
  if (type !== '' && !type.includes('text/plain')) return false;
  return /^\s*(<!doctype html|<html|<head)/iu.test(body.subarray(0, 512).toString('latin1'));
}

/** Decodes an HTML body with the charset from Content-Type or an early meta tag, defaulting to UTF-8. */
export function decodeHtml(headers: HeaderMap, body: Buffer): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/iu.exec(headerValue(headers, 'content-type') ?? '')?.[1];
  const head = body.subarray(0, 1024).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/iu.exec(head)?.[1];
  const label = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(body).replace(/^\uFEFF/u, '');
  } catch {
    return new TextDecoder('utf-8').decode(body).replace(/^\uFEFF/u, '');
  }
}

export function documentFacts(html: string): DocumentFacts {
  const parsed = parseHtml(html);
  return { html, parsed, data: extractStructuredData(parsed) };
}

/** Fetches a URL and, when it returns HTML, parses it and classifies the page. */
export async function fetchPage(client: HttpClient, url: string, options: { isHome?: boolean; headers?: Record<string, string> } = {}): Promise<PageFacts> {
  const fetch: FetchResult = await client.fetch(url, { maxBytes: htmlFetchLimit, ...(options.headers ? { headers: options.headers } : {}) });
  const raw = fetch.error === undefined && isHtmlResponse(fetch.headers, fetch.body) ? documentFacts(decodeHtml(fetch.headers, fetch.body)) : undefined;
  const decision = classifyPage({
    url: fetch.finalUrl,
    status: fetch.status,
    title: raw?.parsed.titles[0]?.text,
    h1: raw?.parsed.headings.find(heading => heading.level === 1)?.text,
    ogType: raw ? metaContent(raw.parsed, 'og:type')[0]?.attrs.content : undefined,
    data: raw?.data,
    ...(options.isHome === undefined ? {} : { isHome: options.isHome }),
    ...(raw ? { languages: ownLanguages(raw, fetch.finalUrl) } : {}),
  });
  return { url, fetch, pageType: decision.type, pageTypeReason: decision.reason, ...(raw ? { raw } : {}) };
}
