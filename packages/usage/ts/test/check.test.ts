// EC:C1 (overage modes) EC:C5 (includedQuantity) EC:A14/EC:C6 (dunning grace gating) EC:C8 (credit conversion)
// spec: packages/usage/spec/usage.pseudo.md
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import { check } from '../src/check.js';
import { record } from '../src/record.js';
import { basePolicy, mkSub } from './fixtures.js';

function harness() {
  const ids = new SequentialIdGen('id_');
  const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
  const ledger = new InMemoryLedger(ids);
  const repo = new InMemoryRepo();
  return { ids, clock, ledger, repo };
}

describe('EC:C1 usage.check — three overage modes', () => {
  it('EC:C1 hard_block denies once projected usage exceeds includedQuantity', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'hard_block' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 5, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e1' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 3, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: false, overage: 3, reason: 'hard_block', remaining: 0 });
  });

  it('EC:C1 soft_cap_notify allows the overage but returns a notify: "usage.soft_cap" payload', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'soft_cap_notify' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 5, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e2' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 2, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: true, overage: 2, reason: 'soft_cap_notify', remaining: 0, notify: 'usage.soft_cap' });
  });

  it('EC:C1 bill_overage allows the overage; overage amount itself is computed by closePeriod (not check), using policy.usage.overageUnitPriceMinor', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();
    // resolvePolicy requires overageUnitPriceMinor when overage='bill_overage' -- set it even though check() itself doesn't consume it.
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'bill_overage' as const, overageUnitPriceMinor: 250 } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 5, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e3' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 4, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: true, overage: 4, reason: 'bill_overage', remaining: 0 });
    expect(result.notify).toBeNull(); // unlike soft_cap_notify, bill_overage carries no notify payload
  });

  it('EC:C1 within_included: projected usage at or under includedQuantity always allows with overage=0', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'hard_block' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 2, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e4' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 2, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: true, overage: 0, reason: 'within_included', remaining: 1 }); // 5 - (2+2) = 1
  });
});

describe('EC:C5 usage.check — includedQuantity (policy default vs. per-call override)', () => {
  it('EC:C5 policy.usage.includedQuantity defaults to 0: any usage at all is immediately overage under the default (hard_block) mode', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 1, sub, policy: basePolicy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: false, overage: 1, reason: 'hard_block', remaining: 0 });
  });

  it('EC:C5 a per-call includedQuantity overrides policy.usage.includedQuantity (e.g. plan.usageIncluded)', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub(); // basePolicy.usage.includedQuantity === 0

    const result = await check({
      customerId: sub.customerId, meter: 'api_call', quantity: 3, sub, policy: basePolicy, repo, ledger, clock,
      includedQuantity: 10,
    });

    expect(result).toMatchObject({ allow: true, overage: 0, reason: 'within_included', remaining: 7 });
  });
});

describe('EC:A14 usage.check — dunning grace modes gate usage before quota math', () => {
  it('EC:A14 usageDuringGrace="block" denies ALL usage during past_due, regardless of quota/overage mode', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub({ status: 'past_due' });
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'hard_block' as const }, dunning: { ...DEFAULT_POLICY.dunning, usageDuringGrace: 'block' as const } };

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 1, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: false, overage: 0, reason: 'grace_block', remaining: 0 });
  });

  it('EC:A14 usageDuringGrace="allow" imposes no extra restriction: overage still allowed with notify during past_due', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub({ status: 'past_due' });
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'soft_cap_notify' as const }, dunning: { ...DEFAULT_POLICY.dunning, usageDuringGrace: 'allow' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 5, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e_grace_allow' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 1, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: true, overage: 1, reason: 'soft_cap_notify', remaining: 0, notify: 'usage.soft_cap' });
  });

  it('EC:A14 usageDuringGrace="allow_existing_only": usage WITHIN already-included quota still works during past_due', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub({ status: 'past_due' });
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'soft_cap_notify' as const }, dunning: { ...DEFAULT_POLICY.dunning, usageDuringGrace: 'allow_existing_only' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 2, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e_grace_existing' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 2, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: true, overage: 0, reason: 'within_included', remaining: 1 });
  });

  it('EC:A14 usageDuringGrace="allow_existing_only" + soft_cap_notify: NEW overage during past_due is denied as grace_block_overage', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub({ status: 'past_due' });
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'soft_cap_notify' as const }, dunning: { ...DEFAULT_POLICY.dunning, usageDuringGrace: 'allow_existing_only' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 5, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e_grace_over' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 1, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: false, overage: 1, reason: 'grace_block_overage', remaining: 0 });
  });

  it('EC:A14 usageDuringGrace="allow_existing_only" + bill_overage: NEW overage during past_due is also denied as grace_block_overage', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub({ status: 'past_due' });
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'bill_overage' as const, overageUnitPriceMinor: 250 }, dunning: { ...DEFAULT_POLICY.dunning, usageDuringGrace: 'allow_existing_only' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 5, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e_grace_over_bill' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 1, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: false, overage: 1, reason: 'grace_block_overage', remaining: 0 });
  });

  it('EC:A14 usageDuringGrace="allow_existing_only" + hard_block: hard_block ignores the grace switch entirely (same result as non-grace)', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub({ status: 'past_due' });
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'hard_block' as const }, dunning: { ...DEFAULT_POLICY.dunning, usageDuringGrace: 'allow_existing_only' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 5, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e_grace_over_hard' }, sub, policy, repo, clock, ids });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 1, sub, policy, repo, ledger, clock });

    expect(result).toMatchObject({ allow: false, overage: 1, reason: 'hard_block', remaining: 0 }); // reason stays 'hard_block', not 'grace_block_overage'
  });
});

describe('EC:C8 usage.check — credit-conversion hybrid replaces quota math entirely', () => {
  it('EC:C8 sufficient balance: consumes exactly quantity * creditsPerUnit from the ledger and allows', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, creditConversion: { unit: 'call', creditsPerUnit: 10 } } };
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'promo', reference: {}, idempotencyKey: 'grant_1', actor: 'test', reason: null,
    });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 3, sub, policy, repo, ledger, clock, idempotencyKey: 'chk_1' });

    // remaining = -result.shortfall; shortfall=0 on a fully-satisfied consume, so remaining is -0 (still === 0 numerically)
    expect(result.allow).toBe(true);
    expect(result.overage).toBe(0);
    expect(result.reason).toBe('credit_conversion');
    expect(result.remaining === 0).toBe(true); // -0 or 0 both fine; toBe() alone is Object.is-strict on -0
    const balance = await ledger.balance(sub.customerId, undefined, clock.now());
    expect(balance.available).toBe(20); // 50 - (3 * 10) = 20, exact multiplication, no rounding applied
  });

  it('EC:C8 insufficient balance: denies as credit_conversion_insufficient and leaves the balance untouched (negativeBalance="block" default)', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, creditConversion: { unit: 'call', creditsPerUnit: 10 } } };
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'promo', reference: {}, idempotencyKey: 'grant_2', actor: 'test', reason: null,
    });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 3, sub, policy, repo, ledger, clock, idempotencyKey: 'chk_2' });

    expect(result).toMatchObject({ allow: false, overage: 0, reason: 'credit_conversion_insufficient', remaining: 0 });
    const balance = await ledger.balance(sub.customerId, undefined, clock.now());
    expect(balance.available).toBe(10); // unchanged -- a denied consume must not debit anything
  });

  it('EC:C8 credit conversion bypasses quota/overage policy entirely, even when includedQuantity=0 and overage=hard_block would otherwise deny', async () => {
    const { ids, clock, ledger, repo } = harness();
    const sub = mkSub();
    const policy = {
      ...DEFAULT_POLICY,
      usage: { ...DEFAULT_POLICY.usage, includedQuantity: 0, overage: 'hard_block' as const, creditConversion: { unit: 'call', creditsPerUnit: 5 } },
    };
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'promo', reference: {}, idempotencyKey: 'grant_3', actor: 'test', reason: null,
    });

    const result = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 4, sub, policy, repo, ledger, clock, idempotencyKey: 'chk_3' });

    // would be hard_block'd under quota math (included=0), but credit_conversion short-circuits before quota math runs
    expect(result.reason).toBe('credit_conversion');
    expect(result.allow).toBe(true);
    const balance = await ledger.balance(sub.customerId, undefined, clock.now());
    expect(balance.available).toBe(80); // 100 - (4*5) = 80
  });
});
