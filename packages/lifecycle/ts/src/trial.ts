// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A9 A11 J1-J5
import {
  Clock,
  Customer,
  LedgerEntry,
  LedgerStore,
  Payment,
  Plan,
  Policy,
  Repo,
  Subscription,
  deserializeLedgerEntry,
  deserializeSubscription,
  runIdempotent,
  serializeLedgerEntry,
  serializeSubscription,
} from '@schift/payment-kit-core';
import { revokePoolBalance } from './internal.js';

export interface ConvertTrialInput {
  sub: Subscription;
  plan: Plan; // plan being converted to (paid)
  payment: Payment;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  /** EC:J5 — default: `convert-trial:{sub.id}:{plan.id}` if omitted. */
  idempotencyKey?: string;
}

export interface ConvertTrialResult {
  sub: Subscription;
  grant: LedgerEntry | null;
  trialRevoked: LedgerEntry | null;
}

// EC:A9 — trial -> paid conversion, deciding what happens to trial-pool credits.
// EC:J1-J5 — wrapped in runIdempotent so a retry replays the first result instead of re-granting.
export async function convertTrial(input: ConvertTrialInput): Promise<ConvertTrialResult> {
  const { sub, plan, payment, policy, ledger, repo, clock } = input;
  const key = input.idempotencyKey ?? `convert-trial:${sub.id}:${plan.id}`;

  const { result } = await runIdempotent<ConvertTrialResult>({
    repo,
    clock,
    key,
    kind: 'lifecycle.convertTrial',
    payload: { subId: sub.id, planId: plan.id, paymentId: payment.id },
    serialize: (r) => ({
      sub: serializeSubscription(r.sub),
      grant: serializeLedgerEntry(r.grant),
      trialRevoked: serializeLedgerEntry(r.trialRevoked),
    }),
    deserialize: (v: any) => ({
      sub: deserializeSubscription(v.sub),
      grant: deserializeLedgerEntry(v.grant),
      trialRevoked: deserializeLedgerEntry(v.trialRevoked),
    }),
    fn: async () => {
      let grant: LedgerEntry | null = null;
      let trialRevoked: LedgerEntry | null = null;

      if (policy.trial.creditsOnConvert !== 'no_grant_until_next_period') {
        // EC:J5 — deterministic (not clock.now()-derived).
        const idempotencyKey = `grant:convert-trial:${sub.id}:${plan.id}`;
        const unitPriceMinor = plan.creditsPerPeriod > 0 ? Math.floor(payment.amount.amountMinor / plan.creditsPerPeriod) : null;
        const { entry } = await ledger.append({
          customerId: sub.customerId,
          pool: 'paid',
          kind: 'grant',
          amount: plan.creditsPerPeriod,
          unitPriceMinor,
          currency: payment.amount.currency,
          expiresAt: policy.credits.rollover === 'full' ? null : sub.currentPeriod.end,
          source: 'subscription',
          reference: { subscriptionId: sub.id, periodStart: sub.currentPeriod.start, paymentId: payment.id },
          idempotencyKey,
          actor: 'system',
          reason: 'trial_convert',
        });
        grant = entry;

        if (policy.trial.creditsOnConvert === 'grant_full') {
          trialRevoked = await revokePoolBalance(
            'trial',
            ledger,
            clock,
            sub.customerId,
            { subscriptionId: sub.id },
            `revoke:trial-convert:${sub.id}`,
            'trial_convert_discard',
          );
        }
        // 'grant_full_keep_trial' — leave trial pool untouched
      }
      // 'no_grant_until_next_period' — the next onRenewalPaid call grants under its own period key

      const updated: Subscription = { ...sub, status: 'active', planId: plan.id };
      await repo.subscriptions.put(updated);

      return { sub: updated, grant, trialRevoked };
    },
  });

  return result;
}

export interface TrialEligibilityInput {
  customerId: string;
  email: string | null;
  repo: Repo;
  policy: Policy;
}

// EC:A11 — one trial per customer (own subscription history + same-email customer records).
export async function isTrialEligible(input: TrialEligibilityInput): Promise<boolean> {
  const { customerId, email, repo, policy } = input;
  if (policy.trial.abuseGuard === 'none') return true;

  const ownSubs = await repo.subscriptions.list({ customerId } as Partial<Subscription>);
  if (ownSubs.length > 0) return false;

  if (email) {
    const sameEmail = await repo.customers.list({ email } as Partial<Customer>);
    for (const c of sameEmail) {
      if (c.id === customerId) continue;
      const subs = await repo.subscriptions.list({ customerId: c.id } as Partial<Subscription>);
      if (subs.length > 0) return false;
    }
  }

  return true;
}
