import { isIP } from 'node:net';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'carrier-nat'
  | 'unique-local'
  | 'multicast'
  | 'documentation'
  | 'reserved'
  | 'unspecified';

const ipv4Ranges: ReadonlyArray<readonly [string, number, AddressClass]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-nat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function ipv4Value(address: string): number {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function inRange(value: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((ipv4Value(base) & mask) >>> 0);
}

function classifyIPv4(address: string): AddressClass {
  const value = ipv4Value(address);
  for (const [base, bits, kind] of ipv4Ranges) if (inRange(value, base, bits)) return kind;
  return 'public';
}

/** Expands an IPv6 address, including an embedded dotted IPv4 tail, to eight 16-bit groups. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  if (dotted) {
    const value = ipv4Value(dotted[1]!);
    text = `${text.slice(0, dotted.index)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill('0'), ...right].map(group => Number.parseInt(group, 16));
}

function embeddedIPv4(high: number, low: number): string {
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function classifyIPv6(address: string): AddressClass {
  const g = ipv6Groups(address);
  const [a = 0, b = 0] = g;
  const zeroPrefix = (count: number) => g.slice(0, count).every(group => group === 0);
  if (g.every(group => group === 0)) return 'unspecified';
  if (zeroPrefix(7) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) take the class of the embedded IPv4 address.
  if (zeroPrefix(5) && g[5] === 0xffff) return classifyIPv4(embeddedIPv4(g[6]!, g[7]!));
  if (a === 0x64 && b === 0xff9b && g.slice(2, 6).every(group => group === 0)) return classifyIPv4(embeddedIPv4(g[6]!, g[7]!));
  if (zeroPrefix(6)) return 'reserved';
  if (a === 0x64 && b === 0xff9b && g[2] === 1) return 'private';
  if (a === 0x2002) return classifyIPv4(embeddedIPv4(b, g[2]!));
  if (a === 0x2001 && b === 0x0db8) return 'documentation';
  if (a === 0x2001 && b === 0) return 'reserved';
  if (a === 0x0100 && zeroPrefix(4)) return 'reserved';
  if ((a & 0xfe00) === 0xfc00) return 'unique-local';
  if ((a & 0xffc0) === 0xfe80) return 'link-local';
  if ((a & 0xffc0) === 0xfec0) return 'reserved';
  if ((a & 0xff00) === 0xff00) return 'multicast';
  return (a & 0xe000) === 0x2000 ? 'public' : 'reserved';
}

/** Classifies an IPv4 or IPv6 literal. Brackets and an IPv6 zone index are ignored. */
export function classifyAddress(address: string): AddressClass {
  const literal = address.replace(/^\[|\]$/gu, '').replace(/%.*$/u, '');
  const family = isIP(literal);
  if (family === 4) return classifyIPv4(literal);
  if (family === 6) return classifyIPv6(literal);
  throw new TypeError(`Not an IP address: ${address}`);
}

export interface NetworkPolicy {
  /** Allows every non-public address, for audits of local or staging sites. */
  readonly allowPrivate: boolean;
  /** Lowercase host names allowed to resolve to non-public addresses, such as the origin given to `verify --origin`. */
  readonly privateHosts?: ReadonlySet<string>;
}

export const publicOnly: NetworkPolicy = { allowPrivate: false };

export function addressAllowed(policy: NetworkPolicy, host: string, address: string): boolean {
  if (policy.allowPrivate) return true;
  if (policy.privateHosts?.has(host.replace(/^\[|\]$/gu, '').toLowerCase())) return true;
  return classifyAddress(address) === 'public';
}
