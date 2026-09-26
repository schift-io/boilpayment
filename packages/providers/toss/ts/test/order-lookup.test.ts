// EC:A52 (round-5 audit A5-5) — only Toss's own "no such payment" answer means the order does not exist.
// A 404 from a proxy, a wrong base URL or an unknown route is an error, never "not found": treating it
// as "not found" closes an attempt that may have moved money, and a later charge bills it again.
import { describe, expect, it } from 'vitest';
import { TossProvider } from '../src/index.js';

const provider = (status: number, body: string, contentType = 'application/json') =>
  new TossProvider({ secretKey: 'test_sk_x', allowedWebhookIps: ['1.1.1.1'] }, (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as never);

describe('EC:A52 Toss getPaymentByOrderId', () => {
  it('NOT_FOUND_PAYMENT 404 means no such order', async () => {
    expect(await provider(404, JSON.stringify({ code: 'NOT_FOUND_PAYMENT', message: 'x' })).getPaymentByOrderId('ord_1')).toBeNull();
  });
  it('an HTML 404 (proxy, wrong base) is an error', async () => {
    await expect(provider(404, '<html>Not Found</html>', 'text/html').getPaymentByOrderId('ord_1')).rejects.toThrow();
  });
  it('a JSON 404 with another code (unknown route) is an error', async () => {
    await expect(provider(404, JSON.stringify({ code: 'NOT_FOUND', message: 'no route' })).getPaymentByOrderId('ord_1')).rejects.toThrow();
  });
});
