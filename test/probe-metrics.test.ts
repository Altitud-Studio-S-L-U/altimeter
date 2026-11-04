import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { answerBody, brandAliases, findMention } from '../src/probe/brand.ts';
import { evaluateRun, queryMetrics, type EvaluatedRun, type SiteMatch } from '../src/probe/metrics.ts';
import type { RawRun, RunRecord } from '../src/probe/types.ts';

const site: SiteMatch = { domain: 'altitudstudio.ad', aliases: brandAliases(['Altitud Studio'], 'altitudstudio') };

function raw(answer: string, extra: Partial<RawRun> = {}): RawRun {
  return { answer, searches: 1, durationMs: 1000, at: '2026-11-04T10:00:00.000Z', ...extra };
}

function completed(queryId: string, run: number, value: RawRun, status: 'ok' | 'cached' = 'ok'): EvaluatedRun {
  const record: RunRecord = { queryId, run, status };
  return { record, raw: value, evaluation: evaluateRun(value, site) };
}

describe('brand mentions', () => {
  test('use every distinctive declared name, apart and joined, and the host label', () => {
    assert.deepEqual(site.aliases, ['altitud studio', 'altitudstudio']);
    assert.deepEqual(brandAliases(['Studio', 'AB', 'Digital Agency'], ''), [], 'generic or short names are not distinctive');
  });

  test('match whole words whatever the case, accents or spacing, and never inside a URL or the list of sources', () => {
    assert.match(findMention('Agencies include ALTITUD   studio, based in Andorra.', site.aliases) ?? '', /ALTITUD/u);
    assert.ok(findMention('Try AltitudStudio for web design.', site.aliases));
    assert.ok(findMention('Àltitud Stúdio builds sites.', site.aliases));
    assert.equal(findMention('La altitud de Andorra es de 1.023 metros.', site.aliases), undefined, 'the word altitude alone is not the brand');
    assert.equal(findMention('See https://altitudstudio.ad/serveis/ for more.', site.aliases), undefined);
    assert.equal(findMention('Andorra has several agencies.\n\nSources:\n- [Altitud Studio](https://altitudstudio.ad/)', site.aliases), undefined);
    assert.equal(findMention('Altitud Studio is one.', []), undefined);
  });

  test('come with the sentence that names the brand, cleaned and short', () => {
    const answer = `Andorra has several studios. One of them, Altitud Studio${String.fromCodePoint(0x202e)}, builds sites! Another one does not.`;
    assert.equal(findMention(answer, site.aliases), 'One of them, Altitud Studio, builds sites!');
  });

  test('stop reading at the last list of sources, in English, Spanish or Catalan', () => {
    assert.equal(answerBody('Body.\n\n**Fuentes:**\n- https://a.example/'), 'Body.\n');
    assert.equal(answerBody('Body.\nFonts: https://a.example/'), 'Body.');
    assert.equal(answerBody('Sources: first line\nBody.'), 'Sources: first line\nBody.', 'a list of sources is never the first line');
  });
});

describe('one run', () => {
  const answer = [
    'Altitud Studio offers web design ([services](https://altitudstudio.ad/serveis/)).',
    'Competitors include https://competitor.example/agency and https://made-up.example/claim.',
    '',
    'Sources:',
    '- https://altitudstudio.ad/serveis',
    '- https://competitor.example/agency?utm_source=chatgpt.com',
  ].join('\n');

  test('with search results counts only citations its search returned', () => {
    const evaluation = evaluateRun(raw(answer, { retrieved: ['https://altitudstudio.ad/serveis/', 'https://www.altitudstudio.ad/contacte/', 'https://competitor.example/agency'] }), site);
    assert.deepEqual(evaluation.cited, ['https://altitudstudio.ad/serveis/', 'https://competitor.example/agency', 'https://made-up.example/claim']);
    assert.deepEqual(evaluation.siteConfirmed, ['https://altitudstudio.ad/serveis/']);
    assert.deepEqual(evaluation.siteUnconfirmed, []);
    assert.deepEqual(evaluation.siteRetrievedNotCited, ['https://www.altitudstudio.ad/contacte/']);
    assert.deepEqual(evaluation.citedNotRetrieved, ['https://made-up.example/claim']);
    assert.deepEqual(evaluation.competitors, ['competitor.example'], 'a domain cited without being retrieved is not counted as a competitor');
    assert.match(evaluation.mention ?? '', /^Altitud Studio offers/u);
  });

  test('that cites the site without retrieving it does not count it', () => {
    const evaluation = evaluateRun(raw('Try https://altitudstudio.ad/ for that.', { retrieved: ['https://other.example/'] }), site);
    assert.deepEqual(evaluation.siteConfirmed, []);
    assert.deepEqual(evaluation.siteUnconfirmed, ['https://altitudstudio.ad/']);
    assert.deepEqual(evaluation.citedNotRetrieved, ['https://altitudstudio.ad/']);
  });

  test('without search results (Codex) takes the answer at its word', () => {
    const evaluation = evaluateRun(raw(answer), site);
    assert.deepEqual(evaluation.siteConfirmed, ['https://altitudstudio.ad/serveis/']);
    assert.deepEqual(evaluation.citedNotRetrieved, []);
    assert.deepEqual(evaluation.siteRetrievedNotCited, []);
    assert.deepEqual(evaluation.competitors, ['competitor.example', 'made-up.example']);
  });
});

describe('counts for a query', () => {
  const runs: EvaluatedRun[] = [
    completed('Q1', 1, raw('Altitud Studio: https://altitudstudio.ad/serveis/ and https://competitor.example/', { retrieved: ['https://altitudstudio.ad/serveis/', 'https://competitor.example/'], searches: 2 })),
    completed('Q1', 2, raw('Only https://competitor.example/ and https://altitudstudio.ad/blog/', { retrieved: ['https://competitor.example/', 'https://altitudstudio.ad/contacte/'] }), 'cached'),
    { record: { queryId: 'Q1', run: 3, status: 'failed', error: { code: 'timeout', message: 'The provider did not finish within 1000 ms.' } } },
  ];

  test('are numbers of completed runs, never percentages, with failed runs kept apart', () => {
    const metrics = queryMetrics('Q1', 3, runs, true);
    assert.deepEqual(
      { completed: metrics.completed, failed: metrics.failed, skipped: metrics.skipped, fromCache: metrics.fromCache, cited: metrics.cited, citedUnconfirmed: metrics.citedUnconfirmed, brandMentioned: metrics.brandMentioned, searched: metrics.searched },
      { completed: 2, failed: 1, skipped: 0, fromCache: 1, cited: 1, citedUnconfirmed: 1, brandMentioned: 1, searched: 2 },
    );
    assert.deepEqual(metrics.siteUrls, [{ value: 'https://altitudstudio.ad/serveis/', runs: 1 }]);
    assert.deepEqual(metrics.retrievedNotCited, [{ value: 'https://altitudstudio.ad/contacte/', runs: 1 }]);
    assert.deepEqual(metrics.competitors, [{ value: 'competitor.example', runs: 2 }]);
    assert.deepEqual(metrics.citedNotRetrieved, [{ value: 'https://altitudstudio.ad/blog/', runs: 1 }]);
    assert.equal(metrics.insufficientSample, true, 'two completed runs are fewer than three');
    assert.equal(JSON.stringify(metrics).includes('%'), false);
  });

  test('leave out the checks an engine without search results cannot support', () => {
    const withoutRetrieved = (value: RawRun): RawRun => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'retrieved')) as unknown as RawRun;
    const metrics = queryMetrics('Q1', 3, runs.map(entry => (entry.raw ? completed('Q1', entry.record.run, withoutRetrieved(entry.raw)) : entry)), false);
    assert.equal(metrics.cited, 2);
    assert.equal(metrics.citedUnconfirmed, undefined);
    assert.equal(metrics.retrievedNotCited, undefined);
    assert.equal(metrics.citedNotRetrieved, undefined);
  });

  test('count a value once per run and list the most frequent first', () => {
    const many = [1, 2, 3].map(run => completed('Q2', run, raw(`https://b.example/ https://b.example/x ${run > 1 ? 'https://a.example/' : ''} https://c.example/`)));
    const metrics = queryMetrics('Q2', 3, many, false);
    assert.deepEqual(metrics.competitors, [{ value: 'b.example', runs: 3 }, { value: 'c.example', runs: 3 }, { value: 'a.example', runs: 2 }]);
    assert.equal(metrics.insufficientSample, false);
  });
});
