// spec/cs.pseudo.md — EC:I6
// Minimal HS256 JWT, stdlib-only (node:crypto) — no jsonwebtoken dependency per ARCHITECTURE.md.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentKitError } from 'boilpayment-core';

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function sign(headerAndPayload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(headerAndPayload).digest());
}

export interface SignTokenInput { customerId: string; ttlSeconds: number; now?: Date }
export interface WidgetClaims { customerId: string; exp: number }

/** cs.widget.signToken({customerId, ttlSeconds}, secret) — app-side helper (v0 has no external JWT lib). */
export function signToken(input: SignTokenInput, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowS = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload = b64url(JSON.stringify({ sub: input.customerId, exp: nowS + input.ttlSeconds }));
  const sig = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${sig}`;
}

/** EC:I6 — cs.widget.verifyToken(token, secret) -> {customerId, exp}. Rejects bad signature or expiry. */
export function verifyToken(token: string, secret: string, opts?: { now?: Date }): WidgetClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new PaymentKitError('malformed widget token', 'widget_token_invalid');
  const [header, payload, sig] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  const sigBuf = b64urlDecode(sig);
  const expectedBuf = b64urlDecode(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new PaymentKitError('invalid widget token signature', 'widget_token_invalid');
  }
  let claims: { sub?: string; exp?: number };
  try {
    claims = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch {
    throw new PaymentKitError('malformed widget token payload', 'widget_token_invalid');
  }
  if (!claims.sub || typeof claims.exp !== 'number') {
    throw new PaymentKitError('malformed widget token claims', 'widget_token_invalid');
  }
  if (claims.exp <= Math.floor((opts?.now ?? new Date()).getTime() / 1000)) {
    throw new PaymentKitError('widget token expired', 'widget_token_expired');
  }
  return { customerId: claims.sub, exp: claims.exp };
}
