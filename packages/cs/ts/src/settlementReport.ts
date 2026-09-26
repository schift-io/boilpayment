// EC:I10 — monthly settlement report. spec/cs.pseudo.md. Read-only: it never writes.
//
// One call answers "what did we charge, refund, grant and consume in this window" for accounting,
// tax invoices and reconciliation against the provider's own payout report. Money is grouped by
// currency (never summed across currencies); credits are grouped by ledger kind and source.
import type { LedgerKind, LedgerSource, LedgerStore, PaymentKind, PaymentStatus, Repo } from 'boilpayment-core';

export interface SettlementReportInput {
  repo: Repo;
  ledger: LedgerStore;
  /** Inclusive start of the window (e.g. the first instant of a month in your accounting timezone). */
  from: Date;
  /** Exclusive end of the window. */
  to: Date;
}

export interface PaymentLine { currency: string; kind: PaymentKind; status: PaymentStatus; count: number; amountMinor: number }
export interface RefundLine { currency: string; count: number; amountMinor: number }
export interface CreditLine { kind: LedgerKind; source: LedgerSource; count: number; amount: number }

export interface SettlementReport {
  from: Date;
  to: Date;
  /** Payments by occurredAt in the window. */
  payments: PaymentLine[];
  /** Succeeded refunds by createdAt in the window. */
  refunds: RefundLine[];
  /** Net per currency: succeeded + partially_refunded payments minus succeeded refunds, both in the window. */
  net: { currency: string; amountMinor: number }[];
  /** Ledger rows by createdAt in the window (signed amounts: grants +, consume/revoke/expire −). */
  credits: CreditLine[];
}

const inWindow = (d: Date, from: Date, to: Date) => d.getTime() >= from.getTime() && d.getTime() < to.getTime();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** EC:I10 — aggregate payments, refunds and ledger movements in [from, to). */
export async function settlementReport(input: SettlementReportInput): Promise<SettlementReport> {
  const { repo, ledger, from, to } = input;
  if (!(from.getTime() < to.getTime())) throw new Error('settlementReport: from must be before to');

  const payments = new Map<string, PaymentLine>();
  for (const p of await repo.payments.list()) {
    if (!inWindow(p.occurredAt, from, to)) continue;
    const k = `${p.amount.currency}|${p.kind}|${p.status}`;
    const line = payments.get(k) ?? { currency: p.amount.currency, kind: p.kind, status: p.status, count: 0, amountMinor: 0 };
    line.count += 1;
    line.amountMinor += p.amount.amountMinor;
    payments.set(k, line);
  }

  const refunds = new Map<string, RefundLine>();
  for (const r of await repo.refunds.list()) {
    if (r.status !== 'succeeded' || !inWindow(r.createdAt, from, to)) continue;
    const line = refunds.get(r.amount.currency) ?? { currency: r.amount.currency, count: 0, amountMinor: 0 };
    line.count += 1;
    line.amountMinor += r.amount.amountMinor;
    refunds.set(r.amount.currency, line);
  }

  const net = new Map<string, number>();
  for (const l of payments.values()) {
    if (l.status === 'succeeded' || l.status === 'partially_refunded') net.set(l.currency, (net.get(l.currency) ?? 0) + l.amountMinor);
  }
  for (const r of refunds.values()) net.set(r.currency, (net.get(r.currency) ?? 0) - r.amountMinor);

  const credits = new Map<string, CreditLine>();
  for (const c of await repo.customers.list()) {
    for (const e of await ledger.entries(c.id, { since: from })) {
      if (!inWindow(e.createdAt, from, to)) continue;
      const k = `${e.kind}|${e.source}`;
      const line = credits.get(k) ?? { kind: e.kind, source: e.source, count: 0, amount: 0 };
      line.count += 1;
      line.amount += e.amount;
      credits.set(k, line);
    }
  }

  return {
    from,
    to,
    payments: [...payments.values()].sort((a, b) => cmp(a.currency, b.currency) || cmp(a.kind, b.kind) || cmp(a.status, b.status)),
    refunds: [...refunds.values()].sort((a, b) => cmp(a.currency, b.currency)),
    net: [...net.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor })).sort((a, b) => cmp(a.currency, b.currency)),
    credits: [...credits.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.source, b.source)),
  };
}
