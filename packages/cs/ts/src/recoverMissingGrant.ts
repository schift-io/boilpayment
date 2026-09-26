import { runIdempotent, serializeCsCase, deserializeCsCase, keyMatchesInstant } from 'boilpayment-core';
import type { CsCase, LedgerEntry, Payment, Period, Plan, Subscription } from 'boilpayment-core';
import { escalate, reject, resolve } from './cases.js';
import { getPurchaseSnapshot } from './purchaseSnapshot.js';
import { applyPurchasedGrant } from './applyPurchasedGrant.js';
import { verifySupportPayment } from './support.js';
import type { SupportDeps, SupportPaymentInput } from './support.js';

export interface SupportGrantOutcome { readonly entry: LedgerEntry | null; readonly duplicated: boolean; readonly deferred: boolean }
export interface SupportGrants {
  topup(input: Pick<SupportPaymentInput, 'customerId' | 'policy' | 'ledger' | 'clock' | 'repo'> & { payment: Payment; credits: number }): Promise<SupportGrantOutcome>;
  grantForPeriod(input: Pick<SupportDeps, 'policy' | 'ledger' | 'clock'> & { payment: Payment; sub: Subscription; plan: Plan; period: Period }): Promise<SupportGrantOutcome>;
}
export interface RecoverMissingGrantInput extends SupportPaymentInput { readonly grants: SupportGrants }
export interface RecoverMissingGrantsInput extends SupportDeps {
  readonly grants: SupportGrants;
  readonly customerId?: string;
  readonly since?: Date;
}

/** Replays the original credit primitive using persisted entitlement and verified payment facts. */
export async function recoverMissingGrant(input: RecoverMissingGrantInput): Promise<CsCase> {
  const recorded = await input.repo.operations.get(`support-case:regrant:${input.customerId}:${input.paymentId}:`);
  if (recorded?.status === 'done') {
    const stored = await input.repo.csCases.get(deserializeCsCase(recorded.result).id);
    if (stored && (stored.status === 'resolved_auto' || stored.status === 'resolved_human' || stored.status === 'rejected')) return stored;
  }
  const verified = await verifySupportPayment({ ...input, kind: 'regrant' });
  if (!verified.ok) return verified.case;
  const { case: csCase, payment } = verified;
  const { repo, ledger, clock, onCaseEvent } = input;
  const policy = csCase.policySnapshot;
  const hold = (reason: string) => escalate({ case: csCase, reason, repo, clock, onCaseEvent, notifier: input.notifier });
  if (payment.status !== 'succeeded') return hold('only an unrefunded successful payment can recover credits');
  if (policy.cs.regrant.mode === 'off') return reject({ case: csCase, reason: 'cs.regrant.mode=off', repo, clock, onCaseEvent, reporter: input.reporter });
  const snapshot = await getPurchaseSnapshot({ paymentId: payment.id, repo });
  if (!snapshot || snapshot.customerId !== input.customerId || snapshot.paymentRef !== payment.providerRef
    || snapshot.provider !== payment.provider || snapshot.price.currency !== payment.amount.currency
    || snapshot.price.amountMinor !== payment.amount.amountMinor || snapshot.plan.creditsPerPeriod <= 0) return hold('immutable purchase entitlement is missing or inconsistent');
  const credits = snapshot.plan.creditsPerPeriod;
  const grantKey = snapshot.plan.interval === null ? `topup:${payment.id}`
    : snapshot.subscriptionId && snapshot.period ? `grant:${snapshot.subscriptionId}:${snapshot.period.start}` : null;
  if (!grantKey) return hold('subscription purchase evidence missing');
  if (policy.cs.regrant.mode === 'manual_approve') return hold('cs.regrant.mode=manual_approve, awaiting approval');
  const completed = await runIdempotent({ repo, clock, key: `support-recover-complete:${csCase.id}`, kind: 'cs.recoverMissingGrant',
    payload: { grantKey }, serialize: serializeCsCase, deserialize: deserializeCsCase,
    fn: async () => {
      const existing = (await ledger.entries(input.customerId, { kind: 'grant' })).find((entry) => entry.idempotencyKey === grantKey
        || (snapshot.plan.interval !== null && snapshot.subscriptionId && snapshot.period
          && keyMatchesInstant(entry.idempotencyKey, `grant:${snapshot.subscriptionId}:`, new Date(snapshot.period.start)))); // EC:J11
      if (existing) return resolve({ case: csCase, by: 'auto', decision: { granted: false, entryId: existing.id, paymentId: payment.id, idempotencyKey: grantKey }, repo, clock, onCaseEvent, reporter: input.reporter });
      const outcome = await applyPurchasedGrant(input);
      if (!outcome.entry || outcome.deferred) return hold('credit grant was deferred');
      return resolve({ case: csCase, by: 'auto', decision: { granted: !outcome.duplicated, entryId: outcome.entry.id, paymentId: payment.id, credits, idempotencyKey: grantKey }, repo, clock, onCaseEvent, reporter: input.reporter });
    } });
  return await repo.csCases.get(completed.result.id) ?? completed.result;

}

/** Scans only locally recorded payments; provider-only orphans require explicit reconciliation. */
export async function recoverMissingGrants(input: RecoverMissingGrantsInput): Promise<CsCase[]> {
  const payments = await input.repo.payments.list(input.customerId ? { customerId: input.customerId } : undefined);
  const results: CsCase[] = [];
  for (const payment of payments) {
    if ((input.since && payment.occurredAt < input.since) || payment.kind === 'overage') continue;
    // EC:A46 — a declined charge bought nothing, and a self-scheduled attempt still pending belongs to
    // the scheduler (EC:A36 A38): neither is a missing grant.
    if (payment.status === 'failed') continue;
    if (payment.status === 'pending' && (payment.raw as { boilpaymentAttemptKey?: unknown } | undefined)?.boilpaymentAttemptKey) continue;
    const entries = await input.ledger.entries(payment.customerId, { kind: 'grant' });
    if (entries.some((entry) => entry.reference.paymentId === payment.id)) continue;
    // EC:A46 — already handed to a person: the scan reports the open case again, it does not re-notify.
    const recorded = await input.repo.operations.get(`support-case:regrant:${payment.customerId}:${payment.id}:`);
    if (recorded?.status === 'done') {
      const open = await input.repo.csCases.get(deserializeCsCase(recorded.result).id);
      if (open?.status === 'needs_human') { results.push(open); continue; }
    }
    results.push(await recoverMissingGrant({ ...input, customerId: payment.customerId, paymentId: payment.id }));
  }
  return results;
}
