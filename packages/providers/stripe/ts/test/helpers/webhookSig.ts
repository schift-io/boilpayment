// Test helper — builds a Stripe `Stripe-Signature` header value by hand, mirroring Stripe's
// documented scheme (https://stripe.com/docs/webhooks/signatures#verify-manually) rather than
// delegating to the SDK's own `webhooks.generateTestHeaderString` helper:
//   signed_payload = "{timestamp}.{body}"
//   v1 = HMAC-SHA256(signed_payload, secret) as hex
//   header = "t={timestamp},v1={v1}"
import { createHmac } from 'node:crypto';

export function signStripePayload(payload: string, secret: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  const signedPayload = `${timestamp}.${payload}`;
  const v1 = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}
