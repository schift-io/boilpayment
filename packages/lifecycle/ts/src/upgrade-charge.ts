// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A57
// The prorated money delta of an immediate upgrade on a self-scheduled provider (Toss/PortOne).
import { Money, Payment, PaymentKitError, PaymentProvider, Repo, Subscription } from 'boilpayment-core';
import { isDecline, providerOrderId } from './charge-attempt.js';

export interface UpgradeChargeInput {
  provider: PaymentProvider;
  repo: Repo;
  sub: Subscription;
  /** The run-idempotent key of the upgrade operation this charge belongs to. */
  opKey: string;
  /** `charge:upgrade:<sub>:<plan>:<period start>` — hashed into the orderId. */
  chargeKey: string;
  /** orderIds an earlier release may have sent for this same charge (it sent the raw key). */
  legacyOrderIds: string[];
  amount: Money;
}

/**
 * EC:A57 — charge the delta once. The orderId (and idempotency key) is `ord_` + 40 hex of the charge
 * key, like renewals (EC:A35): Toss accepts only 6–64 characters of [A-Za-z0-9_-], PortOne uses it as the
 * paymentId path segment. When the upgrade operation runs again (the earlier run may have charged and
 * lost the answer), the provider is asked first, for this orderId and for the raw keys an earlier
 * release sent: a paid order ends the charge, a pending or unknown answer stops the upgrade, and only
 * an order that is absent or failed everywhere is charged.
 */
export async function chargeUpgradeDelta(input: UpgradeChargeInput): Promise<Payment> {
  const { provider, repo, sub } = input;
  const orderId = providerOrderId(input.chargeKey);
  const op = await repo.operations.get(input.opKey);
  if ((op?.attempts ?? 1) > 1) {
    const prior = await priorCharge(provider, sub, orderId, input.legacyOrderIds);
    if (prior) return prior;
  }
  return provider.chargeBillingKey({
    billingKey: sub.billingKey as string, amount: input.amount, orderId, customerRef: sub.customerId, idempotencyKey: orderId,
  });
}

async function priorCharge(provider: PaymentProvider, sub: Subscription, orderId: string, legacy: string[]): Promise<Payment | null> {
  if (!provider.getPaymentByOrderId) return null; // the charge below re-sends the same idempotency key
  for (const id of [orderId, ...legacy.filter((l) => l !== orderId)]) {
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
