// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A1 A2 A8 J1-J5
import {
  Clock,
  IdGen,
  LedgerEntry,
  LedgerStore,
  PaymentKitError,
  PaymentProvider,
  Period,
  Policy,
  Repo,
  Subscription,
  Plan,
  deserializeLedgerEntry,
  deserializeSubscription,
  runIdempotent,
  serializeLedgerEntry,
  serializeSubscription,
} from '@schift/payment-kit-core';
import { nextPeriod, prorationRatio } from './period.js';
import { resolvePriceRef, scopeProvider } from './internal.js';

export interface UpgradeInput {
  sub: Subscription;
  newPlan: Plan;
  policy: Policy;
  provider: PaymentProvider;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  ids: IdGen;
  /** EC:J5 — default: `upgrade:{sub.id}:{newPlan.id}:{sub.currentPeriod.start ISO}` if omitted. */
  idempotencyKey?: string;
  /** EC:L5 — when present, scopes this upgrade's `changeSubscription`/`chargeBillingKey` calls to
   * this correlationId via the duck-typed `provider.withCorrelationId(id)` (`internal.ts`
   * `scopeProvider`). */
  correlationId?: string;
}

export interface UpgradeResult {
  sub: Subscription;
  grant: LedgerEntry | null;
  creditDelta: number;
}

// EC:A1 A2 A8 — mid-cycle upgrade: immediate proration + credit delta, or scheduled for next period.
// EC:J1-J5 — the whole operation (provider calls + grant + subscription update) is wrapped in
// runIdempotent so a retry after a partial failure replays the first result instead of
// re-charging/re-granting. See spec/lifecycle.pseudo.md [EC:A1 A2 A8] "멱등성" note.
export async function upgrade(input: UpgradeInput): Promise<UpgradeResult> {
  const { sub, newPlan, policy, provider, ledger, repo, clock } = input;
  const key = input.idempotencyKey ?? `upgrade:${sub.id}:${newPlan.id}:${sub.currentPeriod.start.toISOString()}`;

  const { result } = await runIdempotent<UpgradeResult>({
    repo,
    clock,
    key,
    kind: 'lifecycle.upgrade',
    payload: { subId: sub.id, newPlanId: newPlan.id, periodStart: sub.currentPeriod.start.toISOString() },
    serialize: (r) => ({ sub: serializeSubscription(r.sub), grant: serializeLedgerEntry(r.grant), creditDelta: r.creditDelta }),
    deserialize: (v: any) => ({ sub: deserializeSubscription(v.sub), grant: deserializeLedgerEntry(v.grant), creditDelta: v.creditDelta }),
    fn: async () => {
      const oldPlan = await repo.plans.get(sub.planId);
      if (!oldPlan) throw new PaymentKitError(`plan not found: ${sub.planId}`, 'plan_not_found');

      // EC:A8 — interval change can be forced to behave like next_period regardless of upgrade.mode
      const intervalChanged = oldPlan.interval !== newPlan.interval;
      const effectiveMode =
        intervalChanged && policy.intervalChange.mode === 'next_period' ? 'next_period' : policy.upgrade.mode;

      if (effectiveMode === 'next_period') {
        const updated: Subscription = { ...sub, scheduledPlanId: newPlan.id };
        await repo.subscriptions.put(updated);
        return { sub: updated, grant: null, creditDelta: 0 };
      }

      const resetAnchor = effectiveMode === 'immediate_prorate_reset_anchor';
      const now = clock.now();

      // EC:F — Toss/PortOne (self-scheduling) don't track subscription state on their side:
      // getSubscription/changeSubscription/cancelSubscription all throw PaymentKitError('unsupported').
      // We update Repo.subscriptions ourselves instead, and charge the prorated *money* delta directly
      // via the billing key (changeSubscription would otherwise have triggered the provider's own
      // proration invoice).
      const scopedProvider = scopeProvider(provider, input.correlationId);
      if (provider.capabilities().nativeSubscriptions) {
        if (sub.providerRef === null) throw new PaymentKitError('native subscription mutation requires its provider reference', 'subscription_provider_ref_required');
        const priceRef = resolvePriceRef(newPlan, sub.provider);
        await scopedProvider.changeSubscription(sub.providerRef, { newPriceRef: priceRef, proration: 'immediate', resetAnchor });
      } else {
        if (!sub.billingKey) throw new PaymentKitError('upgrade requires a billing key for self-scheduling providers', 'billing_key_required');
        const oldPrice = oldPlan.prices[0]; // representative price per plan — see spec note #4
        const newPrice = newPlan.prices[0];
        const priceDeltaMinor = (newPrice?.amountMinor ?? 0) - (oldPrice?.amountMinor ?? 0);
        const moneyRatio = prorationRatio(sub.currentPeriod, now, policy.proration.denominator);
        const proratedMoneyDelta = Math.floor(priceDeltaMinor * moneyRatio);
        if (proratedMoneyDelta > 0 && newPrice) {
          // EC:J5 — deterministic (not clock.now()-derived): a retry of this same upgrade operation
          // must reuse the same provider-side charge idempotency key.
          const chargeKey = `charge:upgrade:${sub.id}:${newPlan.id}:${sub.currentPeriod.start.toISOString()}`;
          const payment = await scopedProvider.chargeBillingKey({
            billingKey: sub.billingKey,
            amount: { amountMinor: proratedMoneyDelta, currency: newPrice.currency },
            orderId: chargeKey,
            customerRef: sub.customerId,
            idempotencyKey: chargeKey,
          });
          if (payment.status !== 'succeeded') {
            throw new PaymentKitError('upgrade charge did not succeed', 'upgrade_charge_failed', { payment });
          }
        }
      }

      let currentPeriod: Period = sub.currentPeriod;
      let anchorDay = sub.anchorDay;

      if (resetAnchor) {
        // EC:G3 — instants stored in UTC; civil-day extraction for non-UTC policy.period.timezone is
        // approximated via UTC date here (core does not expose a public tz-aware civil-day helper).
        // See spec "계약 변경 제안" #1.
        anchorDay = now.getUTCDate();
        const interval = (newPlan.interval ?? 'month') as 'month' | 'year';
        currentPeriod = nextPeriod({ start: now, end: now }, interval, anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
      }

      // EC:A2 — credit delta, computed against the *original* (pre-upgrade) period's remaining ratio.
      const fullDelta = newPlan.creditsPerPeriod - oldPlan.creditsPerPeriod;
      const delta =
        policy.upgrade.creditDelta === 'full_delta'
          ? fullDelta
          : Math.floor(fullDelta * prorationRatio(sub.currentPeriod, now, policy.proration.denominator));

      let grant: LedgerEntry | null = null;
      if (delta > 0) {
        // EC:J5 — deterministic ledger idempotency key (sub + target plan + *original* period start,
        // not clock.now()); see docs/EDGE_CASES.md §J J5.
        const idempotencyKey = `grant:upgrade:${sub.id}:${newPlan.id}:${sub.currentPeriod.start.toISOString()}`;
        const expiresAt = policy.credits.rollover === 'full' ? null : currentPeriod.end;
        const { entry } = await ledger.append({
          customerId: sub.customerId,
          pool: 'paid',
          kind: 'grant',
          amount: delta,
          unitPriceMinor: null,
          currency: null,
          expiresAt,
          source: 'subscription',
          reference: { subscriptionId: sub.id, periodStart: currentPeriod.start },
          idempotencyKey,
          actor: 'system',
          reason: `upgrade:${oldPlan.id}->${newPlan.id}`,
        });
        grant = entry;
      }

      const updated: Subscription = { ...sub, planId: newPlan.id, currentPeriod, anchorDay, scheduledPlanId: null };
      await repo.subscriptions.put(updated);

      return { sub: updated, grant, creditDelta: delta };
    },
  });

  return result;
}
