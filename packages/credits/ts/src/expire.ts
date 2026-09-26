// spec: packages/credits/spec/credits.pseudo.md — EC:B14
import { Clock, LedgerEntry, LedgerStore } from '@schift/payment-kit-core';

export interface ExpireDueInput {
  ledger: LedgerStore;
  clock: Clock;
  customerId: string;
}

export interface ExpireDueResult {
  entries: LedgerEntry[];
}

// EC:B14 — writes bookkeeping 'expire' entries for grants whose expiresAt <= now. Balances are
// already computed excluding these (ledger.consume/balance filter by expiresAt > now); this is a
// cleanup batch, not a balance-affecting operation.
export async function expireDue(input: ExpireDueInput): Promise<ExpireDueResult> {
  const { ledger, clock, customerId } = input;
  const now = clock.now();
  const all = await ledger.entries(customerId);
  const dueGrants = all.filter((e) => e.kind === 'grant' && e.expiresAt !== null && e.expiresAt <= now);

  const entries: LedgerEntry[] = [];
  for (const g of dueGrants) {
    const used = all
      .filter((e) => (e.kind === 'consume' || e.kind === 'revoke') && e.reference.grantId === g.id)
      .reduce((sum, e) => sum + e.amount, 0);
    const remaining = Math.max(0, g.amount + used);
    if (remaining <= 0) continue;

    const { entry } = await ledger.append({
      customerId,
      pool: g.pool,
      kind: 'expire',
      amount: -remaining,
      unitPriceMinor: g.unitPriceMinor,
      currency: g.currency,
      expiresAt: null,
      source: g.source,
      reference: { ...g.reference, grantId: g.id },
      idempotencyKey: `expire:${g.id}`,
      actor: 'system',
      reason: null,
    });
    entries.push(entry);
  }
  return { entries };
}
