import { PaymentKitError } from 'boilpayment-core';
import type { Clock, LedgerStore, Money, Payment, PaymentProvider, Period, Policy, Repo, Subscription } from 'boilpayment-core';
import { prepareSettlement } from './prepareSettlement.js';
import { reportPeriod } from './reportPeriod.js';

export interface SettlePeriodInput {
  readonly sub: Subscription;
  readonly period: Period;
  readonly policy: Policy;
  readonly repo: Repo;
  readonly ledger: LedgerStore;
  readonly provider: PaymentProvider;
  readonly clock: Clock;
  readonly currency?: string;
}
export interface SettlePeriodResult {
  readonly status: 'not_due' | 'unchanged' | 'charged' | 'pending' | 'failed' | 'awaiting_provider_billing' | 'report_pending' | 'report_failed';
  readonly total: number;
  readonly chargedAmount: Money | null;
  readonly payment: Payment | null;
}

/** Prepare/commit, call provider outside the transaction, then atomically finalize. */
export async function settlePeriod(input: SettlePeriodInput): Promise<SettlePeriodResult> {
  const { sub, period, repo, provider, clock, ledger } = input;
  if (period.end <= period.start) throw new PaymentKitError('Invalid usage period', 'invalid_usage_period');
  if (clock.now() < period.end) return { status: 'not_due', total: 0, chargedAmount: null, payment: null };
  const prepared = await ledger.transaction(sub.customerId, () => prepareSettlement(input));
  switch (prepared.kind) {
    case 'result': return prepared.result;
    case 'report': return { status: await reportPeriod({ sub, events: prepared.events, repo, provider, clock }), total: prepared.total, chargedAmount: null, payment: null };
    case 'charge': break;
    default: { const unreachable: never = prepared; throw new PaymentKitError('Unknown settlement action', 'usage_settlement_corrupt', unreachable); }
  }
  const { operation, payment, total } = prepared;
  // No database transaction encloses provider I/O: unknown outcomes cannot erase intent.
  const response = payment.providerRef !== `unresolved:${operation.key}`
    ? await provider.getPayment(payment.providerRef)
    : await provider.chargeBillingKey({ billingKey: prepared.billingKey, amount: payment.amount, orderId: operation.key, customerRef: prepared.customerRef, idempotencyKey: operation.key });
  if (response.provider !== provider.name || response.amount.currency !== payment.amount.currency || response.amount.amountMinor !== payment.amount.amountMinor || !response.providerRef) throw new PaymentKitError('Provider charge does not match the durable request', 'usage_charge_unresolved');
  return ledger.transaction(sub.customerId, async () => {
    const current = await repo.operations.get(operation.key);
    if (current?.status === 'done') return { status: 'unchanged', total, chargedAmount: null, payment: await repo.payments.get(operation.key) };
    const saved = await repo.payments.put({ ...response, id: operation.key, customerId: sub.customerId, subscriptionId: sub.id, kind: 'overage', period });
    switch (saved.status) {
      case 'succeeded':
      case 'failed': {
        const paid = saved.status === 'succeeded';
        await repo.operations.put({ ...operation, status: paid ? 'done' : 'failed', error: paid ? null : saved.failure?.code ?? 'payment_failed', completedAt: clock.now() });
        const claim = await repo.outbox.get(operation.key);
        if (!claim) throw new PaymentKitError('Settlement retry lease is missing', 'usage_settlement_corrupt');
        await repo.outbox.put({ ...claim, status: paid ? 'sent' : 'failed' });
        return { status: paid ? 'charged' : 'failed', total, chargedAmount: paid ? saved.amount : null, payment: saved };
      }
      case 'pending': case 'requires_action': case 'refunded': case 'partially_refunded': case 'disputed':
        return { status: 'pending', total, chargedAmount: null, payment: saved };
      default: { const unreachable: never = saved.status; throw new PaymentKitError('Unknown charge status', 'usage_charge_unresolved', unreachable); }
    }
  });
}
