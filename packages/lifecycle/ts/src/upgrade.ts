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
} from 'boilpayment-core';
import { prorationFraction, scaleMinor } from 'boilpayment-core';
import { nextPeriod, prorationRatio } from './period.js';
import { priceForSubscription, requirePriceForSubscription, resolvePriceRef, scopeProvider } from './internal.js';
import { chargeUpgradeDelta } from './upgrade-charge.js';

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
        const priceRef = resolvePriceRef(newPlan, sub.provider, sub.currency);
        await scopedProvider.changeSubscription(sub.providerRef, { newPriceRef: priceRef, proration: 'immediate', resetAnchor });
      } else {
        if (!sub.billingKey) throw new PaymentKitError('upgrade requires a billing key for self-scheduling providers', 'billing_key_required');
        // EC:A28 — both prices in the subscription's currency (spec note #4 used the first price).
        // EC:A33 — a missing old price is refused, not read as 0 (the whole new price as the delta).
        const oldPrice = requirePriceForSubscription(oldPlan, sub);
        const newPrice = requirePriceForSubscription(newPlan, sub);
        const priceDeltaMinor = (newPrice?.amountMinor ?? 0) - (oldPrice?.amountMinor ?? 0);
        // EC:J7 — exact integer proration (a float ratio can land one minor unit short).
        const frac = prorationFraction(sub.currentPeriod, now, policy.proration.denominator);
        const proratedMoneyDelta = scaleMinor(priceDeltaMinor, frac.num, frac.den, 'floor');
        if (proratedMoneyDelta > 0 && newPrice) {
          // EC:J5 — deterministic (not clock.now()-derived): a retry of this same upgrade operation
          // must reuse the same provider-side charge idempotency key.
          const chargeKey = `charge:upgrade:${sub.id}:${newPlan.id}:${sub.currentPeriod.start.toISOString()}`;
          // EC:A57 — a valid provider orderId; an earlier release's raw-key order is looked up first.
          const payment = await chargeUpgradeDelta({
            provider: scopedProvider, repo, sub, opKey: key, chargeKey, legacyOrderIds: [chargeKey],
            amount: { amountMinor: proratedMoneyDelta, currency: newPrice.currency },
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
