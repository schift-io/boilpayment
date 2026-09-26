// Runs the real lifecycle.* (+ transitively credits.*) code path against core's in-memory
// reference implementations. No test framework — prints balances/state at each step; compare
// byte-for-byte against py/examples/smoke.py's stdout.
import {
  Checkout,
  CollectingNotifier,
  CreateCheckoutInput,
  FixedClock,
  InMemoryLedger,
  InMemoryRepo,
  Money,
  NormalizedEvent,
  Payment,
  PaymentKitError,
  PaymentProvider,
  Plan,
  Refund,
  SequentialIdGen,
  Subscription,
  resolvePolicy,
} from 'boilpayment-core';
import { upgrade, downgrade, dunning } from 'boilpayment-lifecycle';
import { onRenewalPaid } from 'boilpayment-lifecycle';
import { consume, manualRevoke, notifyExpiring } from 'boilpayment-credits';

// Minimal canned PaymentProvider — only changeSubscription is actually invoked by this scenario
// (upgrade/downgrade), and its return value is discarded by lifecycle. Everything else throws if
// hit, so a real call site accidentally exercising it would fail loudly.
class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  capabilities() {
    return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider' as const, webhookSignature: true };
  }
  async createCustomer(): Promise<{ ref: string }> {
    return { ref: 'cus_fake' };
  }
  async createCheckout(_input: CreateCheckoutInput): Promise<Checkout> {
    throw new Error('not used in this scenario');
  }
  async getPayment(): Promise<Payment> {
    throw new Error('not used in this scenario');
  }
  async listPayments(): Promise<Payment[]> {
    return [];
  }
  async getSubscription(): Promise<Subscription> {
    throw new Error('not used in this scenario');
  }
  async changeSubscription(): Promise<Subscription> {
    return DUMMY_SUB; // lifecycle discards this return value; canned for interface compliance
  }
  async cancelSubscription(): Promise<Subscription> {
    return DUMMY_SUB;
  }
  async chargeBillingKey(): Promise<Payment> {
    throw new Error('not used in this scenario');
  }
  async refund(): Promise<Refund> {
    throw new Error('not used in this scenario');
  }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(): Promise<NormalizedEvent> {
    throw new Error('not used in this scenario');
  }
}

let DUMMY_SUB: Subscription; // assigned once `sub` exists, below

// EC:F — Toss-shaped self-scheduling provider: no native subscription tracking. getSubscription/
// changeSubscription/cancelSubscription throw exactly like the real Toss/PortOne provider
// implementations do, so if lifecycle.upgrade ever regressed into calling changeSubscription for a
// non-native provider, this smoke would fail loudly instead of silently passing.
class FakeSelfSchedulingProvider implements PaymentProvider {
  readonly name = 'toss' as const;
  lastCharge: { amountMinor: number; currency: string } | null = null;
  nextChargeStatus: 'succeeded' | 'failed' = 'succeeded'; // EC:A24 smoke steps flip this to force a retry
  capabilities() {
    return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self' as const, webhookSignature: false };
  }
  async createCustomer(): Promise<{ ref: string }> {
    return { ref: 'cus_toss_fake' };
  }
  async createCheckout(): Promise<Checkout> {
    throw new Error('not used in this scenario');
  }
  async getPayment(): Promise<Payment> {
    throw new Error('not used in this scenario');
  }
  async listPayments(): Promise<Payment[]> {
    return [];
  }
  async getSubscription(): Promise<Subscription> {
    throw new PaymentKitError('unsupported', 'unsupported');
  }
  async changeSubscription(): Promise<Subscription> {
    throw new PaymentKitError('unsupported', 'unsupported');
  }
  async cancelSubscription(): Promise<Subscription> {
    throw new PaymentKitError('unsupported', 'unsupported');
  }
  async chargeBillingKey(input: { billingKey: string; amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment> {
    this.lastCharge = { amountMinor: input.amount.amountMinor, currency: input.amount.currency };
    return {
      id: `pay_${input.idempotencyKey}`,
      customerId: input.customerRef,
      provider: 'toss',
      providerRef: input.orderId,
      subscriptionId: null,
      amount: input.amount,
      status: this.nextChargeStatus,
      kind: 'subscription',
      period: null,
      occurredAt: new Date(),
      failure: this.nextChargeStatus === 'failed' ? { code: 'card_declined', providerCode: null, retryable: true, userMessage: 'declined' } : null,
    };
  }
  async refund(): Promise<Refund> {
    throw new Error('not used in this scenario');
  }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(): Promise<NormalizedEvent> {
    throw new Error('not used in this scenario');
  }
}

async function main(): Promise<void> {
  const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  const notifier = new CollectingNotifier();
  const provider = new FakeProvider();
  const ids = new SequentialIdGen('id_');
  const policy = resolvePolicy(); // DEFAULT_POLICY

  const planA: Plan = {
    id: 'plan_a',
    name: 'Plan A',
    interval: 'month',
    creditsPerPeriod: 100,
    usageIncluded: 0,
    trialDays: 0,
    prices: [{ currency: 'USD', amountMinor: 1000 }],
  };
  const planB: Plan = {
    id: 'plan_b',
    name: 'Plan B',
    interval: 'month',
    creditsPerPeriod: 300,
    usageIncluded: 0,
    trialDays: 0,
    prices: [{ currency: 'USD', amountMinor: 3000 }],
  };
  await repo.plans.put(planA);
  await repo.plans.put(planB);

  let sub: Subscription = {
    id: 'sub_1',
    customerId: 'cust_1',
    planId: planA.id,
    provider: 'stripe',
    providerRef: 'stripe_sub_1',
    status: 'active',
    currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    billingKey: null,
    scheduledPlanId: null,
    version: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  };
  DUMMY_SUB = sub;
  await repo.subscriptions.put(sub);

  const print = async (label: string) => {
    const balance = await ledger.balance(sub.customerId, undefined, clock.now());
    console.log(`${label}: balance=${balance.available} status=${sub.status} planId=${sub.planId} periodStart=${sub.currentPeriod.start.toISOString()}`);
  };

  // 1. onRenewalPaid grants the first period's credits (Jan 1 - Feb 1, plan A, $10 -> 100 credits)
  const payment1: Payment = {
    id: 'pay_1',
    customerId: sub.customerId,
    provider: 'stripe',
    providerRef: 'pi_1',
    subscriptionId: sub.id,
    amount: { amountMinor: 1000, currency: 'USD' },
    status: 'succeeded',
    kind: 'subscription',
    period: null, // falls back to sub.currentPeriod — see renewal.ts
    occurredAt: clock.now(),
    failure: null,
  };
  const r1 = await onRenewalPaid({ sub, payment: payment1, policy, ledger, repo, clock });
  sub = r1.sub;
  await print('01_renewal_paid_100');

  // 2. consume 30
  await consume({ customerId: sub.customerId, amount: 30, policy, ledger, clock, idempotencyKey: 'consume_1' });
  await print('02_consume_30');

  // 3. mid-cycle upgrade to plan B on Jan 16 (default policy: immediate_prorate_reset_anchor, full_delta)
  clock.advance(15 * 86_400_000); // Jan 1 -> Jan 16
  const u1 = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
  sub = u1.sub;
  console.log(`03_upgrade_full_delta: creditDelta=${u1.creditDelta} anchorDay=${sub.anchorDay}`);
  await print('03_upgrade_full_delta');

  // 4. consume 250 (leaves only 20 — sets up a clawback shortfall below)
  await consume({ customerId: sub.customerId, amount: 250, policy, ledger, clock, idempotencyKey: 'consume_2' });
  await print('04_consume_250');

  // 5. downgrade back to plan A, immediate_clawback (custom policy) — wants to revoke 200 but only
  //    20 is available, so clamp_to_zero clamps the revoke and reports the shortfall.
  const policyClawback = resolvePolicy({ downgrade: { mode: 'immediate_clawback' } });
  const d1 = await downgrade({ sub, newPlan: planA, policy: policyClawback, provider, ledger, repo, clock, ids });
  sub = d1.sub;
  console.log(`05_downgrade_clawback: revoked=${d1.clawback?.revoked ?? 0} shortfall=${d1.clawback?.shortfall ?? 0}`);
  await print('05_downgrade_clawback');

  // 6. renewal payment fails -> grace period starts
  const f1 = await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
  sub = f1.sub;
  console.log(`06_payment_failed: status=${sub.status} graceUntil=${sub.graceUntil?.toISOString()}`);

  // 7. payment recovers -> regrant current period
  const payment2: Payment = {
    id: 'pay_2',
    customerId: sub.customerId,
    provider: 'stripe',
    providerRef: 'pi_2',
    subscriptionId: sub.id,
    amount: { amountMinor: 1000, currency: 'USD' },
    status: 'succeeded',
    kind: 'subscription',
    period: null,
    occurredAt: clock.now(),
    failure: null,
  };
  const rec1 = await dunning.onRecovered({ sub, payment: payment2, policy, ledger, repo, clock });
  sub = rec1.sub;
  await print('07_recovered');

  console.log(`notifications=${notifier.sent.map((n) => n.type).join(',')}`);

  // 8. EC:F — mid-cycle upgrade on a self-scheduling (Toss-shaped) provider: nativeSubscriptions is
  //    false, so upgrade() must NOT call changeSubscription (it would throw PaymentKitError
  //    'unsupported' here, exactly like the real Toss/PortOne providers) — instead it charges the
  //    prorated money delta directly via chargeBillingKey.
  const tossProvider = new FakeSelfSchedulingProvider();
  let subToss: Subscription = {
    id: 'sub_toss_1',
    customerId: 'cust_toss_1',
    planId: planA.id,
    provider: 'toss',
    providerRef: 'toss_sub_1',
    status: 'active',
    currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    billingKey: 'bk_toss_1',
    scheduledPlanId: null,
    version: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  };
  await repo.subscriptions.put(subToss);

  const paymentToss: Payment = {
    id: 'pay_toss_1',
    customerId: subToss.customerId,
    provider: 'toss',
    providerRef: 'toss_pi_1',
    subscriptionId: subToss.id,
    amount: { amountMinor: 1000, currency: 'USD' },
    status: 'succeeded',
    kind: 'subscription',
    period: null,
    occurredAt: clock.now(),
    failure: null,
  };
  const rToss1 = await onRenewalPaid({ sub: subToss, payment: paymentToss, policy, ledger, repo, clock });
  subToss = rToss1.sub;

  const uToss = await upgrade({ sub: subToss, newPlan: planB, policy, provider: tossProvider, ledger, repo, clock, ids });
  subToss = uToss.sub;
  const balanceToss = await ledger.balance(subToss.customerId, undefined, clock.now());
  console.log(
    `08_self_scheduling_upgrade: changeSubscription_called=false creditDelta=${uToss.creditDelta} balance=${balanceToss.available} planId=${subToss.planId} chargedMinor=${tossProvider.lastCharge?.amountMinor} chargedCurrency=${tossProvider.lastCharge?.currency}`,
  );

  // 9. EC:A24 — smart retry: a fresh past_due Toss subscription with a billing key. First retry
  //    attempt fails, second retry attempt (1 hour later per a custom short interval) succeeds and
  //    routes into dunning.onRecovered.
  const retryProvider = new FakeSelfSchedulingProvider();
  let subRetry: Subscription = {
    ...subToss,
    id: 'sub_retry_1',
    customerId: 'cust_retry_1',
    status: 'past_due',
    version: 0,
  };
  await repo.subscriptions.put(subRetry);
  const retryPolicy = resolvePolicy({ dunning: { retryAttempts: 2, retryIntervalHours: [1, 1, 1] } });
  await dunning.onPaymentFailed({ sub: subRetry, policy: retryPolicy, repo, notifier, clock });
  clock.advance(3_600_000); // +1h — attempt 1 due
  let due = await dunning.retryDue({ repo, clock });
  retryProvider.nextChargeStatus = 'failed';
  const attempt1 = await dunning.runRetry({ item: due[0], provider: retryProvider, repo, ledger, policy: retryPolicy, notifier, clock });
  console.log(`09a_retry_attempt1: outcome=${attempt1.outcome} charged=${retryProvider.lastCharge !== null}`);
  clock.advance(3_600_000); // +1h — attempt 2 due
  due = await dunning.retryDue({ repo, clock });
  retryProvider.nextChargeStatus = 'succeeded';
  const attempt2 = await dunning.runRetry({ item: due[0], provider: retryProvider, repo, ledger, policy: retryPolicy, notifier, clock });
  const balRetry = await ledger.balance('cust_retry_1', undefined, clock.now());
  console.log(`09b_retry_attempt2: outcome=${attempt2.outcome} subStatus=${attempt2.sub?.status} balance=${balRetry.available}`);

  // 10. EC:B17 — negative balance offset: manualRevoke pushes cust_offset_1 to -30, then a 100-credit
  //     grant lands. offset_next_grant (default) settles 30 of the debt and caps the fresh grant's
  //     own bucket to 70 spendable.
  await manualRevoke({ customerId: 'cust_offset_1', pool: 'paid', amount: 30, reason: 'chargeback', actor: 'admin', ledger, clock, idempotencyKey: 'debt_offset_1' });
  let subOffset: Subscription = { ...subToss, id: 'sub_offset_1', customerId: 'cust_offset_1', planId: planA.id, status: 'active', version: 0 };
  await repo.subscriptions.put(subOffset);
  const paymentOffset: Payment = { ...paymentToss, id: 'pay_offset_1', customerId: 'cust_offset_1', subscriptionId: subOffset.id };
  const rOffset = await onRenewalPaid({ sub: subOffset, payment: paymentOffset, policy, ledger, repo, clock });
  const grantOffset = rOffset.grant;
  const balOffset = await ledger.balance('cust_offset_1', undefined, clock.now());
  console.log(`10_negative_offset: granted=${grantOffset?.entry?.amount} offset=${grantOffset?.offset} balance=${balOffset.available}`);

  // 11. EC:B16 — expiry notice: cust_expire_1 has 100 credits expiring in 3 days; a 7-day notice
  //     window picks it up once, then is silent on a same-day rerun.
  await onRenewalPaid({
    sub: { ...subToss, id: 'sub_expire_1', customerId: 'cust_expire_1', planId: planA.id, status: 'active', version: 0, currentPeriod: { start: clock.now(), end: new Date(clock.now().getTime() + 3 * 86_400_000) } },
    payment: { ...paymentToss, id: 'pay_expire_1', customerId: 'cust_expire_1', subscriptionId: 'sub_expire_1' },
    policy,
    ledger,
    repo,
    clock,
  });
  const expiryPolicy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });
  const notice1 = await notifyExpiring({ customerId: 'cust_expire_1', ledger, repo, notifier, policy: expiryPolicy, clock });
  const notice2 = await notifyExpiring({ customerId: 'cust_expire_1', ledger, repo, notifier, policy: expiryPolicy, clock });
  console.log(`11_expiry_notice: first_pending=${notice1.pending.length} second_pending_same_day=${notice2.pending.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
