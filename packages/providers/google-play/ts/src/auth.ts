// EC:N1 — Google auth pieces, implemented with node:crypto (no google-auth-library): both are
// small, and base URLs / JWKS / token endpoint must be injectable for the local mock.
//   1. Pub/Sub push OIDC token verification (RS256 JWT against Google's JWKS).
//      https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
//   2. Service-account access token (JWT bearer grant) for the androidpublisher API.
//      https://developers.google.com/identity/protocols/oauth2/service-account#httprest
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
export const ANDROIDPUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface PubsubAuthConfig {
  /** The audience configured on the push subscription. */
  audience: string;
  /** The service account the push subscription authenticates as. */
  serviceAccountEmail: string;
  jwksUrl?: string;
  issuers?: string[];
}

export class PushAuthError extends Error {}

const b64 = (s: string) => Buffer.from(s, 'base64url');

let jwksCache: { url: string; keys: (JsonWebKey & { kid?: string })[]; at: number } | null = null;

async function jwks(url: string, refresh: boolean): Promise<(JsonWebKey & { kid?: string })[]> {
  if (!refresh && jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new PushAuthError(`jwks fetch failed: ${res.status}`);
  const keys = ((await res.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys;
  jwksCache = { url, keys, at: Date.now() };
  return keys;
}

/** Verifies `Authorization: Bearer <OIDC JWT>` from a Pub/Sub push. Throws PushAuthError. */
export async function verifyPushToken(authorization: string | undefined, config: PubsubAuthConfig, now = new Date()): Promise<Record<string, unknown>> {
  if (!authorization?.startsWith('Bearer ')) throw new PushAuthError('push request has no bearer token');
  const parts = authorization.slice(7).split('.');
  if (parts.length !== 3) throw new PushAuthError('push token is not a JWT');
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64(parts[0]).toString('utf8'));
    claims = JSON.parse(b64(parts[1]).toString('utf8'));
  } catch {
    throw new PushAuthError('push token is not valid JSON');
  }
  if (header.alg !== 'RS256') throw new PushAuthError('push token must be RS256');
  const url = config.jwksUrl ?? GOOGLE_JWKS_URL;
  let key = (await jwks(url, false)).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks(url, true)).find((k) => k.kid === header.kid);
  if (!key) throw new PushAuthError('push token signed by an unknown key');
  const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), b64(parts[2]));
  if (!ok) throw new PushAuthError('push token signature does not verify');
  const nowSec = now.getTime() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp < nowSec) throw new PushAuthError('push token expired');
  if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) throw new PushAuthError('push token issued in the future');
  if (!(config.issuers ?? GOOGLE_ISSUERS).includes(String(claims.iss))) throw new PushAuthError('push token issuer is not Google');
  if (claims.aud !== config.audience) throw new PushAuthError('push token audience mismatch');
  if (claims.email !== config.serviceAccountEmail || claims.email_verified !== true) throw new PushAuthError('push token is not from the configured service account');
  return claims;
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Access token for androidpublisher, cached until one minute before expiry. */
export class ServiceAccountTokens {
  private cached: { token: string; until: number } | null = null;
  constructor(private readonly account: ServiceAccount) {}

  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.until) return this.cached.token;
    const tokenUri = this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(Date.now() / 1000);
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = enc({ alg: 'RS256', typ: 'JWT' });
    const body = enc({ iss: this.account.client_email, scope: ANDROIDPUBLISHER_SCOPE, aud: tokenUri, iat, exp: iat + 3600 });
    const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), this.account.private_key).toString('base64url');
    const res = await fetch(tokenUri, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }).toString(),
    });
    if (!res.ok) throw new Error(`google token request failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.cached = { token: json.access_token, until: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000 };
    return json.access_token;
  }
}
