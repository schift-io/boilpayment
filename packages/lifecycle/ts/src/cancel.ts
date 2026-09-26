// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A5 A6 A10 I4 J1-J5
import {
  Clock,
  LedgerStore,
  PaymentProvider,
  PaymentKitError,
  Policy,
  Repo,
  Subscription,
  deserializeLedgerEntry,
  deserializeSubscription,
  runIdempotent,
  serializeLedgerEntry,
  serializeSubscription,
} from '@schift/payment-kit-core';
import { clawback, ClawbackResult } from '@schift/payment-kit-credits';
import { revokePoolBalance, scopeProvider } from './internal.js';

export interface ChurnInfo {
  customerId: string;
  subscriptionId: string;
  reason: string | null;
  text: string | null;
}

export interface CancelInput {
  sub: Subscription;
  policy: Policy;
  provider: PaymentProvider;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  churnReason?: string | null;
  churnText?: string | null;
  // EC:I4 — churn is always recorded on the returned object; persisting a CsCase is the cs
  // module's job. Pass a callback if the caller wants to persist it inline (e.g. via cs.churn.record).
  onChurn?: (info: ChurnInfo) => void | Promise<void>;
  /** EC:J5 — default: `cancel:{sub.id}:{sub.currentPeriod.start ISO}` if omitted. */
  idempotencyKey?: string;
  /** EC:L5 — when present, scopes this cancel's `cancelSubscription` call to this correlationId via
   * the duck-typed `provider.withCorrelationId(id)` (`internal.ts` `scopeProvider`). */
  correlationId?: string;
}

export interface CancelResult {
  sub: Subscription;
  churn: { reason: string | null; text: string | null };
  revoked: ClawbackResult | null;
}

function serializeClawback(c: ClawbackResult | null): unknown {
  if (!c) return null;
  return { ...c, entry: serializeLedgerEntry(c.entry) };
}
function deserializeClawback(v: any): ClawbackResult | null {
  if (!v) return null;
  return { ...v, entry: deserializeLedgerEntry(v.entry) };
}

// EC:A5 A6 A10 I4 — cancel now or at period end; resolve outstanding credits per policy.
// EC:J1-J5 — wrapped in runIdempotent so a retry replays the first result instead of re-revoking.
export async function cancel(input: CancelInput): Promise<CancelResult> {
  const { sub, policy, provider, ledger, repo, clock, churnReason = null, churnText = null, onChurn } = input;
  if (policy.cancel.credits === 'keep_forever') {
    throw new PaymentKitError('cancel.credits=keep_forever is not supported by the append-only ledger', 'unsupported');
  }
  const key = input.idempotencyKey ?? `cancel:${sub.id}:${sub.currentPeriod.start.toISOString()}`;

  const { result } = await runIdempotent<CancelResult>({
    repo,
    clock,
    key,
    kind: 'lifecycle.cancel',
    payload: { subId: sub.id, periodStart: sub.currentPeriod.start.toISOString() },
    serialize: (r) => ({ sub: serializeSubscription(r.sub), churn: r.churn, revoked: serializeClawback(r.revoked) }),
    deserialize: (v: any) => ({ sub: deserializeSubscription(v.sub), churn: v.churn, revoked: deserializeClawback(v.revoked) }),
    fn: async () => {
      const atPeriodEnd = policy.cancel.mode === 'end_of_period';
      // EC:F — Toss/PortOne (self-scheduling) don't track subscription state; cancelSubscription would
      // throw PaymentKitError('unsupported'). We just stop scheduling future charges via Repo below
      // (scheduler.dueSubscriptions excludes cancelAtPeriodEnd subscriptions).
      if (provider.capabilities().nativeSubscriptions) {
        if (sub.providerRef === null) throw new PaymentKitError('native subscription mutation requires its provider reference', 'subscription_provider_ref_required');
        await scopeProvider(provider, input.correlationId).cancelSubscription(sub.providerRef, { atPeriodEnd });
      }

      let revoked: ClawbackResult | null = null;

      // EC:A6
      if (policy.cancel.credits === 'revoke_immediately') {
        const balance = await ledger.balance(sub.customerId, 'paid', clock.now());
        if (balance.available > 0) {
          revoked = await clawback({
            customerId: sub.customerId,
            amount: balance.available,
            policy,
            ledger,
            clock,
            reason: 'cancel',
            reference: { subscriptionId: sub.id, periodStart: sub.currentPeriod.start },
            actor: 'system',
            idempotencyKey: `revoke:cancel:${sub.id}:${sub.currentPeriod.start.toISOString()}`,
            shortfall: 'clamp_to_zero',
          });
        }
      }
      // 'keep_until_period_end' — no-op, existing grant.expiresAt already governs this.

      // EC:A10 — trial credits revoked on cancel while still trialing
      if (sub.status === 'trialing' && policy.trial.creditsOnCancel === 'revoke') {
        await revokePoolBalance(
          'trial',
          ledger,
          clock,
          sub.customerId,
          { subscriptionId: sub.id },
          `revoke:trial-cancel:${sub.id}`,
          'trial_cancel',
        );
      }

      const updated: Subscription = {
        ...sub,
        status: atPeriodEnd ? sub.status : 'canceled',
        cancelAtPeriodEnd: atPeriodEnd,
      };
      await repo.subscriptions.put(updated);

      const churn = { reason: churnReason, text: churnText };
      if (onChurn) {
        await onChurn({ customerId: sub.customerId, subscriptionId: sub.id, reason: churnReason, text: churnText });
      }

      return { sub: updated, churn, revoked };
    },
  });

  return result;
}
