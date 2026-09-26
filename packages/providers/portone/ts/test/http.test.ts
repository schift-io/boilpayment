// Phase 6 regression tests — HTTP-calling methods driven through an injected fetch.
// No real network calls. Covers billing-key charge, cancel (incl. D14 partial-cancel
// PG rejection), and schedule (provider-side scheduled billing), per
// spec/portone.pseudo.md "[EC:F] issueBillingKey / chargeBillingKey / schedulePayment /
// cancelSchedules" and "[EC:D4 D13 D14 D6] refund".
import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderError } from '@schift/payment-kit-core';
import { PortoneProvider } from '../src/index.js';

const API_SECRET = 'test_sk_dummy';
const STORE_ID = 'store_dummy';
const WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

function makeCapturingFetch(respond: (call: Captured) => { status: number; body: unknown }) {
  const calls: Captured[] = [];
  const fetchStub: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://api.portone.io', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    const call: Captured = { method, path, headers, body };
    calls.push(call);
    const { status, body: respBody } = respond(call);
    return { ok: status >= 200 && status < 300, status, json: async () => respBody } as Response;
  };
  return { fetchStub, calls };
}

function makeProvider(fetchStub: typeof fetch, scheduling: 'provider' | 'self' = 'provider') {
  return new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET, scheduling }, fetchStub);
}

describe('[EC:F] PortoneProvider.chargeBillingKey', () => {
  let calls: Captured[];
  let provider: PortoneProvider;

  beforeEach(() => {
    // Real PayWithBillingKeyResponse shape (verified against the V2 OpenAPI spec): only
    // `{ payment: { pgTxId, paidAt } }` — a slim completion summary, not a full Payment.
    const PAYMENT_RESPONSE = { payment: { pgTxId: 'pg_tx_1', paidAt: '2026-09-01T00:00:05.000Z' } };
    const cap = makeCapturingFetch(() => ({ status: 200, body: PAYMENT_RESPONSE }));
    calls = cap.calls;
    provider = makeProvider(cap.fetchStub);
  });

  it('[EC:F] sends POST /payments/{orderId}/billing-key with PortOne auth header and full body', async () => {
    const payment = await provider.chargeBillingKey({
      billingKey: 'billing-key-abcdef1234',
      amount: { amountMinor: 9900, currency: 'KRW' },
      orderId: 'order_charge_1',
      customerRef: 'cus_abc',
      idempotencyKey: 'charge:cus_abc:2026-09',
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/payments/order_charge_1/billing-key');
    expect(call.headers['authorization']).toBe(`PortOne ${API_SECRET}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({
      storeId: STORE_ID,
      billingKey: 'billing-key-abcdef1234',
      orderName: 'Subscription charge',
      amount: { total: 9900 },
      currency: 'KRW',
      customer: { id: 'cus_abc' },
    });
    expect(payment.status).toBe('succeeded');
    expect(payment.id).toBe('order_charge_1');
  });

  it('[EC:F] orderId (not an Idempotency-Key header) is the idempotency mechanism — no Idempotency-Key header is sent', async () => {
    await provider.chargeBillingKey({
      billingKey: 'billing-key-abcdef1234',
      amount: { amountMinor: 9900, currency: 'KRW' },
      orderId: 'order_charge_1',
      customerRef: 'cus_abc',
      idempotencyKey: 'charge:cus_abc:2026-09',
    });
    const headerKeys = Object.keys(calls[0].headers);
    expect(headerKeys.some((k) => k.includes('idempotency'))).toBe(false);
    expect(calls[0].path).toContain('order_charge_1');
  });

  it('[EC:F] a distinct orderId per attempt produces a distinct path — this is how retries stay idempotent', async () => {
    await provider.chargeBillingKey({ billingKey: 'bk_1', amount: { amountMinor: 9900, currency: 'KRW' }, orderId: 'order_charge_1', customerRef: 'cus_abc', idempotencyKey: 'x' });
    await provider.chargeBillingKey({ billingKey: 'bk_1', amount: { amountMinor: 9900, currency: 'KRW' }, orderId: 'order_charge_2', customerRef: 'cus_abc', idempotencyKey: 'y' });
    expect(calls[0].path).toBe('/payments/order_charge_1/billing-key');
    expect(calls[1].path).toBe('/payments/order_charge_2/billing-key');
  });
});

describe('[EC:D4 D6] PortoneProvider.refund — full and partial cancel', () => {
  it('[EC:D4] full-amount cancel sends POST /payments/{paymentRef}/cancel with storeId, reason and amount', async () => {
    const CANCEL_RESPONSE = { cancellation: { status: 'SUCCEEDED', id: 'cxl_full_1', totalAmount: 15000, cancelledAt: '2026-09-02T00:00:00.000Z' } };
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: CANCEL_RESPONSE }));
    const provider = makeProvider(fetchStub);
    const refund = await provider.refund({
      paymentRef: 'example-payment-id',
      amount: { amountMinor: 15000, currency: 'KRW' },
      reason: 'customer request',
      idempotencyKey: 'revoke:1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/payments/example-payment-id/cancel');
    expect(calls[0].headers['authorization']).toBe(`PortOne ${API_SECRET}`);
    expect(calls[0].body).toEqual({ storeId: STORE_ID, reason: 'customer request', amount: 15000 });
    // EC:D6 — refund currency comes from the caller's Money.currency (== payment.currency), not invented
    expect(refund.amount).toEqual({ amountMinor: 15000, currency: 'KRW' });
    expect(refund.status).toBe('succeeded');
  });

  it('[EC:D4] partial cancel includes amount < full payment total in the request body', async () => {
    const CANCEL_RESPONSE = { cancellation: { status: 'SUCCEEDED', id: 'cxl_partial_1', totalAmount: 5000, cancelledAt: '2026-09-02T00:00:00.000Z' } };
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: CANCEL_RESPONSE }));
    const provider = makeProvider(fetchStub);
    const refund = await provider.refund({
      paymentRef: 'example-payment-id',
      amount: { amountMinor: 5000, currency: 'KRW' },
      reason: 'partial refund',
      idempotencyKey: 'revoke:2',
    });
    expect(calls[0].body).toMatchObject({ amount: 5000 });
    expect(refund.amount.amountMinor).toBe(5000);
  });

  it('[EC:D13] refund with extra.refundAccount (virtual-account refund) includes refundAccount in the body', async () => {
    const CANCEL_RESPONSE = { cancellation: { status: 'SUCCEEDED', id: 'cxl_va_1', totalAmount: 20000, cancelledAt: '2026-09-02T00:00:00.000Z' } };
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: CANCEL_RESPONSE }));
    const provider = makeProvider(fetchStub);
    const refundAccount = { bank: '004', accountNumber: '110-123-456789', holderName: '홍길동' };
    await provider.refund({
      paymentRef: 'va-payment-id',
      amount: { amountMinor: 20000, currency: 'KRW' },
      reason: 'virtual account refund',
      idempotencyKey: 'revoke:3',
      extra: { refundAccount },
    });
    expect(calls[0].body).toEqual({ storeId: STORE_ID, reason: 'virtual account refund', amount: 20000, refundAccount });
  });

  it('[EC:D14] PG rejects partial cancel (unsupported) -> PortOne error response propagates as ProviderError, not silently swallowed', async () => {
    // provider.capabilities().partialRefund stays true — deny_partial is observed by the
    // caller as a thrown error, per spec: "provider 는 사전 차단하지 않고 PortOne 이 반환하는
    // 에러를 그대로 전파한다 (deny_partial 은 호출자가 에러로 관찰)".
    const { fetchStub, calls } = makeCapturingFetch(() => ({
      status: 400,
      body: { message: 'Selected PG does not support partial cancellation', type: 'PARTIAL_CANCEL_NOT_SUPPORTED' },
    }));
    const provider = makeProvider(fetchStub);
    expect(provider.capabilities().partialRefund).toBe(true);

    let thrown: unknown;
    try {
      await provider.refund({
        paymentRef: 'installment-payment-id',
        amount: { amountMinor: 3000, currency: 'KRW' },
        reason: 'partial refund attempt',
        idempotencyKey: 'revoke:4',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    const err = thrown as ProviderError;
    expect(err.failure.providerCode).toBe('PARTIAL_CANCEL_NOT_SUPPORTED');
    expect(err.failure.userMessage).toBe('Selected PG does not support partial cancellation');
    // the request was still made with the requested partial amount — no client-side pre-block
    expect(calls[0].body).toMatchObject({ amount: 3000 });
  });
});

describe('[EC:F] PortoneProvider.schedulePayment — provider-side scheduled billing', () => {
  it('[EC:F] sends POST /payments/{orderId}/schedule with billingKey, amount, currency, customer and timeToPay', async () => {
    const SCHEDULE_RESPONSE = { schedule: { id: 'sch_1', status: 'SCHEDULED' } };
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: SCHEDULE_RESPONSE }));
    const provider = makeProvider(fetchStub, 'provider');
    const timeToPay = new Date('2026-10-01T00:00:00.000Z');
    const result = await provider.schedulePayment({
      billingKey: 'billing-key-abcdef1234',
      amount: { amountMinor: 9900, currency: 'KRW' },
      orderId: 'order_schedule_1',
      customerRef: 'cus_abc',
      timeToPay,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/payments/order_schedule_1/schedule');
    expect(calls[0].headers['authorization']).toBe(`PortOne ${API_SECRET}`);
    expect(calls[0].body).toEqual({
      payment: {
        storeId: STORE_ID,
        billingKey: 'billing-key-abcdef1234',
        orderName: 'Subscription charge',
        amount: { total: 9900 },
        currency: 'KRW',
        customer: { id: 'cus_abc' },
      },
      timeToPay: timeToPay.toISOString(),
    });
    expect(result).toEqual(SCHEDULE_RESPONSE);
  });

  it("[EC:F] capabilities().scheduling reflects the constructor's scheduling option ('provider' by default)", () => {
    const { fetchStub } = makeCapturingFetch(() => ({ status: 200, body: {} }));
    const providerDefault = makeProvider(fetchStub);
    expect(providerDefault.capabilities().scheduling).toBe('provider');
    const providerSelf = makeProvider(fetchStub, 'self');
    expect(providerSelf.capabilities().scheduling).toBe('self');
  });
});

describe('[EC:F] PortoneProvider.cancelSchedules', () => {
  it('[EC:F] sends DELETE /payment-schedules with billingKey + storeId in the body and PortOne auth header', async () => {
    // Real endpoint per the V2 OpenAPI spec: DELETE /payment-schedules (RevokePaymentSchedulesBody),
    // not /payments/{paymentId}/schedule — there is no such cancel-by-paymentId endpoint.
    const REVOKE_RESPONSE = { revokedScheduleIds: ['sch_1'], revokedAt: '2026-09-02T00:00:00.000Z' };
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: REVOKE_RESPONSE }));
    const provider = makeProvider(fetchStub);
    const result = await provider.cancelSchedules({ billingKey: 'billing-key-abcdef1234' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].path).toBe('/payment-schedules');
    expect(calls[0].headers['authorization']).toBe(`PortOne ${API_SECRET}`);
    expect(calls[0].body).toEqual({ storeId: STORE_ID, billingKey: 'billing-key-abcdef1234' });
    expect(result).toEqual(REVOKE_RESPONSE);
  });

  it('[EC:F] throws invalid_request when neither billingKey nor scheduleIds is given', async () => {
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: {} }));
    const provider = makeProvider(fetchStub);
    await expect(provider.cancelSchedules({})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('[EC:K2 K3 K4] issueCashReceipt', () => {
  it('[EC:K4] refuses to issue against a card payment WITHOUT calling POST /cash-receipts', async () => {
    const { fetchStub, calls } = makeCapturingFetch((call) => {
      if (call.path.startsWith('/payments/')) return { status: 200, body: { amount: { total: 15000 }, currency: 'KRW', method: { type: 'PaymentMethodCard' } } };
      return { status: 500, body: {} };
    });
    const provider = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET, channelKey: 'channel_1' }, fetchStub);
    await expect(
      provider.issueCashReceipt({ paymentRef: 'pay_card', type: 'personal', customerIdentityNumber: '01012345678' }),
    ).rejects.toMatchObject({ code: 'cash_receipt_unsupported_for_payment_method' });
    expect(calls).toHaveLength(1); // only the GET re-fetch, no POST /cash-receipts
  });

  it('[EC:K2 K3] issues against a non-card payment and posts the real IssueCashReceiptBody shape', async () => {
    const { fetchStub, calls } = makeCapturingFetch((call) => {
      if (call.method === 'GET' && call.path.startsWith('/payments/')) {
        return { status: 200, body: { amount: { total: 15000 }, currency: 'KRW', orderName: 'Sub', method: { type: 'PaymentMethodTransfer' } } };
      }
      if (call.method === 'POST' && call.path === '/cash-receipts') {
        return { status: 200, body: { cashReceipt: { issueNumber: '12345', url: 'https://x', pgReceiptId: 'pg_1' } } };
      }
      return { status: 500, body: {} };
    });
    const provider = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET, channelKey: 'channel_1' }, fetchStub);
    const receipt = await provider.issueCashReceipt({ paymentRef: 'pay_1', type: 'business', customerIdentityNumber: '1234567890' });
    expect(receipt.status).toBe('issued');
    expect(receipt.type).toBe('business');
    const postCall = calls.find((c) => c.method === 'POST')!;
    expect(postCall.body).toMatchObject({ paymentId: 'pay_1', channelKey: 'channel_1', type: 'CORPORATE', currency: 'KRW', amount: { total: 15000 } });
  });

  it('[EC:K2] throws channel_key_required when no channelKey is configured', async () => {
    const { fetchStub } = makeCapturingFetch(() => ({ status: 200, body: {} }));
    const provider = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET }, fetchStub);
    await expect(
      provider.issueCashReceipt({ paymentRef: 'pay_1', type: 'personal', customerIdentityNumber: '010' }),
    ).rejects.toMatchObject({ code: 'channel_key_required' });
  });
});

describe('[EC:K5] cancelCashReceipt', () => {
  it('[EC:K5] POSTs /payments/{paymentId}/cash-receipt/cancel with no request body (no partial-cancel support in V2)', async () => {
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: { cancelledAmount: 15000, cancelledAt: '2026-09-09T00:00:00.000Z' } }));
    const provider = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET, channelKey: 'channel_1' }, fetchStub);
    const receipt = await provider.cancelCashReceipt({ paymentRef: 'pay_1' });
    expect(receipt.status).toBe('canceled');
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/payments/pay_1/cash-receipt/cancel');
    expect(calls[0].body).toEqual({ storeId: STORE_ID });
  });
});

describe('[EC:K7] getCashReceipt', () => {
  it('[EC:K7] GETs /payments/{paymentId}/cash-receipt', async () => {
    const { fetchStub, calls } = makeCapturingFetch(() => ({ status: 200, body: { status: 'ISSUED', paymentId: 'pay_1', issueNumber: '1', url: 'https://x' } }));
    const provider = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET, channelKey: 'channel_1' }, fetchStub);
    const receipt = await provider.getCashReceipt({ paymentRef: 'pay_1' });
    expect(receipt?.status).toBe('issued');
    expect(calls[0].path).toBe('/payments/pay_1/cash-receipt');
  });

  it('[EC:K7] returns null on CashReceiptNotFoundError instead of throwing', async () => {
    const { fetchStub } = makeCapturingFetch(() => ({ status: 404, body: { type: 'CashReceiptNotFoundError', message: 'not found' } }));
    const provider = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET, channelKey: 'channel_1' }, fetchStub);
    const receipt = await provider.getCashReceipt({ paymentRef: 'pay_missing' });
    expect(receipt).toBeNull();
  });
});

describe('[EC:A23] getSubscription / changeSubscription / cancelSubscription / uncancelSubscription — unsupported by design', () => {
  it('[EC:A23] uncancelSubscription throws unsupported (no native subscription, mirrors get/change/cancelSubscription)', async () => {
    const { fetchStub } = makeCapturingFetch(() => ({ status: 200, body: {} }));
    const provider = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET }, fetchStub);
    await expect(provider.uncancelSubscription()).rejects.toMatchObject({ code: 'unsupported' });
  });
});
