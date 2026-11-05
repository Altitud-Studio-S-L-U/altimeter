import { headerValue, type HttpClient } from '../fetch/http.ts';

export const cruxEndpoint = 'https://chromeuxreport.googleapis.com';

export type CruxFormFactor = 'PHONE' | 'DESKTOP';

export interface CruxHistogramBin {
  readonly start: number;
  readonly end?: number;
  readonly density: number;
}

export interface CruxMetric {
  /** 75th percentile in milliseconds, or unitless for cumulative_layout_shift. */
  readonly p75: number | undefined;
  readonly histogram: readonly CruxHistogramBin[];
}

export interface CruxRecord {
  readonly scope: 'url' | 'origin';
  readonly key: string;
  readonly formFactor: CruxFormFactor;
  readonly metrics: Readonly<Record<string, CruxMetric>>;
  /** Fractions per navigation type, when the API reports them. */
  readonly navigationTypes?: Readonly<Record<string, number>>;
  readonly collectionPeriod: { readonly first: string; readonly last: string };
  /** The URL CrUX actually matched, when it normalized the requested one. */
  readonly normalizedUrl?: string;
}

export type CruxOutcome =
  | { readonly status: 'ok'; readonly record: CruxRecord }
  /** CrUX has no data: the page or origin is not public, not indexable or not popular enough. */
  | { readonly status: 'no-data' }
  | { readonly status: 'no-key' }
  | { readonly status: 'error'; readonly message: string };

function date(value: { year?: number; month?: number; day?: number } | undefined): string {
  if (!value?.year || !value.month || !value.day) return '';
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Queries the CrUX API for one URL or origin and form factor. The API key travels in the x-goog-api-key
 * header, never in a URL, so it cannot end up in evidence, reports or logs.
 */
export async function queryCrux(
  client: HttpClient,
  apiKey: string | undefined,
  target: { readonly url: string } | { readonly origin: string },
  formFactor: CruxFormFactor,
  endpoint = cruxEndpoint,
): Promise<CruxOutcome> {
  if (!apiKey) return { status: 'no-key' };
  const result = await client.fetch(`${endpoint}/v1/records:queryRecord`, {
    method: 'POST',
    followRedirects: false,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ ...target, formFactor }),
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 20_000,
  });
  if (result.error) return { status: 'error', message: `CrUX request failed (${result.error.code})` };
  if (result.status === 404) return { status: 'no-data' };
  if (result.status !== 200) return { status: 'error', message: `CrUX answered ${result.status}` };
  if (!(headerValue(result.headers, 'content-type') ?? '').includes('json')) return { status: 'error', message: 'CrUX answered without JSON' };
  let payload: { record?: Record<string, unknown>; urlNormalizationDetails?: { normalizedUrl?: string } };
  try {
    payload = JSON.parse(result.body.toString('utf8')) as typeof payload;
  } catch {
    return { status: 'error', message: 'CrUX returned invalid JSON' };
  }
  const record = payload.record;
  if (!record || typeof record.metrics !== 'object' || record.metrics === null) return { status: 'no-data' };
  const metrics: Record<string, CruxMetric> = {};
  let navigationTypes: Record<string, number> | undefined;
  for (const [name, raw] of Object.entries(record.metrics as Record<string, Record<string, unknown>>)) {
    if (name === 'navigation_types') {
      const fractions = (raw.fractions ?? {}) as Record<string, unknown>;
      navigationTypes = Object.fromEntries(Object.entries(fractions).map(([type, value]) => [type, numeric(value) ?? 0]));
      continue;
    }
    const histogram = Array.isArray(raw.histogram) ? raw.histogram as Array<Record<string, unknown>> : [];
    metrics[name] = {
      p75: numeric((raw.percentiles as Record<string, unknown> | undefined)?.p75),
      histogram: histogram.map(bin => ({
        start: numeric(bin.start) ?? 0,
        ...(numeric(bin.end) === undefined ? {} : { end: numeric(bin.end)! }),
        density: numeric(bin.density) ?? 0,
      })),
    };
  }
  const period = record.collectionPeriod as { firstDate?: Record<string, number>; lastDate?: Record<string, number> } | undefined;
  return {
    status: 'ok',
    record: {
      scope: 'url' in target ? 'url' : 'origin',
      key: 'url' in target ? target.url : target.origin,
      formFactor,
      metrics,
      ...(navigationTypes ? { navigationTypes } : {}),
      collectionPeriod: { first: date(period?.firstDate), last: date(period?.lastDate) },
      ...(payload.urlNormalizationDetails?.normalizedUrl ? { normalizedUrl: payload.urlNormalizationDetails.normalizedUrl } : {}),
    },
  };
}
