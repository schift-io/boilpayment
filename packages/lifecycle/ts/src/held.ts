// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A53 A54
// What a person does after the kit stopped and told them. Two states wait for a person:
//   EC:A53 A58 — an attempt held for review (EC:A50: the provider's order did not match the charge);
//   EC:A54 — a subscription parked by missedPeriods = 'needs_human_only' (EC:A47).
// Without these the only way out was editing rows by hand.
import { Clock, isUnderReview, LedgerStore, Money, NoopNotifier, Notifier, Payment, PaymentKitError, PaymentProvider, Plan, Policy, Repo, Subscription } from 'boilpayment-core';
import { attemptKeyOf, orderIdOf, withAttemptLease } from './charge-attempt.js';
import { onRenewalPaid } from './renewal.js';
import { onPaymentFailed } from './dunning.js';
import { catchUpPeriods } from './missed-periods.js';
import { renewalPlanId } from './internal.js';

export type HeldDecision = 'settle' | 'void' | 'close';

export interface ResolveHeldAttemptInput {
  paymentId: string;
  /**
   * settle — the provider's order IS this renewal (for example a price change since the send): the row
   *          takes the provider's amount and reference, becomes succeeded and buys its period.
   * void   — no money moved for this attempt, or it was fully refunded at the provider: the row is closed
   *          as failed and dunning takes over the renewal (grace, retries), as for a decline. Refused
   *          when the provider shows the order paid, partly refunded, disputed or still pending.
   * close  — money moved but the kit should neither grant nor charge again (a partial refund, an order
   *          a person settles outside the kit): the row is closed, the subscription moves past the
   *          period without a grant, and the person handles any refund (EC:A58).
   */
  decision: HeldDecision;
  /** Who decided (kept on the row). */
  actor: string;
  note?: string;
  /** EC:A58 — asked again for the order before `void`. */
  provider: PaymentProvider;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  notifier?: Notifier;
}

export interface ResolveHeldAttemptResult {
  payment: Payment;
  sub: Subscription | null;
}

interface Review { reason?: string; status?: string; amount?: Money | null; providerRef?: string | null }

/** Order states in which money is (or may still be) with the merchant: `void` would charge the period again. */
const MOVED_MONEY = new Set(['succeeded', 'partially_refunded', 'disputed', 'pending', 'requires_action']);

/**
 * EC:A53 A58 — resolve an attempt held for review. Throws `attempt_not_held` for any other row and
 * `attempt_in_flight` while another worker holds the attempt (EC:A37: the decision runs under the same
 * lease as every other attempt writer, so two decisions cannot both apply).
 */
export async function resolveHeldAttempt(input: ResolveHeldAttemptInput): Promise<ResolveHeldAttemptResult> {
  const { paymentId, repo, clock } = input;
  // I-2 — the provider is asked about the order before `void`; a missing one is a clear error, not a TypeError.
  if (!input.provider || typeof input.provider.capabilities !== 'function') {
    throw new PaymentKitError('resolveHeldAttempt needs the provider of this attempt', 'provider_required', { paymentId });
  }
  const first = await repo.payments.get(paymentId);
  if (!first || first.status !== 'pending' || !isUnderReview(first)) {
    throw new PaymentKitError('payment is not an attempt held for review', 'attempt_not_held', { paymentId });
  }
  const leased = await withAttemptLease(repo, clock, attemptKeyOf(first) ?? first.id, () => resolveHeld(input));
  if (!leased.held) throw new PaymentKitError('another worker is handling this attempt; try again', 'attempt_in_flight', { paymentId });
  return leased.value;
}

async function resolveHeld(input: ResolveHeldAttemptInput): Promise<ResolveHeldAttemptResult> {
  const { paymentId, decision, actor, policy, ledger, repo, clock } = input;
  const notifier = input.notifier ?? new NoopNotifier();
  const row = await repo.payments.get(paymentId); // re-read under the lease: another decision may have won
  if (!row || row.status !== 'pending' || !isUnderReview(row)) {
    throw new PaymentKitError('payment is not an attempt held for review', 'attempt_not_held', { paymentId });
  }
  const raw = { ...(row.raw as Record<string, unknown>) };
  const review = raw.boilpaymentReview as Review;
  delete raw.boilpaymentReview;
  raw.boilpaymentReviewResolved = { ...review, decision, actor, note: input.note ?? null, at: clock.now().toISOString() };
  const sub = row.subscriptionId ? await repo.subscriptions.get(row.subscriptionId) : null;

  if (decision === 'settle') {
    // Only a paid order buys a period: a refunded or disputed one is voided or closed by a person.
    if (review.status !== 'succeeded') {
      throw new PaymentKitError(`the held order is ${review.status ?? 'unknown'}, not paid: void or close it instead`, 'held_order_not_paid', { paymentId });
    }
    const settled: Payment = { ...row, status: 'succeeded', amount: review.amount ?? row.amount,
      providerRef: review.providerRef || row.providerRef, failure: null, raw };
    await repo.payments.put(settled);
    if (!sub) return { payment: settled, sub: null };
    const result = await onRenewalPaid({ sub, payment: settled, policy, ledger, repo, clock });
    return { payment: settled, sub: result.sub };
  }

  if (decision === 'close') {
    const closed: Payment = { ...row, status: 'failed', raw, failure: {
      code: 'review_closed', providerCode: null, retryable: false, userMessage: 'A person closed this charge after review; any refund is handled by them.' } };
    await repo.payments.put(closed);
    // EC:A58 — the period is over as far as the kit is concerned: no grant and no further charge for it.
    if (sub && row.period && (sub.status === 'active' || sub.status === 'past_due') && row.period.end.getTime() > sub.currentPeriod.end.getTime()) {
      const moved = await repo.subscriptions.put({ ...sub, planId: sub.scheduledPlanId ?? sub.planId, scheduledPlanId: null,
        currentPeriod: row.period, status: 'active', graceUntil: null });
      return { payment: closed, sub: moved };
    }
    return { payment: closed, sub };
  }

  // EC:A58 — void starts dunning, which charges the period again: first make sure no money sits with this order.
  const now = await currentOrderStatus(input.provider, row, review);
  if (MOVED_MONEY.has(now)) {
    throw new PaymentKitError(`the provider shows the held order ${now}: settle or close it instead`, 'held_order_moved_money', { paymentId, status: now });
  }
  const voided: Payment = { ...row, status: 'failed', raw, failure: {
    code: 'review_voided', providerCode: null, retryable: false, userMessage: 'A person closed this charge after review.' } };
  await repo.payments.put(voided);
  // The renewal it stood for is unpaid: dunning takes over, as for a decline (a still-renewing
  // subscription only; an ended one stays ended).
  if (sub && (sub.status === 'active' || sub.status === 'past_due')) {
    const result = await onPaymentFailed({ sub, policy, repo, notifier, clock });
    return { payment: voided, sub: result.sub };
  }
  return { payment: voided, sub };
}

/** The order's status now: asked from the provider when it can answer, else the status seen at hold time. */
async function currentOrderStatus(provider: PaymentProvider, row: Payment, review: Review): Promise<string> {
  if (typeof provider.getPaymentByOrderId !== 'function') return review.status ?? 'unknown';
  let found: Payment | null;
  try {
    found = await provider.getPaymentByOrderId(orderIdOf(row));
  } catch (err) {
    throw new PaymentKitError('the provider did not answer for the held order; try again', 'held_order_unverified', {
      paymentId: row.id, reason: err instanceof Error ? err.message : String(err) });
  }
  return found ? found.status : 'not_found';
}

export interface ResumeParkedInput {
  subscriptionId: string;
  actor: string;
  policy: Policy;
  repo: Repo;
  clock: Clock;
  notifier?: Notifier;
}

/**
 * EC:A54 — a subscription parked by `missedPeriods: 'needs_human_only'` resumes from the period
 * containing now: the missed periods stay unbilled and ungranted, the subscription becomes active one
 * period behind, and the next scheduler tick charges the current period once (the ordinary renewal).
 * To end it instead, cancel it. Throws `not_parked` when the subscription is not parked.
 */
export async function resumeParked(input: ResumeParkedInput): Promise<Subscription> {
  const { subscriptionId, actor, policy, repo, clock } = input;
  const notifier = input.notifier ?? new NoopNotifier();
  const sub = await repo.subscriptions.get(subscriptionId);
  const plan: Plan | null = sub ? await repo.plans.get(renewalPlanId(sub)) : null;
  const cu = sub && plan ? catchUpPeriods(sub, plan, policy, clock.now()) : null;
  if (!sub || !plan || sub.status !== 'past_due' || sub.graceUntil !== null || !cu) {
    throw new PaymentKitError('subscription is not parked for missed periods', 'not_parked', { subscriptionId });
  }
  const resumed: Subscription = { ...sub, status: 'active', graceUntil: null, currentPeriod: cu.previous };
  const saved = await repo.subscriptions.put(resumed);
  await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
    kind: 'missed_periods_resumed', subscriptionId: sub.id, actor, skipped: cu.skipped.map((p) => p.start.toISOString()),
    charging: cu.target.start.toISOString() } });
  return saved ?? resumed;
}
