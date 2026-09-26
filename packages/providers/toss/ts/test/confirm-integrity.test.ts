// Phase 6 regression tests — supplements test/toss.test.ts with coverage the task
// spec calls out explicitly that the base suite did not yet have:
//   - EC:E13/E6/E10: confirmPayment amount-mismatch integrity check. Per
//     spec/toss.pseudo.md "confirmPayment": "Toss 서버가 위젯 오픈 시점 금액과 confirm
//     금액을 자체 대조해 불일치 시 에러를 반환한다" — the mismatch check happens on
//     Toss's server, not client-side in TossProvider. So the correct behavior to test
//     is: confirmPayment sends exactly the amount it was given, and when Toss's API
//     rejects the confirm call (simulating a requested-vs-actual amount mismatch), the
//     error propagates as a ProviderError instead of being swallowed.
//   - refund(): Authorization header is asserted on the cancel POST call too, not just
//     the confirm/billing calls already covered in toss.test.ts.
import { describe, it, expect } from 'vitest';
import { ProviderError } from '@schift/payment-kit-core';
import { TossProvider } from '../src/index.js';

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

describe('[EC:E13][EC:E6][EC:E10] confirmPayment — amount integrity check is enforced server-side, error propagates', () => {
  it('[EC:E13] sends exactly {paymentKey, orderId, amount} to /v1/payments/confirm — no client-side amount comparison to short-circuit', async () => {
    // Per spec/toss.pseudo.md: "호출자(app)는 자신의 주문 테이블에서 조회한 기대 금액을 amount 로 넘긴다."
    // TossProvider does not itself compare amount against anything — it forwards the
    // caller's amount verbatim and lets Toss's server be the source of truth (EC:E6/E10
    // defense line). Assert the exact outgoing body carries the requested amount unmodified.
    const { stub, calls } = makeFetchStub({
      'POST /v1/payments/confirm': () => fakeResponse({ ...({} as any), paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', orderId: 'YOWWcpZSDCZ8WJC5x7mkl', status: 'DONE', totalAmount: 15000, currency: 'KRW', approvedAt: '2022-05-12T00:00:05+09:00' }),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await provider.confirmPayment({ paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', orderId: 'YOWWcpZSDCZ8WJC5x7mkl', amount: 15000 });
    expect(calls[0].body).toEqual({ paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', orderId: 'YOWWcpZSDCZ8WJC5x7mkl', amount: 15000 });
  });

  it('[EC:E13][EC:E6] Toss rejecting confirm because the requested amount does not match the order (simulated 400) propagates as ProviderError, not a silent success', async () => {
    // Fixture shape follows the same {code, message} error envelope used for the
    // documented NOT_ENOUGH_BALANCE case in toss.test.ts / TOSS_FAILURE_MAP — this
    // particular provider code is not in the pseudo spec's mapping table, so we only
    // assert the generic ProviderError propagation, not an invented normalized code.
    const { stub, calls } = makeFetchStub({
      'POST /v1/payments/confirm': () => fakeResponse({ message: '요청 금액과 실제 결제 금액이 일치하지 않습니다.' }, 400),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await expect(
      provider.confirmPayment({ paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', orderId: 'YOWWcpZSDCZ8WJC5x7mkl', amount: 999 }),
    ).rejects.toBeInstanceOf(ProviderError);
    // the mismatched amount was still sent verbatim — the guard lives on Toss's side, not ours.
    expect(calls[0].body.amount).toBe(999);
  });
});

describe('[EC:D13] refund — Authorization header on the cancel POST call', () => {
  it('[EC:D13] cancel POST carries the same Basic auth header as every other Toss call', async () => {
    const { stub, calls } = makeFetchStub({
      'GET /v1/payments/VA_KEY': () => fakeResponse(PAYMENT_FIXTURE_VA),
      'POST /v1/payments/VA_KEY/cancel': () => fakeResponse(PAYMENT_FIXTURE_VA),
    });
    const provider = new TossProvider({ secretKey: 'sk_test' }, stub);
    await provider.refund({
      paymentRef: 'VA_KEY',
      amount: { amountMinor: 5000, currency: 'KRW' },
      reason: 'customer request',
      idempotencyKey: 'revoke:2',
      extra: { refundReceiveAccount: { bank: '004', accountNumber: '123456789', holderName: '홍길동' } },
    });
    const expectedAuth = 'Basic ' + Buffer.from('sk_test:').toString('base64');
    expect(calls[0].headers.Authorization).toBe(expectedAuth); // GET /v1/payments/VA_KEY
    expect(calls[1].headers.Authorization).toBe(expectedAuth); // POST .../cancel
  });
});
