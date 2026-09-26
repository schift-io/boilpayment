// EC:D16 refund reason rules — spec/refund.pseudo.md
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Payment, Policy } from 'boilpayment-core';
import { evaluate } from '../src/evaluate.js';

// Paid 1000 for 100 credits, 60 used, 10 days later (outside the 7-day no-questions window).
async function scenario(policy: Policy = DEFAULT_POLICY) {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('r_'), clock);
  const repo = new InMemoryRepo();
  const payment: Payment = {
    id: 'pay', customerId: 'customer', provider: 'stripe', providerRef: 'pi_pay', subscriptionId: null,
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription',
    period: { start: clock.now(), end: new Date('2026-01-31T00:00:00Z') }, occurredAt: clock.now(), failure: null,
  };
  await ledger.append({ customerId: 'customer', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD',
    expiresAt: null, source: 'subscription', reference: { paymentId: 'pay' }, idempotencyKey: 'grant', actor: 'system', reason: null });
  clock.advance(10 * 86_400_000);
  await ledger.consume({ customerId: 'customer', poolOrder: ['paid'], amount: 60, idempotencyKey: 'use', meta: { reason: 'usage' },
    now: clock.now(), negativeBalance: 'block', negativeFloor: 0 });
  return { payment, policy, ledger, repo, clock };
}
const strict = resolvePolicy({ refund: { reasons: { technicalFailure: 'full', dissatisfied: 'evidence_required', userError: 'deny' } } });

describe('EC:D16 refund reasons', () => {
  it('defaults change nothing: every category gets the amount rules', async () => {
    const base = await evaluate(await scenario());
    for (const category of ['technical_failure', 'dissatisfied', 'user_error', 'other'] as const) {
      const d = await evaluate({ ...(await scenario()), reason: { category } });
      expect(d).toEqual(base);
    }
    expect(base).toMatchObject({ eligible: true, ruleId: 'D2', amount: { amountMinor: 400 }, creditsToRevoke: 40 });
  });

  it('technical_failure -> full refunds the whole payment outside the window, revoking only what is left', async () => {
    const d = await evaluate({ ...(await scenario(strict)), reason: { category: 'technical_failure' } });
    expect(d).toMatchObject({ eligible: true, ruleId: 'D16', amount: { amountMinor: 1000 }, creditsToRevoke: 40 });
  });

  it('technical_failure -> full also ignores refund.method=deny and the annual deny window', async () => {
    const policy = resolvePolicy({ refund: { method: 'deny', reasons: { technicalFailure: 'full' } } });
    const d = await evaluate({ ...(await scenario(policy)), reason: { category: 'technical_failure' } });
    expect(d).toMatchObject({ eligible: true, ruleId: 'D16', amount: { amountMinor: 1000 } });
  });

  it('user_error -> deny refuses', async () => {
    const d = await evaluate({ ...(await scenario(strict)), reason: { category: 'user_error' } });
    expect(d).toMatchObject({ eligible: false, ruleId: 'D16', creditsToRevoke: 0 });
  });

  it('dissatisfied under evidence_required: without evidence a person decides, with evidence the rules decide', async () => {
    const without = await evaluate({ ...(await scenario(strict)), reason: { category: 'dissatisfied' } });
    expect(without).toMatchObject({ eligible: true, needsHuman: true, amount: { amountMinor: 400 } });
    expect(without.reason).toContain('D16: dissatisfied without evidenceRef');
    const withEvidence = await evaluate({ ...(await scenario(strict)), reason: { category: 'dissatisfied', evidenceRef: 'job_42' } });
    expect(withEvidence).toMatchObject({ eligible: true, needsHuman: false, amount: { amountMinor: 400 } });
  });

  it('dissatisfied -> needs_human always goes to a person', async () => {
    const policy = resolvePolicy({ refund: { reasons: { dissatisfied: 'needs_human' } } });
    const d = await evaluate({ ...(await scenario(policy)), reason: { category: 'dissatisfied', evidenceRef: 'x' } });
    expect(d).toMatchObject({ eligible: true, needsHuman: true });
  });

  it('other always gets the amount rules', async () => {
    const d = await evaluate({ ...(await scenario(strict)), reason: { category: 'other' } });
    expect(d).toMatchObject({ eligible: true, ruleId: 'D2', needsHuman: false, amount: { amountMinor: 400 } });
  });
});
