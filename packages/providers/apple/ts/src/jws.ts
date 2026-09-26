// EC:N1 N3 — App Store signed data (JWS compact, ES256, x5c chain) verification.
// spec: ../../spec/apple.pseudo.md [EC:N1]
//
// Implemented with node:crypto instead of @apple/app-store-server-library: the library's API client
// fixes the store hostnames (no base-URL injection for the local mock), and the verifier is small.
// Checks mirror the library's SignedDataVerifier: chain leaf <- intermediate <- trusted root, the
// Apple marker OIDs on leaf and intermediate, validity dates, then the ES256 signature itself.
import { X509Certificate, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { PaymentKitError } from 'boilpayment-core';

/** Apple App Store receipt signing (leaf) and WWDR intermediate marker OIDs. */
export const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_WWDR_OID = '1.2.840.113635.100.6.2.1';

function oidDer(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const body: number[] = [40 * parts[0] + parts[1]];
  for (const n of parts.slice(2)) {
    const bytes = [n & 0x7f];
    for (let rest = Math.floor(n / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80);
    body.push(...bytes);
  }
  return Buffer.from([0x06, body.length, ...body]);
}

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

function invalid(message: string): PaymentKitError {
  return new PaymentKitError(message, 'iap_signature_invalid');
}

function within(cert: X509Certificate, at: Date): boolean {
  return new Date(cert.validFrom) <= at && at <= new Date(cert.validTo);
}

export interface VerifyJwsOptions {
  /** Trusted roots as PEM (production: Apple Root CA - G3 from apple.com/certificateauthority). */
  rootCertificates: readonly string[];
  now?: Date;
}

/** Verifies an App Store JWS and returns its decoded payload. Throws iap_signature_invalid. */
export function verifyAppleJws<T = Record<string, unknown>>(token: string, options: VerifyJwsOptions): T {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw invalid('signed data is not a compact JWS');
  let header: { alg?: string; x5c?: string[] };
  let payload: T;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    payload = JSON.parse(b64url(parts[1]).toString('utf8')) as T;
  } catch {
    throw invalid('signed data is not valid JSON');
  }
  if (header.alg !== 'ES256') throw invalid('signed data must use ES256');
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3) throw invalid('signed data needs a 3-certificate x5c chain');
  let chain: X509Certificate[];
  try {
    chain = header.x5c.map((der) => new X509Certificate(Buffer.from(der, 'base64')));
  } catch {
    throw invalid('x5c certificate could not be parsed');
  }
  const [leaf, intermediate, presentedRoot] = chain;
  const roots = options.rootCertificates.map((pem) => new X509Certificate(pem));
  const root = roots.find((r) => r.fingerprint256 === presentedRoot.fingerprint256);
  if (!root) throw invalid('x5c chain does not end at a trusted root');
  const at = options.now ?? new Date();
  if (!intermediate.ca || leaf.ca) throw invalid('x5c chain has the wrong CA flags');
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw invalid('intermediate is not signed by the trusted root');
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw invalid('leaf is not signed by the intermediate');
  if (!within(leaf, at) || !within(intermediate, at) || !within(root, at)) throw invalid('x5c certificate is outside its validity period');
  if (!leaf.raw.includes(oidDer(APPLE_LEAF_OID))) throw invalid('leaf lacks the App Store signing OID');
  if (!intermediate.raw.includes(oidDer(APPLE_WWDR_OID))) throw invalid('intermediate lacks the Apple WWDR OID');
  const signature = b64url(parts[2]);
  if (signature.length !== 64) throw invalid('ES256 signature must be 64 bytes');
  const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  if (!ok) throw invalid('JWS signature does not verify');
  return payload;
}

/** ES256 JWT for the App Store Server API (bearer token), signed with the .p8 key. */
export function appStoreApiToken(input: { issuerId: string; keyId: string; privateKey: string; bundleId: string; now?: Date }): string {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const head = enc({ alg: 'ES256', kid: input.keyId, typ: 'JWT' });
  const body = enc({ iss: input.issuerId, iat, exp: iat + 300, aud: 'appstoreconnect-v1', bid: input.bundleId });
  const key = createPublicKeySafe(input.privateKey);
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

function createPublicKeySafe(privateKeyPem: string): string {
  // Validates the PEM early (createPublicKey throws on a malformed key) and returns it unchanged.
  createPublicKey(privateKeyPem);
  return privateKeyPem;
}
