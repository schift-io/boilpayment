// E2E round-trip across all boilpayment modules (TypeScript side).
// Uses ONLY public package exports + an in-file fake PaymentProvider.
// Mirrors examples/e2e/round_trip.py line-for-line (except ISO tz suffix).
import {
  InMemoryLedger,
  InMemoryRepo,
  FixedClock,
  SequentialIdGen,
  CollectingNotifier,
  resolvePolicy,
  WebhookSignatureError,
} from 'boilpayment-core';
import type {
  Customer,
  Plan,
  Subscription,
  Payment,
  PaymentProvider,
  ProviderCapabilities,
  Money,
  NormalizedEvent,
  Refund,
  CreateCheckoutInput,
  Checkout,
} from 'boilpayment-core';
import * as credits from 'boilpayment-credits';
import * as lifecycle from 'boilpayment-lifecycle';
import * as refund from 'boilpayment-refund';
import * as usage from 'boilpayment-usage';
import * as webhook from 'boilpayment-webhook';
import * as cs from 'boilpayment-cs';

// ── in-file fake provider ────────────────────────────────────────────────────
class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private payments = new Map<string, Payment>(); // by providerRef
  private paymentsByCustomer = new Map<string, Payment[]>(); // by customerRef
  private subs = new Map<string, Subscription>(); // by providerRef

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true };
  }
  async createCustomer(): Promise<{ ref: string }> {
    return { ref: 'cus_fake' };
  }
  async createCheckout(_input: CreateCheckoutInput): Promise<Checkout> {
    throw new Error('fake: createCheckout not used in this scenario');
  }
  async getPayment(providerRef: string): Promise<Payment> {
    const p = this.payments.get(providerRef);
    if (!p) throw new Error(`fake: no payment ${providerRef}`);
    return p;
  }
  async listPayments(input: { customerRef: string; since: Date }): Promise<Payment[]> {
    return (this.paymentsByCustomer.get(input.customerRef) ?? []).filter((p) => p.occurredAt >= input.since);
  }
  async getSubscription(providerRef: string): Promise<Subscription> {
    const s = this.subs.get(providerRef);
    if (!s) throw new Error(`fake: no subscription ${providerRef}`);
    return s;
  }
  async changeSubscription(providerRef: string): Promise<Subscription> {
    const s = this.subs.get(providerRef);
    if (!s) throw new Error(`fake: no subscription ${providerRef}`);
    return s;
  }
  async cancelSubscription(providerRef: string): Promise<Subscription> {
    const s = this.subs.get(providerRef);
    if (!s) throw new Error(`fake: no subscription ${providerRef}`);
    return s;
  }
  async chargeBillingKey(): Promise<Payment> {
    throw new Error('fake: chargeBillingKey not used in this scenario');
  }
  async refund(input: { paymentRef: string; amount: Money; reason: string; idempotencyKey: string }): Promise<Refund> {
    const payment = this.payments.get(input.paymentRef);
    return {
      id: `re_${input.idempotencyKey}`,
      paymentId: payment?.id ?? '',
      customerId: payment?.customerId ?? '',
      amount: input.amount,
      status: 'succeeded',
      providerRef: `re_${input.idempotencyKey}`,
      creditsRevoked: 0,
      ruleId: '',
      reason: input.reason,
      failure: null,
      createdAt: new Date(),
    };
  }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string }): Promise<NormalizedEvent> {
    if (input.headers['x-sig'] !== 'ok') throw new WebhookSignatureError();
    const raw = JSON.parse(input.rawBody);
    return {
      id: raw.id,
      provider: 'stripe',
      type: raw.type,
      occurredAt: new Date(raw.occurredAt),
      customerRef: raw.customerRef ?? null,
      subscriptionRef: raw.subscriptionRef ?? null,
      paymentRef: raw.paymentRef ?? null,
      amount: raw.amount ?? null,
      raw,
    };
  }

  // test-only helpers — mirror local repo state into the "live" provider view
  setPayment(p: Payment, customerRef: string): void {
    this.payments.set(p.providerRef, p);
    const list = this.paymentsByCustomer.get(customerRef) ?? [];
    const idx = list.findIndex((x) => x.providerRef === p.providerRef);
    if (idx >= 0) list[idx] = p;
    else list.push(p);
    this.paymentsByCustomer.set(customerRef, list);
  }
  setSubscription(s: Subscription): void {
    this.subs.set(s.providerRef, s);
  }
}

function fmt(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return String(v);
  return String(v);
}
function line(n: string, label: string, kv: Record<string, unknown>): void {
  const parts = Object.entries(kv)
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(' ');
  console.log(`${n}_${label}: ${parts}`);
}

async function main() {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
  const ids = new SequentialIdGen('id_');
  const ledger = new InMemoryLedger(ids);
  const repo = new InMemoryRepo();
  const notifier = new CollectingNotifier();
  const policy = resolvePolicy({ credits: { rollover: 'banked', bankCap: 50 } });
  const provider = new FakeProvider();

  // ── 01 seed ─────────────────────────────────────────────────────────────
  const customer: Customer = {
    id: 'cust1',
    email: 'e@x.com',
    providerRefs: [{ provider: 'stripe', ref: 'cus_1' }],
    status: 'active',
    createdAt: clock.now(),
  };
  await repo.customers.put(customer);

  const planA: Plan = { id: 'planA', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 5, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
  const planB: Plan = { id: 'planB', name: 'Plan B', interval: 'month', creditsPerPeriod: 300, usageIncluded: 20, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 3000 }] };
  await repo.plans.put(planA);
  await repo.plans.put(planB);

  let sub1: Subscription = {
    id: 'sub1',
    customerId: 'cust1',
    planId: 'planA',
    provider: 'stripe',
    providerRef: 'sub_1',
    status: 'active',
    currentPeriod: { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-02-01T00:00:00.000Z') },
    anchorDay: 1,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    billingKey: null,
    scheduledPlanId: null,
    version: 0,
    createdAt: clock.now(),
  };
  await repo.subscriptions.put(sub1);
  provider.setSubscription(sub1);

  const payment1: Payment = {
    id: 'pay1',
    customerId: 'cust1',
    provider: 'stripe',
    providerRef: 'pay_1',
    subscriptionId: 'sub1',
    amount: { amountMinor: 1000, currency: 'USD' },
    status: 'succeeded',
    kind: 'subscription',
    period: { start: sub1.currentPeriod.start, end: sub1.currentPeriod.end },
    occurredAt: clock.now(),
    failure: null,
  };
  await repo.payments.put(payment1);
  provider.setPayment(payment1, 'cus_1');

  line('01', 'seed', { customer: customer.id, planA: planA.id, planB: planB.id, sub: sub1.id, payment: payment1.id });

  // ── 02 webhook: payment.succeeded (first period) ───────────────────────
  const lifecycleDeps = { onRenewalPaid: lifecycle.onRenewalPaid, dunning: { onPaymentFailed: lifecycle.dunning.onPaymentFailed } };
  const handlers = webhook.defaultHandlers({ policy, ledger, repo, notifier, clock, ids, lifecycle: lifecycleDeps });

  const evt1 = { id: 'evt_1', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), customerRef: 'cus_1', subscriptionRef: 'sub_1', paymentRef: 'pay_1', amount: payment1.amount };
  const r1 = await webhook.receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: JSON.stringify(evt1), repo, clock });
  await webhook.process({ eventId: r1.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  let bal = await ledger.balance('cust1', 'paid', clock.now());
  line('02', 'webhook_first_period', { received_status: r1.status, duplicated: r1.duplicated, balance: bal.available });

  const r1dup = await webhook.receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: JSON.stringify(evt1), repo, clock });
  await webhook.process({ eventId: r1dup.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  bal = await ledger.balance('cust1', 'paid', clock.now());
  line('02', 'webhook_duplicate', { duplicated: r1dup.duplicated, balance: bal.available });

  // ── 03 consume 30 ───────────────────────────────────────────────────────
  const consumeResult = await credits.consume({ customerId: 'cust1', amount: 30, policy, ledger, clock, idempotencyKey: 'consume:1' });
  bal = await ledger.balance('cust1', 'paid', clock.now());
  line('03', 'consume', { ok: consumeResult.ok, balance: bal.available });

  // ── 04 advance to Jan 16, upgrade to plan B ────────────────────────────
  clock.advance(15 * 86_400_000);
  sub1 = (await repo.subscriptions.get('sub1'))!;
  const upgradeResult = await lifecycle.upgrade({ sub: sub1, newPlan: planB, policy, provider, ledger, repo, clock, ids });
  sub1 = upgradeResult.sub;
  provider.setSubscription(sub1);
  bal = await ledger.balance('cust1', 'paid', clock.now());
  line('04', 'upgrade', {
    creditDelta: upgradeResult.creditDelta,
    anchorDay: sub1.anchorDay,
    periodStart: sub1.currentPeriod.start,
    periodEnd: sub1.currentPeriod.end,
    balance: bal.available,
  });

  // ── 05 usage.record x3 + usage.check (included=5, hard_block) ──────────
  for (let i = 0; i < 3; i++) {
    await usage.record({
      event: { customerId: 'cust1', meter: 'api_call', quantity: 1, occurredAt: clock.now(), idempotencyKey: `usage:${i}` },
      sub: sub1,
      policy,
      repo,
      clock,
      ids,
    });
  }
  const checkAllow = await usage.check({ customerId: 'cust1', meter: 'api_call', quantity: 2, sub: sub1, policy, repo, ledger, clock, includedQuantity: 5 });
  const checkBlock = await usage.check({ customerId: 'cust1', meter: 'api_call', quantity: 4, sub: sub1, policy, repo, ledger, clock, includedQuantity: 5 });
  line('05', 'usage', { allow: checkAllow.allow, allow_reason: checkAllow.reason, block: checkBlock.allow, block_reason: checkBlock.reason });

  // ── 06 advance to period end (Feb 16), renewal ─────────────────────────
  clock.advance(sub1.currentPeriod.end.getTime() - clock.now().getTime());
  sub1 = (await repo.subscriptions.get('sub1'))!;
  const period2 = lifecycle.period.nextPeriod(sub1.currentPeriod, 'month', sub1.anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
  const payment2: Payment = {
    id: 'pay2',
    customerId: 'cust1',
    provider: 'stripe',
    providerRef: 'pay_2',
    subscriptionId: 'sub1',
    amount: { amountMinor: planB.prices[0].amountMinor, currency: 'USD' },
    status: 'succeeded',
    kind: 'subscription',
    period: period2,
    occurredAt: clock.now(),
    failure: null,
  };
  await repo.payments.put(payment2);
  provider.setPayment(payment2, 'cus_1');
  provider.setSubscription(sub1);

  const evt2 = { id: 'evt_2', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), customerRef: 'cus_1', subscriptionRef: 'sub_1', paymentRef: 'pay_2', amount: payment2.amount };
  const r2 = await webhook.receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: JSON.stringify(evt2), repo, clock });
  await webhook.process({ eventId: r2.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  sub1 = (await repo.subscriptions.get('sub1'))!;
  bal = await ledger.balance('cust1', 'paid', clock.now());
  line('06', 'renewal', { periodStart: sub1.currentPeriod.start, periodEnd: sub1.currentPeriod.end, balance: bal.available });

  // ── 07 refund at day 3 (D1) via cs.refundAssist ────────────────────────
  clock.advance(3 * 86_400_000);
  const decision = await refund.evaluate({ payment: payment2, sub: sub1, policy, ledger, repo, clock });
  const csCaseRefund = await cs.openCase({ customerId: 'cust1', kind: 'refund', referenceId: payment2.id, policy, repo, clock, ids });
  const resolvedRefundCase = await cs.refundAssist({
    case: csCaseRefund,
    payment: payment2,
    sub: sub1,
    policy,
    ledger,
    repo,
    clock,
    ids,
    provider,
    refundEvaluate: refund.evaluate,
    refundExecute: refund.execute,
  });
  bal = await ledger.balance('cust1', 'paid', clock.now());
  const refundRecord = (resolvedRefundCase.decision as Record<string, unknown> | null)?.refund as Refund | undefined;
  line('07', 'refund', {
    ruleId: decision.ruleId,
    amountMinor: decision.amount.amountMinor,
    creditsToRevoke: decision.creditsToRevoke,
    needsHuman: decision.needsHuman,
    caseStatus: resolvedRefundCase.status,
    refundStatus: refundRecord?.status,
    balance: bal.available,
  });

  // ── 08 cs.reconcile / cs.regrant (topup payment with no ledger grant) ──
  const topupPayment: Payment = {
    id: 'pay3',
    customerId: 'cust1',
    provider: 'stripe',
    providerRef: 'pay_3',
    subscriptionId: null,
    amount: { amountMinor: 500, currency: 'USD' },
    status: 'succeeded',
    kind: 'topup',
    period: null,
    occurredAt: clock.now(),
    failure: null,
  };
  provider.setPayment(topupPayment, 'cus_1'); // deliberately NOT stored in local repo.payments / no ledger grant

  const since = new Date('2026-01-01T00:00:00.000Z');
  const cases1 = await cs.reconcile({ providers: { stripe: provider }, ledger, repo, policy, clock, ids, since });
  const regrantCase = cases1.find((c) => c.kind === 'regrant' && c.referenceId === `topup:${topupPayment.id}`);
  if (!regrantCase) throw new Error('expected a regrant case for the unmatched topup payment');
  const regranted = await cs.regrant({ case: regrantCase, ledger, repo, policy, clock, ids, plan: { pool: 'paid', amount: 50, reason: 'reconcile regrant' } });
  bal = await ledger.balance('cust1', 'paid', clock.now());
  const cases2 = await cs.reconcile({ providers: { stripe: provider }, ledger, repo, policy, clock, ids, since });
  line('08', 'cs_reconcile', { cases_found: cases1.length, regrant_status: regranted.status, balance: bal.available, cases_second_pass: cases2.length });

  // ── 09 dunning: payment_failed -> grace expired ────────────────────────
  provider.setSubscription(sub1);
  const evt3 = { id: 'evt_3', type: 'subscription.payment_failed', occurredAt: clock.now().toISOString(), customerRef: 'cus_1', subscriptionRef: 'sub_1', paymentRef: null, amount: null };
  const r3 = await webhook.receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: JSON.stringify(evt3), repo, clock });
  await webhook.process({ eventId: r3.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  sub1 = (await repo.subscriptions.get('sub1'))!;
  line('09', 'payment_failed', { status: sub1.status, graceUntil: sub1.graceUntil });

  clock.advance(8 * 86_400_000);
  sub1 = (await repo.subscriptions.get('sub1'))!;
  const graceResult = await lifecycle.dunning.onGraceExpired({ sub: sub1, policy, ledger, repo, notifier, clock });
  sub1 = graceResult.sub;
  bal = await ledger.balance('cust1', 'paid', clock.now());
  line('09', 'grace_expired', {
    status: sub1.status,
    revoked_count: graceResult.revoked.length,
    balance: bal.available,
    notifier_types: notifier.sent.map((n) => n.type).join(','),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
