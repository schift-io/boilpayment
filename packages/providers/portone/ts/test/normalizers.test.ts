// Phase 6 regression tests — pure normalizers. Fixtures mirror ts/examples/smoke.ts and spec/portone.pseudo.md.
import { describe, it, expect } from 'vitest';
import {
  normalizePortoneStatus,
  normalizePortoneFailure,
  normalizePortonePayment,
  normalizePortoneCashReceipt,
  mapPortoneWebhook,
} from '../src/index.js';

describe('[EC:E8] normalizePortoneStatus', () => {
  const table: Array<[string, string]> = [
    ['READY', 'pending'],
    ['PAY_PENDING', 'pending'], // real V2 status literal (verified against the OpenAPI spec) — "PENDING" never occurs
    ['VIRTUAL_ACCOUNT_ISSUED', 'pending'],
    ['PAID', 'succeeded'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'refunded'],
    ['PARTIAL_CANCELLED', 'partially_refunded'],
  ];
  for (const [raw, expected] of table) {
    it(`[EC:E8] maps ${raw} -> ${expected}`, () => {
      expect(normalizePortoneStatus(raw)).toBe(expected);
    });
  }

  it('[EC:E8] VIRTUAL_ACCOUNT_ISSUED must map to pending, not succeeded — no grant until PAID', () => {
    expect(normalizePortoneStatus('VIRTUAL_ACCOUNT_ISSUED')).toBe('pending');
  });

  it('[EC:E8] unknown status falls back to pending', () => {
    expect(normalizePortoneStatus('SOME_NEW_STATUS')).toBe('pending');
  });
});

describe('[EC:E9] normalizePortoneFailure', () => {
  it('[EC:E9] null/undefined failure -> null', () => {
    expect(normalizePortoneFailure(null)).toBeNull();
    expect(normalizePortoneFailure(undefined)).toBeNull();
  });

  it('[EC:E9] INSUFFICIENT pgCode -> insufficient_funds, not retryable', () => {
    const f = normalizePortoneFailure({ pgCode: 'INSUFFICIENT_BALANCE', pgMessage: '잔액이 부족합니다.' });
    expect(f).toEqual({ code: 'insufficient_funds', providerCode: 'INSUFFICIENT_BALANCE', retryable: false, userMessage: '잔액이 부족합니다.' });
  });

  it('[EC:E9] EXPIRED pgCode -> expired_card', () => {
    const f = normalizePortoneFailure({ pgCode: 'CARD_EXPIRED', pgMessage: 'expired' });
    expect(f?.code).toBe('expired_card');
    expect(f?.retryable).toBe(false);
  });

  it('[EC:E9] DECLINE pgCode -> card_declined', () => {
    expect(normalizePortoneFailure({ pgCode: 'CARD_DECLINED' })?.code).toBe('card_declined');
  });

  it('[EC:E9] REJECT pgCode -> card_declined', () => {
    expect(normalizePortoneFailure({ pgCode: 'ISSUER_REJECT' })?.code).toBe('card_declined');
  });

  it('[EC:E9] TIMEOUT/NETWORK/UNAVAILABLE pgCode -> provider_unavailable, retryable=true', () => {
    expect(normalizePortoneFailure({ pgCode: 'GATEWAY_TIMEOUT' })).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(normalizePortoneFailure({ pgCode: 'NETWORK_ERROR' })).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(normalizePortoneFailure({ pgCode: 'PG_UNAVAILABLE' })).toMatchObject({ code: 'provider_unavailable', retryable: true });
  });

  it('[EC:E9] unrecognized pgCode -> unknown, not retryable, preserves providerCode', () => {
    const f = normalizePortoneFailure({ pgCode: 'SOME_WEIRD_PG_CODE', pgMessage: 'huh' });
    expect(f).toEqual({ code: 'unknown', providerCode: 'SOME_WEIRD_PG_CODE', retryable: false, userMessage: 'huh' });
  });

  it('[EC:E9] falls back to reason then default Korean message when pgMessage absent', () => {
    expect(normalizePortoneFailure({ pgCode: 'X', reason: 'card issuer down' })?.userMessage).toBe('card issuer down');
    expect(normalizePortoneFailure({ pgCode: 'X' })?.userMessage).toBe('결제에 실패했습니다.');
  });
});

describe('[EC:F][EC:E8][EC:E9] normalizePortonePayment', () => {
  const PAID_FIXTURE = {
    id: 'example-payment-id',
    status: 'PAID',
    amount: { total: 15000, taxFree: 0, vat: 1364 },
    currency: 'KRW',
    customer: { id: 'cus_abc' },
    paidAt: '2026-09-01T00:00:05.000Z',
    requestedAt: '2026-09-01T00:00:00.000Z',
  };
  const FAILED_FIXTURE = {
    id: 'example-payment-failed',
    status: 'FAILED',
    amount: { total: 8000 },
    currency: 'KRW',
    customer: { id: 'cus_abc' },
    requestedAt: '2026-09-01T00:10:00.000Z',
    failure: { pgCode: 'INSUFFICIENT_BALANCE', pgMessage: '잔액이 부족합니다.' },
  };

  it('[EC:F] maps a PAID payment to succeeded, no failure attached', () => {
    const p = normalizePortonePayment(PAID_FIXTURE);
    expect(p.status).toBe('succeeded');
    expect(p.id).toBe('example-payment-id');
    expect(p.customerId).toBe('cus_abc');
    expect(p.amount).toEqual({ amountMinor: 15000, currency: 'KRW' });
    expect(p.failure).toBeNull();
    expect(p.occurredAt).toEqual(new Date('2026-09-01T00:00:05.000Z'));
  });

  it('[EC:E9] a FAILED payment carries a normalized failure', () => {
    const p = normalizePortonePayment(FAILED_FIXTURE);
    expect(p.status).toBe('failed');
    expect(p.failure).toEqual({ code: 'insufficient_funds', providerCode: 'INSUFFICIENT_BALANCE', retryable: false, userMessage: '잔액이 부족합니다.' });
  });

  it('[EC:F] currency defaults to KRW when raw.currency absent', () => {
    const p = normalizePortonePayment({ id: 'p1', status: 'PAID', amount: { total: 100 }, customer: {}, paidAt: '2026-01-01T00:00:00.000Z' });
    expect(p.amount.currency).toBe('KRW');
  });
});

describe('[EC:E4] mapPortoneWebhook', () => {
  const table: Array<[string, string]> = [
    ['Transaction.Paid', 'payment.succeeded'],
    ['Transaction.Failed', 'payment.failed'],
    ['Transaction.Cancelled', 'refund.created'],
    ['Transaction.PartialCancelled', 'refund.created'],
    ['Transaction.VirtualAccountIssued', 'payment.pending'],
    ['Transaction.PayPending', 'payment.pending'],
    ['Transaction.CancelPending', 'refund.pending'],
    ['Transaction.DisputeCreated', 'dispute.opened'],
    ['Transaction.DisputeResolved', 'dispute.closed'],
    ['BillingKey.Issued', 'unknown'],
    ['BillingKey.Failed', 'unknown'],
    ['BillingKey.Deleted', 'unknown'],
    ['SomethingElseEntirely', 'unknown'],
  ];
  for (const [type, expected] of table) {
    it(`[EC:E4] maps webhook type ${type} -> ${expected}`, () => {
      const event = mapPortoneWebhook({ type, timestamp: '2024-04-25T10:00:00.000Z', data: { paymentId: 'pay_1' } });
      expect(event.type).toBe(expected);
      expect(event.provider).toBe('portone');
      expect(event.paymentRef).toBe('pay_1');
    });
  }

  it('[EC:E4] paymentRef falls back to null when data.paymentId is absent', () => {
    const event = mapPortoneWebhook({ type: 'BillingKey.Issued', timestamp: '2024-04-25T10:00:00.000Z', data: { billingKey: 'bk_1' } });
    expect(event.paymentRef).toBeNull();
  });
});

describe('[EC:K2 K3 K5 K6] normalizePortoneCashReceipt', () => {
  it('[EC:K2 K3] maps an ISSUED cash receipt, type CORPORATE -> business', () => {
    const receipt = normalizePortoneCashReceipt({
      status: 'ISSUED',
      paymentId: 'pay_1',
      type: 'CORPORATE',
      amount: 10000,
      currency: 'KRW',
      issueNumber: '12345',
      url: 'https://example.com/receipt',
    });
    expect(receipt.status).toBe('issued');
    expect(receipt.type).toBe('business');
    expect(receipt.amount).toEqual({ amountMinor: 10000, currency: 'KRW' });
  });

  it('[EC:K5] maps a CANCELLED cash receipt', () => {
    const receipt = normalizePortoneCashReceipt({ status: 'CANCELLED', paymentId: 'pay_1', amount: 10000 });
    expect(receipt.status).toBe('canceled');
  });

  it('[EC:K6] maps an ISSUE_FAILED cash receipt', () => {
    const receipt = normalizePortoneCashReceipt({ status: 'ISSUE_FAILED', paymentId: 'pay_1' });
    expect(receipt.status).toBe('issue_failed');
  });
});
