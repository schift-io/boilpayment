// spec/cs.pseudo.md — EC:H5
//
// GDPR / 개인정보보호법 data-portability export. One JSON-serializable snapshot of everything the
// kit knows about a customer, built purely against the `Repo`/`LedgerStore` interfaces (works on
// InMemory and Postgres alike — no schema assumptions beyond the core contract).
//
// Relationship to EC:H2 (deletion vs 전자상거래법 5-year retention): this function only READS and
// never deletes anything. H2's answer (anonymize `customers` PII, keep the ledger) is unaffected —
// export is always safe to run; deletion is a separate, harder decision this function does not make.
import { Clock, LedgerStore, Payment, Refund, Repo, Subscription, UsageEvent, redact } from '@schift/payment-kit-core';
import { timeline, TimelineResult } from './timeline.js';

export interface ExportCustomerInput {
  customerId: string;
  repo: Repo;
  ledger: LedgerStore;
  clock: Clock;
  /**
   * Default true — every field is passed through `@schift/payment-kit-core` `redact()` before
   * being returned, so card numbers / 주민번호 / API secrets never leave the kit in the clear.
   * Pass `false` ONLY when legally answering a subject access request that requires the raw
   * values — never as a default, never for anything other than that request.
   */
  redact?: boolean;
}

export interface CustomerExport {
  schemaVersion: 1;
  generatedAt: string; // ISO
  customerId: string;
  redacted: boolean;
  customer: unknown;
  subscriptions: unknown[];
  payments: unknown[];
  ledgerEntries: unknown[];
  usageEvents: unknown[];
  refunds: unknown[];
  csCases: unknown[];
  timeline: TimelineResult;
}

/** Recursively turns every `Date` into an ISO string so the result is plain-JSON round-trippable. */
function toJsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

/**
 * EC:H5 — cs.exportCustomer({customerId, repo, ledger, clock, redact?}) -> CustomerExport
 * A single JSON-serializable object covering the customer row, subscriptions, payments, ledger
 * entries, usage events, refunds, cs cases, and the reconstructed timeline (EC:I9, reused as-is).
 */
export async function exportCustomer(input: ExportCustomerInput): Promise<CustomerExport> {
  const { customerId, repo, ledger, clock } = input;
  const shouldRedact = input.redact !== false;

  const customer = await repo.customers.get(customerId);
  const subscriptions = await repo.subscriptions.list({ customerId } as Partial<Subscription>);
  const payments = await repo.payments.list({ customerId } as Partial<Payment>);
  const ledgerEntries = await ledger.entries(customerId);
  const usageEvents = await repo.usageEvents.list({ customerId } as Partial<UsageEvent>);
  const refunds = await repo.refunds.list({ customerId } as Partial<Refund>);
  const csCases = await repo.csCases.list({ customerId });
  const tl = await timeline({ customerId, repo, ledger, clock });

  const raw = {
    schemaVersion: 1 as const,
    generatedAt: clock.now(),
    customerId,
    redacted: shouldRedact,
    customer,
    subscriptions,
    payments,
    ledgerEntries,
    usageEvents,
    refunds,
    csCases,
    timeline: tl,
  };

  const shaped = shouldRedact ? redact(raw) : raw;
  return toJsonSafe(shaped) as CustomerExport;
}
