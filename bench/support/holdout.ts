import type { Handler, Origins, ScenarioSite } from './scenario.ts';
import type { BenchRequest, BenchResponse } from './server.ts';
import type { Studio, StudioPage } from './studio.ts';

export const day = 86_400_000;

/** A calendar date `days` from now, as YYYY-MM-DD. */
export function isoDate(days: number): string {
  return new Date(Date.now() + days * day).toISOString().slice(0, 10);
}

/** `text` with `from` replaced once; a missing `from` throws, so a template change cannot silently empty a scenario. */
export function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`holdout: "${from.slice(0, 60)}" not found`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

export const insertAfter = (text: string, marker: string, addition: string): string => replaceOnce(text, marker, `${marker}${addition}`);
export const insertBefore = (text: string, marker: string, addition: string): string => replaceOnce(text, marker, `${addition}${marker}`);

/** The line of the rendered page that starts with `start`, removed. */
export function dropLine(html: string, start: string): string {
  const at = html.indexOf(start);
  if (at < 0) throw new Error(`holdout: "${start}" not found`);
  const end = html.indexOf('\n', at);
  return html.slice(0, at) + html.slice(end + 1);
}

export const jsonLd = (data: unknown): string => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

export function page(site: Studio, path: string): StudioPage {
  const found = site.pages.get(path);
  if (!found) throw new Error(`holdout: no studio page ${path}`);
  return found;
}

/** Appends `edit` to the page's last edits of its HTML. */
export function transform(target: StudioPage, edit: (html: string) => string): void {
  const previous = target.transform;
  target.transform = previous ? html => edit(previous(html)) : edit;
}

/** Organization, founder and WebSite nodes of the studio, copied so a page can change its own. */
export function siteNodes(site: Studio): Record<string, unknown>[] {
  return structuredClone(page(site, '/en/').graph.slice(0, 3));
}

export function webPage(site: Studio, path: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const url = site.url(path);
  return { '@type': 'WebPage', '@id': `${url}#webpage`, url, name, inLanguage: 'en', isPartOf: { '@id': `${site.origin}/#website` }, ...extra };
}

/** A new English page of the studio, built on the open-source page's template and registered at `path`. */
export function addPage(site: Studio, path: string, fields: Partial<StudioPage> & Pick<StudioPage, 'title' | 'h1'>): StudioPage {
  const base = page(site, '/en/open-source/');
  const created: StudioPage = {
    ...base, path, description: '', label: fields.h1, lead: '', hero: '', body: '', head: '', afterMain: '', headers: {}, alternates: {},
    graph: [...siteNodes(site), webPage(site, path, fields.title)], inSitemap: true, ...fields,
  };
  site.pages.set(path, created);
  return created;
}

/** The origins of the studio with its https apex answered by `wrap`, plus `extra` origins. */
export function served(site: Studio, path: string, wrap?: (apex: Handler) => Handler, extra: Origins = {}): ScenarioSite {
  const origins = site.origins();
  const apex = origins['https://vellora.example'] as Handler;
  return { origins: { ...origins, 'https://vellora.example': wrap ? wrap(apex) : apex, ...extra }, url: site.url(path) };
}

/** Answers the first matching user agent with its own response, every other request as `apex` does. */
export function byUserAgent(apex: Handler, answers: readonly (readonly [RegExp, (request: BenchRequest) => BenchResponse | undefined])[]): Handler {
  return request => {
    const agent = String(request.headers['user-agent'] ?? '');
    for (const [pattern, answer] of answers) {
      if (!pattern.test(agent)) continue;
      const response = answer(request);
      if (response) return response;
    }
    return typeof apex === 'function' ? apex(request) : apex;
  };
}

/** What an edge answers a refused crawler on every path but robots.txt. */
export function refuse(status: number, headers: Record<string, string>, text: string): (request: BenchRequest) => BenchResponse | undefined {
  return request => (request.pathname === '/robots.txt' ? undefined
    : htmlResponse(`<!doctype html><title>${text}</title><h1>${text}</h1>`, status, { server: 'cloudflare', ...headers }));
}

/** A small standalone HTML document for hosts and paths outside the studio template. */
export function htmlDocument(options: { readonly lang: string; readonly title: string; readonly head?: string; readonly body: string; readonly robots?: string }): string {
  return `<!doctype html>
<html lang="${options.lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<meta name="robots" content="${options.robots ?? 'index, follow'}">${options.head ? `\n${options.head}` : ''}
</head>
<body>
${options.body}
</body>
</html>
`;
}

export const htmlResponse = (body: string, status = 200, headers: Record<string, string> = {}): BenchResponse =>
  ({ status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate', ...headers }, body });
