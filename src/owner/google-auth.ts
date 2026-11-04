import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpClient } from '../fetch/http.ts';

/** Read-only access to Search Console; Altimeter never asks for write access. */
export const searchConsoleScope = 'https://www.googleapis.com/auth/webmasters.readonly';
export const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';

export interface AccessToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
  readonly source: 'environment' | 'service-account' | 'oauth';
}

export class GoogleAuthError extends Error {}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

async function tokenRequest(client: HttpClient, endpoint: string, form: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
  const result = await client.fetch(endpoint, {
    method: 'POST',
    followRedirects: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    maxBytes: 64 * 1024,
  });
  if (result.error) throw new GoogleAuthError(`The token endpoint could not be reached (${result.error.code}).`);
  let payload: { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
  try {
    payload = JSON.parse(result.body.toString('utf8')) as typeof payload;
  } catch {
    throw new GoogleAuthError(`The token endpoint answered ${result.status} without JSON.`);
  }
  // Google's error codes are safe to show; the request and response bodies never are.
  if (result.status !== 200 || !payload.access_token) throw new GoogleAuthError(`Google refused the token request (${payload.error ?? result.status}).`);
  return payload as { access_token: string; expires_in?: number; refresh_token?: string };
}

/** A short-lived token the owner obtained elsewhere, for example from the OAuth Playground. */
export function tokenFromEnvironment(variable = 'ALTIMETER_GSC_ACCESS_TOKEN'): AccessToken | undefined {
  const token = process.env[variable]?.trim();
  return token ? { token, expiresAt: Date.now() + 50 * 60_000, source: 'environment' } : undefined;
}

interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

/** Signs a JWT bearer assertion with the service account's key and exchanges it for an access token. */
export async function tokenFromServiceAccount(client: HttpClient, keyPath: string, now = Date.now()): Promise<AccessToken> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(await readFile(keyPath, 'utf8')) as ServiceAccountKey;
  } catch {
    throw new GoogleAuthError('The service account key file could not be read as JSON.');
  }
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') throw new GoogleAuthError('The file is not a Google service account key.');
  const endpoint = key.token_uri ?? googleTokenEndpoint;
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: key.client_email, scope: searchConsoleScope, aud: endpoint, iat: issuedAt, exp: issuedAt + 3600,
  }))}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(key.private_key));
  const payload = await tokenRequest(client, endpoint, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(signature)}` });
  return { token: payload.access_token, expiresAt: now + (payload.expires_in ?? 3600) * 1000, source: 'service-account' };
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authUri: string;
  readonly tokenUri: string;
}

/** Reads a Desktop OAuth client downloaded from the owner's Google Cloud project. */
export async function readOAuthClient(path: string): Promise<OAuthClient> {
  let json: { installed?: Record<string, string> };
  try {
    json = JSON.parse(await readFile(path, 'utf8')) as typeof json;
  } catch {
    throw new GoogleAuthError('The OAuth client file could not be read as JSON.');
  }
  const installed = json.installed;
  if (!installed?.client_id || !installed.client_secret) throw new GoogleAuthError('The file is not a Desktop OAuth client ("installed" type).');
  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    authUri: installed.auth_uri ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: installed.token_uri ?? googleTokenEndpoint,
  };
}

export interface LoopbackLogin {
  /** The URL the owner opens in a browser. */
  readonly authorizationUrl: string;
  /** Resolves once Google redirects back with a code, after the code is exchanged for tokens. */
  readonly token: Promise<AccessToken>;
  readonly cancel: () => void;
}

/**
 * Starts the OAuth flow for installed apps: a one-shot server on 127.0.0.1 receives the redirect, with PKCE (S256)
 * and a random state. Nothing is stored; the caller decides whether to keep the refresh token.
 */
export async function startLoopbackLogin(client: HttpClient, oauth: OAuthClient, timeoutMs = 300_000): Promise<LoopbackLogin> {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));
  let settle!: (value: AccessToken) => void;
  let fail!: (error: Error) => void;
  const token = new Promise<AccessToken>((resolve, reject) => { settle = resolve; fail = reject; });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') return void res.writeHead(404).end();
    const respond = (status: number, text: string) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
    if (url.searchParams.get('state') !== state) return void respond(400, 'This sign-in link is not the one Altimeter started. Close this tab.');
    const code = url.searchParams.get('code');
    if (!code) {
      respond(400, 'Sign-in was cancelled. You can close this tab.');
      return void fail(new GoogleAuthError(`Sign-in did not complete (${url.searchParams.get('error') ?? 'no code'}).`));
    }
    respond(200, 'Altimeter is signed in to Search Console. You can close this tab.');
    void tokenRequest(client, oauth.tokenUri, {
      grant_type: 'authorization_code', code, client_id: oauth.clientId, client_secret: oauth.clientSecret, redirect_uri: redirectUri, code_verifier: verifier,
    }).then(payload => settle({
      token: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      source: 'oauth',
    }), fail);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const close = () => { server.closeAllConnections(); server.close(); };
  const timer = setTimeout(() => fail(new GoogleAuthError('Sign-in timed out.')), timeoutMs);
  void token.finally(() => { clearTimeout(timer); close(); }).catch(() => {});
  const authorizationUrl = `${oauth.authUri}?${new URLSearchParams({
    client_id: oauth.clientId, redirect_uri: redirectUri, response_type: 'code', scope: searchConsoleScope,
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  }).toString()}`;
  return { authorizationUrl, token, cancel: () => fail(new GoogleAuthError('Sign-in was cancelled.')) };
}

export async function refreshAccessToken(client: HttpClient, oauth: OAuthClient, refreshToken: string): Promise<AccessToken> {
  const payload = await tokenRequest(client, oauth.tokenUri, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: oauth.clientId, client_secret: oauth.clientSecret });
  return { token: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000, refreshToken, source: 'oauth' };
}
