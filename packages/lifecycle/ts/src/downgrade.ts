// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A3 A4 J1-J5
import {
  Clock,
  IdGen,
  LedgerStore,
  PaymentKitError,
  PaymentProvider,
  Plan,
  Policy,
  Repo,
  Subscription,
  deserializeLedgerEntry,
  deserializeSubscription,
  runIdempotent,
  serializeLedgerEntry,
  serializeSubscription,
} from 'boilpayment-core';
import { clawback, ClawbackResult } from 'boilpayment-credits';
import { resolvePriceRef, scopeProvider } from './internal.js';

function serializeClawback(c: ClawbackResult | null): unknown {
  if (!c) return null;
  return { ...c, entry: serializeLedgerEntry(c.entry) };
}
function deserializeClawback(v: any): ClawbackResult | null {
  if (!v) return null;
  return { ...v, entry: deserializeLedgerEntry(v.entry) };
}

export interface DowngradeInput {
  sub: Subscription;
  newPlan: Plan;
  policy: Policy;
  provider: PaymentProvider;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  ids: IdGen;
  /** EC:J5 — default: `downgrade:{sub.id}:{newPlan.id}:{sub.currentPeriod.start ISO}` if omitted. */
  idempotencyKey?: string;
  /** EC:L5 — when present, scopes this downgrade's `changeSubscription` call to this correlationId
   * via the duck-typed `provider.withCorrelationId(id)` (`internal.ts` `scopeProvider`). */
  correlationId?: string;
}

export interface DowngradeResult {
  sub: Subscription;
  clawback: ClawbackResult | null;
}

// EC:A3 A4 — downgrade, optionally clawing back the credit surplus immediately.
// EC:J1-J5 — wrapped in runIdempotent so a retry replays the first result instead of re-clawing-back.
export async function downgrade(input: DowngradeInput): Promise<DowngradeResult> {
  const { sub, newPlan, policy, provider, ledger, clock, repo } = input;
  const key = input.idempotencyKey ?? `downgrade:${sub.id}:${newPlan.id}:${sub.currentPeriod.start.toISOString()}`;

  const { result } = await runIdempotent<DowngradeResult>({
    repo,
    clock,
    key,
    kind: 'lifecycle.downgrade',
    payload: { subId: sub.id, newPlanId: newPlan.id, periodStart: sub.currentPeriod.start.toISOString() },
    serialize: (r) => ({ sub: serializeSubscription(r.sub), clawback: serializeClawback(r.clawback) }),
    deserialize: (v: any) => ({ sub: deserializeSubscription(v.sub), clawback: deserializeClawback(v.clawback) }),
    fn: async () => {
      // EC:A61 C11 — an ended or unpaid subscription does not change plan.
      const stored = await repo.subscriptions.get(sub.id);
      if (stored && stored.status !== 'active' && stored.status !== 'trialing') {
        throw new PaymentKitError(`a ${stored.status} subscription cannot change plan`, 'subscription_inactive', { subscriptionId: sub.id, status: stored.status });
      }
      const oldPlan = await repo.plans.get(sub.planId);
      if (!oldPlan) throw new PaymentKitError(`plan not found: ${sub.planId}`, 'plan_not_found');

      if (policy.downgrade.mode === 'end_of_period') {
        // SB-14 — native providers must carry the lower price into the next renewal; the local
        // scheduledPlanId alone can otherwise undergrant while the higher price is still charged.
        if ((sub.provider === 'stripe' || sub.provider === 'polar') && provider.capabilities().nativeSubscriptions) {
          if (sub.providerRef === null) throw new PaymentKitError('native subscription mutation requires its provider reference', 'subscription_provider_ref_required');
          const priceRef = resolvePriceRef(newPlan, sub.provider, sub.currency);
          await scopeProvider(provider, input.correlationId).changeSubscription(sub.providerRef, {
            newPriceRef: priceRef, proration: 'none', resetAnchor: false,
          });
        }
        const updated: Subscription = { ...sub, scheduledPlanId: newPlan.id };
        await repo.subscriptions.put(updated);
        return { sub: updated, clawback: null };
      }

      // EC:F — Toss/PortOne (self-scheduling) don't track subscription state; changeSubscription would
      // throw PaymentKitError('unsupported'). We update Repo.subscriptions ourselves instead. Downgrade
      // never needs an immediate charge (price only goes down), so there's nothing to bill here.
      if (provider.capabilities().nativeSubscriptions) {
        if (sub.providerRef === null) throw new PaymentKitError('native subscription mutation requires its provider reference', 'subscription_provider_ref_required');
        const priceRef = resolvePriceRef(newPlan, sub.provider, sub.currency);
        await scopeProvider(provider, input.correlationId).changeSubscription(sub.providerRef, { newPriceRef: priceRef, proration: 'immediate', resetAnchor: false });
      }

      let clawbackResult: ClawbackResult | null = null;
      if (policy.downgrade.mode === 'immediate_clawback') {
        const delta = oldPlan.creditsPerPeriod - newPlan.creditsPerPeriod;
        if (delta > 0) {
          const idempotencyKey = `revoke:downgrade:${sub.id}:${sub.currentPeriod.start.toISOString()}`;
          clawbackResult = await clawback({
            customerId: sub.customerId,
            amount: delta,
            policy,
            ledger,
            clock,
            reason: `downgrade:${oldPlan.id}->${newPlan.id}`,
            reference: { subscriptionId: sub.id, periodStart: sub.currentPeriod.start },
            actor: 'system',
            idempotencyKey,
            shortfall: policy.downgrade.clawbackShortfall,
          });
        }
      }
      // 'immediate_keep' — price changes now, no clawback.

      const updated: Subscription = { ...sub, planId: newPlan.id, scheduledPlanId: null };
      await repo.subscriptions.put(updated);

      return { sub: updated, clawback: clawbackResult };
    },
  });

  return result;
}
