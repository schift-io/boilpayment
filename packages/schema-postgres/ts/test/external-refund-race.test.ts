// [EC:D18] An external refund's revoke racing a consume on Postgres: the balance read, the clamp and the
// revoke run under the customer's ledger lock, so negativeBalance=block holds (never below zero) and a
// clamped revoke opens a reconcile case.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SystemClock, UuidIdGen } from 'boilpayment-core';
import type { NormalizedEvent, Payment } from 'boilpayment-core';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { onExternalRefund } from '../../../refund/ts/dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('[EC:D18] external refund vs consume on Postgres', () => {
  let db: TestDb; let repo: PostgresRepo; let ledger: PostgresLedgerStore;
  beforeAll(async () => { db = await createTestDb('extrefund'); repo = new PostgresRepo(db.pool); ledger = new PostgresLedgerStore(db.pool); });
  afterAll(async () => { await dropTestDb(db); });

  it('[EC:D18] 8 rounds: the balance never goes below zero and every clamp opens a case', async () => {
    const rounds: Array<{ bal: number; revoked: number; consumed: boolean; cases: number }> = [];
    for (let round = 0; round < 8; round++) {
      const c = `c_${randomUUID()}`;
      await repo.customers.put({ id: c, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
      const payment: Payment = { id: `p_${randomUUID()}`, customerId: c, provider: 'stripe', providerRef: `pi_${randomUUID()}`, subscriptionId: null,
        amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: new Date(), failure: null };
      await repo.payments.put(payment);
      await ledger.append({ customerId: c, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
        source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`, actor: 't', reason: null });
      let cases = 0;
      const cs = { openReconcileMismatchCase: async () => { cases++; } };
      const event = { id: `evt_${round}`, provider: 'stripe', type: 'refund.created', occurredAt: new Date(), customerRef: null, subscriptionRef: null,
        paymentRef: payment.providerRef, refundRef: `re_${round}`, amount: { amountMinor: 1000, currency: 'USD' }, raw: {} } as unknown as NormalizedEvent;
      const [refund, consume] = await Promise.all([
        onExternalRefund({ event, ledger, repo, cs, clock: new SystemClock(), ids: new UuidIdGen() }),
        ledger.consume({ customerId: c, poolOrder: ['paid'], amount: 100, idempotencyKey: `use_${round}`, meta: {}, now: new Date(),
          negativeBalance: 'block', negativeFloor: 0 }),
      ]);
      const bal = (await ledger.balance(c, undefined, new Date())).available;
      rounds.push({ bal, revoked: refund.creditsRevoked, consumed: consume.ok, cases });
    }
    console.log('[EC:D18] rounds', rounds.map((r) => `bal=${r.bal},revoked=${r.revoked},consumed=${r.consumed},cases=${r.cases}`).join(' | '));
    for (const r of rounds) {
      expect(r.bal).toBeGreaterThanOrEqual(0);
      expect(r.revoked + (r.consumed ? 100 : 0)).toBeLessThanOrEqual(100);
      if (r.revoked < 100) expect(r.cases).toBeGreaterThan(0);
    }
  });
});
