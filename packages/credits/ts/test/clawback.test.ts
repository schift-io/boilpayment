// spec: packages/credits/spec/credits.pseudo.md [EC:A4] [EC:B13]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InsufficientBalanceError, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { clawback } from '../src/index.js';

const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));

async function seed(amount: number) {
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  await ledger.append({
    customerId: 'cust_1', pool: 'paid', kind: 'grant', amount, unitPriceMinor: null, currency: null,
    expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: 'g1', actor: 'system', reason: null,
  });
  return ledger;
}

describe("EC:A4 clawback shortfall — 'clamp_to_zero'", () => {
  it('revokes only what is available, reports the rest as shortfall', async () => {
    const ledger = await seed(20);
    const res = await clawback({
      customerId: 'cust_1', amount: 200, policy: resolvePolicy(), ledger, clock, reason: 'downgrade:plan_b->plan_a',
      reference: {}, actor: 'system', idempotencyKey: 'revoke:downgrade:sub_1:2024-01-01T00:00:00.000Z', shortfall: 'clamp_to_zero',
    });
    expect(res.revoked).toBe(20);
    expect(res.shortfall).toBe(180);
    expect(res.entry?.source).toBe('downgrade'); // inferred from idempotencyKey prefix
    const bal = await ledger.balance('cust_1', 'paid', clock.now());
    expect(bal.available).toBe(0);
  });

  it('when amount <= available, revokes in full with zero shortfall', async () => {
    const ledger = await seed(100);
    const res = await clawback({
      customerId: 'cust_1', amount: 40, policy: resolvePolicy(), ledger, clock, reason: 'test',
      reference: {}, actor: 'system', idempotencyKey: 'revoke:manual:1', shortfall: 'clamp_to_zero',
    });
    expect(res.revoked).toBe(40);
    expect(res.shortfall).toBe(0);
  });
});

describe("EC:A4 clawback shortfall — 'allow_negative'", () => {
  it('revokes the full requested amount even past zero, balance goes negative', async () => {
    const ledger = await seed(20);
    const res = await clawback({
      customerId: 'cust_1', amount: 200, policy: resolvePolicy(), ledger, clock, reason: 'test',
      reference: {}, actor: 'system', idempotencyKey: 'revoke:manual:2', shortfall: 'allow_negative',
    });
    expect(res.revoked).toBe(200);
    expect(res.shortfall).toBe(0);
    const bal = await ledger.balance('cust_1', 'paid', clock.now());
    expect(bal.available).toBe(-180);
  });
});

describe("EC:A4 clawback shortfall — 'deny_downgrade'", () => {
  it('throws InsufficientBalanceError and writes nothing when balance is short', async () => {
    const ledger = await seed(20);
    await expect(
      clawback({
        customerId: 'cust_1', amount: 200, policy: resolvePolicy(), ledger, clock, reason: 'test',
        reference: {}, actor: 'system', idempotencyKey: 'revoke:manual:3', shortfall: 'deny_downgrade',
      }),
    ).rejects.toThrow(InsufficientBalanceError);
    const bal = await ledger.balance('cust_1', 'paid', clock.now());
    expect(bal.available).toBe(20); // untouched
  });

  it('succeeds normally when balance covers the amount', async () => {
    const ledger = await seed(200);
    const res = await clawback({
      customerId: 'cust_1', amount: 50, policy: resolvePolicy(), ledger, clock, reason: 'test',
      reference: {}, actor: 'system', idempotencyKey: 'revoke:manual:4', shortfall: 'deny_downgrade',
    });
    expect(res.revoked).toBe(50);
    expect(res.shortfall).toBe(0);
  });
});

describe('EC:B13 refund-sourced revoke — source inferred from revoke:refund: prefix', () => {
  it("idempotencyKey starting with 'revoke:refund:' is tagged source='refund'", async () => {
    const ledger = await seed(100);
    const res = await clawback({
      customerId: 'cust_1', amount: 30, policy: resolvePolicy(), ledger, clock, reason: 'refund',
      reference: { refundId: 're_1' }, actor: 'system', idempotencyKey: 'revoke:refund:re_1', shortfall: 'clamp_to_zero',
    });
    expect(res.entry?.source).toBe('refund');
  });
});

describe('[EC:L5] correlationId propagation', () => {
  it('[EC:L5] clawback stamps reference.correlationId on the revoke entry', async () => {
    const ledger = await seed(100);
    const res = await clawback({
      customerId: 'cust_1', amount: 30, policy: resolvePolicy(), ledger, clock, reason: 'downgrade',
      reference: {}, actor: 'system', idempotencyKey: 'revoke:downgrade:1', shortfall: 'clamp_to_zero',
      correlationId: 'corr_clawback_1',
    });
    expect(res.entry?.reference.correlationId).toBe('corr_clawback_1');
  });

  it('[EC:L5] does not overwrite a correlationId already set on `reference`', async () => {
    const ledger = await seed(100);
    const res = await clawback({
      customerId: 'cust_1', amount: 30, policy: resolvePolicy(), ledger, clock, reason: 'downgrade',
      reference: { correlationId: 'from_reference' }, actor: 'system', idempotencyKey: 'revoke:downgrade:2', shortfall: 'clamp_to_zero',
      correlationId: 'from_param',
    });
    expect(res.entry?.reference.correlationId).toBe('from_reference');
  });
});
