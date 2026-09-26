// [EC:D17] Two refund requests for the same payment with different keys, racing on Postgres: the
// remaining-refundable check and the pending refund write are serialized per customer, so when
// their sum exceeds the payment exactly one is accepted.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SystemClock, UuidIdGen } from 'boilpayment-core';
import type { Payment, PaymentProvider, Refund, RefundDecision } from 'boilpayment-core';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { execute } from '../../../refund/ts/dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

const provider = {
  name: 'stripe',
  capabilities: () => ({ nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true }),
  async refund(input: { amount: Payment['amount'] }) {
    await new Promise((r) => setTimeout(r, 20));
    return { id: `re_${randomUUID()}`, providerRef: `re_${randomUUID()}`, amount: input.amount, status: 'succeeded', failure: null } as unknown as Refund;
  },
} as unknown as PaymentProvider;

describe('[EC:D17] Postgres refund race', () => {
  let db: TestDb;
  let repo: PostgresRepo;
  let ledger: PostgresLedgerStore;
  beforeAll(async () => { db = await createTestDb('refundrace'); repo = new PostgresRepo(db.pool); ledger = new PostgresLedgerStore(db.pool); });
  afterAll(async () => { await dropTestDb(db); });

  it('[EC:D17] 600 + 600 against a 1000 payment: exactly one refund is accepted (5 rounds)', async () => {
    const lines: string[] = [];
    for (let round = 0; round < 5; round++) {
      const customerId = `c_${randomUUID()}`;
      await repo.customers.put({ id: customerId, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
      const payment: Payment = { id: `p_${randomUUID()}`, customerId, provider: 'stripe', providerRef: `pi_${randomUUID()}`, subscriptionId: null,
        amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: new Date(), failure: null };
      await repo.payments.put(payment);
      const decision = (n: number): RefundDecision => ({ eligible: true, amount: { amountMinor: 600, currency: 'USD' }, creditsToRevoke: 0,
        ruleId: `rule_${n}`, reason: 'test', needsHuman: false, paymentId: payment.id, customerId, subscriptionId: null });
      const run = (n: number) => execute({ decision: decision(n), provider, ledger, repo, clock: new SystemClock(), ids: new UuidIdGen(), idempotencyKey: `k_${round}_${n}` });
      const settled = await Promise.allSettled([run(1), run(2)]);
      const won = settled.filter((s) => s.status === 'fulfilled').length;
      const refused = settled.filter((s) => s.status === 'rejected' && String((s as PromiseRejectedResult).reason?.code ?? (s as PromiseRejectedResult).reason) === 'refund_invalid_decision').length;
      const total = (await repo.refunds.list({ paymentId: payment.id } as Partial<Refund>)).reduce((a, r) => a + r.amount.amountMinor, 0);
      lines.push(`round=${round} won=${won} refused=${refused} refunded=${total}`);
    }
    console.log(`[EC:D17 pg race] ${lines.join(' | ')}`);
    expect(lines.every((l) => l.includes('won=1 refused=1 refunded=600'))).toBe(true);
  });
});
