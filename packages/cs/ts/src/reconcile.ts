// spec/cs.pseudo.md — EC:E1 H4
import { PaymentKitError, deserializeCsCase, keyMatchesInstant, runIdempotent, serializeCsCase } from 'boilpayment-core';
import type { Clock, CsCase, IdGen, LedgerStore, PaymentProvider, Policy, ProviderName, Repo } from 'boilpayment-core';
import { escalate, openCase } from './cases.js';
import type { OnCaseEvent } from './cases.js';

export interface ReconcileInput {
  customerId?: string | null;
  providers: Partial<Record<ProviderName, PaymentProvider>>;
  ledger: LedgerStore;
  repo: Repo;
  policy: Policy;
  clock: Clock;
  ids: IdGen;
  since: Date;
  onCaseEvent?: OnCaseEvent;
  /** Hours a payment may remain held before human review. Defaults to 24. */
  registrationHoldHours?: number;
}

function heldPayment(value: unknown): { readonly paymentId: string; readonly customerId: string; readonly receivedAt: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('paymentId' in value) || typeof value.paymentId !== 'string'
    || !('customerId' in value) || typeof value.customerId !== 'string'
    || !('receivedAt' in value) || typeof value.receivedAt !== 'string') return null;
  return { paymentId: value.paymentId, customerId: value.customerId, receivedAt: value.receivedAt };
}

async function reconcileRegistrationHolds(input: ReconcileInput): Promise<CsCase[]> {
  const hours = input.registrationHoldHours ?? 24;
  if (!Number.isFinite(hours) || hours < 0) throw new PaymentKitError('registration hold window must be non-negative', 'registration_hold_window_invalid');
  const cases: CsCase[] = [];
  for (const operation of await input.repo.operations.list({ kind: 'checkout.paymentHeld' })) {
    if (operation.status !== 'done') continue;
    const held = heldPayment(operation.result);
    if (!held || (input.customerId && held.customerId !== input.customerId)
      || await input.repo.operations.get(`purchase-entitlement:${held.paymentId}`)) continue;
    const receivedAt = new Date(held.receivedAt);
    if (!Number.isFinite(receivedAt.getTime()) || input.clock.now().getTime() - receivedAt.getTime() < hours * 3_600_000) continue;
    const { result } = await runIdempotent({
      repo: input.repo, clock: input.clock, key: `registration-hold-case:${held.paymentId}`, kind: 'cs.supportCase',
      payload: { paymentId: held.paymentId, customerId: held.customerId }, serialize: serializeCsCase, deserialize: deserializeCsCase,
      fn: async () => escalate({
        case: await openCase({ customerId: held.customerId, kind: 'reconcile_mismatch', referenceId: held.paymentId,
          policy: input.policy, repo: input.repo, clock: input.clock, ids: input.ids, onCaseEvent: input.onCaseEvent }),
        reason: 'payment checkout registration is still missing', repo: input.repo, clock: input.clock, onCaseEvent: input.onCaseEvent,
      }),
    });
    cases.push(result);
  }
  return cases;
}

/** EC:E1 — cs.reconcile({customerId?, providers, ledger, repo, policy, clock, ids, since}) -> CsCase[] */
export async function reconcile(input: ReconcileInput): Promise<CsCase[]> {
  const { customerId, providers, ledger, repo, policy, clock, ids, since, onCaseEvent } = input;
  const customers = customerId
    ? [await repo.customers.get(customerId)].filter((c): c is NonNullable<typeof c> => c !== null)
    : await repo.customers.list();

  const cases: CsCase[] = await reconcileRegistrationHolds(input);
  for (const customer of customers) {
    for (const pref of customer.providerRefs) {
      const provider = providers[pref.provider];
      if (!provider) continue;
      const payments = await provider.listPayments({ customerRef: pref.ref, since });
      for (const payment of payments) {
        if (payment.status !== 'succeeded') continue;
        let grantKey: string;
        if (payment.kind === 'subscription') {
          if (!payment.period) continue;
          grantKey = `grant:${payment.subscriptionId}:${payment.period.start.toISOString()}`;
        } else if (payment.kind === 'topup') {
          grantKey = `topup:${payment.id}`;
        } else {
          continue; // overage payments aren't grant-backed
        }
        const grantEntries = await ledger.entries(customer.id, { kind: 'grant' });
        const found = grantEntries.some((e) => e.idempotencyKey === grantKey
          || (payment.kind === 'subscription' && payment.period && keyMatchesInstant(e.idempotencyKey, `grant:${payment.subscriptionId}:`, payment.period.start)));
        if (!found) {
          const csCase = await openCase({ customerId: customer.id, kind: 'regrant', referenceId: grantKey, policy, repo, clock, ids, onCaseEvent });
          cases.push(csCase);
        }
      }
    }
  }
  return cases;
}

export interface BalanceMismatch { customerId: string; ledger: number; snapshot: number }

/**
 * EC:H4 — optional balance cross-check. The core `Repo` contract (fixed; not owned by this package)
 * has no `credit_balances` snapshot table, so this only activates if the concrete `repo` passed in
 * happens to expose one (duck-typed via `repo.creditBalances`); otherwise it's a documented no-op.
 * See final report "계약 변경 제안".
 */
export async function checkBalances(input: { ledger: LedgerStore; repo: Repo; customerIds?: string[]; clock: Clock }): Promise<BalanceMismatch[]> {
  const snapshotTable = (input.repo as unknown as { creditBalances?: { get(id: string): Promise<{ available: number } | null> } }).creditBalances;
  if (!snapshotTable) return [];
  const ids = input.customerIds ?? (await input.repo.customers.list()).map((c) => c.id);
  const mismatches: BalanceMismatch[] = [];
  for (const customerId of ids) {
    const live = (await input.ledger.balance(customerId, 'paid', input.clock.now())).available; // thread injected clock (FINDINGS#1 class) — now required by LedgerStore.balance
    const snap = await snapshotTable.get(customerId);
    if (snap && snap.available !== live) mismatches.push({ customerId, ledger: live, snapshot: snap.available });
  }
  return mismatches;
}
