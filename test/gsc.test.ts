import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HttpClient } from '../src/fetch/http.ts';
import { GoogleAuthError, startLoopbackLogin, tokenFromEnvironment, tokenFromServiceAccount } from '../src/owner/google-auth.ts';
import { chooseProperty, fetchGscData, reportingPeriods } from '../src/owner/gsc.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let server: Server;
let base: string;
let work: string;
const codeVerifiers = new Map<string, string>();
let queries = 0;

const body = (req: IncomingMessage) => new Promise<string>(resolve => { let text = ''; req.on('data', chunk => (text += chunk)); req.on('end', () => resolve(text)); });

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await body(req));
        if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          const [header, claims, signature] = (form.get('assertion') ?? '').split('.');
          const valid = verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature ?? '', 'base64url'));
          const payload = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()) as { scope: string };
          return void (valid && payload.scope.endsWith('webmasters.readonly') ? json(200, { access_token: 'sa-token', expires_in: 3600 }) : json(400, { error: 'invalid_grant' }));
        }
        if (form.get('grant_type') === 'authorization_code') {
          const expected = codeVerifiers.get(form.get('code') ?? '');
          const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
          return void (expected === challenge ? json(200, { access_token: 'user-token', refresh_token: 'refresh-1', expires_in: 3599 }) : json(400, { error: 'invalid_grant' }));
        }
        return void json(400, { error: 'unsupported_grant_type' });
      }
      const auth = req.headers.authorization;
      if (auth === 'Bearer expired') return void json(401, { error: { code: 401 } });
      if (url.pathname === '/webmasters/v3/sites') return void json(200, { siteEntry: [
        { siteUrl: 'https://example.com/', permissionLevel: 'siteFullUser' },
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:other.org', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://pending.example.net/', permissionLevel: 'siteUnverifiedUser' },
      ] });
      if (url.pathname.endsWith('/searchAnalytics/query')) {
        queries += 1;
        const request = JSON.parse(await body(req)) as { dimensions: string[]; startRow: number; rowLimit: number };
        if (request.dimensions.join() === 'query' && request.startRow === 0) {
          return void json(200, { rows: Array.from({ length: request.rowLimit }, (_, index) => ({ keys: [`q${index}`], clicks: 1, impressions: 10, ctr: 0.1, position: 3 })) });
        }
        return void json(200, { rows: request.startRow === 0 ? [{ keys: request.dimensions.map(dimension => `${dimension}-key`), clicks: 5, impressions: 100, ctr: 0.05, position: 7.2 }] : [] });
      }
      if (url.pathname === '/v1/urlInspection/index:inspect') {
        const request = JSON.parse(await body(req)) as { inspectionUrl: string; languageCode: string };
        return void json(200, { inspectionResult: { indexStatusResult: {
          verdict: 'PASS', coverageState: 'Submitted and indexed', googleCanonical: request.inspectionUrl, userCanonical: request.inspectionUrl,
          lastCrawlTime: '2026-10-30T10:00:00Z', crawledAs: 'MOBILE', sitemap: ['https://example.com/sitemap.xml'], pageFetchState: 'SUCCESSFUL',
        }, richResultsResult: { verdict: 'PASS', detectedItems: [{ richResultType: 'Breadcrumbs', items: [{ name: 'Unnamed item', issues: [] }] }] } } });
      }
      if (url.pathname.endsWith('/sitemaps')) return void json(200, { sitemap: [{ path: 'https://example.com/sitemap.xml', lastDownloaded: '2026-11-01T00:00:00Z', warnings: '0', errors: '1' }] });
      json(404, {});
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(join(tmpdir(), 'altimeter-gsc-'));
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
});

const client = () => new HttpClient({ policy: { allowPrivate: false, privateHosts: new Set(['127.0.0.1']) } });
const endpoints = () => ({ webmasters: `${base}/webmasters/v3`, inspection: `${base}/v1` });

describe('Google authentication', () => {
  test('reads a short-lived token from the environment', () => {
    process.env.ALTIMETER_TEST_TOKEN = '  abc  ';
    assert.equal(tokenFromEnvironment('ALTIMETER_TEST_TOKEN')?.token, 'abc');
    delete process.env.ALTIMETER_TEST_TOKEN;
    assert.equal(tokenFromEnvironment('ALTIMETER_TEST_TOKEN'), undefined);
  });

  test('signs a JWT for a service account and exchanges it', async () => {
    const keyPath = join(work, 'key.json');
    await writeFile(keyPath, JSON.stringify({ client_email: 'audit@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${base}/token` }));
    const http = client();
    const token = await tokenFromServiceAccount(http, keyPath);
    await http.close();
    assert.deepEqual([token.token, token.source], ['sa-token', 'service-account']);
  });

  test('completes the loopback OAuth flow with PKCE and refuses a forged state', async () => {
    const http = client();
    const login = await startLoopbackLogin(http, { clientId: 'cid', clientSecret: 'secret', authUri: `${base}/auth`, tokenUri: `${base}/token` });
    const authorization = new URL(login.authorizationUrl);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/webmasters.readonly');
    codeVerifiers.set('code-1', authorization.searchParams.get('code_challenge')!);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    const forged = await http.fetch(`${callback.href}?code=code-1&state=wrong`);
    assert.equal(forged.status, 400);
    const accepted = await http.fetch(`${callback.href}?code=code-1&state=${authorization.searchParams.get('state')}`);
    assert.equal(accepted.status, 200);
    const token = await login.token;
    await http.close();
    assert.deepEqual([token.token, token.refreshToken, token.source], ['user-token', 'refresh-1', 'oauth']);
  });
});

describe('Search Console data', () => {
  test('chooses the Domain property, then the longest URL prefix', () => {
    const properties = [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }, { siteUrl: 'https://example.com/en/', permissionLevel: 'siteOwner' },
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteUnverifiedUser' }];
    assert.equal(chooseProperty(properties, 'https://example.com/en/about/')?.siteUrl, 'https://example.com/en/');
    assert.equal(chooseProperty(properties, 'https://example.com/es/')?.siteUrl, 'https://example.com/');
    assert.equal(chooseProperty(properties, 'https://www.example.com/'), undefined, 'a non-www prefix property does not cover www');
    assert.equal(chooseProperty([...properties, { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' }], 'https://shop.example.com')?.siteUrl, 'sc-domain:example.com');
    assert.equal(chooseProperty(properties, 'https://unrelated.org'), undefined);
  });

  test('reads performance, inspections and sitemaps, paging through large results', async () => {
    const http = client();
    queries = 0;
    const data = await fetchGscData(http, { token: 'ok', expiresAt: Date.now() + 1000, source: 'environment' }, {
      url: 'https://example.com/', inspectUrls: ['https://example.com/en/'], now: new Date('2026-11-04T12:00:00Z'), endpoints: endpoints(),
    });
    await http.close();
    assert.equal(data.property.siteUrl, 'sc-domain:example.com');
    assert.deepEqual(data.period, { start: '2026-10-05', end: '2026-11-01' });
    assert.equal(data.byQuery.length, 25_000);
    assert.equal(queries, 7, 'the query dimension needed a second page');
    assert.equal(data.inspections[0]?.coverageState, 'Submitted and indexed');
    assert.equal(data.inspections[0]?.richResults[0]?.type, 'Breadcrumbs');
    assert.deepEqual([data.sitemaps[0]?.errors, data.truncated], [1, false]);
  });

  test('says why no property was read, naming an option only when the caller has one', async () => {
    const http = client();
    const token = { token: 'ok', expiresAt: Date.now() + 1000, source: 'environment' as const };
    const read = (options: { url: string; siteUrl?: string; propertyOption?: string }) => fetchGscData(http, token, { ...options, endpoints: endpoints() });
    try {
      await assert.rejects(read({ url: 'https://unrelated.net/' }), (error: Error) => {
        assert.equal(error.message, 'No verified Search Console property covers https://unrelated.net. Add and verify the site in Search Console.');
        return true;
      });
      await assert.rejects(read({ url: 'https://unrelated.net/', propertyOption: '--gsc-property' }),
        /Add and verify the site in Search Console, or pass the property that holds its data with --gsc-property, for example sc-domain:example\.com\.$/u);
      for (const siteUrl of ['sc-domain:missing.example', 'https://pending.example.net/']) {
        await assert.rejects(read({ url: 'https://example.com/', siteUrl, propertyOption: '--gsc-property' }), (error: Error) => {
          assert.equal(error.message, `${siteUrl} is not a verified Search Console property this credential can read.`);
          return true;
        });
      }
    } finally {
      await http.close();
    }
  });

  test('turns an expired token into an authentication error', async () => {
    const http = client();
    await assert.rejects(fetchGscData(http, { token: 'expired', expiresAt: 0, source: 'environment' }, { url: 'https://example.com/', endpoints: endpoints() }), GoogleAuthError);
    await http.close();
  });

  test('computes complete reporting periods', () => {
    assert.deepEqual(reportingPeriods(new Date('2026-11-04T00:00:00Z')), {
      current: { start: '2026-10-05', end: '2026-11-01' }, previous: { start: '2026-09-07', end: '2026-10-04' },
    });
  });
});
