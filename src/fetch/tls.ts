import type { lookup as dnsLookup } from 'node:dns';
import { connect, type PeerCertificate } from 'node:tls';
import { addressAllowed, publicOnly, type NetworkPolicy } from './ip-guard.ts';
import { guardedLookup } from './http.ts';

export interface TlsFacts {
  readonly host: string;
  readonly port: number;
  /** True when the chain verifies against the trusted roots and the certificate matches the host. */
  readonly authorized: boolean;
  /** The verification failure, such as CERT_HAS_EXPIRED or ERR_TLS_CERT_ALTNAME_INVALID. */
  readonly error?: string;
  readonly protocol?: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly daysRemaining?: number;
  readonly subjectAltNames: readonly string[];
  readonly issuer?: string;
  /** Number of certificates the server sent, leaf first. */
  readonly chainLength: number;
}

function chainLength(certificate: PeerCertificate & { issuerCertificate?: PeerCertificate }): number {
  let count = 0;
  const seen = new Set<string>();
  for (let current: (PeerCertificate & { issuerCertificate?: PeerCertificate }) | undefined = certificate; current && current.fingerprint256; current = current.issuerCertificate) {
    if (seen.has(current.fingerprint256)) break;
    seen.add(current.fingerprint256);
    count += 1;
  }
  return count;
}

/** Opens a TLS connection like a browser would and reports what the certificate looks like. */
export function inspectTls(host: string, options: { port?: number; policy?: NetworkPolicy; lookup?: typeof dnsLookup; timeoutMs?: number; ca?: string } = {}): Promise<TlsFacts> {
  const port = options.port ?? 443;
  const policy = options.policy ?? publicOnly;
  return new Promise(resolve => {
    const done = (facts: TlsFacts) => {
      socket.destroy();
      resolve(facts);
    };
    const socket = connect({
      host,
      port,
      servername: /^\d+\.\d+\.\d+\.\d+$/u.test(host) ? '' : host,
      rejectUnauthorized: false,
      lookup: guardedLookup(policy, options.lookup) as never,
      timeout: options.timeoutMs ?? 10_000,
      ...(options.ca ? { ca: options.ca } : {}),
    }, () => {
      const certificate = socket.getPeerCertificate(true);
      const validTo = certificate.valid_to ? new Date(certificate.valid_to) : undefined;
      const error = socket.authorizationError ? String((socket.authorizationError as Error & { code?: string }).code ?? socket.authorizationError) : undefined;
      done({
        host,
        port,
        authorized: socket.authorized,
        ...(error ? { error } : {}),
        ...(socket.getProtocol() ? { protocol: socket.getProtocol()! } : {}),
        ...(certificate.valid_from ? { validFrom: new Date(certificate.valid_from).toISOString() } : {}),
        ...(validTo ? { validTo: validTo.toISOString(), daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86_400_000) } : {}),
        subjectAltNames: (certificate.subjectaltname ?? '').split(/,\s*/u).filter(Boolean).map(name => name.replace(/^DNS:/u, '')),
        ...(certificate.issuer?.O || certificate.issuer?.CN ? { issuer: String(certificate.issuer.O ?? certificate.issuer.CN) } : {}),
        chainLength: certificate.fingerprint256 ? chainLength(certificate) : 0,
      });
    });
    socket.on('timeout', () => done({ host, port, authorized: false, error: 'TIMEOUT', subjectAltNames: [], chainLength: 0 }));
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code ?? 'TLS_ERROR';
      done({ host, port, authorized: false, error: code === 'ALTIMETER_BLOCKED_ADDRESS' ? 'BLOCKED_ADDRESS' : code, subjectAltNames: [], chainLength: 0 });
    });
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) && !addressAllowed(policy, host, host)) done({ host, port, authorized: false, error: 'BLOCKED_ADDRESS', subjectAltNames: [], chainLength: 0 });
  });
}
