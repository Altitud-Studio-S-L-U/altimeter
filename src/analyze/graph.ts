import type { PageFacts, SiteFacts } from '../core/facts.ts';
import { absoluteUrl, documentBase, linksWithRel, pageDocument, sameSite } from '../rules/helpers.ts';

export interface LinkEdge {
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly rel: readonly string[];
  /** True when the link sits inside nav, header or footer, the usual template regions. */
  readonly template: boolean;
}

export interface LinkGraph {
  /** Internal links between audited pages, keyed by the source page's final URL. */
  readonly outlinks: ReadonlyMap<string, readonly LinkEdge[]>;
  /** Internal links pointing at each URL, keyed by the target without its fragment. */
  readonly inlinks: ReadonlyMap<string, readonly LinkEdge[]>;
  /** Shortest click depth from the home page, for pages reachable through followed links. */
  readonly depth: ReadonlyMap<string, number>;
  /** Final URL of each audited page, keyed by requested URL, so redirected URLs resolve. */
  readonly finalUrls: ReadonlyMap<string, string>;
  /** Canonical target declared by each page (raw HTML, else rendered). */
  readonly canonicalOf: ReadonlyMap<string, string>;
}

function withoutFragment(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function templateRegion(html: string, offset: number): boolean {
  if (offset < 0) return false;
  const before = html.slice(0, offset).toLowerCase();
  for (const tag of ['nav', 'header', 'footer']) {
    const opened = before.lastIndexOf(`<${tag}`);
    if (opened !== -1 && opened > before.lastIndexOf(`</${tag}`)) return true;
  }
  return false;
}

/** Builds the internal link graph of the audited pages. Only links the parser found as <a href> count. */
export function linkGraph(site: SiteFacts): LinkGraph {
  const outlinks = new Map<string, LinkEdge[]>();
  const inlinks = new Map<string, LinkEdge[]>();
  const finalUrls = new Map<string, string>();
  const canonicalOf = new Map<string, string>();
  for (const page of site.pages.values()) {
    const from = page.fetch.finalUrl;
    finalUrls.set(page.url, from);
    const doc = pageDocument(page, 'raw') ?? pageDocument(page);
    if (!doc) continue;
    const base = documentBase(doc, from);
    const canonical = absoluteUrl(linksWithRel(doc, 'canonical')[0]?.attrs.href, base);
    if (canonical) canonicalOf.set(from, canonical);
    const edges: LinkEdge[] = [];
    for (const anchor of doc.parsed.anchors) {
      const target = absoluteUrl(anchor.attrs.href, base);
      if (!target || !/^https?:/u.test(target) || !sameSite(target, from)) continue;
      const edge: LinkEdge = { from, to: withoutFragment(target), text: anchor.text || anchor.imageAlt, rel: anchor.rel, template: templateRegion(doc.html, anchor.offset) };
      edges.push(edge);
      inlinks.set(edge.to, [...(inlinks.get(edge.to) ?? []), edge]);
    }
    outlinks.set(from, edges);
  }
  const depth = new Map<string, number>();
  const home = site.homeUrl ? withoutFragment(site.homeUrl) : undefined;
  if (home) {
    depth.set(home, 0);
    const queue = [home];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of outlinks.get(current) ?? []) {
        if (edge.rel.includes('nofollow')) continue;
        const target = finalUrls.get(edge.to) ?? edge.to;
        if (depth.has(target)) continue;
        depth.set(target, depth.get(current)! + 1);
        queue.push(target);
      }
    }
  }
  return { outlinks, inlinks, depth, finalUrls, canonicalOf };
}

/** Pages in `site.pages` whose final URL equals `url`, after redirects. */
export function pagesAt(site: SiteFacts, url: string): PageFacts[] {
  return [...site.pages.values()].filter(page => page.fetch.finalUrl === url || page.url === url);
}
