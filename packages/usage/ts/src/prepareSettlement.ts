import { hashPayload, PaymentKitError } from 'boilpayment-core';
import type { Operation, Payment, UsageEvent } from 'boilpayment-core';
import { billingCurrency } from './billingCurrency.js';
import { settlementPeriod } from './settlementPeriod.js';
import type { SettlePeriodInput, SettlePeriodResult } from './settlePeriod.js';

export type PreparedSettlement =
  | { readonly kind: 'result'; readonly result: SettlePeriodResult }
  | { readonly kind: 'report'; readonly events: UsageEvent[]; readonly total: number }
  | { readonly kind: 'charge'; readonly operation: Operation; readonly payment: Payment; readonly customerRef: string; readonly billingKey: string; readonly total: number };

/** Commit an immutable request and a five-minute retry lease before any provider I/O. */
export async function prepareSettlement(input: SettlePeriodInput): Promise<PreparedSettlement> {
  const { sub, period, policy, repo, provider, clock } = input;
  const snapshotCurrency = await settlementPeriod(repo, sub, period);
  const events = (await repo.usageEvents.list({ customerId: sub.customerId })).filter((event) => event.periodStart.getTime() === period.start.getTime());
  const total = events.reduce((sum, event) => sum + event.quantity, 0);
  if (events.some((event) => !Number.isSafeInteger(event.quantity) || event.quantity < 0) || !Number.isSafeInteger(total)) throw new PaymentKitError('Invalid usage quantity', 'invalid_usage_quantity');
  const unchanged: PreparedSettlement = { kind: 'result', result: { status: 'unchanged', total, chargedAmount: null, payment: null } };
  const kind = `usage.settle:${sub.id}:${period.start.getTime()}`;
  const operations = await repo.operations.list({ kind });
  if (!operations.length && (policy.usage.overage !== 'bill_overage' || policy.usage.creditConversion || total <= policy.usage.includedQuantity)) return unchanged;
  if (provider.capabilities().meters && !operations.length) return { kind: 'report', events, total };
  const unitPrice = policy.usage.overageUnitPriceMinor;
  if (policy.usage.overage !== 'bill_overage' || policy.usage.creditConversion || unitPrice === null || !Number.isSafeInteger(unitPrice) || unitPrice < 0) throw new PaymentKitError('Usage settlement requires configured overage pricing', 'usage_billing_policy_changed');
  if (snapshotCurrency && input.currency && snapshotCurrency !== input.currency) throw new PaymentKitError('Currency differs from original payment', 'billing_currency_required');
  const currency = await billingCurrency(repo, sub.planId, snapshotCurrency ?? input.currency);
  const targetAmount = Math.max(0, total - policy.usage.includedQuantity) * unitPrice;
  if (!Number.isSafeInteger(targetAmount)) throw new PaymentKitError('Usage amount exceeds safe integer range', 'invalid_usage_quantity');
  const customer = await repo.customers.get(sub.customerId);
  // EC:A60 A75 — the customer key the billing key was issued under (Toss refuses any other).
  const customerRef = sub.billingCustomerRef || customer?.providerRefs.find((ref) => ref.provider === provider.name)?.ref;
  const policyHash = hashPayload({ currency, unitPrice, included: policy.usage.includedQuantity, provider: provider.name, customerRef, billingKey: sub.billingKey, periodEnd: period.end.getTime() });
  if (operations.some((operation) => operation.payloadHash !== policyHash)) throw new PaymentKitError('Resolve existing settlement before changing its billing rules', 'usage_billing_policy_changed');
  let settledAmount = 0;
  let pending: { operation: Operation; payment: Payment } | null = null;
  for (const operation of operations) {
    const payment = await repo.payments.get(operation.key);
    if (!payment) throw new PaymentKitError('Settlement payment record is missing', 'usage_settlement_corrupt');
    switch (operation.status) {
      case 'done': settledAmount += payment.amount.amountMinor; break;
      case 'failed': return { kind: 'result', result: { status: 'failed', total, chargedAmount: null, payment } };
      case 'in_progress': pending = { operation, payment }; break;
      default: { const unreachable: never = operation.status; throw new PaymentKitError('Unknown operation status', 'usage_settlement_corrupt', unreachable); }
    }
  }
  const amountMinor = targetAmount - settledAmount;
  if (!pending && amountMinor <= 0) return unchanged;
  const capabilities = provider.capabilities();
  const eventIds = new Set(events.map((event) => event.id));
  const reports = await repo.outbox.list({ kind: 'usage.report' });
  if (provider.name !== sub.provider || capabilities.meters || capabilities.nativeSubscriptions || !sub.billingKey || !customerRef || reports.some((report) => typeof report.payload.eventId === 'string' && eventIds.has(report.payload.eventId))) throw new PaymentKitError('Direct usage billing needs an unmetered billing-key provider and linked customer', 'unsupported_usage_billing');
  let operation: Operation;
  let payment: Payment;
  if (pending) {
    operation = pending.operation;
    payment = pending.payment;
    const claim = await repo.outbox.get(operation.key);
    if (!claim) throw new PaymentKitError('Settlement retry lease is missing', 'usage_settlement_corrupt');
    if (claim.nextAttemptAt > clock.now()) return { kind: 'result', result: { status: 'pending', total, chargedAmount: null, payment } };
  } else {
    const key = `usage_${hashPayload([kind, targetAmount]).slice(0, 40)}`;
    payment = { id: key, customerId: sub.customerId, subscriptionId: sub.id, provider: provider.name, providerRef: `unresolved:${key}`, amount: { amountMinor, currency }, status: 'pending', kind: 'overage', period, occurredAt: clock.now(), failure: null, cashReceipt: null };
    operation = { id: key, key, kind, payloadHash: policyHash, status: 'in_progress', result: key, error: null, createdAt: clock.now(), completedAt: null, attempts: 0 };
    await repo.payments.put(payment);
  }
  operation = await repo.operations.put({ ...operation, attempts: operation.attempts + 1 });
  await repo.outbox.put({ id: operation.key, kind: 'usage.charge', payload: { paymentId: payment.id }, status: 'pending', attempts: operation.attempts, nextAttemptAt: new Date(clock.now().getTime() + 300_000), createdAt: operation.createdAt });
  return { kind: 'charge', operation, payment, customerRef, billingKey: sub.billingKey, total };
}
