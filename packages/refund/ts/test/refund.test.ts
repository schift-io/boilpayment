// Phase 6 regression tests — packages/refund (TS). Real code paths against the core in-memory
// doubles; only PaymentProvider is faked. Mirrors packages/refund/py/tests/test_refund.py
// (same cases, same expected numbers). See docs/EDGE_CASES.md D1-D15/B13/B8, examples/e2e/FINDINGS.md.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_POLICY,
  FixedClock,
  InMemoryLedger,
  InMemoryRepo,
  SequentialIdGen,
  PaymentKitError,
  resolvePolicy,
} from 'boilpayment-core';
import type {
  Payment,
  PaymentProvider,
  ProviderCapabilities,
  Refund,
  NormalizedEvent,
  Policy,
  Money,
} from 'boilpayment-core';
import { evaluate, execute, onExternalRefund } from '../src/index.js';
import type { ReconcileMismatchCaseOpener } from '../src/external.js';

// ── shared fake provider (implements every PaymentProvider method, throws if unexpected) ──────
class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true };
  }
  async createCustomer(): Promise<{ ref: string }> { throw new Error('unused: createCustomer'); }
  async createCheckout(): Promise<never> { throw new Error('unused: createCheckout'); }
  async getPayment(): Promise<never> { throw new Error('unused: getPayment'); }
  async listPayments() { return []; }
  async getSubscription(): Promise<never> { throw new Error('unused: getSubscription'); }
  async changeSubscription(): Promise<never> { throw new Error('unused: changeSubscription'); }
  async cancelSubscription(): Promise<never> { throw new Error('unused: cancelSubscription'); }
  async chargeBillingKey(): Promise<never> { throw new Error('unused: chargeBillingKey'); }
  async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> {
    return {
      id: `cancel_${input.paymentRef}`, paymentId: 'unused', customerId: '', amount: input.amount, status: 'succeeded',
      providerRef: `pref_${input.paymentRef}`, creditsRevoked: 0, ruleId: '', reason: null, failure: null, createdAt: new Date(),
    };
  }
  async reportUsage() {}
  async verifyWebhook(): Promise<never> { throw new Error('unused: verifyWebhook'); }
}

class ReceiveAccountRequiredProvider extends FakeProvider {
  async refund(): Promise<never> {
    throw new PaymentKitError('refundReceiveAccount required for Toss virtual account refunds', 'refund_receive_account_required');
  }
}

class AlwaysFailProvider extends FakeProvider {
  async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> {
    return { ...await super.refund(input), status: 'failed', failure: {
      code: 'refund_declined', providerCode: null, retryable: false, userMessage: 'refund declined',
    } };
  }
}

// EC:K5 — duck-typed extra method, not part of PaymentProvider (mirrors TossProvider/PortoneProvider).
class ProviderWithCashReceiptCancel extends FakeProvider {
  cashReceiptCancelCalls: Array<{ paymentRef: string; receiptKey?: string; amountMinor?: number }> = [];
  async cancelCashReceipt(input: { paymentRef: string; receiptKey?: string; amountMinor?: number }): Promise<unknown> {
    this.cashReceiptCancelCalls.push(input);
    return { status: 'canceled' };
  }
}

class ProviderWithFailingCashReceiptCancel extends FakeProvider {
  async cancelCashReceipt(): Promise<unknown> {
    throw new Error('toss cash receipt cancel failed');
  }
}

class CountingProvider extends FakeProvider {
  calls = 0;
  async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> {
    this.calls += 1;
    return super.refund(input);
  }
}

// EC:L5 — mirrors providers/*'s real withCorrelationId (a shallow clone carrying an override),
// so this proves the SAME duck-typed contract refund/execute.ts relies on.
class RecordingProvider extends FakeProvider {
  correlationIdOverride: string | null = null;
  receivedCorrelationIds: (string | null)[] = [];
  withCorrelationId(id: string): RecordingProvider {
    const clone = Object.create(RecordingProvider.prototype) as RecordingProvider;
    Object.assign(clone, this, { correlationIdOverride: id });
    return clone;
  }
  async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> {
    this.receivedCorrelationIds.push(this.correlationIdOverride);
    return super.refund(input);
  }
}

class DeferredProvider extends FakeProvider {
  gate: Promise<void>;
  private resolveGate!: () => void;
  entered: Promise<void>;
  private resolveEntered!: () => void;
  constructor() {
    super();
    this.gate = new Promise((res) => { this.resolveGate = res; });
    this.entered = new Promise((res) => { this.resolveEntered = res; });
  }
  release() { this.resolveGate(); }
  async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> {
    this.resolveEntered();
    await this.gate;
    return super.refund(input);
  }
}

let clock: FixedClock;
let ids: SequentialIdGen;
let ledger: InMemoryLedger;
let repo: InMemoryRepo;
let policy: Policy;
const customerId = 'cust_1';

beforeEach(() => {
  clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  ids = new SequentialIdGen('id_');
  ledger = new InMemoryLedger(ids);
  repo = new InMemoryRepo();
  policy = DEFAULT_POLICY;
});

async function makeTopup(id: string, amountMinor: number, currency = 'USD'): Promise<Payment> {
  const payment: Payment = {
    id, customerId, provider: 'stripe', providerRef: `pi_${id}`, subscriptionId: null,
    amount: { amountMinor, currency }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null,
  };
  await repo.payments.put(payment);
  return payment;
}

async function grant(paymentId: string, credits: number, unitPriceMinor: number, currency = 'USD', expiresAt: Date | null = null) {
  return (await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: credits, unitPriceMinor, currency, expiresAt,
    source: 'topup', reference: { paymentId }, idempotencyKey: `topup:${paymentId}`, actor: 'system', reason: null,
  })).entry;
}

async function consume(amount: number, key: string) {
  return ledger.consume({
    customerId, poolOrder: ['paid'], amount, idempotencyKey: key, meta: { reason: 'usage' },
    now: clock.now(), negativeBalance: policy.credits.negativeBalance, negativeFloor: policy.credits.negativeFloor,
  });
}

describe('refund.evaluate', () => {
  it('[EC:D1] full refund inside the no-questions window', async () => {
    const p = await makeTopup('pay_d1', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000); // day 3, inside 7-day window
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    expect(decision.eligible).toBe(true);
    expect(decision.ruleId).toBe('D1');
    expect(decision.amount.amountMinor).toBe(1000);
    expect(decision.creditsToRevoke).toBe(100);
    expect(decision.needsHuman).toBe(false);
  });

  it('[EC:D1+B13] measured smoke scenario — 100 credits @ unitPrice 10, consume 40, day 3 -> $6/60 (clamp_and_reduce_refund)', async () => {
    const p = await makeTopup('pay_1', 1000);
    await grant(p.id, 100, 10);
    const c = await consume(40, 'consume:1');
    expect(c.ok).toBe(true);
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(60);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    expect(decision.ruleId).toBe('D1');
    expect(decision.amount.amountMinor).toBe(600);
    expect(decision.creditsToRevoke).toBe(60);
    expect(decision.reason).toContain('B13 clamp_and_reduce_refund');
  });

  it('[EC:D2] measured smoke scenario — unused_credits outside window: grant 100 @10, consume 30, day 20 -> $7/70', async () => {
    const p = await makeTopup('pay_2', 1000);
    await grant(p.id, 100, 10);
    await consume(30, 'consume:2');
    clock.advance(20 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    expect(decision.ruleId).toBe('D2');
    expect(decision.amount.amountMinor).toBe(700);
    expect(decision.creditsToRevoke).toBe(70);
    expect(decision.reason).toContain('unused_credits');
  });

  it('[EC:D2/time_prorated] + [EC:D3] within elapsed ratio -> no deny, floor rounding', async () => {
    const pol = resolvePolicy({ refund: { method: 'time_prorated' } });
    const period = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-31T00:00:00Z') }; // 30 days
    const p: Payment = {
      id: 'pay_tp', customerId, provider: 'stripe', providerRef: 'pi_tp', subscriptionId: 'sub_1',
      amount: { amountMinor: 3000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period,
      occurredAt: period.start, failure: null,
    };
    await repo.payments.put(p);
    await grant(p.id, 100, 30); // unitPrice 30 -> matches 3000/100
    await consume(50, 'consume:tp'); // consumedRatio 0.5 <= elapsedRatio (2/3 at day20)
    clock.advance(20 * 86_400_000); // remaining 10/30 -> ratio 1/3 -> amount round(3000/3)=1000
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.eligible).toBe(true);
    expect(decision.ruleId).toBe('D2');
    expect(decision.amount.amountMinor).toBe(1000);
    expect(decision.creditsToRevoke).toBe(Math.floor(1000 / 30)); // floor_credits default
  });

  it('[EC:D3] overuse denies time_prorated when overuseBehavior=deny (default)', async () => {
    const pol = resolvePolicy({ refund: { method: 'time_prorated' } });
    const period = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-31T00:00:00Z') };
    const p: Payment = {
      id: 'pay_d3', customerId, provider: 'stripe', providerRef: 'pi_d3', subscriptionId: 'sub_1',
      amount: { amountMinor: 3000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period,
      occurredAt: period.start, failure: null,
    };
    await repo.payments.put(p);
    await grant(p.id, 100, 30);
    await consume(80, 'consume:d3'); // consumedRatio 0.8 > elapsedRatio 2/3 at day 20
    clock.advance(20 * 86_400_000);
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.eligible).toBe(false);
    expect(decision.ruleId).toBe('D3');
    expect(decision.reason).toContain('overuse');
  });

  it('[EC:D3] refund_time_prorated_anyway computes the refund despite overuse', async () => {
    const pol = resolvePolicy({ refund: { method: 'time_prorated', overuseBehavior: 'refund_time_prorated_anyway' } });
    const period = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-31T00:00:00Z') };
    const p: Payment = {
      id: 'pay_d3b', customerId, provider: 'stripe', providerRef: 'pi_d3b', subscriptionId: 'sub_1',
      amount: { amountMinor: 3000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period,
      occurredAt: period.start, failure: null,
    };
    await repo.payments.put(p);
    await grant(p.id, 100, 30);
    await consume(80, 'consume:d3b');
    clock.advance(20 * 86_400_000);
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.eligible).toBe(true);
    expect(decision.ruleId).toBe('D2');
    // time_prorated computes 1000 minor / 33 credits, but B13 clamp_and_reduce_refund (default) then
    // clamps against the post-overuse balance (100 granted - 80 consumed = 20 available):
    // ratio 20/33 -> floor(1000 * 20/33) = 606 minor, 20 credits revoked.
    expect(decision.amount.amountMinor).toBe(606);
    expect(decision.creditsToRevoke).toBe(20);
    expect(decision.reason).toContain('B13 clamp_and_reduce_refund');
  });

  it('[EC:D2/min_of_both] picks unused_credits when it is smaller', async () => {
    const pol = resolvePolicy({ refund: { method: 'min_of_both' } });
    const period = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-31T00:00:00Z') };
    const p: Payment = {
      id: 'pay_mob1', customerId, provider: 'stripe', providerRef: 'pi_mob1', subscriptionId: 'sub_1',
      amount: { amountMinor: 3000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period,
      occurredAt: period.start, failure: null,
    };
    await repo.payments.put(p);
    await grant(p.id, 20, 30); // total value 600 minor
    await consume(1, 'consume:mob1'); // unused=19 -> 570 minor, well under elapsed ratio
    clock.advance(20 * 86_400_000); // time_prorated amount = 1000 minor (as above)
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.ruleId).toBe('D2');
    expect(decision.reason).toContain('unused_credits');
    expect(decision.amount.amountMinor).toBe(Math.round(19 * 30));
  });

  it('[EC:D2/min_of_both] picks time_prorated when it is smaller', async () => {
    const pol = resolvePolicy({ refund: { method: 'min_of_both' } });
    const period = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-31T00:00:00Z') };
    const p: Payment = {
      id: 'pay_mob2', customerId, provider: 'stripe', providerRef: 'pi_mob2', subscriptionId: 'sub_1',
      amount: { amountMinor: 3000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period,
      occurredAt: period.start, failure: null,
    };
    await repo.payments.put(p);
    await grant(p.id, 100, 30); // unused up to 3000 minor value
    await consume(10, 'consume:mob2'); // consumedRatio 0.1, within elapsed ratio
    clock.advance(20 * 86_400_000); // time_prorated = 1000 minor < unused (2700 minor)
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.ruleId).toBe('D2');
    expect(decision.reason).toContain('time_prorated');
    expect(decision.amount.amountMinor).toBe(1000);
  });

  it('[EC:D2/deny] policy.refund.method=deny -> ineligible', async () => {
    const pol = resolvePolicy({ refund: { method: 'deny' } });
    const p = await makeTopup('pay_deny', 1000);
    await grant(p.id, 100, 10);
    clock.advance(20 * 86_400_000);
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.eligible).toBe(false);
    expect(decision.ruleId).toBe('D2');
  });

  it('[EC:D10] velocity guard flips needsHuman once maxPerCustomerPerYear is exceeded', async () => {
    const p = await makeTopup('pay_d10', 1000);
    await grant(p.id, 100, 10);
    const past: Refund = {
      id: 'r_past', paymentId: 'other', customerId, amount: { amountMinor: 100, currency: 'USD' },
      status: 'succeeded', providerRef: null, creditsRevoked: 0, ruleId: 'D1', reason: null,
      failure: null, createdAt: clock.now(),
    };
    await repo.refunds.put({ ...past, id: 'r_past_1' });
    await repo.refunds.put({ ...past, id: 'r_past_2' });
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    expect(decision.needsHuman).toBe(true);
    expect(decision.ruleId).toBe('D10');
    expect(decision.reason).toContain('velocity');
  });

  it('[EC:I1] autoApprove.maxAmountMinor limit -> needsHuman true even when eligible', async () => {
    const pol = resolvePolicy({ cs: { autoApprove: { maxAmountMinor: 100, maxCredits: 10_000 } } });
    const p = await makeTopup('pay_i1a', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.eligible).toBe(true);
    expect(decision.needsHuman).toBe(true);
  });

  it('[EC:I1] autoApprove.maxCredits limit -> needsHuman true even when eligible', async () => {
    const pol = resolvePolicy({ cs: { autoApprove: { maxAmountMinor: 1_000_000, maxCredits: 10 } } });
    const p = await makeTopup('pay_i1b', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.eligible).toBe(true);
    expect(decision.needsHuman).toBe(true);
  });

  it('[EC:B13] clamp_to_zero leaves amount unchanged, revokes only what is available', async () => {
    const pol = resolvePolicy({ refund: { revokeShortfall: 'clamp_to_zero' } });
    const p = await makeTopup('pay_b13a', 1000);
    await grant(p.id, 100, 10);
    await consume(40, 'consume:b13a');
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.amount.amountMinor).toBe(1000);
    expect(decision.creditsToRevoke).toBe(60);
    expect(decision.reason).toContain('clamp_to_zero');
  });

  it('[EC:B13] allow_negative leaves both amount and creditsToRevoke at the original target', async () => {
    const pol = resolvePolicy({ refund: { revokeShortfall: 'allow_negative' } });
    const p = await makeTopup('pay_b13b', 1000);
    await grant(p.id, 100, 10);
    await consume(40, 'consume:b13b');
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy: pol, ledger, repo, clock });
    expect(decision.amount.amountMinor).toBe(1000);
    expect(decision.creditsToRevoke).toBe(100);
    expect(decision.reason).toContain('allow_negative');
  });

  it('[FINDINGS#1 regression] evaluate() uses the injected Clock, not wall time, for balance checks', async () => {
    // Real wall time is well past 2026-01 (system date 2026-09-09). A grant expiring 2026-06-01 is
    // "not yet expired" under the FixedClock (now=2026-01-01) but WOULD look expired under `new Date()`.
    // Before the fix, ledger.balance() was called without `now` and defaulted to the real wall clock,
    // making every grant look already-expired.
    const p = await makeTopup('pay_findings1', 1000);
    await grant(p.id, 100, 10, 'USD', new Date('2026-06-01T00:00:00Z'));
    clock.advance(3 * 86_400_000); // day 3, still well before the grant's expiresAt under FixedClock
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    expect(decision.eligible).toBe(true);
    expect(decision.creditsToRevoke).toBe(100); // not 0 / not phantom-negative-balance-driven
    expect(decision.amount.amountMinor).toBe(1000);
  });

  it('[FINDINGS#1 regression] consumedFromGrants B8 fallback also uses the injected Clock', async () => {
    // Second call site from FINDINGS.md #1: consumedFromGrants' B8 fallback (no attributed consume
    // entries at all -> approximate via ledger.balance()). Exercise the D2 branch (day > noQuestionsDays)
    // with zero consumption so the fallback formula alone decides the outcome. Same wall-clock-vs-
    // FixedClock trap as the B13 case above.
    const p = await makeTopup('pay_findings1b', 1000);
    await grant(p.id, 100, 10, 'USD', new Date('2026-06-01T00:00:00Z'));
    clock.advance(20 * 86_400_000); // day 20, outside the 7-day window -> unused_credits branch
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    expect(decision.eligible).toBe(true);
    expect(decision.ruleId).toBe('D2');
    // correct (FixedClock-aware): consumed=0 -> unused=100 -> amount=round(100*10)=1000, credits=100.
    // buggy (wall-clock): grant looks expired -> balance=0 -> consumed=100 -> unused=0 -> amount=0.
    expect(decision.amount.amountMinor).toBe(1000);
    expect(decision.creditsToRevoke).toBe(100);
  });
});

describe('refund.execute', () => {
  it('[EC:D15] hold -> revoke -> release ordering, revoke attributed to the grant (FINDINGS#3 regression)', async () => {
    const p = await makeTopup('pay_exec1', 1000);
    const g = await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new FakeProvider();
    const refund = await execute({ decision, provider, ledger, repo, clock, ids });

    expect(refund.status).toBe('succeeded');
    expect(refund.creditsRevoked).toBe(100);

    const entries = await ledger.entries(customerId);
    const kinds = entries.filter((e) => e.reference.refundId === refund.id).map((e) => e.kind);
    expect(kinds).toEqual(['hold', 'revoke', 'release']);

    const revokeEntry = entries.find((e) => e.kind === 'revoke' && e.reference.refundId === refund.id)!;
    expect(revokeEntry.reference.grantId).toBe(g.id);
    expect(revokeEntry.idempotencyKey).toBe(`revoke:refund:${refund.id}:${g.id}`);

    const holdEntry = entries.find((e) => e.kind === 'hold' && e.reference.refundId === refund.id)!;
    expect(holdEntry.idempotencyKey).toBe(`hold:refund:${refund.id}`);
    const releaseEntry = entries.find((e) => e.kind === 'release' && e.reference.refundId === refund.id)!;
    expect(releaseEntry.idempotencyKey).toBe(`release:refund:${refund.id}`);

    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);
  });

  it('[EC:D15/B8] a refund spanning 2+ grants writes one revoke entry PER grant, each carrying that grant\'s id (FINDINGS#3 regression)', async () => {
    const p = await makeTopup('pay_multi', 2000);
    const gA = await grant(p.id, 60, 10); // idempotencyKey `topup:pay_multi`
    // grant() always keys by `topup:${paymentId}`, so a second grant bucket on the same payment needs
    // its own explicit idempotencyKey — append directly rather than reusing the helper.
    const gB = (await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 140, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: p.id }, idempotencyKey: `topup:${p.id}:2`, actor: 'system', reason: null,
    })).entry;
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    expect(decision.creditsToRevoke).toBe(200); // 60 + 140, no consumption -> D1 full revoke

    const refund = await execute({ decision, provider: new FakeProvider(), ledger, repo, clock, ids });
    expect(refund.status).toBe('succeeded');
    expect(refund.creditsRevoked).toBe(200);

    const revokeEntries = (await ledger.entries(customerId, { kind: 'revoke' })).filter((e) => e.reference.refundId === refund.id);
    expect(revokeEntries).toHaveLength(2); // one per grant bucket, not one unattributed lump entry

    const byGrant = new Map(revokeEntries.map((e) => [e.reference.grantId, e]));
    expect(byGrant.get(gA.id)?.amount).toBe(-60);
    expect(byGrant.get(gA.id)?.idempotencyKey).toBe(`revoke:refund:${refund.id}:${gA.id}`);
    expect(byGrant.get(gB.id)?.amount).toBe(-140);
    expect(byGrant.get(gB.id)?.idempotencyKey).toBe(`revoke:refund:${refund.id}:${gB.id}`);

    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);

  });

  it('[EC:D15/B8] retrying execute() with the SAME refundId does not revoke twice (retry-idempotent)', async () => {
    const p = await makeTopup('pay_retry', 2000);
    const gA = await grant(p.id, 60, 10);
    const gB = (await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 140, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: p.id }, idempotencyKey: `topup:${p.id}:2`, actor: 'system', reason: null,
    })).entry;
    void gA; void gB;
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const fixedIds = { newId: () => 'refund_fixed' };

    const first = await execute({ decision, provider: new FakeProvider(), ledger, repo, clock, ids: fixedIds });
    expect(first.status).toBe('succeeded');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);

    const second = await execute({ decision, provider: new FakeProvider(), ledger, repo, clock, ids: fixedIds });
    expect(second.status).toBe('succeeded');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0); // was -200 before the fix
    const revokes = (await ledger.entries(customerId, { kind: 'revoke' })).filter((e) => e.reference.refundId === 'refund_fixed');
    expect(revokes.reduce((sum, e) => sum + -e.amount, 0)).toBe(200);
  });

  it('[EC:D15] the hold reduces available balance before the provider call resolves', async () => {
    const p = await makeTopup('pay_hold', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new DeferredProvider();

    const pending = execute({ decision, provider, ledger, repo, clock, ids });
    await provider.entered;
    const midFlight = await ledger.balance(customerId, 'paid', clock.now());
    expect(midFlight.available).toBe(0); // 100 - 100 (held)

    provider.release();
    const refund = await pending;
    expect(refund.status).toBe('succeeded');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);
  });

  it('[EC:D12] provider refund failure releases the hold, no permanent revoke, status failed', async () => {
    const p = await makeTopup('pay_d12', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const before = (await ledger.balance(customerId, 'paid', clock.now())).available;
    const refund = await execute({ decision, provider: new AlwaysFailProvider(), ledger, repo, clock, ids });

    expect(refund.status).toBe('failed');
    expect(refund.creditsRevoked).toBe(0);
    const after = (await ledger.balance(customerId, 'paid', clock.now())).available;
    expect(after).toBe(before);

    const entries = await ledger.entries(customerId, { kind: 'revoke' });
    expect(entries.filter((e) => e.reference.refundId === refund.id)).toHaveLength(0);
  });

  it('[EC:D13] Toss refund_receive_account_required -> failed + cs case with needs=refund_receive_account', async () => {
    const p = await makeTopup('pay_d13', 1000, 'KRW');
    await grant(p.id, 100, 10, 'KRW');
    clock.advance(0);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock }); // fresh -> D1
    const before = (await ledger.balance(customerId, 'paid', clock.now())).available;

    let opened: { customerId: string; referenceId: string; reason: string; needs?: string } | null = null;
    const refund = await execute({
      decision, provider: new ReceiveAccountRequiredProvider(), ledger, repo, clock, ids,
      cs: { openRefundFailedCase: async (input) => { opened = input; } },
    });

    expect(refund.status).toBe('failed');
    expect(refund.failure?.code).toBe('refund_receive_account_required');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(before);
    expect(opened).not.toBeNull();
    expect(opened!.needs).toBe('refund_receive_account');
  });

  it('[EC:K5] cancelOnRefund=true + extra.cashReceiptKey -> calls provider.cancelCashReceipt with paymentRef/receiptKey/amountMinor after a successful refund', async () => {
    const p = await makeTopup('pay_k5', 1000, 'KRW');
    await grant(p.id, 100, 10, 'KRW');
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new ProviderWithCashReceiptCancel();
    const pol: Policy = { ...policy, cashReceipt: { ...policy.cashReceipt, cancelOnRefund: true } };

    const refund = await execute({ decision, provider, ledger, repo, clock, ids, policy: pol, extra: { cashReceiptKey: 'receipt_123' } });

    expect(refund.status).toBe('succeeded');
    expect(provider.cashReceiptCancelCalls).toHaveLength(1);
    expect(provider.cashReceiptCancelCalls[0]).toMatchObject({ paymentRef: 'pi_pay_k5', receiptKey: 'receipt_123' });
  });

  it('[EC:K5] cancelOnRefund=false -> does NOT call provider.cancelCashReceipt even with a receipt key present', async () => {
    const p = await makeTopup('pay_k5b', 1000, 'KRW');
    await grant(p.id, 100, 10, 'KRW');
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new ProviderWithCashReceiptCancel();
    const pol: Policy = { ...policy, cashReceipt: { ...policy.cashReceipt, cancelOnRefund: false } };

    await execute({ decision, provider, ledger, repo, clock, ids, policy: pol, extra: { cashReceiptKey: 'receipt_123' } });

    expect(provider.cashReceiptCancelCalls).toHaveLength(0);
  });

  it('[EC:K5] cancelOnRefund=true but no extra.cashReceiptKey -> does NOT call provider.cancelCashReceipt', async () => {
    const p = await makeTopup('pay_k5c', 1000, 'KRW');
    await grant(p.id, 100, 10, 'KRW');
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new ProviderWithCashReceiptCancel();
    const pol: Policy = { ...policy, cashReceipt: { ...policy.cashReceipt, cancelOnRefund: true } };

    await execute({ decision, provider, ledger, repo, clock, ids, policy: pol });

    expect(provider.cashReceiptCancelCalls).toHaveLength(0);
  });

  it('[EC:K6] a cash-receipt-cancel failure does NOT roll back the already-succeeded refund, and escalates via cs.openRefundFailedCase', async () => {
    const p = await makeTopup('pay_k6', 1000, 'KRW');
    await grant(p.id, 100, 10, 'KRW');
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new ProviderWithFailingCashReceiptCancel();
    const pol: Policy = { ...policy, cashReceipt: { ...policy.cashReceipt, cancelOnRefund: true } };
    let opened: { customerId: string; referenceId: string; reason: string; needs?: string } | null = null;

    const refund = await execute({
      decision, provider, ledger, repo, clock, ids, policy: pol, extra: { cashReceiptKey: 'receipt_123' },
      cs: { openRefundFailedCase: async (input) => { opened = input; } },
    });

    expect(refund.status).toBe('succeeded'); // K6 — refund success is never rolled back
    expect(opened).not.toBeNull();
    expect(opened!.needs).toBe('cash_receipt_cancel_failed');
  });

  it('[EC:J1] a retried execute() with the default key replays the first Refund without calling the provider again', async () => {
    const p = await makeTopup('pay_j1', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new CountingProvider();

    const first = await execute({ decision, provider, ledger, repo, clock, ids });
    const second = await execute({ decision, provider, ledger, repo, clock, ids });

    expect(second).toEqual(first);
    expect(provider.calls).toBe(1); // not re-charged/re-refunded at the provider
    expect((await ledger.entries(customerId, { kind: 'revoke' })).length).toBe(1); // not double-revoked
  });

  it('[EC:J2] a retried execute() with the same key but a different decision throws idempotency_key_reused', async () => {
    const p = await makeTopup('pay_j2', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new CountingProvider();
    await execute({ decision, provider, ledger, repo, clock, ids, idempotencyKey: 'refund:fixed-key' });

    const otherDecision = { ...decision, amount: { ...decision.amount, amountMinor: decision.amount.amountMinor + 1 } };
    await expect(
      execute({ decision: otherDecision, provider, ledger, repo, clock, ids, idempotencyKey: 'refund:fixed-key' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('[EC:J3] a concurrent duplicate execute() call throws idempotency_in_progress', async () => {
    const p = await makeTopup('pay_j3', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new DeferredProvider();

    const pending = execute({ decision, provider, ledger, repo, clock, ids });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve(); // let the first call reach 'in_progress' before the second starts

    await expect(execute({ decision, provider, ledger, repo, clock, ids })).rejects.toMatchObject({
      code: 'idempotency_in_progress',
    });

    provider.release();
    await pending;
  });

  it('[EC:L5] correlationId reaches the provider via withCorrelationId and stamps the hold/revoke/release entries', async () => {
    const p = await makeTopup('pay_l5', 1000);
    const g = await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new RecordingProvider();

    const refund = await execute({ decision, provider, ledger, repo, clock, ids, correlationId: 'corr_l5_1' });
    expect(refund.status).toBe('succeeded');

    // provider.refund() was called through the scoped clone, not the bare provider.
    expect(provider.receivedCorrelationIds).toEqual(['corr_l5_1']);

    const entries = (await ledger.entries(customerId)).filter((e) => e.reference.refundId === refund.id);
    const byKind = new Map(entries.map((e) => [e.kind, e]));
    expect(byKind.get('hold')?.reference.correlationId).toBe('corr_l5_1');
    expect(byKind.get('revoke')?.reference.correlationId).toBe('corr_l5_1');
    expect(byKind.get('revoke')?.reference.grantId).toBe(g.id);
    expect(byKind.get('release')?.reference.correlationId).toBe('corr_l5_1');
  });

  it('[EC:L5] no correlationId -> the bare provider is used and entries carry no correlationId', async () => {
    const p = await makeTopup('pay_l5_none', 1000);
    await grant(p.id, 100, 10);
    clock.advance(3 * 86_400_000);
    const decision = await evaluate({ payment: p, policy, ledger, repo, clock });
    const provider = new RecordingProvider();

    const refund = await execute({ decision, provider, ledger, repo, clock, ids });
    expect(refund.status).toBe('succeeded');
    expect(provider.receivedCorrelationIds).toEqual([null]);

    const entries = (await ledger.entries(customerId)).filter((e) => e.reference.refundId === refund.id);
    for (const e of entries) expect(e.reference.correlationId).toBeUndefined();
  });
});

describe('refund.onExternalRefund', () => {
  const csStub: ReconcileMismatchCaseOpener & { calls: unknown[] } = {
    calls: [],
    async openReconcileMismatchCase(input) { this.calls.push(input); },
  };

  it('[EC:D8] matched payment: creates a revoke and is idempotent by provider refund reference', async () => {
    csStub.calls.length = 0;
    const p = await makeTopup('pay_d8', 1000);
    await grant(p.id, 100, 10);
    const event: NormalizedEvent = {
      id: 'evt_ext_1', refundRef: 're_ext_1', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(),
      customerRef: 'cus_1', subscriptionRef: null, paymentRef: p.providerRef,
      amount: { amountMinor: 1000, currency: 'USD' }, raw: {},
    };
    const first = await onExternalRefund({ event, ledger, repo, cs: csStub, clock, ids });
    expect(first.status).toBe('succeeded');
    expect(first.providerRef).toBe('re_ext_1');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);

    const second = await onExternalRefund({ event, ledger, repo, cs: csStub, clock, ids });
    expect(second.id).toBe(first.id); // no-op / same record, not a duplicate revoke
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);
  });

  it('[EC:D8] unmatched payment opens a reconcile-mismatch case', async () => {
    csStub.calls.length = 0;
    const event: NormalizedEvent = {
      id: 'evt_ext_unknown', refundRef: 're_ext_unknown', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(),
      customerRef: 'cus_unknown', subscriptionRef: null, paymentRef: 'pi_does_not_exist',
      amount: { amountMinor: 500, currency: 'USD' }, raw: {},
    };
    await expect(onExternalRefund({ event, ledger, repo, cs: csStub, clock, ids })).rejects.toMatchObject({ code: 'refund_reconciliation_required' });
    expect(await repo.refunds.list()).toHaveLength(0);
    expect(csStub.calls.length).toBe(1);
  });

  it('[EC:L5] correlationId stamps the revoke entry onExternalRefund writes', async () => {
    csStub.calls.length = 0;
    const p = await makeTopup('pay_l5_ext', 1000);
    await grant(p.id, 100, 10);
    const event: NormalizedEvent = {
      id: 'evt_ext_l5', refundRef: 're_ext_l5', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(),
      customerRef: 'cus_1', subscriptionRef: null, paymentRef: p.providerRef,
      amount: { amountMinor: 1000, currency: 'USD' }, raw: {},
    };
    const refund = await onExternalRefund({ event, ledger, repo, cs: csStub, clock, ids, correlationId: 'corr_l5_ext' });
    expect(refund.status).toBe('succeeded');

    const revoke = (await ledger.entries(customerId, { kind: 'revoke' })).find((e) => e.reference.refundId === refund.id);
    expect(revoke?.reference.correlationId).toBe('corr_l5_ext');
  });
});

describe('refund execution rule boundaries', () => {
  it('requires explicit approval before executing a needsHuman decision', async () => {
    const payment = await makeTopup('approval', 1000);
    const decision = { ...await evaluate({ payment, policy, ledger, repo, clock }), needsHuman: true };
    const provider = new CountingProvider();
    await expect(execute({ decision, provider, ledger, repo, clock, ids })).rejects.toMatchObject({ code: 'refund_approval_required' });
    expect(provider.calls).toBe(0);
  });
  it('rejects a decision for a different customer before calling the provider', async () => {
    const payment = await makeTopup('ownership', 1000);
    const decision = { ...await evaluate({ payment, policy, ledger, repo, clock }), customerId: 'other' };
    const provider = new CountingProvider();
    await expect(execute({ decision, provider, ledger, repo, clock, ids })).rejects.toMatchObject({ code: 'refund_invalid_decision' });
    expect(provider.calls).toBe(0);
  });
  it.each(['failed', 'pending'] as const)('does not revoke credits or mark payment refunded for provider status %s', async (status) => {
    const payment = await makeTopup('provider-status', 1000);
    await grant(payment.id, 100, 10);
    const decision = await evaluate({ payment, policy, ledger, repo, clock });
    class UnconfirmedProvider extends FakeProvider {
      async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> {
        return { ...await super.refund(input), status };
      }
    }
    const refund = await execute({ decision, provider: new UnconfirmedProvider(), ledger, repo, clock, ids });
    expect(refund.status).toBe(status);
    expect(refund.creditsRevoked).toBe(0);
    expect((await repo.payments.get(payment.id))?.status).toBe('succeeded');
    expect(await ledger.entries(customerId, { kind: 'revoke' })).toHaveLength(0);
  });
});

it.each(['refund.created', 'refund.failed'] as const)('settles a pending refund only with its trusted refund reference: %s', async (type) => {
  const payment = await makeTopup('pending-settle', 1000);
  await grant(payment.id, 100, 10);
  const decision = await evaluate({ payment, policy, ledger, repo, clock });
  class PendingProvider extends FakeProvider {
    async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> { return { ...await super.refund(input), status: 'pending' }; }
  }
  const pending = await execute({ decision, provider: new PendingProvider(), ledger, repo, clock, ids });
  const event: NormalizedEvent = { id: 'event-settle', provider: 'stripe', type, occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: payment.amount, raw: {} };
  const cs = { openReconcileMismatchCase: async () => {} };
  const unresolved = await onExternalRefund({ event, ledger, repo, cs, clock, ids });
  expect(unresolved.status).toBe('pending');
  expect(await repo.refunds.list({ paymentId: payment.id })).toHaveLength(1);
  event.refundRef = pending.providerRef;
  const settled = await onExternalRefund({ event, ledger, repo, cs, clock, ids });
  expect(settled.id).toBe(pending.id);
  expect(settled.status).toBe(type === 'refund.created' ? 'succeeded' : 'failed');
  expect((await ledger.balance(customerId, 'paid', clock.now())).held === 0).toBe(true);
  expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(type === 'refund.created' ? 0 : 100);
  const replay = await onExternalRefund({ event, refundRef: pending.providerRef ?? '', ledger, repo, cs, clock, ids });
  expect(replay.id).toBe(pending.id);
  expect(await repo.refunds.list({ paymentId: payment.id })).toHaveLength(1);
});

it('honors approved allow_negative credit revocation when a pending refund settles', async () => {
  const payment = await makeTopup('pending-negative', 1000);
  await grant(payment.id, 100, 10);
  await consume(60, 'pending-negative-use');
  const approvedPolicy = resolvePolicy({ refund: { revokeShortfall: 'allow_negative' } });
  const decision = await evaluate({ payment, policy: approvedPolicy, ledger, repo, clock });
  class PendingProvider extends FakeProvider {
    async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> { return { ...await super.refund(input), status: 'pending' }; }
  }
  const pending = await execute({ decision, provider: new PendingProvider(), ledger, repo, clock, ids });
  const event: NormalizedEvent = { id: 'event-negative', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: payment.amount, raw: {} };
  const settled = await onExternalRefund({ event, refundRef: pending.providerRef ?? '', ledger, repo, cs: { openReconcileMismatchCase: async () => {} }, clock, ids });
  expect(settled.creditsRevoked).toBe(100);
  expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(-60);
});

it.each(['refundRef', 'amount'] as const)('does not infer an external refund when %s is missing', async (missing) => {
  // Given a payment with credits but incomplete external refund evidence.
  const payment = await makeTopup('incomplete', 1000);
  await grant(payment.id, 100, 10);
  const event: NormalizedEvent = { id: 'delivery-only', refundRef: missing === 'refundRef' ? null : 'actual-refund', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: missing === 'amount' ? null : payment.amount, raw: {} };
  const reasons: string[] = [];
  // When reconciliation receives the incomplete event.
  await expect(onExternalRefund({ event, ledger, repo, clock, ids, cs: { openReconcileMismatchCase: async ({ reason }) => { reasons.push(reason); } } })).rejects.toMatchObject({ code: 'refund_reconciliation_required' });
  // Then it records the problem without inventing a refund or revoking credits.
  expect(reasons).toHaveLength(1);
  expect(await repo.refunds.list()).toHaveLength(0);
  expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(100);
});
