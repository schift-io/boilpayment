// spec/refund.pseudo.md — EC:D1 D2 D3 D4 D5 D6 D7 D10 B13 A22 B8
import type {
  Clock, LedgerEntry, LedgerStore, Payment, Policy, RefundDecision, Repo, Subscription,
} from '@schift/payment-kit-core';
import { applyRounding, daysBetween, prorationRatio, weightedAvgUnitPrice } from './util.js';

export interface EvaluateInput {
  payment: Payment;
  sub?: Subscription | null;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  /** CS-initiated partial refund request. Can only reduce the policy-computed amount, never raise it. */
  requestedAmount?: { amountMinor: number; currency: string } | null;
  /** D7: PG fee, unknown to us unless the caller supplies it (provider-specific). */
  providerFeeMinor?: number | null;
}

function ineligible(payment: Payment, subId: string | null, ruleId: string, reason: string): RefundDecision {
  return {
    eligible: false,
    amount: { amountMinor: 0, currency: payment.amount.currency },
    creditsToRevoke: 0,
    ruleId,
    reason,
    needsHuman: false,
    paymentId: payment.id,
    customerId: payment.customerId,
    subscriptionId: subId,
  };
}

async function grantedByPayment(ledger: LedgerStore, customerId: string, paymentId: string): Promise<LedgerEntry[]> {
  const entries = await ledger.entries(customerId, { kind: 'grant' });
  return entries.filter((e) => e.reference.paymentId === paymentId && (e.source === 'subscription' || e.source === 'topup'));
}

async function consumedFromGrants(ledger: LedgerStore, customerId: string, grants: LedgerEntry[], totalGranted: number, now: Date): Promise<number> {
  const grantIds = new Set(grants.map((g) => g.id));
  if (grantIds.size === 0) return 0;
  const consumeEntries = (await ledger.entries(customerId, { kind: 'consume' })).filter(
    (e) => e.reference.grantId !== undefined && grantIds.has(e.reference.grantId),
  );
  const attributed = consumeEntries.length > 0;
  if (attributed) return consumeEntries.reduce((sum, e) => sum + -e.amount, 0);
  // B8 fallback: ledger lacks grantId attribution — approximate via current balance.
  const balance = await ledger.balance(customerId, 'paid', now);
  return Math.max(0, totalGranted - Math.min(balance.available, totalGranted));
}

/** EC:evaluate — refund.evaluate({payment, sub, policy, ledger, repo, clock, requestedAmount?}) -> RefundDecision */
export async function evaluate(input: EvaluateInput): Promise<RefundDecision> {
  const { payment, sub, policy, ledger, repo, clock } = input;
  const subId = sub?.id ?? null;
  if (input.requestedAmount != null && (
    !Number.isSafeInteger(input.requestedAmount.amountMinor) || input.requestedAmount.amountMinor <= 0 ||
    input.requestedAmount.currency !== payment.amount.currency
  )) {
    return ineligible(payment, subId, 'D-request', 'requested amount must be a positive minor-unit integer in the payment currency');
  }

  // Step 1 — status guard
  if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
    return ineligible(payment, subId, 'D-status', `payment status '${payment.status}' is not refundable`);
  }

  const now = clock.now();
  const daysSince = daysBetween(payment.occurredAt, now);
  const customerId = payment.customerId;

  // Step 2 — EC:D10 velocity (flagged now, applied at the end)
  const windowStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const pastRefunds = await repo.refunds.list({ customerId });
  const refundCountLastYear = pastRefunds.filter((r) => r.status === 'succeeded' && r.createdAt >= windowStart).length;
  const velocityTriggered = refundCountLastYear >= policy.refund.maxPerCustomerPerYear;

  const alreadyRefundedMinor = (await repo.refunds.list({ paymentId: payment.id }))
    .filter((r) => r.status === 'succeeded')
    .reduce((sum, r) => sum + r.amount.amountMinor, 0);

  const grants = await grantedByPayment(ledger, customerId, payment.id);
  const totalGranted = grants.reduce((sum, g) => sum + g.amount, 0);
  const revokeEntries = await ledger.entries(customerId, { kind: 'revoke' });
  const alreadyRevoked = revokeEntries
    .filter((e) => e.reference.paymentId === payment.id && e.source === 'refund')
    .reduce((sum, e) => sum + -e.amount, 0);

  let amountMinor: number;
  let creditsToRevoke: number;
  let ruleId: string;
  let reason: string;

  if (daysSince <= policy.refund.noQuestionsDays) {
    // EC:D1
    amountMinor = Math.max(0, payment.amount.amountMinor - alreadyRefundedMinor);
    creditsToRevoke = Math.max(0, totalGranted - alreadyRevoked);
    ruleId = 'D1';
    reason = `D1: no-questions window (${daysSince}/${policy.refund.noQuestionsDays}d) -> full ${amountMinor} minor, revoke ${creditsToRevoke} credits`;
  } else {
    // EC:D2 D3 D4 B8
    const method = policy.refund.method;
    if (method === 'deny') {
      return ineligible(payment, subId, 'D2', 'refund.method=deny');
    }
    const consumed = await consumedFromGrants(ledger, customerId, grants, totalGranted, clock.now());
    const unitPrice = weightedAvgUnitPrice(grants);

    const computeUnused = (): { amount: number; credits: number } => {
      const unused = Math.max(0, totalGranted - consumed);
      return { amount: Math.round(unused * unitPrice), credits: unused };
    };
    const computeTimeProrated = (): { amount: number; credits: number; denied: string | null } => {
      if (!payment.period) throw new Error('refund.evaluate: time_prorated requires payment.period');
      const ratio = prorationRatio(payment.period, now, policy.proration.denominator);
      const amount = Math.round(payment.amount.amountMinor * ratio);
      const elapsedRatio = 1 - ratio;
      const consumedRatio = totalGranted > 0 ? consumed / totalGranted : 0;
      if (consumedRatio > elapsedRatio && policy.refund.overuseBehavior === 'deny') {
        return { amount: 0, credits: 0, denied: `overuse: consumed ${(consumedRatio * 100).toFixed(1)}% > elapsed ${(elapsedRatio * 100).toFixed(1)}%` };
      }
      const rawCredits = unitPrice > 0 ? amount / unitPrice : 0;
      return { amount, credits: applyRounding(rawCredits, policy.refund.rounding), denied: null };
    };

    if (method === 'unused_credits') {
      const r = computeUnused();
      amountMinor = r.amount; creditsToRevoke = r.credits; ruleId = 'D2';
      reason = `D2: unused_credits ${r.credits} credits x ${unitPrice} minor/credit -> ${r.amount} minor`;
    } else if (method === 'time_prorated') {
      const r = computeTimeProrated();
      if (r.denied) return ineligible(payment, subId, 'D3', r.denied);
      amountMinor = r.amount; creditsToRevoke = r.credits; ruleId = 'D2';
      reason = `D2: time_prorated -> ${r.amount} minor, revoke ${r.credits} credits`;
    } else {
      // min_of_both
      const a = computeUnused();
      const b = computeTimeProrated();
      if (b.denied) {
        return ineligible(payment, subId, 'D3', b.denied);
      } else if (a.amount <= b.amount) {
        amountMinor = a.amount; creditsToRevoke = a.credits;
        reason = `D2: min_of_both -> unused_credits ${a.amount} minor <= time_prorated ${b.amount} minor`;
      } else {
        amountMinor = b.amount; creditsToRevoke = b.credits;
        reason = `D2: min_of_both -> time_prorated ${b.amount} minor < unused_credits ${a.amount} minor`;
      }
      ruleId = 'D2';
    }
  }

  // EC:D5 — annual plan refund window
  if (sub) {
    const plan = await repo.plans.get(sub.planId);
    if (plan && plan.interval === 'year' && policy.refund.annualMethod === 'deny_after_days') {
      const limit = policy.refund.annualDenyAfterDays;
      if (limit !== null && daysSince > limit) {
        return ineligible(payment, subId, 'D5', `annual plan, deny_after_days=${limit}, elapsed=${daysSince}`);
      }
    }
  }

  const remainingMinor = Math.max(0, payment.amount.amountMinor - alreadyRefundedMinor);
  if (amountMinor > remainingMinor) {
    creditsToRevoke = applyRounding(creditsToRevoke * remainingMinor / amountMinor, policy.refund.rounding);
    amountMinor = remainingMinor;
    reason += `; remaining payment cap -> ${amountMinor} minor, ${creditsToRevoke} credits`;
  }

  // Requested amount can only reduce (CS-initiated partial refund), never raise, the policy-computed amount.
  if (input.requestedAmount != null && input.requestedAmount.amountMinor < amountMinor && amountMinor > 0) {
    const ratio = input.requestedAmount.amountMinor / amountMinor;
    amountMinor = input.requestedAmount.amountMinor;
    creditsToRevoke = applyRounding(creditsToRevoke * ratio, policy.refund.rounding);
    reason += `; requestedAmount override -> ${amountMinor} minor, ${creditsToRevoke} credits`;
  }

  // EC:D7 — fee borne by customer
  if (policy.refund.feeBearer === 'customer') {
    const fee = input.providerFeeMinor ?? 0;
    if (fee > 0) {
      amountMinor = Math.max(0, amountMinor - fee);
      reason += `; D7 fee ${fee} minor deducted (customer-borne)`;
    }
  }

  // EC:B13 — revoke shortfall
  const available = Math.max(0, (await ledger.balance(customerId, 'paid', clock.now())).available);
  if (available < creditsToRevoke) {
    const behavior = policy.refund.revokeShortfall;
    if (behavior === 'clamp_and_reduce_refund') {
      const ratio = creditsToRevoke > 0 ? available / creditsToRevoke : 1;
      amountMinor = Math.floor(amountMinor * ratio);
      reason += `; B13 clamp_and_reduce_refund: balance ${available} < ${creditsToRevoke} -> amount ${amountMinor} minor, ${available} credits`;
      creditsToRevoke = available;
    } else if (behavior === 'clamp_to_zero') {
      reason += `; B13 clamp_to_zero: revoke only ${available} of ${creditsToRevoke}, amount unchanged`;
      creditsToRevoke = available;
    } else {
      reason += `; B13 allow_negative: revoking ${creditsToRevoke} against balance ${available}`;
    }
  }

  if (amountMinor <= 0) {
    return ineligible(payment, subId, 'D-zero', 'no refundable amount remains after applying policy');
  }

  // EC:D6 — currency is always the payment's currency
  const currency = payment.amount.currency;

  let needsHuman = amountMinor > policy.cs.autoApprove.maxAmountMinor || creditsToRevoke > policy.cs.autoApprove.maxCredits;
  if (velocityTriggered) {
    needsHuman = true;
    ruleId = 'D10';
    reason += `; D10 velocity: ${refundCountLastYear}/${policy.refund.maxPerCustomerPerYear} refunds in past year -> needs human`;
  }

  return {
    eligible: true,
    amount: { amountMinor, currency },
    creditsToRevoke,
    ruleId,
    reason,
    needsHuman,
    paymentId: payment.id,
    customerId,
    subscriptionId: subId,
  };
}
