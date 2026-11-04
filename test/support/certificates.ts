/**
 * Throwaway certificates for tests: a self-signed CA and leaves it issues, generated in memory with node:crypto.
 * Nothing is written to disk and the CA key never leaves this module, so no key can end up in the repository.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const day = 86_400_000;

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER element: tag, definite length and contents. */
function der(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]) => der(0x30, ...items);
const set = (...items: Buffer[]) => der(0x31, ...items);
const octetString = (value: Buffer) => der(0x04, value);
const bitString = (value: Buffer, unusedBits = 0) => der(0x03, Buffer.from([unusedBits]), value);
const boolean = (value: boolean) => der(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = (value: string) => der(0x0c, Buffer.from(value, 'utf8'));
const explicit = (number: number, inner: Buffer) => der(0xa0 | number, inner);

/** A non-negative INTEGER: leading zero bytes removed, and one added when the high bit would make it negative. */
function integer(value: Buffer): Buffer {
  let bytes = value;
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) bytes = bytes.subarray(1);
  return der(0x02, (bytes[0]! & 0x80) === 0 ? bytes : Buffer.concat([Buffer.from([0]), bytes]));
}

function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes: number[] = [first * 40 + second];
  for (const arc of rest) {
    const encoded = [arc % 128];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) encoded.unshift(0x80 | (value % 128));
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

/** UTCTime until 2049 and GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString();
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(digits.slice(2), 'ascii')) : der(0x18, Buffer.from(digits, 'ascii'));
}

const name = (commonName: string) => sequence(set(sequence(objectIdentifier('2.5.4.3'), utf8String(commonName))));
const ecdsaWithSha256 = sequence(objectIdentifier('1.2.840.10045.4.3.2'));

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return sequence(objectIdentifier(oid), ...(critical ? [boolean(true)] : []), octetString(value));
}

const spkiOf = (key: KeyObject) => key.export({ type: 'spki', format: 'der' });
const keyIdentifier = (spki: Buffer) => createHash('sha1').update(spki).digest();
const spkiHash = (spki: Buffer) => createHash('sha256').update(spki).digest('base64');

function pem(label: string, body: Buffer): string {
  const lines = body.toString('base64').match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

interface Signed {
  readonly subject: string;
  readonly issuer: string;
  readonly spki: Buffer;
  readonly signer: KeyObject;
  readonly validity: Validity;
  readonly extensions: readonly Buffer[];
}

function certificate(input: Signed): Buffer {
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ecdsaWithSha256,
    name(input.issuer),
    sequence(time(input.validity.notBefore), time(input.validity.notAfter)),
    name(input.subject),
    input.spki,
    explicit(3, sequence(...input.extensions)),
  );
  return sequence(tbs, ecdsaWithSha256, bitString(sign('sha256', tbs, input.signer)));
}

export interface Validity {
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/** From yesterday to a week ahead, so clock skew between the test and the TLS stack never matters. */
export function defaultValidity(now = Date.now()): Validity {
  return { notBefore: new Date(now - day), notAfter: new Date(now + 7 * day) };
}

export interface TestLeaf {
  /** The leaf certificate alone, as PEM. */
  readonly cert: string;
  /** Leaf then CA, as a server sends its chain. */
  readonly chain: string;
  /** PKCS #8 private key, as PEM. */
  readonly key: string;
  /** Base64 SHA-256 of the leaf's SubjectPublicKeyInfo, the form Chrome's SPKI allowlist takes. */
  readonly spki: string;
}

export interface TestCa {
  readonly cert: string;
  /** Base64 SHA-256 of the CA's SubjectPublicKeyInfo. */
  readonly spki: string;
  /** Issues a server certificate for these DNS names (subjectAltName, serverAuth). */
  issue(names: readonly string[], validity?: Validity): TestLeaf;
}

/** A self-signed EC P-256 CA (basicConstraints CA:true, keyCertSign and cRLSign) whose key stays in memory. */
export function createTestCa(commonName = 'Altimeter Test CA', validity: Validity = defaultValidity()): TestCa {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = spkiOf(publicKey);
  const caId = keyIdentifier(spki);
  const caCert = pem('CERTIFICATE', certificate({
    subject: commonName,
    issuer: commonName,
    spki,
    signer: privateKey,
    validity,
    extensions: [
      extension('2.5.29.19', true, sequence(boolean(true))),
      // keyCertSign (bit 5) and cRLSign (bit 6): 0b0000_0110 with the last bit unused.
      extension('2.5.29.15', true, bitString(Buffer.from([0x06]), 1)),
      extension('2.5.29.14', false, octetString(caId)),
    ],
  }));
  return {
    cert: caCert,
    spki: spkiHash(spki),
    issue(names, leafValidity = defaultValidity()) {
      if (names.length === 0) throw new Error('A leaf certificate needs at least one DNS name.');
      const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const leafSpki = spkiOf(leaf.publicKey);
      const cert = pem('CERTIFICATE', certificate({
        subject: names[0]!,
        issuer: commonName,
        spki: leafSpki,
        signer: privateKey,
        validity: leafValidity,
        extensions: [
          extension('2.5.29.19', true, sequence()),
          // digitalSignature (bit 0) with the seven other bits unused.
          extension('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),
          extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))),
          extension('2.5.29.17', false, sequence(...names.map(entry => der(0x82, Buffer.from(entry, 'ascii'))))),
          extension('2.5.29.14', false, octetString(keyIdentifier(leafSpki))),
          extension('2.5.29.35', false, sequence(der(0x80, caId))),
        ],
      }));
      return { cert, chain: `${cert}${caCert}`, key: String(leaf.privateKey.export({ type: 'pkcs8', format: 'pem' })), spki: spkiHash(leafSpki) };
    },
  };
}

export interface TestCertificates {
  readonly ca: { readonly cert: string; readonly spki: string };
  readonly leaf: TestLeaf;
}

/** A fresh CA and one leaf for `names`, valid from yesterday to a week ahead. */
export function createTestCertificates(names: readonly string[]): TestCertificates {
  const ca = createTestCa();
  return { ca: { cert: ca.cert, spki: ca.spki }, leaf: ca.issue(names) };
}
