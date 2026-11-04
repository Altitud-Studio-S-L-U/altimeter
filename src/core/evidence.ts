export type EvidenceKind =
  | 'http'
  | 'redirect'
  | 'header'
  | 'html'
  | 'text'
  | 'robots'
  | 'sitemap'
  | 'structured-data'
  | 'render'
  | 'lighthouse'
  | 'crux'
  | 'probe'
  | 'crawl'
  | 'owner-data';

export interface EvidenceItem {
  /** Stable within one audit, e.g. `E12`. Findings, tasks and model output cite these ids. */
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly url?: string;
  /** Neutral description written by Altimeter, never copied from the site. */
  readonly label: string;
  /** The exact value observed on the site. Always untrusted. */
  readonly excerpt?: string;
  readonly line?: number;
  /** Location inside a structured value, e.g. `jsonld[0].@graph[1].logo` or a CSS selector. */
  readonly path?: string;
  /** False when the excerpt was cut to `maxExcerptLength`. */
  readonly complete: boolean;
}

export const maxExcerptLength = 2000;

export type NewEvidence = Omit<EvidenceItem, 'id' | 'complete'>;

export class EvidenceStore {
  readonly #items = new Map<string, EvidenceItem>();
  readonly #byKey = new Map<string, string>();
  #next = 1;

  /** Records an observation and returns its id; recording the same observation twice returns the same id. */
  add(entry: NewEvidence): string {
    const excerpt = entry.excerpt === undefined ? undefined : entry.excerpt.slice(0, maxExcerptLength);
    const key = JSON.stringify([entry.kind, entry.url, entry.label, excerpt, entry.line, entry.path]);
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `E${this.#next++}`;
    this.#items.set(id, {
      ...entry,
      id,
      ...(excerpt === undefined ? {} : { excerpt }),
      complete: entry.excerpt === undefined || entry.excerpt.length <= maxExcerptLength,
    });
    this.#byKey.set(key, id);
    return id;
  }

  get(id: string): EvidenceItem | undefined {
    return this.#items.get(id);
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  all(): EvidenceItem[] {
    return [...this.#items.values()];
  }
}
