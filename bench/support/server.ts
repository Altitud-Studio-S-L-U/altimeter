import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { createSecureContext, type SecureContext } from 'node:tls';
import zlib from 'node:zlib';

export interface BenchRequest {
  readonly secure: boolean;
  /** Lowercase host name from the Host header, without the port. */
  readonly host: string;
  /** The TLS server name the client sent, for https requests. */
  readonly sni?: string;
  readonly method: string;
  /** Path and query, as requested. */
  readonly path: string;
  readonly pathname: string;
  readonly headers: IncomingHttpHeaders;
}

export interface BenchResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string | Buffer;
  /** Compress text responses with br or gzip when the client accepts it (default true). */
  readonly compress?: boolean;
}

export interface KeyPair {
  readonly key: string;
  /** The certificate chain the server sends, leaf first. */
  readonly cert: string;
}

export interface VirtualHostOptions {
  /** The certificate for every server name without one of its own. */
  readonly tls: KeyPair;
  /** Certificates by server name, to give one host an expired or mismatched certificate. */
  readonly hostTls?: Readonly<Record<string, KeyPair>>;
  readonly handle: (request: BenchRequest) => BenchResponse;
}

export interface VirtualHostServer {
  /** The one port that answers both plain HTTP and HTTPS. */
  readonly port: number;
  /** Every request received, in order. */
  readonly requests: readonly BenchRequest[];
  close(): Promise<void>;
}

const compressible = /^(?:text\/|application\/(?:xml|json|javascript|ld\+json|manifest\+json|xhtml\+xml|rss\+xml|atom\+xml)|image\/svg\+xml)/iu;

function encode(request: BenchRequest, response: BenchResponse, body: Buffer, headers: Record<string, string | string[]>): Buffer {
  const type = String(headers['content-type'] ?? '');
  if (response.compress === false || body.length === 0 || !compressible.test(type) || headers['content-encoding'] !== undefined) return body;
  const accepted = String(request.headers['accept-encoding'] ?? '').toLowerCase();
  const vary = headers.vary === undefined ? [] : [headers.vary].flat();
  if (!vary.some(value => /accept-encoding/iu.test(value))) headers.vary = [...vary, 'Accept-Encoding'].join(', ');
  if (/\bbr\b/u.test(accepted)) {
    headers['content-encoding'] = 'br';
    return zlib.brotliCompressSync(body);
  }
  if (/\bgzip\b/u.test(accepted)) {
    headers['content-encoding'] = 'gzip';
    return zlib.gzipSync(body);
  }
  return body;
}

function respond(handle: VirtualHostOptions['handle'], requests: BenchRequest[], secure: boolean) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/u, '').toLowerCase();
    const path = req.url ?? '/';
    const sni = secure ? (req.socket as Socket & { servername?: string | false }).servername : undefined;
    const request: BenchRequest = {
      secure, host, method: req.method ?? 'GET', path, pathname: path.replace(/[?#].*$/su, ''), headers: req.headers,
      ...(typeof sni === 'string' ? { sni } : {}),
    };
    requests.push(request);
    let response: BenchResponse;
    try {
      response = handle(request);
    } catch (error) {
      response = { status: 500, headers: { 'content-type': 'text/plain' }, body: error instanceof Error ? error.message : 'handler failed' };
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = typeof value === 'string' ? value : [...value];
    const raw = typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : response.body ?? Buffer.alloc(0);
    const body = encode(request, response, raw, headers);
    if (headers['transfer-encoding'] === undefined) headers['content-length'] = String(body.length);
    res.writeHead(response.status ?? 200, headers);
    res.end(request.method === 'HEAD' ? undefined : body);
  };
}

function listen(server: Server | NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * Serves plain HTTP and HTTPS on one loopback port, so http variants, https redirects and www counterparts keep
 * the same explicit port. The first byte of each connection decides: 0x16 opens a TLS handshake. The Host header
 * picks the site, and SNI picks the certificate.
 */
export async function startVirtualHosts(options: VirtualHostOptions): Promise<VirtualHostServer> {
  const requests: BenchRequest[] = [];
  const contexts = new Map<string, SecureContext>(Object.entries(options.hostTls ?? {}).map(([name, pair]) => [name.toLowerCase(), createSecureContext(pair)]));
  const plain = createHttpServer(respond(options.handle, requests, false));
  const secure = createHttpsServer({
    ...options.tls,
    SNICallback: (servername, callback) => callback(null, contexts.get(servername.toLowerCase())),
  }, respond(options.handle, requests, true));
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const [plainPort, securePort] = await Promise.all([listen(plain), listen(secure)]);
  // The front port only forwards bytes, so neither server depends on how Node hands an open socket to another server.
  const front = createNetServer(client => {
    track(client);
    client.on('error', () => client.destroy());
    client.once('data', (first: Buffer) => {
      client.pause();
      const upstream = connect({ port: first[0] === 0x16 ? securePort : plainPort, host: '127.0.0.1' }, () => {
        upstream.write(first);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      track(upstream);
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
  });
  const port = await listen(front);
  return {
    port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      plain.closeAllConnections();
      secure.closeAllConnections();
      await Promise.all([front, plain, secure].map(server => new Promise(resolve => server.close(resolve))));
    },
  };
}
