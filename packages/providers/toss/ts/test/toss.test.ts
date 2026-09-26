// Phase 6 regression tests for TossProvider. No network calls — every HTTP-calling
// method is driven through an injected fetch stub. Fixtures are taken from
// examples/smoke.ts (docs.tosspayments.com example response shapes) plus the
// status/failure/webhook mapping tables in spec/toss.pseudo.md.
import { describe, it, expect } from 'vitest';
import { WebhookSignatureError, ProviderError, PaymentKitError } from 'boilpayment-core';
import type { CreateCheckoutInput, Plan, PlanPrice } from 'boilpayment-core';
import { TossProvider, normalizeTossStatus, normalizeTossFailure, normalizeTossPayment, mapTossWebhook } from '../src/index.js';

// ── shared fixtures (mirrors examples/smoke.ts) ──────────────────────────────

const WEBHOOK_FIXTURE = {
  eventType: 'PAYMENT_STATUS_CHANGED',
  createdAt: '2022-05-12T00:00:00.000',
  data: { paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', status: 'DONE', orderId: 'YOWWcpZSDCZ8WJC5x7mkl' },
};

const PAYMENT_FIXTURE_DONE = {
  paymentKey: 'B3EvL1cKz9p-kO6XPNpfF',
  orderId: 'YOWWcpZSDCZ8WJC5x7mkl',
  status: 'DONE',
  totalAmount: 15000,
  currency: 'KRW',
  method: '카드',
  approvedAt: '2022-05-12T00:00:05+09:00',
  requestedAt: '2022-05-12T00:00:00+09:00',
};

const PAYMENT_FIXTURE_ABORTED = {
  paymentKey: 'ABORTED_KEY',
  orderId: 'ord_aborted',
  status: 'ABORTED',
  totalAmount: 5000,
  currency: 'KRW',
  method: '카드',
  requestedAt: '2022-05-12T00:10:00+09:00',
  failure: { code: 'REJECT_CARD_COMPANY', message: '카드사에서 승인을 거절했습니다.' },
};

const PAYMENT_FIXTURE_VA = {
  paymentKey: 'VA_KEY',
  orderId: 'ord_va',
  status: 'PARTIAL_CANCELED',
  totalAmount: 20000,
  currency: 'KRW',
  method: '가상계좌',
  approvedAt: '2022-05-12T00:00:00+09:00',
  cancels: [{ transactionKey: 'txn_1', cancelAmount: 5000, canceledAt: '2022-05-13T00:00:00+09:00' }],
};

// EC:H4 — /v1/transactions rows are TransactionDto, NOT Payment: field names differ
// (`amount`/`transactionAt` vs `totalAmount`/`approvedAt`). Shape per
// docs.tosspayments.com/reference#거래-조회.
const TRANSACTION_FIXTURE_DONE = {
  mId: 'tosspayments_test',
  transactionKey: 'txn_9F8fPFGA3fyprBrpqNyC1',
  paymentKey: 'B3EvL1cKz9p-kO6XPNpfF',
  orderId: 'YOWWcpZSDCZ8WJC5x7mkl',
  method: '카드',
  customerKey: 'cus_abc',
  useEscrow: false,
  status: 'DONE',
  transactionAt: '2022-05-12T00:00:05+09:00',
  currency: 'KRW',
  amount: 15000,
  receiptUrl: 'https://dashboard.tosspayments.com/receipt/txn_9F8fPFGA3fyprBrpqNyC1',
};

const TRANSACTION_FIXTURE_OTHER_CUSTOMER = {
  mId: 'tosspayments_test',
  transactionKey: 'txn_other',
  paymentKey: 'ABORTED_KEY',
  orderId: 'ord_aborted',
  method: '카드',
  customerKey: 'cus_other',
  useEscrow: false,
  status: 'ABORTED',
  transactionAt: '2022-05-12T00:10:00+09:00',
  currency: 'KRW',
  amount: 5000,
  receiptUrl: 'https://dashboard.tosspayments.com/receipt/txn_other',
};

const PAYMENT_FIXTURE_WAITING = {
  paymentKey: 'WAIT_KEY',
  orderId: 'ord_wait',
  status: 'WAITING_FOR_DEPOSIT',
  totalAmount: 10000,
  currency: 'KRW',
  method: '가상계좌',
  requestedAt: '2022-05-12T00:00:00+09:00',
};

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface RecordedCall { url: string; method: string; headers: Record<string, string>; body: any }

function makeFetchStub(routes: Record<string, (call: RecordedCall) => Response>) {
  const calls: RecordedCall[] = [];
  const stub: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://api.tosspayments.com', '');
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
    }
    const call: RecordedCall = {
      url: String(url),
      method: (init?.method as string) ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${path.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`fakeFetch: unhandled route ${key}`);
    return handler(call);
  };
  return { stub, calls };
}

const PLAN: Plan = { id: 'plan_1', name: 'Pro', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [] };
const PRICE: PlanPrice = { currency: 'KRW', amountMinor: 15000 };

// ── (a) pure normalizers ──────────────────────────────────────────────────

describe('[EC:E8] normalizeTossStatus', () => {
  it('[EC:E8] maps WAITING_FOR_DEPOSIT to pending (no grant until DONE)', () => {
    expect(normalizeTossStatus('WAITING_FOR_DEPOSIT')).toBe('pending');
  });
  it('[EC:E8] maps READY and IN_PROGRESS to pending', () => {
    expect(normalizeTossStatus('READY')).toBe('pending');
    expect(normalizeTossStatus('IN_PROGRESS')).toBe('pending');
  });
  it('[EC:E8] maps DONE to succeeded', () => {
    expect(normalizeTossStatus('DONE')).toBe('succeeded');
  });
  it('[EC:D4] maps CANCELED to refunded and PARTIAL_CANCELED to partially_refunded', () => {
    expect(normalizeTossStatus('CANCELED')).toBe('refunded');
    expect(normalizeTossStatus('PARTIAL_CANCELED')).toBe('partially_refunded');
  });
  it('[EC:E8] maps ABORTED and EXPIRED to failed', () => {
    expect(normalizeTossStatus('ABORTED')).toBe('failed');
    expect(normalizeTossStatus('EXPIRED')).toBe('failed');
  });
});

describe('[EC:E9] normalizeTossFailure', () => {
  it('[EC:E9] maps a known Toss failure code with correct retryable flag', () => {
    const f = normalizeTossFailure({ code: 'REJECT_CARD_COMPANY', message: '카드사에서 승인을 거절했습니다.' });
    expect(f).toEqual({ code: 'card_declined', providerCode: 'REJECT_CARD_COMPANY', retryable: true, userMessage: '카드사에서 승인을 거절했습니다.' });
  });
  it('[EC:E9] maps EXPIRED_CARD to expired_card, not retryable', () => {
    const f = normalizeTossFailure({ code: 'EXPIRED_CARD', message: 'expired' });
    expect(f).toEqual({ code: 'expired_card', providerCode: 'EXPIRED_CARD', retryable: false, userMessage: 'expired' });
  });
  it('[EC:E9] unmapped code falls back to unknown/not-retryable and preserves providerCode', () => {
    const f = normalizeTossFailure({ code: 'SOME_NEW_TOSS_CODE', message: 'huh' });
    expect(f).toEqual({ code: 'unknown', providerCode: 'SOME_NEW_TOSS_CODE', retryable: false, userMessage: 'huh' });
  });
  it('[EC:E9] returns null when there is no failure', () => {
    expect(normalizeTossFailure(null)).toBeNull();
    expect(normalizeTossFailure(undefined)).toBeNull();
  });
});

describe('[EC:F][EC:E8][EC:E9] normalizeTossPayment', () => {
  it('[EC:E8] DONE payment normalizes to succeeded with no failure', () => {
    const p = normalizeTossPayment(PAYMENT_FIXTURE_DONE);
    expect(p.status).toBe('succeeded');
    expect(p.id).toBe('B3EvL1cKz9p-kO6XPNpfF');
    expect(p.amount).toEqual({ amountMinor: 15000, currency: 'KRW' });
    expect(p.failure).toBeNull();
  });
  it('[EC:E9] ABORTED payment normalizes to failed and carries normalized failure', () => {
    const p = normalizeTossPayment(PAYMENT_FIXTURE_ABORTED);
    expect(p.status).toBe('failed');
    expect(p.failure).toEqual({ code: 'card_declined', providerCode: 'REJECT_CARD_COMPANY', retryable: true, userMessage: '카드사에서 승인을 거절했습니다.' });
  });
});

// ── (b) verifyWebhook — IP allowlist ─────────────────────────────────────

describe('[EC:E4] verifyWebhook — IP allowlist (Toss has no signature)', () => {
  it('[EC:E4] allowed IP passes and returns the mapped event', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test', allowedWebhookIps: ['203.0.113.10'] }, (async () => { throw new Error('should not fetch'); }) as any);
    const rawBody = JSON.stringify(WEBHOOK_FIXTURE);
    const event = await provider.verifyWebhook({ headers: {}, rawBody, remoteAddress: '203.0.113.10' });
    expect(event.type).toBe('payment.succeeded');
    expect(event.paymentRef).toBe('B3EvL1cKz9p-kO6XPNpfF');
  });
  it('[EC:E4] disallowed IP throws WebhookSignatureError', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test', allowedWebhookIps: ['203.0.113.10'] }, (async () => { throw new Error('should not fetch'); }) as any);
    const rawBody = JSON.stringify(WEBHOOK_FIXTURE);
    await expect(provider.verifyWebhook({ headers: {}, rawBody, remoteAddress: '198.51.100.1' })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E4] missing connection address throws WebhookSignatureError when an allowlist is configured', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test', allowedWebhookIps: ['203.0.113.10'] }, (async () => { throw new Error('should not fetch'); }) as any);
    const rawBody = JSON.stringify(WEBHOOK_FIXTURE);
    await expect(provider.verifyWebhook({ headers: {}, rawBody })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E19] no allowlist configured refuses the webhook at receipt (fail closed)', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('should not fetch'); }) as any);
    const rawBody = JSON.stringify(WEBHOOK_FIXTURE);
    await expect(provider.verifyWebhook({ headers: {}, rawBody, remoteAddress: '203.0.113.10' })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe('[EC:E3][EC:E4] mapTossWebhook — event mapping table', () => {
  it('[EC:E3] PAYMENT_STATUS_CHANGED/DONE -> payment.succeeded', () => {
    expect(mapTossWebhook(WEBHOOK_FIXTURE).type).toBe('payment.succeeded');
  });
  it('[EC:D4] PAYMENT_STATUS_CHANGED/CANCELED -> refund.created', () => {
    const body = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2022-05-12T00:00:00.000', data: { paymentKey: 'k', status: 'CANCELED' } };
    expect(mapTossWebhook(body).type).toBe('refund.created');
  });
  it('[EC:D4] PAYMENT_STATUS_CHANGED/PARTIAL_CANCELED -> refund.created', () => {
    const body = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2022-05-12T00:00:00.000', data: { paymentKey: 'k', status: 'PARTIAL_CANCELED' } };
    expect(mapTossWebhook(body).type).toBe('refund.created');
  });
  it('[EC:E8] PAYMENT_STATUS_CHANGED/WAITING_FOR_DEPOSIT -> payment.pending', () => {
    const body = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2022-05-12T00:00:00.000', data: { paymentKey: 'k', status: 'WAITING_FOR_DEPOSIT' } };
    expect(mapTossWebhook(body).type).toBe('payment.pending');
  });
  it('[EC:E8] PAYMENT_STATUS_CHANGED/EXPIRED and /ABORTED -> payment.failed', () => {
    const expired = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2022-05-12T00:00:00.000', data: { paymentKey: 'k', status: 'EXPIRED' } };
    const aborted = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2022-05-12T00:00:00.000', data: { paymentKey: 'k', status: 'ABORTED' } };
    expect(mapTossWebhook(expired).type).toBe('payment.failed');
    expect(mapTossWebhook(aborted).type).toBe('payment.failed');
  });
  it('[EC:D4] CANCEL_STATUS_CHANGED without completion stays pending', () => {
    const body = { eventType: 'CANCEL_STATUS_CHANGED', createdAt: '2022-05-12T00:00:00.000', data: { paymentKey: 'k' } };
    expect(mapTossWebhook(body).type).toBe('refund.pending');
  });
  it('[EC:F] BILLING_DELETED -> subscription.canceled', () => {
    const body = { eventType: 'BILLING_DELETED', createdAt: '2022-05-12T00:00:00.000', data: {} };
    expect(mapTossWebhook(body).type).toBe('subscription.canceled');
  });
  it('[EC:E3] unrecognized eventType -> unknown', () => {
    const body = { eventType: 'SOMETHING_ELSE', createdAt: '2022-05-12T00:00:00.000', data: {} };
    expect(mapTossWebhook(body).type).toBe('unknown');
  });
  it('[EC:E3] synthesized id is stable across identical retries (eventType:paymentKey:status:createdAt)', () => {
    const e1 = mapTossWebhook(WEBHOOK_FIXTURE);
    const e2 = mapTossWebhook({ ...WEBHOOK_FIXTURE });
    expect(e1.id).toBe(e2.id);
    expect(e1.id).toBe('PAYMENT_STATUS_CHANGED:B3EvL1cKz9p-kO6XPNpfF:DONE:2022-05-12T00:00:00.000');
  });
  it('[EC:E3] DEPOSIT_CALLBACK/DONE -> payment.succeeded (same table row as PAYMENT_STATUS_CHANGED)', () => {
    const body = { eventType: 'DEPOSIT_CALLBACK', createdAt: '2022-05-12T00:00:00.000', data: { paymentKey: 'k', status: 'DONE' } };
    expect(mapTossWebhook(body).type).toBe('payment.succeeded');
  });
});

// ── (c) HTTP-calling methods via injected fetch stub ─────────────────────

describe('[EC:E13] confirmPayment', () => {
  it('[EC:E13] POSTs to /v1/payments/confirm with Basic auth and the exact body, no idempotency header', async () => {
    const { stub, calls } = makeFetchStub({
      'POST /v1/payments/confirm': () => fakeResponse(PAYMENT_FIXTURE_DONE),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const payment = await provider.confirmPayment({ paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', orderId: 'YOWWcpZSDCZ8WJC5x7mkl', amount: 15000 });
    expect(payment.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.tosspayments.com/v1/payments/confirm');
    expect(calls[0].headers.Authorization).toBe('Basic ' + Buffer.from('sk_test:').toString('base64'));
    expect(calls[0].body).toEqual({ paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', orderId: 'YOWWcpZSDCZ8WJC5x7mkl', amount: 15000 });
    expect(calls[0].headers['Idempotency-Key']).toBeUndefined();
  });
});

describe('[EC:F] chargeBillingKey (self-scheduler)', () => {
  it('[EC:F] POSTs to /v1/billing/{billingKey} with Idempotency-Key header and exact body', async () => {
    const { stub, calls } = makeFetchStub({
      'POST /v1/billing/bk_123': () => fakeResponse(PAYMENT_FIXTURE_DONE),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const payment = await provider.chargeBillingKey({
      billingKey: 'bk_123',
      amount: { amountMinor: 15000, currency: 'KRW' },
      orderId: 'charge:sub_1:2026-09-01T00:00:00.000Z',
      customerRef: 'cus_abc',
      idempotencyKey: 'charge:sub_1:2026-09-01T00:00:00.000Z',
    });
    expect(payment.status).toBe('succeeded');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.tosspayments.com/v1/billing/bk_123');
    expect(calls[0].headers.Authorization).toBe('Basic ' + Buffer.from('sk_test:').toString('base64'));
    expect(calls[0].headers['Idempotency-Key']).toBe('charge:sub_1:2026-09-01T00:00:00.000Z');
    expect(calls[0].body).toEqual({ customerKey: 'cus_abc', amount: 15000, orderId: 'charge:sub_1:2026-09-01T00:00:00.000Z', orderName: 'Subscription charge' });
  });

  it('[EC:F] a provider error response (e.g. NOT_ENOUGH_BALANCE) throws ProviderError with normalized failure', async () => {
    const { stub } = makeFetchStub({
      'POST /v1/billing/bk_fail': () => fakeResponse({ code: 'NOT_ENOUGH_BALANCE', message: '잔액이 부족합니다.' }, 400),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await expect(
      provider.chargeBillingKey({ billingKey: 'bk_fail', amount: { amountMinor: 1000, currency: 'KRW' }, orderId: 'o1', customerRef: 'c1', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ failure: { code: 'insufficient_funds', retryable: true, providerCode: 'NOT_ENOUGH_BALANCE' } });
  });

  it('[EC:F] a provider error response is a ProviderError instance', async () => {
    const { stub } = makeFetchStub({
      'POST /v1/billing/bk_fail2': () => fakeResponse({ code: 'NOT_ENOUGH_BALANCE', message: '잔액이 부족합니다.' }, 400),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await expect(
      provider.chargeBillingKey({ billingKey: 'bk_fail2', amount: { amountMinor: 1000, currency: 'KRW' }, orderId: 'o1', customerRef: 'c1', idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('[EC:D13][EC:D4] refund', () => {
  it('[EC:D13] refunding a virtual-account payment without refundReceiveAccount throws refund_receive_account_required', async () => {
    const { stub } = makeFetchStub({
      'GET /v1/payments/VA_KEY': () => fakeResponse(PAYMENT_FIXTURE_VA),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await expect(
      provider.refund({ paymentRef: 'VA_KEY', amount: { amountMinor: 5000, currency: 'KRW' }, reason: 'customer request', idempotencyKey: 'revoke:1' }),
    ).rejects.toMatchObject({ code: 'refund_receive_account_required' });
  });

  it('[EC:D13][EC:D4] refunding with refundReceiveAccount succeeds and posts cancelAmount + refundReceiveAccount + Idempotency-Key', async () => {
    const { stub, calls } = makeFetchStub({
      'GET /v1/payments/VA_KEY': () => fakeResponse(PAYMENT_FIXTURE_VA),
      'POST /v1/payments/VA_KEY/cancel': () => fakeResponse(PAYMENT_FIXTURE_VA),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const refundReceiveAccount = { bank: '004', accountNumber: '123456789', holderName: '홍길동' };
    const refund = await provider.refund({
      paymentRef: 'VA_KEY',
      amount: { amountMinor: 5000, currency: 'KRW' },
      reason: 'customer request',
      idempotencyKey: 'revoke:2',
      extra: { refundReceiveAccount },
    });
    expect(refund.amount).toEqual({ amountMinor: 5000, currency: 'KRW' });
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('GET');
    const cancelCall = calls[1];
    expect(cancelCall.method).toBe('POST');
    expect(cancelCall.url).toBe('https://api.tosspayments.com/v1/payments/VA_KEY/cancel');
    expect(cancelCall.headers['Idempotency-Key']).toBe('revoke:2');
    expect(cancelCall.body).toEqual({ cancelReason: 'customer request', cancelAmount: 5000, refundReceiveAccount });
  });

  it('[EC:D4] refunding a card payment (non-virtual-account) does not require refundReceiveAccount', async () => {
    const { stub, calls } = makeFetchStub({
      'GET /v1/payments/CARD_KEY': () => fakeResponse(PAYMENT_FIXTURE_DONE),
      'POST /v1/payments/CARD_KEY/cancel': () => fakeResponse(PAYMENT_FIXTURE_DONE),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const refund = await provider.refund({ paymentRef: 'CARD_KEY', amount: { amountMinor: 5000, currency: 'KRW' }, reason: 'r', idempotencyKey: 'revoke:3' });
    expect(refund).toBeTruthy();
    expect(calls[1].body).toEqual({ cancelReason: 'r', cancelAmount: 5000 });
  });
});

describe('[EC:E10][EC:E6] createCheckout', () => {
  const baseInput: CreateCheckoutInput = {
    customerRef: 'cus_abc',
    plan: PLAN,
    price: PRICE,
    mode: 'subscription',
    successUrl: 'https://app.example.com/success',
    cancelUrl: 'https://app.example.com/cancel',
    idempotencyKey: 'checkout:cus_abc:plan_1:2026-09-09T00:00',
  };

  it('[EC:E10] rejects a non-KRW price with currency_unsupported', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    const usdPrice: PlanPrice = { currency: 'USD', amountMinor: 1500 };
    await expect(provider.createCheckout({ ...baseInput, price: usdPrice })).rejects.toMatchObject({ code: 'currency_unsupported' });
  });

  it('[EC:E6] deterministic orderId derived from idempotencyKey — same key produces the same orderId (double-click safe)', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    const c1 = await provider.createCheckout(baseInput);
    const c2 = await provider.createCheckout(baseInput);
    expect(c1.id).toBe(c2.id);
    expect(c1.providerRef).toBe(c1.id);
    expect(c1.url).toContain(`orderId=${c1.id}`);
    expect(c1.url).toContain('amount=15000');
  });

  it('[EC:E6] a different idempotencyKey produces a different orderId', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    const c1 = await provider.createCheckout(baseInput);
    const c2 = await provider.createCheckout({ ...baseInput, idempotencyKey: 'checkout:cus_abc:plan_1:2026-09-09T00:01' });
    expect(c1.id).not.toBe(c2.id);
  });
});

describe('[EC:F] getSubscription / changeSubscription / cancelSubscription — unsupported by design', () => {
  it('[EC:F] getSubscription throws unsupported (no native subscription)', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    await expect(provider.getSubscription('sub_ref')).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('[EC:F] changeSubscription throws unsupported', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    await expect(provider.changeSubscription()).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('[EC:F] cancelSubscription throws unsupported', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    await expect(provider.cancelSubscription()).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('[EC:A23] uncancelSubscription throws unsupported', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    await expect(provider.uncancelSubscription()).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('[EC:F] reportUsage throws unsupported (capabilities().meters === false)', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    expect(provider.capabilities().meters).toBe(false);
    await expect(provider.reportUsage()).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('[EC:F] createCustomer', () => {
  it('[EC:F] generates a deterministic customerKey from email when none supplied', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    const { ref } = await provider.createCustomer({ email: 'user@example.com' });
    expect(ref.startsWith('cus_')).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(50);
    const { ref: ref2 } = await provider.createCustomer({ email: 'user@example.com' });
    expect(ref2).toBe(ref);
  });
  it('[EC:F] uses metadata.customerKey verbatim when supplied', async () => {
    const provider = new TossProvider({ secretKey: 'sk_test' }, (async () => { throw new Error('no fetch'); }) as any);
    const { ref } = await provider.createCustomer({ email: 'user@example.com', metadata: { customerKey: 'custom_key_1' } });
    expect(ref).toBe('custom_key_1');
  });
});

describe('[EC:H4] listPayments', () => {
  it('[EC:H4] GETs /v1/transactions with date range and filters best-effort by customerKey', async () => {
    const { stub, calls } = makeFetchStub({
      'GET /v1/transactions': () => fakeResponse([TRANSACTION_FIXTURE_DONE, TRANSACTION_FIXTURE_OTHER_CUSTOMER]),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const payments = await provider.listPayments({ customerRef: 'cus_abc', since: new Date('2026-01-01T00:00:00Z') });
    expect(payments).toHaveLength(1);
    expect(payments[0].id).toBe('B3EvL1cKz9p-kO6XPNpfF');
    // TransactionDto uses `amount`/`transactionAt`, not Payment's `totalAmount`/`approvedAt` —
    // asserting these catches the field-name mismatch bug (pre-fix: amountMinor was undefined).
    expect(payments[0].status).toBe('succeeded');
    expect(payments[0].amount).toEqual({ amountMinor: 15000, currency: 'KRW' });
    expect(payments[0].occurredAt).toEqual(new Date('2022-05-12T00:00:05+09:00'));
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/v1/transactions?startDate=');
  });
});

describe('[EC:E8] getPayment on a waiting-for-deposit virtual account payment', () => {
  it('[EC:E8] returns pending status, not succeeded, until DONE arrives', async () => {
    const { stub } = makeFetchStub({
      'GET /v1/payments/WAIT_KEY': () => fakeResponse(PAYMENT_FIXTURE_WAITING),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const payment = await provider.getPayment('WAIT_KEY');
    expect(payment.status).toBe('pending');
  });
});

// ── (d) EC:K2-K7 — KR cash receipt ────────────────────────────────────────

// Real response shape confirmed live 2026-09-09 against api.tosspayments.com (test_sk_ key,
// POST /v1/cash-receipts) — see index.ts's normalizeTossCashReceipt doc comment.
const CASH_RECEIPT_ISSUE_FIXTURE = {
  receiptKey: 'vdX0wJDpj5mBZ1gQ4YVX9wpP6aLypjrl2KPoqNbMGOkn9EW7',
  orderId: 'YOWWcpZSDCZ8WJC5x7mkl',
  orderName: 'paykit live test',
  type: '소득공제',
  issueNumber: '730000031',
  receiptUrl: 'https://dashboard-sandbox.tosspayments.com/receipts/cash-receipt/YOWWcpZSDCZ8WJC5x7mkl/tvivarepublica?ref=PX',
  businessNumber: '',
  transactionType: 'CONFIRM',
  amount: 10000,
  taxFreeAmount: 0,
  issueStatus: 'IN_PROGRESS',
  failure: null,
  customerIdentityNumber: '01012345678',
  requestedAt: '2026-09-09T12:00:02+09:00',
};

const CASH_RECEIPT_CANCEL_FIXTURE = {
  ...CASH_RECEIPT_ISSUE_FIXTURE,
  receiptKey: 'c_vdX0wJDpj5mBZ1gQ4YVX9wpP6aLypjrl2KPoqNbMGOkn9EW7',
  transactionType: 'CANCEL',
};

describe('[EC:K2 K3 K4] issueCashReceipt', () => {
  it('[EC:K4] refuses to issue against a card payment WITHOUT calling POST /v1/cash-receipts (client-side guard — real Toss test API does not reject this itself, confirmed live 2026-09-09)', async () => {
    const { stub, calls } = makeFetchStub({
      'GET /v1/payments/B3EvL1cKz9p-kO6XPNpfF': () => fakeResponse(PAYMENT_FIXTURE_DONE), // method: '카드'
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await expect(
      provider.issueCashReceipt({ paymentRef: 'B3EvL1cKz9p-kO6XPNpfF', type: 'personal', customerIdentityNumber: '01012345678' }),
    ).rejects.toMatchObject({ code: 'cash_receipt_unsupported_for_payment_method' });
    expect(calls).toHaveLength(1); // only the GET re-fetch, no POST /v1/cash-receipts
  });

  it('[EC:K2 K3] issues against a cash-eligible (virtual account) payment, mapping type personal->소득공제', async () => {
    const { stub, calls } = makeFetchStub({
      'GET /v1/payments/VA_KEY': () => fakeResponse(PAYMENT_FIXTURE_VA),
      'POST /v1/cash-receipts': () => fakeResponse(CASH_RECEIPT_ISSUE_FIXTURE),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const receipt = await provider.issueCashReceipt({ paymentRef: 'VA_KEY', type: 'personal', customerIdentityNumber: '01012345678' });
    expect(receipt.status).toBe('in_progress');
    expect(receipt.type).toBe('personal');
    expect(receipt.receiptKey).toBe(CASH_RECEIPT_ISSUE_FIXTURE.receiptKey);
    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall!.body).toMatchObject({ orderId: 'ord_va', type: '소득공제', customerIdentityNumber: '01012345678', amount: 20000 });
  });

  it('[EC:K3] type=business maps to 지출증빙', async () => {
    const { stub, calls } = makeFetchStub({
      'GET /v1/payments/VA_KEY': () => fakeResponse(PAYMENT_FIXTURE_VA),
      'POST /v1/cash-receipts': () => fakeResponse({ ...CASH_RECEIPT_ISSUE_FIXTURE, type: '지출증빙' }),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const receipt = await provider.issueCashReceipt({ paymentRef: 'VA_KEY', type: 'business', customerIdentityNumber: '1234567890' });
    expect(receipt.type).toBe('business');
    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall!.body.type).toBe('지출증빙');
  });
});

describe('[EC:K5 K6] cancelCashReceipt', () => {
  it('[EC:K5] full cancel omits amount in the request body', async () => {
    const receiptKey = CASH_RECEIPT_ISSUE_FIXTURE.receiptKey;
    const { stub, calls } = makeFetchStub({
      [`POST /v1/cash-receipts/${receiptKey}/cancel`]: () => fakeResponse(CASH_RECEIPT_CANCEL_FIXTURE),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const receipt = await provider.cancelCashReceipt({ receiptKey });
    expect(receipt.status).toBe('canceled');
    expect(calls[0].body).toEqual({});
  });

  it('[EC:K5] partial cancel sends amount', async () => {
    const receiptKey = CASH_RECEIPT_ISSUE_FIXTURE.receiptKey;
    const { stub, calls } = makeFetchStub({
      [`POST /v1/cash-receipts/${receiptKey}/cancel`]: () => fakeResponse({ ...CASH_RECEIPT_CANCEL_FIXTURE, amount: 3000 }),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await provider.cancelCashReceipt({ receiptKey, amountMinor: 3000 });
    expect(calls[0].body).toEqual({ amount: 3000 });
  });
});

describe('[EC:K7] getCashReceipt', () => {
  it('[EC:K7] lists by requestDate and filters client-side by orderId (no per-key GET endpoint exists)', async () => {
    const { stub } = makeFetchStub({
      'GET /v1/cash-receipts': () => fakeResponse([CASH_RECEIPT_ISSUE_FIXTURE]),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const receipt = await provider.getCashReceipt({ orderId: 'YOWWcpZSDCZ8WJC5x7mkl', requestDate: '2026-09-09' });
    expect(receipt?.receiptKey).toBe(CASH_RECEIPT_ISSUE_FIXTURE.receiptKey);
  });

  it('[EC:K7] returns null when no receipt matches the orderId', async () => {
    const { stub } = makeFetchStub({
      'GET /v1/cash-receipts': () => fakeResponse([CASH_RECEIPT_ISSUE_FIXTURE]),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    const receipt = await provider.getCashReceipt({ orderId: 'no_such_order', requestDate: '2026-09-09' });
    expect(receipt).toBeNull();
  });
});
