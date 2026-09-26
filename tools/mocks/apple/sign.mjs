// Test-only JWS signer for the App Store mock. Uses the chain written by make_chain.py.
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, sign, verify, createPublicKey } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

/** Generates a fresh chain in a temp dir (needs the repo .venv with `cryptography`). */
export function makeChain() {
  const dir = mkdtempSync(join(tmpdir(), 'apple-chain-'));
  const python = process.env.BOILPAYMENT_PYTHON ?? join(ROOT, '.venv', 'bin', 'python');
  execFileSync(python, [join(HERE, 'make_chain.py'), dir], { stdio: 'ignore' });
  return dir;
}

export function loadChain(dir, stem = '') {
  const pem = (n) => readFileSync(join(dir, `${stem}${n}.pem`), 'utf8');
  const der = (p) => new X509Certificate(p).raw.toString('base64');
  return {
    key: readFileSync(join(dir, `${stem}leaf.key`), 'utf8'),
    x5c: [der(pem('leaf')), der(pem('intermediate')), der(pem('root'))],
    rootPem: pem('root'),
  };
}

const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signJws(payload, chain, header = {}) {
  const head = enc({ alg: 'ES256', x5c: chain.x5c, ...header });
  const body = enc(payload);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: chain.key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

/** Checks an App Store Server API bearer JWT against the mock's API key. */
export function verifyApiToken(token, apiKeyPem, bundleId) {
  const [h, b, s] = String(token).split('.');
  if (!h || !b || !s) return false;
  const pub = createPublicKey(apiKeyPem);
  if (!verify('sha256', Buffer.from(`${h}.${b}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return false;
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  return claims.aud === 'appstoreconnect-v1' && claims.bid === bundleId && claims.exp * 1000 > Date.now();
}
