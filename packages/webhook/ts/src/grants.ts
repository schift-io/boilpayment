// EC:E13 — see spec/webhook.pseudo.md
import type { LedgerEntry, LedgerStore, Payment, Repo } from 'boilpayment-core';

export interface GetGrantsForCheckoutInput {
  checkoutIdOrPaymentRef: string;
  repo: Repo;
  ledger: LedgerStore;
}
export interface GetGrantsForCheckoutResult {
  ready: boolean;
  customerId?: string;
  entries?: LedgerEntry[];
}

export async function getGrantsForCheckout(input: GetGrantsForCheckoutInput): Promise<GetGrantsForCheckoutResult> {
  const { checkoutIdOrPaymentRef, repo, ledger } = input;
  const payments = await repo.payments.list({ providerRef: checkoutIdOrPaymentRef } as Partial<Payment>);
  if (payments.length === 0) return { ready: false };
  const payment = payments[0];
  if (payment.status !== 'succeeded') return { ready: false };

  const allEntries = await ledger.entries(payment.customerId, { since: payment.occurredAt });
  const grantEntries = allEntries.filter((e) => e.reference.paymentId === payment.id);
  return { ready: true, customerId: payment.customerId, entries: grantEntries };
}
