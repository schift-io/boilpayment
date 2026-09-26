// EC:K2 K4 K6 K7 — auto-issue of a KR 현금영수증 (cash receipt) from the payment.succeeded handler.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from '@schift/payment-kit-core';
import type { CreditsDeps, Payment, Policy } from '@schift/payment-kit-core';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

const AUTO: Policy = { ...DEFAULT_POLICY, cashReceipt: { mode: 'auto', defaultType: 'personal', cancelOnRefund: true } };

function harness(policy: Policy, overrides: Partial<Payment> = {}) {
  const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const notifier = new CollectingNotifier();
  const payment: Payment = {
    id: 'pay_cr', customerId: 'cust_1', provider: 'toss', providerRef: 'tviva_cr', subscriptionId: null,
    amount: { amountMinor: 9900, currency: 'KRW' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null, cashReceipt: null, ...overrides,
  };
  const credits: CreditsDeps = { topup: async () => {} };
  return { clock, repo, ledger, notifier, payment, credits, policy };
}

async function deliver(h: ReturnType<typeof harness>, issueCashReceipt: unknown, resolveIdentity: unknown, eventId = 'evt_cr') {
  await h.repo.payments.put(h.payment);
  const provider = Object.assign(new FakeProvider({ verify: jsonVerify(), getPaymentImpl: () => h.payment }), { name: 'toss' as const, issueCashReceipt });
  const handlers = defaultHandlers({
    policy: h.policy, ledger: h.ledger, repo: h.repo, notifier: h.notifier, clock: h.clock, ids: new SequentialIdGen('id_'),
    credits: h.credits, resolveTopupCredits: async () => 10,
    resolveCashReceiptIdentity: resolveIdentity as never,
  });
  const rawBody = JSON.stringify({ id: eventId, type: 'payment.succeeded', occurredAt: h.clock.now().toISOString(), paymentRef: h.payment.providerRef });
  const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo: h.repo, clock: h.clock });
  await processWebhook({ eventId: r.eventId!, providers: { toss: provider }, handlers, repo: h.repo, clock: h.clock });
  return { record: await h.repo.webhookEvents.get(r.eventId!), stored: await h.repo.payments.get(h.payment.id) };
}

describe('webhook.defaultHandlers — EC:K2 cash receipt auto-issue', () => {
  it('EC:K2 issues on payment.succeeded and records the receipt on the payment', async () => {
    const h = harness(AUTO);
    const calls: unknown[] = [];
    const { record, stored } = await deliver(
      h,
      async (i: unknown) => { calls.push(i); return { receiptKey: 'rk_1', type: 'personal' as const }; },
      async () => ({ customerIdentityNumber: '01012345678' }),
    );
    expect(record?.status).toBe('processed');
    expect(calls).toHaveLength(1);
    expect(stored?.cashReceipt).toEqual({ receiptKey: 'rk_1', issuedAt: h.clock.now(), type: 'personal' });
  });

  it('EC:K7 does not issue twice when the payment already carries a receipt (webhook redelivery)', async () => {
    const h = harness(AUTO, { cashReceipt: { receiptKey: 'rk_existing', issuedAt: new Date('2026-01-01T00:00:00Z'), type: 'personal' } });
    const calls: unknown[] = [];
    const { stored } = await deliver(h, async () => { calls.push(1); return { receiptKey: 'rk_2', type: 'personal' as const }; }, async () => ({ customerIdentityNumber: '01012345678' }));
    expect(calls).toHaveLength(0);
    expect(stored?.cashReceipt?.receiptKey).toBe('rk_existing');
  });

  it('EC:K6 an issuance failure never fails the payment: the record still processes and the failure is notified', async () => {
    const h = harness(AUTO);
    const { record, stored } = await deliver(
      h,
      async () => { throw new Error('NOT_FOUND_MERCHANT_BUSINESS_NUMBER'); },
      async () => ({ customerIdentityNumber: '01012345678' }),
    );
    expect(record?.status).toBe('processed'); // payment side succeeded
    expect(stored?.cashReceipt ?? null).toBeNull();
    const notified = h.notifier.sent.find((n) => (n.payload as { kind?: string }).kind === 'cash_receipt_issue_failed');
    expect(notified).toBeDefined();
  });

  it('EC:K2 does nothing when the policy mode is off (default)', async () => {
    const h = harness(DEFAULT_POLICY);
    const calls: unknown[] = [];
    const { stored } = await deliver(h, async () => { calls.push(1); return { receiptKey: 'rk_3', type: 'personal' as const }; }, async () => ({ customerIdentityNumber: '01012345678' }));
    expect(calls).toHaveLength(0);
    expect(stored?.cashReceipt ?? null).toBeNull();
  });
});
