// spec/cs.pseudo.md — EC:B11 D9
import { Clock, CsCase, IdGen, LedgerStore, NormalizedEvent, Notifier, PaymentKitError, PaymentProvider, Policy, Repo, Subscription } from 'boilpayment-core';
import { escalate, OnCaseEvent, openCase, resolve } from './cases.js';
import { LicenseReporter } from './metrics.js';

export interface DisputeInput {
  event: NormalizedEvent;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  notifier: Notifier;
  clock: Clock;
  ids: IdGen;
  onCaseEvent?: OnCaseEvent;
  /** EC:I5 — reports the resulting resolved_human transition (dispute.closed) to the license server. */
  reporter?: LicenseReporter | null;
  /** EC:L5 — optional delivery-scoped id, merged into `reference.correlationId` on every
   *  revoke/restore entry this call writes. */
  correlationId?: string;
  /** EC:A66 — the provider the event came from: a banned customer's subscriptions with it are canceled there too. */
  provider?: PaymentProvider;
}

/**
 * EC:B11 D9 — revoke the credits this payment granted, attributed per grant bucket so the ledger,
 * expiry (B14) and a later restore can all see which bucket each unit came from. Idempotent: the
 * per-bucket keys make a second call a no-op, so `dispute.opened` and a later `lost` close can both
 * call it safely. Returns the amount revoked by this call.
 */
async function revokeDisputedGrants(opts: {
  ledger: LedgerStore; customerId: string; paymentId: string; caseId: string; correlationId?: string;
}): Promise<number> {
  const { ledger, customerId, paymentId, caseId, correlationId } = opts;
  const all = await ledger.entries(customerId, { pool: 'paid' });
  const grants = all.filter((e) => e.kind === 'grant' && e.reference.paymentId === paymentId);
  const totalGranted = grants.reduce((sum, g) => sum + g.amount, 0);
  const alreadyRevoked = all
    .filter((e) => e.kind === 'revoke' && e.source === 'dispute' && e.reference.caseId === caseId)
    .reduce((sum, e) => sum + -e.amount, 0);
  let left = Math.max(0, totalGranted - alreadyRevoked);
  if (left <= 0) return 0;

  let revoked = 0;
  for (const g of grants) {
    if (left <= 0) break;
    const used = all
      .filter((e) => e.kind !== 'grant' && e.reference.grantId === g.id)
      .reduce((sum, e) => sum + e.amount, 0);
    const take = Math.min(Math.max(0, g.amount + used), left);
    if (take <= 0) continue;
    const { duplicated } = await ledger.append({
      customerId, pool: 'paid', kind: 'revoke', amount: -take, source: 'dispute',
      reference: { paymentId, caseId, grantId: g.id, ...(correlationId ? { correlationId } : {}) }, idempotencyKey: `revoke:dispute:${caseId}:${g.id}`,
      actor: 'system', reason: 'B11 dispute', unitPriceMinor: g.unitPriceMinor, currency: g.currency, expiresAt: null,
    });
    if (!duplicated) revoked += take;
    left -= take;
  }
  if (left > 0) {
    // The customer already spent these credits; the chargeback still takes the money back, so the
    // remainder is revoked unattributed and the balance may go negative (merchant eats the loss).
    const { duplicated } = await ledger.append({
      customerId, pool: 'paid', kind: 'revoke', amount: -left, source: 'dispute',
      reference: { paymentId, caseId, ...(correlationId ? { correlationId } : {}) }, idempotencyKey: `revoke:dispute:${caseId}`,
      actor: 'system', reason: 'B11 dispute (spent remainder)', unitPriceMinor: null, currency: null, expiresAt: null,
    });
    if (!duplicated) revoked += left;
  }
  return revoked;
}

/**
 * EC:D9 — the merchant WON the dispute: the charge stands, so every credit revoked for this case
 * must come back. Restoration is not a policy choice — keeping the money and the credits would be
 * charging the customer twice. Each restored bucket keeps the ORIGINAL grant's expiry, so credits
 * that would have lapsed during the dispute stay lapsed. Idempotent by `restore:dispute:{caseId}:*`.
 */
async function restoreDisputedGrants(opts: {
  ledger: LedgerStore; customerId: string; caseId: string; correlationId?: string;
}): Promise<number> {
  const { ledger, customerId, caseId, correlationId } = opts;
  const all = await ledger.entries(customerId, { pool: 'paid' });
  const revokes = all.filter((e) => e.kind === 'revoke' && e.source === 'dispute' && e.reference.caseId === caseId);
  let restored = 0;
  for (const r of revokes) {
    const amount = -r.amount;
    if (amount <= 0) continue;
    const origin = r.reference.grantId ? all.find((e) => e.id === r.reference.grantId) : undefined;
    const suffix = r.reference.grantId ?? 'remainder';
    const { duplicated } = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount, source: 'dispute',
      reference: { paymentId: r.reference.paymentId, caseId, grantId: r.reference.grantId, ...(correlationId ? { correlationId } : {}) },
      idempotencyKey: `restore:dispute:${caseId}:${suffix}`,
      actor: 'system', reason: 'D9 dispute won — restoring revoked credits',
      unitPriceMinor: origin?.unitPriceMinor ?? r.unitPriceMinor ?? null,
      currency: origin?.currency ?? r.currency ?? null,
      expiresAt: origin?.expiresAt ?? null,
    });
    if (!duplicated) restored += amount;
  }
  return restored;
}

/** EC:B11 D9 — cs.dispute({event, policy, ledger, repo, notifier}) -> CsCase */
export async function dispute(input: DisputeInput): Promise<CsCase> {
  const { event, policy, ledger, repo, notifier, clock, ids, onCaseEvent, reporter, correlationId } = input;

  if (event.type === 'dispute.opened') {
    const payments = event.paymentRef ? await repo.payments.list({ providerRef: event.paymentRef }) : [];
    const payment = payments[0] ?? null;
    // EC:E24 — the local customer: the payment's, else the one holding this provider customer ref.
    const customerId = payment?.customerId ?? await localCustomerId(repo, event);
    if (!customerId) throw new PaymentKitError('dispute names no local payment or customer', 'unmatched_dispute');
    const csCase = await openCase({ customerId, kind: 'dispute', referenceId: event.paymentRef ?? event.id, policy, repo, clock, ids, onCaseEvent });

    const onOpen = policy.dispute.onOpen;
    if (onOpen === 'freeze_customer') {
      const customer = await repo.customers.get(customerId);
      if (customer) { customer.status = 'frozen'; await repo.customers.put(customer); } // B11
    } else if (onOpen === 'revoke_disputed_grant' && payment) {
      await revokeDisputedGrants({ ledger, customerId, paymentId: payment.id, caseId: csCase.id, correlationId });
    }
    // onOpen === 'none' -> no side effect

    return escalate({ case: csCase, repo, clock, notifier, reason: 'dispute opened', onCaseEvent });
  }

  if (event.type === 'dispute.closed') {
    const referenceId = event.paymentRef ?? event.id;
    const existing = await repo.csCases.list({ kind: 'dispute', referenceId });
    const closedCustomer = existing[0] ? null : await localCustomerId(repo, event);
    if (!existing[0] && !closedCustomer) throw new PaymentKitError('dispute names no local payment or customer', 'unmatched_dispute');
    const csCase = existing[0] ?? await openCase({ customerId: closedCustomer!, kind: 'dispute', referenceId, policy, repo, clock, ids, onCaseEvent });

    const outcome = disputeOutcome(event);
    const customer = await repo.customers.get(csCase.customerId);

    const disputedPayments = event.paymentRef ? await repo.payments.list({ providerRef: event.paymentRef }) : [];
    const disputedPayment = disputedPayments[0] ?? null;

    if (outcome === 'lost') {
      // EC:D9 — BOTH onLost values revoke: the card network took the money back, so the credits must
      // go too. Whether it already happened at dispute.opened depends on policy.dispute.onOpen, so
      // call the (idempotent) revoke here as well — otherwise `revoke_only` revokes nothing whenever
      // onOpen was 'freeze_customer' or 'none', which is what its name promises.
      const revoked = disputedPayment
        ? await revokeDisputedGrants({ ledger, customerId: csCase.customerId, paymentId: disputedPayment.id, caseId: csCase.id, correlationId })
        : 0;
      if (policy.dispute.onLost === 'revoke_and_ban' && customer) {
        customer.status = 'banned';
        await repo.customers.put(customer);
        await endBannedSubscriptions({ repo, notifier, provider: input.provider, customerId: customer.id });
      }
      return resolve({ case: csCase, by: 'human', decision: { outcome: 'lost', revoked }, repo, clock, onCaseEvent, reporter });
    }

    if (outcome !== 'won') {
      // EC:D21 — the provider closed the dispute without saying who won (PortOne, Stripe
      // warning_closed, a caller without the field). Neither restore nor revoke on a guess: the
      // customer stays as dispute.opened left them and a person decides.
      return escalate({ case: csCase, repo, clock, notifier, reason: 'dispute closed without a verdict', onCaseEvent });
    }

    // EC:D9 — won: the charge stands, so give back every credit this dispute revoked and lift the freeze.
    const restored = await restoreDisputedGrants({ ledger, customerId: csCase.customerId, caseId: csCase.id, correlationId });
    if (customer && customer.status === 'frozen') {
      customer.status = 'active';
      await repo.customers.put(customer);
    }
    return resolve({ case: csCase, by: 'human', decision: { outcome, restored }, repo, clock, onCaseEvent, reporter });
  }

  throw new Error(`cs.dispute: unsupported event type '${event.type}'`);
}

/** EC:D21 — the verdict of a closed dispute: the adapter's `disputeOutcome`, else `raw.outcome` (a
 *  caller building the event by hand). Anything but won/lost is no verdict. */
function disputeOutcome(event: NormalizedEvent): 'won' | 'lost' | null {
  if (event.disputeOutcome === 'won' || event.disputeOutcome === 'lost') return event.disputeOutcome;
  const raw = event.raw as { outcome?: unknown } | null | undefined;
  const fromRaw = raw && typeof raw === 'object' ? raw.outcome : undefined;
  return fromRaw === 'won' || fromRaw === 'lost' ? fromRaw : null;
}

/** EC:E24 — the local customer for a provider event: via the disputed payment, else the provider customer ref. */
async function localCustomerId(repo: DisputeInput['repo'], event: DisputeInput['event']): Promise<string | null> {
  if (event.paymentRef) {
    const [p] = await repo.payments.list({ providerRef: event.paymentRef });
    if (p) return p.customerId;
  }
  if (!event.customerRef) return null;
  const match = (await repo.customers.list()).find((c) => c.providerRefs.some((r) => r.provider === event.provider && r.ref === event.customerRef));
  if (match) return match.id;
  // A caller that already holds the local customer id may pass it as customerRef.
  return (await repo.customers.get(event.customerRef))?.id ?? null;
}

const LIVE: ReadonlySet<Subscription['status']> = new Set(['active', 'past_due', 'trialing', 'paused', 'incomplete']);

/**
 * EC:A66 — a banned customer is not billed or granted again: every live subscription ends now (the
 * scheduler never charges a canceled one). A native subscription is canceled at the provider when it is
 * the provider this event came from; otherwise, or when that call fails, a person is told to cancel it.
 */
async function endBannedSubscriptions(opts: { repo: Repo; notifier: Notifier; provider?: PaymentProvider; customerId: string }): Promise<void> {
  const { repo, notifier, provider, customerId } = opts;
  for (const listed of await repo.subscriptions.list({ customerId })) {
    if (!LIVE.has(listed.status)) continue;
    let providerCanceled = listed.providerRef === null; // self-scheduled: ending it here stops the charges
    if (listed.providerRef !== null && provider && provider.name === listed.provider && provider.capabilities().nativeSubscriptions) {
      try {
        await provider.cancelSubscription(listed.providerRef, { atPeriodEnd: false });
        providerCanceled = true;
      } catch {
        providerCanceled = false;
      }
    }
    for (let i = 0; i < 5; i++) {
      const fresh = await repo.subscriptions.get(listed.id);
      if (!fresh || !LIVE.has(fresh.status)) break;
      try {
        await repo.subscriptions.put({ ...fresh, status: 'canceled', cancelAtPeriodEnd: false, graceUntil: null });
        break;
      } catch (err) {
        if (!(err instanceof PaymentKitError && err.code === 'subscription_version_conflict') || i === 4) throw err;
      }
    }
    if (!providerCanceled) {
      await notifier.send({ type: 'cs.needs_human', customerId, payload: {
        kind: 'banned_customer_subscription', subscriptionId: listed.id, provider: listed.provider, providerRef: listed.providerRef } });
    }
  }
}
