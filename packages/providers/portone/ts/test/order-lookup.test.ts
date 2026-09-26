// EC:A52 (round-5 audit A5-5) — only PortOne's PAYMENT_NOT_FOUND means the order does not exist.
import { describe, expect, it } from 'vitest';
import { PortoneProvider } from '../src/index.js';

const provider = (status: number, body: string, contentType = 'application/json') =>
  new PortoneProvider({ apiSecret: 's', storeId: 'st', webhookSecret: 'whsec_c2VjcmV0', scheduling: 'self' },
    (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as never);

describe('EC:A52 PortOne getPaymentByOrderId', () => {
  it('PAYMENT_NOT_FOUND 404 means no such order', async () => {
    expect(await provider(404, JSON.stringify({ type: 'PAYMENT_NOT_FOUND', message: 'x' })).getPaymentByOrderId('ord_1')).toBeNull();
  });
  it('an HTML 404 (proxy, wrong base) is an error', async () => {
    await expect(provider(404, '<html>Not Found</html>', 'text/html').getPaymentByOrderId('ord_1')).rejects.toThrow();
  });
  it('a JSON 404 of another type (unknown route) is an error', async () => {
    await expect(provider(404, JSON.stringify({ type: 'NOT_FOUND', message: 'no route' })).getPaymentByOrderId('ord_1')).rejects.toThrow();
  });
});
