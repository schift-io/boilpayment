import { isZeroSaleHandled, openZeroSaleCase, runIdempotent, serializeCsCase, deserializeCsCase, keyMatchesInstant, nextPeriod } from 'boilpayment-core';
import type { CsCase, LedgerEntry, Payment, Period, Plan, Subscription } from 'boilpayment-core';
import { escalate, reject, resolve } from './cases.js';
import { getPurchaseSnapshot, matchesCapturedSaleAmount } from './purchaseSnapshot.js';
import { applyPurchasedGrant } from './applyPurchasedGrant.js';
import { verifySupportPayment } from './support.js';
import type { SupportDeps, SupportPaymentInput } from './support.js';

export interface SupportGrantOutcome { readonly entry: LedgerEntry | null; readonly duplicated: boolean; readonly deferred: boolean }
export interface SupportGrants {
  topup(input: Pick<SupportPaymentInput, 'customerId' | 'policy' | 'ledger' | 'clock' | 'repo'> & { payment: Payment; credits: number }): Promise<SupportGrantOutcome>;
  grantForPeriod(input: Pick<SupportDeps, 'policy' | 'ledger' | 'clock'> & { payment: Payment; sub: Subscription; plan: Plan; period: Period }): Promise<SupportGrantOutcome>;
}
/** Appends the affiliate commission accrual for a granted payment; idempotent per payment. */
export type AccrueAffiliate = (payment: Payment) => Promise<void>;
export interface RecoverMissingGrantInput extends SupportPaymentInput {
  readonly grants: SupportGrants;
  readonly accrueAffiliate?: AccrueAffiliate | null;
}
export interface RecoverMissingGrantsInput extends SupportDeps {
  readonly grants: SupportGrants;
  readonly accrueAffiliate?: AccrueAffiliate | null;
  /** AF-04 — whether a recovered native renewal accrues (`include`) or only a first purchase does. */
  readonly affiliateRenewals?: 'first_only' | 'include';
  readonly customerId?: string;
  readonly since?: Date;
}

function rawContains(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => rawContains(item, expected));
  if (value !== null && typeof value === 'object') return Object.values(value).some((item) => rawContains(item, expected));
  return false;
}

function rawField(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.entries(value).find(([key]) => key === field)?.[1];
}

function markTrialOpeningInvoice(value: unknown): Record<string, unknown> {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
  return { ...raw, boilpaymentTrialOpeningInvoice: true };
}

async function openReconcileMismatch(input: {
  readonly sub: Subscription; readonly payment: Payment; readonly deps: RecoverMissingGrantsInput;
  readonly actualPlanId: string | null; readonly reason?: string;
}): Promise<CsCase> {
  const { sub, payment, deps, actualPlanId, reason } = input;
  const id = `reconcile_mismatch:${payment.id}`;
  const existing = await deps.repo.csCases.get(id);
  if (existing) return existing;
  const now = deps.clock.now();
  const mismatchCase: CsCase = {
    id, customerId: sub.customerId, kind: 'reconcile_mismatch', status: 'needs_human', referenceId: payment.id,
    policySnapshot: structuredClone(deps.policy), decision: {
      subscriptionId: sub.id, expectedPlanId: sub.scheduledPlanId ?? sub.planId, actualPlanId,
      amountMinor: payment.amount.amountMinor, currency: payment.amount.currency, ...(reason ? { reason } : {}),
    }, churnReason: null, churnText: null, openedAt: now, resolvedAt: null, escalatedAt: now,
  };
  await deps.repo.csCases.put(mismatchCase);
  return mismatchCase;
}

async function resolveReconciledPlan(input: {
  readonly sub: Subscription; readonly payment: Payment; readonly deps: RecoverMissingGrantsInput;
}): Promise<{ readonly plan: Plan | null; readonly mismatchCase: CsCase | null }> {
  const { sub, payment, deps } = input;
  const expectedPlanId = sub.scheduledPlanId ?? sub.planId;
  const expected = await deps.repo.plans.get(expectedPlanId);
  const currency = payment.amount.currency.toUpperCase();
  const expectedMatches = expected?.interval !== null && expected?.prices.some((price) => {
    const ref = price.providerPriceRefs?.[payment.provider];
    return (ref !== undefined && (payment.saleEvidence?.priceRef === ref || rawContains(payment.raw, ref)))
      || (price.currency.toUpperCase() === currency && price.amountMinor === payment.amount.amountMinor);
  });
  if (expected && expectedMatches) return { plan: expected, mismatchCase: null };
  const plans = (await deps.repo.plans.list()).filter((plan) => plan.interval !== null);
  const byProviderRef = plans.filter((plan) => plan.prices.some((price) => {
    const ref = price.providerPriceRefs?.[payment.provider];
    return ref !== undefined && (payment.saleEvidence?.priceRef === ref || rawContains(payment.raw, ref));
  }));
  const byAmount = plans.filter((plan) => plan.prices.some((price) =>
    price.currency.toUpperCase() === currency && price.amountMinor === payment.amount.amountMinor));
  const candidates = byProviderRef.length > 0 ? byProviderRef : byAmount;
  const actual = candidates.length === 1 ? candidates[0] ?? null : null;
  if (actual?.id === expectedPlanId) return { plan: actual, mismatchCase: null };

  // SB-14 — a renewal charged at another (or ambiguous) price must never receive the scheduled
  // plan's credits. The deterministic case also deduplicates a late webhook's mismatch handling.
  const mismatchCase = await openReconcileMismatch({ sub, payment, deps, actualPlanId: actual?.id ?? null });
  return { plan: actual, mismatchCase };
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
    || snapshot.provider !== payment.provider || !matchesCapturedSaleAmount(snapshot, payment)
    || snapshot.plan.creditsPerPeriod <= 0) return hold('immutable purchase entitlement is missing or inconsistent');
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
      const accrue = () => input.accrueAffiliate
        ? input.accrueAffiliate({ ...payment, affiliateId: payment.affiliateId ?? snapshot.affiliateId })
        : Promise.resolve();
      if (existing) {
        await accrue();
        return resolve({ case: csCase, by: 'auto', decision: { granted: false, entryId: existing.id, paymentId: payment.id, idempotencyKey: grantKey }, repo, clock, onCaseEvent, reporter: input.reporter });
      }
      const outcome = await applyPurchasedGrant(input);
      if (!outcome.entry || outcome.deferred) return hold('credit grant was deferred');
      await accrue();
      return resolve({ case: csCase, by: 'auto', decision: { granted: !outcome.duplicated, entryId: outcome.entry.id, paymentId: payment.id, credits, idempotencyKey: grantKey }, repo, clock, onCaseEvent, reporter: input.reporter });
    } });
  return await repo.csCases.get(completed.result.id) ?? completed.result;

}

/** Reconciles native renewals, then scans all local payments that still lack their grant. */
export async function recoverMissingGrants(input: RecoverMissingGrantsInput): Promise<CsCase[]> {
  // SB-06 — Stripe/Polar can charge a native renewal even when its webhook is lost. Pull those
  // payments from each eligible local subscription and use the webhook's canonical grant key.
  const since = input.since;
  const reconciledCases: CsCase[] = [];
  if (since) {
    const subscriptions = await input.repo.subscriptions.list(input.customerId ? { customerId: input.customerId } : undefined);
    for (const listed of subscriptions) {
      if ((listed.provider !== 'stripe' && listed.provider !== 'polar') || (listed.status !== 'active' && listed.status !== 'past_due')) continue;
      if (!listed.providerRef) continue;
      const provider = input.providers[listed.provider];
      if (!provider?.capabilities().nativeSubscriptions) continue;
      const customer = await input.repo.customers.get(listed.customerId);
      const customerRef = customer?.providerRefs.find((ref) => ref.provider === listed.provider)?.ref;
      if (!customerRef) continue;
      const remotePayments = (await provider.listPayments({ customerRef, since }))
        .filter((payment) => payment.provider === listed.provider && payment.kind === 'subscription'
          && payment.status === 'succeeded' && payment.subscriptionId === listed.providerRef
          && payment.occurredAt >= since)
        .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
      for (const remote of remotePayments) {
        const current = await input.repo.subscriptions.get(listed.id);
        if (!current || (current.status !== 'active' && current.status !== 'past_due')) continue;
        const existing = (await input.repo.payments.list({ provider: current.provider, providerRef: remote.providerRef }))[0];
        if (existing && (existing.customerId !== current.customerId || existing.subscriptionId !== current.id)) continue;
        const raw = remote.raw ?? existing?.raw;
        const trialOpeningInvoice = rawField(existing?.raw, 'boilpaymentTrialOpeningInvoice') === true;
        let payment: Payment = {
          id: existing?.id ?? input.ids.newId(), customerId: current.customerId, provider: current.provider,
          providerRef: remote.providerRef, subscriptionId: current.id, amount: remote.amount, status: remote.status,
          kind: 'subscription', period: remote.period ?? existing?.period ?? null, occurredAt: remote.occurredAt, failure: remote.failure,
          cashReceipt: existing?.cashReceipt ?? null, raw: trialOpeningInvoice ? markTrialOpeningInvoice(raw) : raw,
          providerRefAliases: remote.providerRefAliases, saleEvidence: remote.saleEvidence ?? existing?.saleEvidence ?? null,
          affiliateId: remote.affiliateId ?? current.affiliateId ?? existing?.affiliateId ?? null,
        };
        await input.repo.payments.put(payment);
        if (trialOpeningInvoice) continue;
        if (payment.amount.amountMinor === 0) { // DC-07 — a paid-zero renewal is never granted
          const zeroCase = await openZeroSaleCase({ repo: input.repo, clock: input.clock, policy: input.policy, payment, notifier: input.notifier });
          if (!reconciledCases.some((item) => item.id === zeroCase.id)) reconciledCases.push(zeroCase);
          continue;
        }
        const resolved = await resolveReconciledPlan({ sub: current, payment, deps: input });
        if (resolved.mismatchCase && !reconciledCases.some((item) => item.id === resolved.mismatchCase?.id)) {
          reconciledCases.push(resolved.mismatchCase);
        }
        const plan = resolved.plan;
        if (!plan) continue;
        if (!payment.period) {
          const derived = payment.provider === 'polar' && plan.interval
            ? nextPeriod(current.currentPeriod, plan.interval, current.anchorDay,
              input.policy.period.timezone, input.policy.period.monthEndAnchor)
            : null;
          const safelyMapped = derived && payment.occurredAt >= derived.start && payment.occurredAt < derived.end;
          if (!derived || !safelyMapped) {
            const periodCase = await openReconcileMismatch({ sub: current, payment, deps: input,
              actualPlanId: plan.id, reason: 'renewal_period_unresolved' });
            if (!reconciledCases.some((item) => item.id === periodCase.id)) reconciledCases.push(periodCase);
            continue;
          }
          payment = { ...payment, period: derived };
          await input.repo.payments.put(payment);
        }
        const paidPeriod = payment.period;
        if (!paidPeriod) continue;
        await input.grants.grantForPeriod({ sub: { ...current, planId: plan.id, status: 'active' }, plan,
          period: paidPeriod, payment, policy: input.policy, ledger: input.ledger, clock: input.clock });
        const fresh = await input.repo.subscriptions.get(current.id);
        if (fresh && (fresh.status === 'active' || fresh.status === 'past_due') && paidPeriod.end > fresh.currentPeriod.end) {
          await input.repo.subscriptions.put({ ...fresh, planId: plan.id, scheduledPlanId: null,
            currentPeriod: paidPeriod, status: 'active', graceUntil: null });
        }
      }
    }
  }
  const payments = await input.repo.payments.list(input.customerId ? { customerId: input.customerId } : undefined);
  const results: CsCase[] = [...reconciledCases];
  for (const payment of payments) {
    if ((input.since && payment.occurredAt < input.since) || payment.kind === 'overage') continue;
    if (rawField(payment.raw, 'boilpaymentTrialOpeningInvoice') === true) continue;
    if (await isZeroSaleHandled(input.repo, payment.id)) continue; // DC-07 — a person already has the case
    // EC:A46 — a declined charge bought nothing, and a self-scheduled attempt still pending belongs to
    // the scheduler (EC:A36 A38): neither is a missing grant.
    if (payment.status === 'failed') continue;
    // OT-09 — a payment held for its registration is not a missing grant; only the registration-hold
    // path (reconcile, after the window) opens the single case for it.
    if (await input.repo.operations.get(`checkout-payment-held:${payment.id}`)
      && !(await input.repo.operations.get(`purchase-entitlement:${payment.id}`))) continue;
    if (payment.status === 'pending' && (payment.raw as { boilpaymentAttemptKey?: unknown } | undefined)?.boilpaymentAttemptKey) continue;
    const entries = await input.ledger.entries(payment.customerId, { kind: 'grant' });
    if (entries.some((entry) => entry.reference.paymentId === payment.id)) continue;
    if (await input.repo.csCases.get(`reconcile_mismatch:${payment.id}`)) continue;
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
