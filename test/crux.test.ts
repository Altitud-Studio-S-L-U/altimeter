import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { queryCrux } from '../src/data/crux.ts';
import { HttpClient } from '../src/fetch/http.ts';

let server: Server;
let endpoint: string;
const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];

const record = {
  record: {
    key: { formFactor: 'PHONE', url: 'https://example.com/' },
    metrics: {
      largest_contentful_paint: { histogram: [{ start: 0, end: 2500, density: 0.8 }, { start: 2500, end: 4000, density: 0.15 }, { start: 4000, density: 0.05 }], percentiles: { p75: 2100 } },
      cumulative_layout_shift: { histogram: [{ start: '0.00', end: '0.10', density: 0.9 }], percentiles: { p75: '0.04' } },
      navigation_types: { fractions: { navigate: 0.7, back_forward_cache: 0.1, reload: 0.2 } },
    },
    collectionPeriod: { firstDate: { year: 2026, month: 10, day: 5 }, lastDate: { year: 2026, month: 11, day: 1 } },
  },
  urlNormalizationDetails: { originalUrl: 'https://example.com/?utm=1', normalizedUrl: 'https://example.com/' },
};

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      const parsed = JSON.parse(body) as { url?: string; origin?: string };
      if (parsed.origin === 'https://quiet.example') return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":404}}');
      if (parsed.origin === 'https://broken.example') return void res.writeHead(500).end('oops');
      res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' }).end(JSON.stringify(record));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const client = () => new HttpClient({ policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) } });

describe('queryCrux', () => {
  test('parses p75 values, histograms, navigation types and the collection period', async () => {
    const http = client();
    const outcome = await queryCrux(http, 'test-key', { url: 'https://example.com/?utm=1' }, 'PHONE', endpoint);
    await http.close();
    assert.equal(outcome.status, 'ok');
    if (outcome.status !== 'ok') return;
    assert.equal(outcome.record.scope, 'url');
    assert.equal(outcome.record.metrics.largest_contentful_paint?.p75, 2100);
    assert.equal(outcome.record.metrics.cumulative_layout_shift?.p75, 0.04);
    assert.equal(outcome.record.metrics.largest_contentful_paint?.histogram[2]?.end, undefined);
    assert.deepEqual(outcome.record.navigationTypes, { navigate: 0.7, back_forward_cache: 0.1, reload: 0.2 });
    assert.deepEqual(outcome.record.collectionPeriod, { first: '2026-10-05', last: '2026-11-01' });
    assert.equal(outcome.record.normalizedUrl, 'https://example.com/');
  });

  test('sends the key in a header and never in the URL', async () => {
    const http = client();
    await queryCrux(http, 'secret-key-value', { origin: 'https://example.com' }, 'DESKTOP', endpoint);
    await http.close();
    const last = seen.at(-1)!;
    assert.equal(last.url, '/v1/records:queryRecord');
    assert.equal(last.headers['x-goog-api-key'], 'secret-key-value');
    assert.deepEqual(JSON.parse(last.body), { origin: 'https://example.com', formFactor: 'DESKTOP' });
  });

  test('distinguishes missing data, a missing key and errors', async () => {
    const http = client();
    assert.equal((await queryCrux(http, 'k', { origin: 'https://quiet.example' }, 'PHONE', endpoint)).status, 'no-data');
    assert.equal((await queryCrux(http, undefined, { origin: 'https://example.com' }, 'PHONE', endpoint)).status, 'no-key');
    const broken = await queryCrux(http, 'k', { origin: 'https://broken.example' }, 'PHONE', endpoint);
    await http.close();
    assert.equal(broken.status, 'error');
    assert.doesNotMatch(JSON.stringify(broken), /k'|key/u);
  });
});
