import { expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Payment, Policy } from 'boilpayment-core';
import { evaluate } from '../src/evaluate.js';

async function scenario(policy: Policy = DEFAULT_POLICY) {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('eval_'));
  const repo = new InMemoryRepo();
  const payment: Payment = {
    id: 'pay', customerId: 'customer', provider: 'stripe', providerRef: 'pi_pay', subscriptionId: null,
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription',
    period: { start: clock.now(), end: new Date('2026-01-31T00:00:00Z') }, occurredAt: clock.now(), failure: null,
  };
  await ledger.append({ customerId: payment.customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10,
    currency: 'USD', expiresAt: null, source: 'subscription', reference: { paymentId: payment.id },
    idempotencyKey: 'grant', actor: 'system', reason: null });
  return { payment, policy, ledger, repo, clock };
}

it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid requested minor amount %s', async (amountMinor) => {
  const input = await scenario();
  const decision = await evaluate({ ...input, requestedAmount: { amountMinor, currency: 'USD' } });
  expect(decision).toMatchObject({ eligible: false, ruleId: 'D-request', creditsToRevoke: 0 });
});

it('rejects requested currency mismatching the actual payment', async () => {
  const input = await scenario();
  const decision = await evaluate({ ...input, requestedAmount: { amountMinor: 100, currency: 'KRW' } });
  expect(decision).toMatchObject({ eligible: false, ruleId: 'D-request' });
});

it.each(['unused_credits', 'time_prorated', 'min_of_both'] as const)('caps %s at the remaining actual payment', async (method) => {
  const input = await scenario(resolvePolicy({ refund: { method } }));
  input.clock.advance(10 * 86_400_000);
  await input.repo.refunds.put({ id: 'past', paymentId: 'pay', customerId: 'customer',
    amount: { amountMinor: 800, currency: 'USD' }, status: 'succeeded', providerRef: 're_past',
    creditsRevoked: 0, ruleId: 'D1', reason: null, failure: null, createdAt: input.clock.now() });
  const decision = await evaluate(input);
  expect(decision.amount.amountMinor).toBe(200);
  expect(decision.creditsToRevoke).toBeLessThanOrEqual(20);
});

it('min_of_both honors configured overuse denial', async () => {
  const input = await scenario(resolvePolicy({ refund: { method: 'min_of_both', overuseBehavior: 'deny' } }));
  input.clock.advance(10 * 86_400_000);
  await input.ledger.consume({ customerId: 'customer', poolOrder: ['paid'], amount: 60, idempotencyKey: 'consume',
    meta: { reason: 'usage' }, now: input.clock.now(), negativeBalance: 'block', negativeFloor: 0 });
  expect(await evaluate(input)).toMatchObject({ eligible: false, ruleId: 'D3', creditsToRevoke: 0 });
});

it.each(['clamp_and_reduce_refund', 'clamp_to_zero'] as const)('treats debt as zero revocable credits for %s', async (revokeShortfall) => {
  const input = await scenario(resolvePolicy({ refund: { revokeShortfall } }));
  await input.ledger.consume({ customerId: 'customer', poolOrder: ['paid'], amount: 150, idempotencyKey: 'debt',
    meta: { reason: 'usage' }, now: input.clock.now(), negativeBalance: 'allow_unbounded', negativeFloor: 0 });
  const decision = await evaluate(input);
  expect(decision.creditsToRevoke).toBe(0);
  expect(decision.amount.amountMinor).toBe(revokeShortfall === 'clamp_to_zero' ? 1000 : 0);
  expect(decision.eligible).toBe(revokeShortfall === 'clamp_to_zero');
  if (revokeShortfall === 'clamp_and_reduce_refund') expect(decision.ruleId).toBe('D-zero');
});
