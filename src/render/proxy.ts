import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import { addressAllowed, type NetworkPolicy } from '../fetch/ip-guard.ts';

type Lookup = typeof dnsLookup;

export interface ProxyDecision {
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
  readonly reason?: 'blocked-address' | 'dns' | 'unsupported';
}

export interface GuardedProxy {
  /** `http://127.0.0.1:<port>`, for Chrome's --proxy-server. */
  readonly url: string;
  /** Connections that were refused, in order. */
  readonly refused: readonly ProxyDecision[];
  close(): Promise<void>;
}

function resolveAllowed(policy: NetworkPolicy, lookup: Lookup, host: string): Promise<{ address?: string; reason?: ProxyDecision['reason'] }> {
  const bare = host.replace(/^\[|\]$/gu, '');
  if (isIP(bare) !== 0) return Promise.resolve(addressAllowed(policy, bare, bare) ? { address: bare } : { reason: 'blocked-address' });
  return new Promise(resolve => {
    lookup(bare, { all: true }, (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error || addresses.length === 0) return resolve({ reason: 'dns' });
      const allowed = addresses.find(entry => addressAllowed(policy, bare, entry.address));
      resolve(allowed ? { address: allowed.address } : { reason: 'blocked-address' });
    });
  });
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | undefined {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/u.exec(authority);
  if (!match) return undefined;
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  return port > 0 && port < 65536 ? { host: match[1]!, port } : undefined;
}

/**
 * Starts a local forward proxy for the audit browser. It resolves every host itself and refuses addresses the
 * network policy blocks, so a page cannot reach private services, including through DNS rebinding.
 */
export async function startGuardedProxy(policy: NetworkPolicy, lookup: Lookup = dnsLookup): Promise<GuardedProxy> {
  const refused: ProxyDecision[] = [];
  const sockets = new Set<Socket>();
  const refuse = (decision: ProxyDecision) => {
    refused.push(decision);
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      refuse({ host: target.hostname, port: Number(target.port) || 0, allowed: false, reason: 'unsupported' });
      res.writeHead(403).end();
      return;
    }
    const port = Number(target.port) || 80;
    void resolveAllowed(policy, lookup, target.hostname).then(({ address, reason }) => {
      if (!address) {
        refuse({ host: target.hostname, port, allowed: false, reason: reason ?? 'blocked-address' });
        res.writeHead(403).end();
        return;
      }
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      const upstream = httpRequest({ host: address, port, method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    const authority = splitHostPort(req.url ?? '', 443);
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    void resolveAllowed(policy, lookup, authority.host).then(({ address, reason }) => {
      if (!address) {
        refuse({ host: authority.host, port: authority.port, allowed: false, reason: reason ?? 'blocked-address' });
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = connect({ host: address, port: authority.port }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
  });

  // Plain-text WebSocket upgrades are not tunnelled; encrypted ones arrive as CONNECT.
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const target = (() => { try { return new URL(req.url ?? ''); } catch { return undefined; } })();
    refuse({ host: target?.hostname ?? '', port: Number(target?.port) || 0, allowed: false, reason: 'unsupported' });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    refused,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
