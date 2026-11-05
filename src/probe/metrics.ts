import { findMention } from './brand.ts';
import type { Count, QueryMetrics, RawRun, RunRecord } from './types.ts';
import { domainOf, onSite, urlKey, urlsInText } from './urls.ts';

/**
 * Every metric is a count computed here from the answer text and the URLs the engine's search returned. No model
 * is asked whether the site was cited, and nothing is turned into a percentage or a score.
 */

/** Fewer completed runs than this are reported as an insufficient sample. A tool convention. */
export const minimumSample = 3;
/** Rows kept in each list of URLs or domains. */
const maxRows = 10;

export interface SiteMatch {
  /** The registrable domain whose URLs are the site's. */
  readonly domain: string;
  /** Folded brand forms that count as a mention. */
  readonly aliases: readonly string[];
}

export interface RunEvaluation {
  /** Every URL the answer cites, canonical. */
  readonly cited: readonly string[];
  /** The site's URLs the answer cites that count: retrieved by the engine's search, or every one when that cannot be checked. */
  readonly siteConfirmed: readonly string[];
  /** The site's URLs the answer cites although the engine's search did not return them. */
  readonly siteUnconfirmed: readonly string[];
  /** The site's URLs the engine's search returned that the answer does not cite. */
  readonly siteRetrievedNotCited: readonly string[];
  /** URLs of any site the answer cites that the engine's search did not return. */
  readonly citedNotRetrieved: readonly string[];
  /** Other registrable domains the answer cites, counted on the same terms as the site. */
  readonly competitors: readonly string[];
  readonly mention?: string;
}

/**
 * What one run shows. When the engine exposes what its search returned, a citation counts only if its URL is
 * among those results; when it does not (Codex), the answer's citations are taken as reported.
 */
export function evaluateRun(raw: RawRun, site: SiteMatch): RunEvaluation {
  const cited = urlsInText(raw.answer);
  const retrieved = raw.retrieved;
  const retrievedKeys = new Set((retrieved ?? []).map(urlKey));
  const confirmed = (url: string) => retrieved === undefined || retrievedKeys.has(urlKey(url));
  const citedKeys = new Set(cited.map(urlKey));
  const siteCited = cited.filter(url => onSite(url, site.domain));
  const competitors = [...new Set(cited.filter(confirmed).map(domainOf).filter((domain): domain is string => domain !== undefined && domain !== site.domain))];
  const mention = findMention(raw.answer, site.aliases);
  return {
    cited,
    siteConfirmed: siteCited.filter(confirmed),
    siteUnconfirmed: siteCited.filter(url => !confirmed(url)),
    siteRetrievedNotCited: (retrieved ?? []).filter(url => onSite(url, site.domain) && !citedKeys.has(urlKey(url))),
    citedNotRetrieved: cited.filter(url => !confirmed(url)),
    competitors,
    ...(mention === undefined ? {} : { mention }),
  };
}

/** Counts how many runs contain each value, once per run, with the most frequent first. */
function tally(perRun: ReadonlyArray<readonly string[]>, key: (value: string) => string = value => value): Count[] {
  const counts = new Map<string, { value: string; runs: number }>();
  for (const values of perRun) {
    const seen = new Set<string>();
    for (const value of values) {
      const id = key(value);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = counts.get(id);
      if (entry) entry.runs += 1;
      else counts.set(id, { value, runs: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.runs - a.runs || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, maxRows);
}

export interface EvaluatedRun {
  readonly record: RunRecord;
  readonly raw?: RawRun;
  readonly evaluation?: RunEvaluation;
}

/** The counts for one query on one engine. Failed and skipped runs are counted as such and never as misses. */
export function queryMetrics(queryId: string, planned: number, runs: readonly EvaluatedRun[], verifiable: boolean): QueryMetrics {
  const completed = runs.filter(run => run.evaluation !== undefined && run.raw !== undefined) as Array<Required<EvaluatedRun>>;
  const evaluations = completed.map(run => run.evaluation);
  const unconfirmed = evaluations.filter(entry => entry.siteConfirmed.length === 0 && entry.siteUnconfirmed.length > 0).length;
  return {
    queryId,
    planned,
    completed: completed.length,
    failed: runs.filter(run => run.record.status === 'failed').length,
    skipped: runs.filter(run => run.record.status === 'skipped').length,
    fromCache: runs.filter(run => run.record.status === 'cached').length,
    cited: evaluations.filter(entry => entry.siteConfirmed.length > 0).length,
    ...(verifiable ? { citedUnconfirmed: unconfirmed } : {}),
    brandMentioned: evaluations.filter(entry => entry.mention !== undefined).length,
    searched: completed.filter(run => run.raw.searches > 0).length,
    siteUrls: tally(evaluations.map(entry => entry.siteConfirmed), urlKey),
    ...(verifiable ? { retrievedNotCited: tally(evaluations.map(entry => entry.siteRetrievedNotCited), urlKey) } : {}),
    competitors: tally(evaluations.map(entry => entry.competitors)),
    ...(verifiable ? { citedNotRetrieved: tally(evaluations.map(entry => entry.citedNotRetrieved), urlKey) } : {}),
    insufficientSample: completed.length < minimumSample,
  };
}
