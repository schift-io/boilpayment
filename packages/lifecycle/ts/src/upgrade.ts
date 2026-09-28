// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A1 A2 A8 J1-J5
import {
  Clock,
  IdGen,
  LedgerEntry,
  LedgerStore,
  Payment,
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
import { civilDayOf, prorationFraction, scaleMinor } from 'boilpayment-core';
import { nextPeriod, prorationRatio } from './period.js';
import { requirePriceForSubscription, resolvePriceRef, scopeProvider } from './internal.js';
import { chargeUpgradeDelta } from './upgrade-charge.js';
import { withAttemptLease } from './charge-attempt.js';

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

// EC:A61 — the change is decided against the stored row, under a per-subscription lease taken before any
// charge: two upgrades at once (pro and max) cannot both charge, and a stale snapshot is refused.
// EC:A1 A2 A8 — mid-cycle upgrade: immediate proration + credit delta, or scheduled for next period.
// EC:J1-J5 — the whole operation (provider calls + grant + subscription update) is wrapped in
// runIdempotent so a retry after a partial failure replays the first result instead of
// re-charging/re-granting. See spec/lifecycle.pseudo.md [EC:A1 A2 A8] "멱등성" note.
export async function upgrade(input: UpgradeInput): Promise<UpgradeResult> {
  const { sub, newPlan, repo, clock } = input;
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
      const leased = await withAttemptLease(repo, clock, `upgrade:${sub.id}`, () => upgradeHeld(input));
      if (!leased.held) throw new PaymentKitError('another change of this subscription is in progress', 'subscription_change_in_flight', { subscriptionId: sub.id });
      return leased.value;
    },
  });

  return result;
}

/** EC:A77 — the operation holding an upgrade delta that waits for its provider order to be paid. */
export function pendingUpgradeGrantKey(subId: string, periodStart: Date): string {
  // EC:A82 — no plan in the key: a change order paid before the subscription row names the new plan still finds it.
  return `upgrade-grant:${subId}:${periodStart.toISOString()}`;
}

async function putPendingGrant(repo: Repo, key: string, amount: number, periodEnd: Date, reason: string, policy: Policy, now: Date): Promise<void> {
  await repo.operations.put({
    id: key, key, kind: 'lifecycle.upgrade_grant', payloadHash: '', status: 'in_progress', error: null, createdAt: now, completedAt: null, attempts: 0,
    result: { amount, expiresAt: policy.credits.rollover === 'full' ? null : periodEnd.toISOString(), reason },
  });
}

/** EC:A61 C11 — the states an upgrade applies to; anything else is refused before any charge. */
const UPGRADABLE: ReadonlySet<Subscription['status']> = new Set(['active', 'trialing']);

/** EC:A61 — the stored row this change applies to, checked before any charge. */
export async function readForChange(repo: Repo, sub: Subscription, targetPlanId: string): Promise<Subscription | 'already_applied'> {
  const stored = await repo.subscriptions.get(sub.id);
  if (!stored) throw new PaymentKitError(`subscription not found: ${sub.id}`, 'subscription_not_found');
  // A retry after the change was written (its answer lost), or the same change from another request.
  if (stored.planId === targetPlanId && stored.scheduledPlanId === null && sub.planId !== targetPlanId) return 'already_applied';
  if ((stored.version ?? 0) !== (sub.version ?? 0)) {
    throw new PaymentKitError('the subscription changed since it was read; read it again and retry', 'subscription_changed', {
      subscriptionId: sub.id, readVersion: sub.version, storedVersion: stored.version, storedPlanId: stored.planId });
  }
  if (!UPGRADABLE.has(stored.status)) {
    throw new PaymentKitError(`a ${stored.status} subscription cannot change plan`, 'subscription_inactive', { subscriptionId: sub.id, status: stored.status });
  }
  return stored;
}

async function upgradeHeld(input: UpgradeInput): Promise<UpgradeResult> {
  const { newPlan, policy, provider, ledger, repo, clock } = input;
  const read = await readForChange(repo, input.sub, newPlan.id);
  if (read === 'already_applied') {
    const current = (await repo.subscriptions.get(input.sub.id)) as Subscription;
    return { sub: current, grant: null, creditDelta: 0 };
  }
  const sub = read;
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
  const native = provider.capabilities().nativeSubscriptions;
  // EC:J7 — exact integer proration: the unused share of the old period.
  const frac = prorationFraction(sub.currentPeriod, now, policy.proration.denominator);
  let payment: Payment | null = null;

  // EC:F — Toss/PortOne (self-scheduling) don't track subscription state on their side:
  // getSubscription/changeSubscription/cancelSubscription all throw PaymentKitError('unsupported').
  // We update Repo.subscriptions ourselves instead, and charge the prorated *money* delta directly
  // via the billing key (changeSubscription would otherwise have triggered the provider's own
  // proration invoice).
  // EC:A2 — credit delta, computed against the *original* (pre-upgrade) period's remaining ratio.
  // EC:A59 — a self-scheduled reset_anchor upgrade bought a whole new period less the old period's unused
  // share, so it grants the new plan's credits less the old plan's unused share (either creditDelta).
  const fullDelta = newPlan.creditsPerPeriod - oldPlan.creditsPerPeriod;
  // EC:A77 — a native reset_anchor change is billed by the provider as a new period, whose paid invoice
  // grants that period's credits: the kit grants no delta on top. A provider that bills the change as a
  // later order (Polar) gets its delta granted when that order's paid webhook arrives.
  const grantOnPayment = native && provider.capabilities().upgradeGrant === 'on_payment';
  const delta = native && resetAnchor && !grantOnPayment ? 0 : resetAnchor && !native
    ? newPlan.creditsPerPeriod - scaleMinor(oldPlan.creditsPerPeriod, frac.num, frac.den, 'floor')
    : policy.upgrade.creditDelta === 'full_delta'
      ? fullDelta
      : Math.floor(fullDelta * prorationRatio(sub.currentPeriod, now, policy.proration.denominator));

  const scopedProvider = scopeProvider(provider, input.correlationId);
  let changed: Subscription | null = null;
  if (native) {
    if (sub.providerRef === null) throw new PaymentKitError('native subscription mutation requires its provider reference', 'subscription_provider_ref_required');
    const priceRef = resolvePriceRef(newPlan, sub.provider, sub.currency);
    // EC:A82 — the delta waiting for the change order is stored before the provider is asked: the order's
    // paid webhook can arrive before this call returns, and must find it.
    const pendingKey = pendingUpgradeGrantKey(sub.id, sub.currentPeriod.start);
    if (delta > 0 && grantOnPayment) await putPendingGrant(repo, pendingKey, delta, sub.currentPeriod.end, `upgrade:${oldPlan.id}->${newPlan.id}`, policy, now);
    try {
      changed = await scopedProvider.changeSubscription(sub.providerRef, { newPriceRef: priceRef, proration: 'immediate', resetAnchor });
    } catch (err) {
      const op = delta > 0 && grantOnPayment ? await repo.operations.get(pendingKey) : null;
      if (op?.status === 'in_progress') await repo.operations.put({ ...op, status: 'failed', error: 'change_failed', completedAt: clock.now() });
      throw err;
    }
  } else {
    if (!sub.billingKey) throw new PaymentKitError('upgrade requires a billing key for self-scheduling providers', 'billing_key_required');
    // EC:A28 — both prices in the subscription's currency (spec note #4 used the first price).
    // EC:A33 — a missing old price is refused, not read as 0 (the whole new price as the delta).
    const oldPrice = requirePriceForSubscription(oldPlan, sub);
    const newPrice = requirePriceForSubscription(newPlan, sub);
    // EC:A59 — reset_anchor starts a whole new period now: it costs the new price less the unused share of
    // the old one (what Stripe's billing_cycle_anchor=now charges). keep_anchor charges the price
    // difference for the rest of the current period.
    const money = resetAnchor
      ? newPrice.amountMinor - scaleMinor(oldPrice.amountMinor, frac.num, frac.den, 'ceil')
      : scaleMinor(newPrice.amountMinor - oldPrice.amountMinor, frac.num, frac.den, 'floor');
    if (money > 0) {
      // EC:J5 — deterministic (not clock.now()-derived): a retry of this same upgrade operation
      // must reuse the same provider-side charge idempotency key.
      const chargeKey = `charge:upgrade:${sub.id}:${newPlan.id}:${sub.currentPeriod.start.toISOString()}`;
      // EC:A57 A62 — a valid provider orderId and a local payment row; an earlier release's raw-key order is looked up first.
      payment = await chargeUpgradeDelta({
        provider: scopedProvider, repo, clock, sub, planId: newPlan.id, chargeKey, legacyOrderIds: [chargeKey],
        amount: { amountMinor: money, currency: newPrice.currency },
        revert: { fromPlanId: sub.planId, period: sub.currentPeriod, anchorDay: sub.anchorDay }, // EC:A76
      });
      if (payment.status !== 'succeeded') {
        throw new PaymentKitError('upgrade charge did not succeed', 'upgrade_charge_failed', { payment });
      }
    }
  }

  let currentPeriod: Period = sub.currentPeriod;
  let anchorDay = sub.anchorDay;

  if (native) {
    // EC:A77 — the provider decides the period after a native change (Polar never resets the anchor).
    if (changed?.currentPeriod) { currentPeriod = changed.currentPeriod; anchorDay = changed.anchorDay ?? anchorDay; }
  } else if (resetAnchor) {
    // EC:A71 — the new anchor is today's civil day in the policy timezone (a UTC day gives a KST
    // 1st-of-month upgrade the previous month's last day, and a two-month first period).
    anchorDay = civilDayOf(now, policy.period.timezone);
    const interval = (newPlan.interval ?? 'month') as 'month' | 'year';
    currentPeriod = nextPeriod({ start: now, end: now }, interval, anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
  }

  let grant: LedgerEntry | null = null;
  if (delta > 0 && grantOnPayment) {
    // EC:A82 — written before the change; a different period from the provider moves it (unless already paid).
    const key = pendingUpgradeGrantKey(sub.id, currentPeriod.start);
    const op = await repo.operations.get(key);
    if (!op || op.status === 'in_progress') await putPendingGrant(repo, key, delta, currentPeriod.end, `upgrade:${oldPlan.id}->${newPlan.id}`, policy, now);
  } else if (delta > 0) {
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
      // EC:A62 — the credits a refund of the upgrade charge takes back (EC:D20) are the ones it bought.
      reference: { subscriptionId: sub.id, periodStart: currentPeriod.start, ...(payment ? { paymentId: payment.id } : {}) },
      idempotencyKey,
      actor: 'system',
      reason: `upgrade:${oldPlan.id}->${newPlan.id}`,
    });
    grant = entry;
  }

  const updated = await applyChange(repo, sub, (base) => ({ ...base, planId: newPlan.id, scheduledPlanId: null,
    ...(resetAnchor || native ? { currentPeriod, anchorDay } : {}) }));
  return { sub: updated, grant, creditDelta: delta };
}

/**
 * EC:A61 — write a change that already charged: a concurrent writer (a renewal webhook, a tick) bumping
 * the version must not leave the money without the plan. The change is re-applied to the row as it is now.
 */
export async function applyChange(repo: Repo, read: Subscription, change: (base: Subscription) => Subscription): Promise<Subscription> {
  let base = read;
  for (let i = 0; ; i++) {
    const next = change(base);
    try {
      await repo.subscriptions.put(next);
      return next;
    } catch (err) {
      if (!(err instanceof PaymentKitError && err.code === 'subscription_version_conflict') || i >= 4) throw err;
      const fresh = await repo.subscriptions.get(read.id);
      if (!fresh) throw err;
      base = fresh;
    }
  }
}
