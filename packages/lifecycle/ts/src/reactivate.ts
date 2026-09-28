// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A23
import {
  Clock,
  LedgerStore,
  PaymentKitError,
  PaymentProvider,
  Policy,
  Repo,
  Subscription,
  SubscriptionStatus,
  deserializeSubscription,
  runIdempotent,
  serializeSubscription,
} from 'boilpayment-core';
import { scopeProvider } from './internal.js';

export interface ReactivateInput {
  sub: Subscription;
  policy: Policy;
  provider: PaymentProvider;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  /** EC:J5-style default: `reactivate:{sub.id}:{sub.currentPeriod.start ISO}` if omitted. */
  idempotencyKey?: string;
  /** EC:L5 — when present, scopes the `uncancelSubscription` call below to this correlationId via
   * the duck-typed `provider.withCorrelationId(id)` (see `internal.ts` `scopeProvider`). */
  correlationId?: string;
}

export interface RestoredCredits {
  restored: number;
}

export interface ReactivateResult {
  sub: Subscription;
  /** Non-null only when `policy.cancel.credits === 'revoke_immediately'` had something to restore. */
  restored: RestoredCredits | null;
  /**
   * EC:A23 — true only when a native provider (`capabilities().nativeSubscriptions`) actually had
   * its own cancellation reversed via `provider.uncancelSubscription`. False for self-scheduling
   * providers (nothing on the provider side to correct) and for a native provider whose adapter
   * throws `PaymentKitError('unsupported')` for this operation — in both cases the Repo-only
   * repair above still happens; this field only reports whether the provider itself was notified.
   */
  providerNotified: boolean;
}

/**
 * EC:A23 restore — the mirror image of cancel.ts's `revoke_immediately` clawback. `cancel.ts` calls
 * `boilpayment-credits` `clawback()`, which appends ONE aggregate `revoke` ledger row
 * (`revoke:cancel:{sub.id}:{periodStart}`, no per-grant `reference.grantId`) rather than a
 * per-bucket breakdown like `cs.dispute`'s `revokeDisputedGrants`. To restore "attributed per
 * bucket, original expiry preserved" (matching the dispute-restore pattern) without changing
 * cancel.ts's ledger shape or its `CancelResult.revoked: ClawbackResult` return type (both are
 * exercised by existing tests), this reconstructs the buckets that funded that aggregate revoke:
 * every `grant` entry that existed by the revoke's `createdAt`, with its live remaining computed
 * as of that same instant, oldest-expiry-first (same order `ledger.balance`/`consume` use) — this
 * is exactly the set of buckets `balance.available` was drawn from at cancel time, since
 * `revoke_immediately` always revokes the full available balance. Each bucket is restored with its
 * OWN original `expiresAt`/`unitPriceMinor`/`currency`, keyed `restore:reactivate:{sub.id}:
 * {periodStart}:{grantId}` so a retry/replay is a no-op. Any leftover (e.g. floating-point/negative-
 * balance edge cases) is restored unattributed under a `:remainder` key.
 */
async function restoreCanceledCredits(opts: {
  ledger: LedgerStore;
  customerId: string;
  subId: string;
  periodStart: Date;
}): Promise<RestoredCredits> {
  const { ledger, customerId, subId, periodStart } = opts;
  const revokeKey = `revoke:cancel:${subId}:${periodStart.toISOString()}`;
  const all = await ledger.entries(customerId, { pool: 'paid' });
  const revokeEntry = all.find((e) => e.idempotencyKey === revokeKey);
  if (!revokeEntry) return { restored: 0 }; // nothing was revoked at cancel time (e.g. balance was 0)

  const totalToRestore = -revokeEntry.amount;
  if (totalToRestore <= 0) return { restored: 0 };

  const cutoff = revokeEntry.createdAt.getTime();
  const buckets = all
    .filter((e) => e.kind === 'grant' && e.createdAt.getTime() <= cutoff)
    .map((g) => {
      const remaining =
        g.amount +
        all
          .filter((e) => e.kind !== 'grant' && e.reference.grantId === g.id && e.createdAt.getTime() <= cutoff)
          .reduce((sum, e) => sum + e.amount, 0);
      return { grant: g, remaining };
    })
    .filter((b) => b.remaining > 0)
    .sort((a, b) => {
      const ae = a.grant.expiresAt ? a.grant.expiresAt.getTime() : Infinity;
      const be = b.grant.expiresAt ? b.grant.expiresAt.getTime() : Infinity;
      return ae - be;
    });

  let left = totalToRestore;
  let restored = 0;
  for (const b of buckets) {
    if (left <= 0) break;
    const take = Math.min(left, b.remaining);
    if (take <= 0) continue;
    const { duplicated } = await ledger.append({
      customerId,
      pool: 'paid',
      kind: 'grant',
      amount: take,
      source: 'subscription',
      reference: { subscriptionId: subId, periodStart, grantId: b.grant.id },
      idempotencyKey: `restore:reactivate:${subId}:${periodStart.toISOString()}:${b.grant.id}`,
      actor: 'system',
      reason: 'A23 reactivate — restoring credits revoked at cancel',
      unitPriceMinor: b.grant.unitPriceMinor,
      currency: b.grant.currency,
      expiresAt: b.grant.expiresAt,
    });
    if (!duplicated) restored += take;
    left -= take;
  }
  if (left > 0) {
    const { duplicated } = await ledger.append({
      customerId,
      pool: 'paid',
      kind: 'grant',
      amount: left,
      source: 'subscription',
      reference: { subscriptionId: subId, periodStart },
      idempotencyKey: `restore:reactivate:${subId}:${periodStart.toISOString()}:remainder`,
      actor: 'system',
      reason: 'A23 reactivate — restoring credits revoked at cancel (unattributed remainder)',
      unitPriceMinor: null,
      currency: null,
      expiresAt: null,
    });
    if (!duplicated) restored += left;
  }
  return { restored };
}

// EC:A23 — undo a pending or in-period cancellation. Not covered by a `policy.*` key: this is an
// operation the app calls explicitly (a "never mind, keep my subscription" action), not a policy
// branch that fires automatically.
//
// EC:J1-J5 — wrapped in runIdempotent so a retry replays the first result instead of re-restoring.
export async function reactivate(input: ReactivateInput): Promise<ReactivateResult> {
  const { sub, policy, provider, ledger, repo, clock } = input;
  const key = input.idempotencyKey ?? `reactivate:${sub.id}:${sub.currentPeriod.start.toISOString()}`;
  // EC:A73 — a banned customer (a lost dispute) does not get a subscription back.
  const owner = await repo.customers.get(sub.customerId);
  if (owner && owner.status === 'banned') {
    throw new PaymentKitError('customer is banned', 'customer_banned', { subscriptionId: sub.id, customerId: sub.customerId });
  }

  const { result } = await runIdempotent<ReactivateResult>({
    repo,
    clock,
    key,
    kind: 'lifecycle.reactivate',
    payload: { subId: sub.id, periodStart: sub.currentPeriod.start.toISOString() },
    serialize: (r) => ({ sub: serializeSubscription(r.sub), restored: r.restored, providerNotified: r.providerNotified }),
    deserialize: (v: any) => ({ sub: deserializeSubscription(v.sub), restored: v.restored, providerNotified: v.providerNotified }),
    fn: async () => {
      const now = clock.now();
      const periodEnded = now.getTime() >= sub.currentPeriod.end.getTime();

      let nextStatus: SubscriptionStatus;
      if (sub.cancelAtPeriodEnd) {
        // Pending cancellation (end_of_period) — never actually stopped serving.
        nextStatus = 'active';
      } else if (sub.status === 'canceled' && !periodEnded) {
        // Canceled immediately, but the paid-for period the customer already covered hasn't ended.
        nextStatus = 'active';
      } else {
        // status === 'expired', or the period already ended, or there was no cancellation in
        // progress to undo (e.g. still 'active'/'trialing'/'past_due' with cancelAtPeriodEnd=false)
        // — nothing to reactivate. The caller must start a new subscription.
        throw new PaymentKitError(
          `subscription ${sub.id} is not reactivatable (status=${sub.status}, cancelAtPeriodEnd=${sub.cancelAtPeriodEnd})`,
          'not_reactivatable',
          { id: sub.id, status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
        );
      }

      // EC:F — self-scheduling providers (Toss/Portone) don't track subscription state at all, so
      // there's nothing to tell them; providerNotified stays false. Native providers (Stripe/Polar)
      // get a real `uncancelSubscription` call (EC:L5-scoped when a correlationId was given) so the
      // provider-side dashboard reflects the reversal too, not just our Repo row. If the adapter
      // throws PaymentKitError('unsupported') (a native provider that hasn't implemented this yet),
      // fall back to the Repo-only repair — that's still the correct outcome, just unnotified. Any
      // other error (in particular 'not_reactivatable' — the provider says this subscription has
      // already fully ended) propagates: the caller needs to know reactivation is impossible rather
      // than getting a silently-repaired-but-wrong Repo row.
      let providerNotified = false;
      if (provider.capabilities().nativeSubscriptions) {
        if (sub.providerRef === null) throw new PaymentKitError('native subscription mutation requires its provider reference', 'subscription_provider_ref_required');
        try {
          await scopeProvider(provider, input.correlationId).uncancelSubscription(sub.providerRef);
          providerNotified = true;
        } catch (err) {
          if (err instanceof PaymentKitError && err.code === 'unsupported') {
            providerNotified = false;
          } else {
            throw err;
          }
        }
      }

      const updated: Subscription = { ...sub, status: nextStatus, cancelAtPeriodEnd: false };
      await repo.subscriptions.put(updated);

      let restored: RestoredCredits | null = null;
      if (policy.cancel.credits === 'revoke_immediately') {
        restored = await restoreCanceledCredits({
          ledger,
          customerId: sub.customerId,
          subId: sub.id,
          periodStart: sub.currentPeriod.start,
        });
      }

      return { sub: updated, restored, providerNotified };
    },
  });

  return result;
}
