// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A57 A62
// The prorated money of an immediate upgrade on a self-scheduled provider (Toss/PortOne).
import { createHash } from 'node:crypto';
import { Clock, Money, Payment, PaymentKitError, PaymentProvider, Repo, Subscription } from 'boilpayment-core';
import { isDecline, providerOrderId } from './charge-attempt.js';
import { billingCustomerRef } from './internal.js';

export interface UpgradeChargeInput {
  provider: PaymentProvider;
  repo: Repo;
  clock: Clock;
  sub: Subscription;
  /** The plan the subscription moves to (kept on the payment row). */
  planId: string;
  /** `charge:upgrade:<sub>:<plan>:<period start>` — hashed into the orderId and the row id. */
  chargeKey: string;
  /** orderIds an earlier release may have sent for this same charge (it sent the raw key). */
  legacyOrderIds: string[];
  amount: Money;
}

/** EC:A62 — the local payment row of an upgrade charge: found again without a scan, on every retry. */
export function upgradePaymentId(chargeKey: string): string {
  return 'pay_up_' + createHash('sha256').update(chargeKey).digest('hex').slice(0, 32);
}

/** EC:A62 — true for the row of an upgrade charge (kind 'subscription', no period: it buys no renewal). */
export function isUpgradePayment(row: Payment): boolean {
  return typeof (row.raw as { boilpaymentUpgrade?: unknown } | undefined)?.boilpaymentUpgrade === 'object';
}

/**
 * EC:A57 A62 — charge the delta once, with a local payment row written before the provider is called.
 * The orderId (and idempotency key) is `ord_` + 40 hex of the charge key, like renewals (EC:A35): Toss
 * accepts only 6–64 characters of [A-Za-z0-9_-], PortOne uses it as the paymentId path segment.
 * The provider is asked first, every time, for this orderId and for the raw keys an earlier release
 * sent: a paid order ends the charge, a pending or unknown answer stops the upgrade, and only an order
 * that is absent or failed everywhere is charged. The row makes the charge refundable through the kit
 * and lets a provider refund webhook find it (the upgrade's credits are granted against it).
 */
export async function chargeUpgradeDelta(input: UpgradeChargeInput): Promise<Payment> {
  const { provider, repo, clock, sub } = input;
  const id = upgradePaymentId(input.chargeKey);
  const orderId = providerOrderId(input.chargeKey);
  const stored = await repo.payments.get(id);
  if (stored?.status === 'succeeded') return stored;
  const base: Payment = stored ?? {
    id, customerId: sub.customerId, provider: sub.provider, providerRef: orderId, subscriptionId: sub.id,
    amount: { ...input.amount }, status: 'pending', kind: 'subscription', period: null, occurredAt: clock.now(),
    failure: null, cashReceipt: null, raw: { boilpaymentUpgrade: { chargeKey: input.chargeKey, planId: input.planId } },
  };
  const prior = await priorCharge(provider, sub, orderId, input.legacyOrderIds);
  if (prior) return record(repo, base, prior);
  if (!stored) await repo.payments.put(base); // durable before the provider is asked
  let answer: Payment;
  try {
    answer = await provider.chargeBillingKey({
      billingKey: sub.billingKey as string, amount: { ...base.amount }, orderId,
      customerRef: await billingCustomerRef(repo, sub), idempotencyKey: orderId, // EC:A60
    });
  } catch (err) {
    if (isDecline(err)) await repo.payments.put({ ...base, status: 'failed', failure: err.failure });
    throw err;
  }
  return record(repo, base, answer);
}

async function record(repo: Repo, base: Payment, answer: Payment): Promise<Payment> {
  const row: Payment = {
    ...base, providerRef: answer.providerRef || base.providerRef, amount: answer.amount ?? base.amount, status: answer.status,
    occurredAt: answer.occurredAt ?? base.occurredAt, failure: answer.failure, cashReceipt: answer.cashReceipt ?? null,
    raw: { ...(base.raw as object), provider: answer.raw ?? null },
  };
  await repo.payments.put(row);
  return row;
}

async function priorCharge(provider: PaymentProvider, sub: Subscription, orderId: string, legacy: string[]): Promise<Payment | null> {
  if (!provider.getPaymentByOrderId) return null; // the charge below re-sends the same idempotency key
  for (const id of [orderId, ...legacy.filter((l, i) => l !== orderId && legacy.indexOf(l) === i)]) {
    let found: Payment | null;
    try {
      found = await provider.getPaymentByOrderId(id);
    } catch (err) {
      // A raw legacy key the provider refuses as an orderId (Toss validates the format) was never an order.
      if (id !== orderId && isDecline(err)) continue;
      throw unresolved(sub, id, err instanceof Error ? err.message : String(err));
    }
    if (!found || found.status === 'failed') continue;
    if (found.status === 'succeeded') return found;
    throw unresolved(sub, id, `order is ${found.status}`);
  }
  return null;
}

function unresolved(sub: Subscription, orderId: string, reason: string): PaymentKitError {
  return new PaymentKitError('An earlier try of this upgrade may have charged; not charging until the provider answers', 'upgrade_charge_unresolved', {
    subscriptionId: sub.id, orderId, reason });
}
