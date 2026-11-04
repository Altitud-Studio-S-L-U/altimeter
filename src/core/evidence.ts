import { format } from '../i18n/format.ts';

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

/** One template of the evidence label catalog (`src/i18n/en/evidence.json`) and the values it fills in. */
export interface LabelPart {
  readonly template: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface EvidenceItem {
  /** Stable within one audit, e.g. `E12`. Findings, tasks and model output cite these ids. */
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly url?: string;
  /** Neutral description written by Altimeter in English, never copied from the site. */
  readonly label: string;
  /**
   * The catalog templates the label was written from, with their values, when it has values or joins several
   * templates, so reports can translate it. A label without them is a fixed text of the catalog.
   */
  readonly labelParts?: readonly LabelPart[];
  /** The exact value observed on the site. Always untrusted. */
  readonly excerpt?: string;
  readonly line?: number;
  /** Location inside a structured value, e.g. `jsonld[0].@graph[1].logo` or a CSS selector. */
  readonly path?: string;
  /** False when the excerpt was cut to `maxExcerptLength`. */
  readonly complete: boolean;
}

/** A label for `EvidenceStore.add`, made with `evidenceLabel` and `joinLabels`. */
export interface EvidenceLabel {
  readonly parts: readonly LabelPart[];
}

/**
 * A label from the catalog in `src/i18n/en/evidence.json`, with `{name}` placeholders for the values in `params`.
 * The template must be a string literal: a test reads every call to check that the catalog holds it.
 */
export function evidenceLabel(template: string, params?: Readonly<Record<string, string | number>>): EvidenceLabel {
  return { parts: [params === undefined ? { template } : { template, params }] };
}

/** Labels written one after the other, such as an observation and where it was made. Reports translate each one. */
export function joinLabels(...labels: readonly EvidenceLabel[]): EvidenceLabel {
  return { parts: labels.flatMap(label => label.parts) };
}

/** The English text of a label, as reports, evidence signatures and task groups read it. */
export function labelText(label: EvidenceLabel): string {
  return label.parts.map(part => format(part.template, part.params)).join(' ');
}

export const maxExcerptLength = 2000;

export type NewEvidence = Omit<EvidenceItem, 'id' | 'complete' | 'label' | 'labelParts'> & { readonly label: EvidenceLabel };

export class EvidenceStore {
  readonly #items = new Map<string, EvidenceItem>();
  readonly #byKey = new Map<string, string>();
  #next = 1;

  /** Records an observation and returns its id; recording the same observation twice returns the same id. */
  add(entry: NewEvidence): string {
    const label = labelText(entry.label);
    const excerpt = entry.excerpt === undefined ? undefined : entry.excerpt.slice(0, maxExcerptLength);
    const key = JSON.stringify([entry.kind, entry.url, label, excerpt, entry.line, entry.path]);
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `E${this.#next++}`;
    const parts = entry.label.parts;
    this.#items.set(id, {
      ...entry,
      label,
      ...(parts.length > 1 || parts.some(part => part.params !== undefined) ? { labelParts: parts } : {}),
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
