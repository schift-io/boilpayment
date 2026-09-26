// EC:L5 — see spec/webhook.pseudo.md [EC:L5]. Two small helpers that thread one webhook
// delivery's correlationId through the rest of the pipeline WITHOUT touching the `PaymentProvider`
// interface or the lifecycle/credits/refund/cs packages' own call signatures:
//   - `mintCorrelationId(providerEventId)` — deterministic, so a redelivery of the same event
//     produces the same id (EC:E5 dedupe already relies on the event id being stable; reusing it
//     for correlationId keeps replay-safety free).
//   - `withCorrelationId(ledger, id)` — wraps a `LedgerStore` so every `.append()`/`.consume()`
//     call made THROUGH this wrapper (by lifecycle/credits/refund/cs, which webhook's own
//     defaultHandlers() constructs deps for) gets `correlationId` merged into the entry's
//     `reference`/`meta` — without lifecycle/credits/refund/cs ever knowing correlationId exists.
import type { Balance, ConsumeInput, ConsumeResult, LedgerEntry, LedgerKind, LedgerSource, LedgerStore, NewLedgerEntry, Pool } from '@schift/payment-kit-core';

/** EC:L5 — `corr_{providerEventId}`. Deterministic across redeliveries of the same webhook event. */
export function mintCorrelationId(providerEventId: string): string {
  return `corr_${providerEventId}`;
}

/** EC:L5 — see module doc comment above. Never overwrites a correlationId a caller already set. */
export function withCorrelationId(ledger: LedgerStore, correlationId: string): LedgerStore {
  return {
    append(entry: NewLedgerEntry): Promise<{ entry: LedgerEntry; duplicated: boolean }> {
      return ledger.append({
        ...entry,
        reference: { ...entry.reference, correlationId: entry.reference?.correlationId ?? correlationId },
      });
    },
    balance(customerId: string, pool: Pool | undefined, now: Date): Promise<Balance> {
      return ledger.balance(customerId, pool, now);
    },
    entries(customerId: string, filter?: { pool?: Pool; kind?: LedgerKind; since?: Date; source?: LedgerSource }): Promise<LedgerEntry[]> {
      return ledger.entries(customerId, filter);
    },
    consume(input: ConsumeInput): Promise<ConsumeResult> {
      return ledger.consume({
        ...input,
        meta: { ...input.meta, correlationId: input.meta?.correlationId ?? correlationId },
      });
    },
    transaction<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
      return ledger.transaction(customerId, fn);
    },
  };
}
