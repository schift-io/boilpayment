// spec/cs.pseudo.md — EC:E1 H4
import { Clock, CsCase, IdGen, LedgerStore, PaymentProvider, Policy, ProviderName, Repo } from '@schift/payment-kit-core';
import { openCase, OnCaseEvent } from './cases.js';

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
}

/** EC:E1 — cs.reconcile({customerId?, providers, ledger, repo, policy, clock, ids, since}) -> CsCase[] */
export async function reconcile(input: ReconcileInput): Promise<CsCase[]> {
  const { customerId, providers, ledger, repo, policy, clock, ids, since, onCaseEvent } = input;
  const customers = customerId
    ? [await repo.customers.get(customerId)].filter((c): c is NonNullable<typeof c> => c !== null)
    : await repo.customers.list();

  const cases: CsCase[] = [];
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
        const found = grantEntries.some((e) => e.idempotencyKey === grantKey);
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
