import { PaymentKitError } from 'boilpayment-core';
import type { NormalizedEvent, Notifier, PaymentProvider, Refund, RefundLookupProvider } from 'boilpayment-core';
import type { HandlerCtx } from './process.js';

const refundEventTypes = { succeeded: 'refund.created', failed: 'refund.failed', pending: 'refund.pending' } as const satisfies Record<Refund['status'], NormalizedEvent['type']>;

function hasRefundLookup(provider: PaymentProvider): provider is PaymentProvider & RefundLookupProvider {
  return 'getRefund' in provider && typeof provider.getRefund === 'function';
}

/** EC:N6 — store refunds (Google voided purchases) carry no amount, and one-time voids no productId
 * (`p|?|<token>`). Resolve both from the local payment; quantity-based partial voids need a person. */
async function storeRefundEvent(ctx: HandlerCtx, notifier: Notifier): Promise<NormalizedEvent> {
  const event = ctx.event;
  const fail = async (reason: string): Promise<never> => {
    await notifier.send({ type: 'reconcile.mismatch', customerId: null, payload: { provider: ctx.provider.name, eventId: event.id, reason } });
    throw new PaymentKitError(reason, 'refund_reconciliation_required');
  };
  let paymentRef = event.paymentRef;
  if (paymentRef?.startsWith('p|?|')) {
    const token = paymentRef.slice(4);
    const matches = (await ctx.repo.payments.list({ provider: ctx.provider.name })).filter((p) => p.providerRef.endsWith(`|${token}`));
    if (matches.length !== 1) return fail('store refund could not be matched to one local payment');
    paymentRef = matches[0].providerRef;
  }
  if (event.amount) return { ...event, paymentRef };
  const raw = event.raw as { voidedPurchaseNotification?: { refundType?: number } } | null;
  if (raw?.voidedPurchaseNotification?.refundType === 2) return fail('quantity-based partial store refund needs review');
  const [payment] = paymentRef ? await ctx.repo.payments.list({ provider: ctx.provider.name, providerRef: paymentRef }) : [];
  if (!payment) return fail('store refund payment was not found');
  return { ...event, paymentRef, amount: payment.amount };
}

/** Toss notifications are unsigned; PortOne notifications omit amount and final cancellation details. */
export async function authoritativeRefundEvent(ctx: HandlerCtx, notifier: Notifier): Promise<NormalizedEvent> {
  if (ctx.provider.capabilities().checkout === 'on_device') return storeRefundEvent(ctx, notifier);
  if (ctx.provider.name !== 'toss' && ctx.provider.name !== 'portone') return ctx.event;
  const refundRef = ctx.event.refundRef;
  let paymentRef = ctx.event.paymentRef;
  if (!paymentRef && refundRef) {
    const refunds = await ctx.repo.refunds.list({ providerRef: refundRef });
    for (const refund of refunds) {
      const payment = await ctx.repo.payments.get(refund.paymentId);
      if (payment?.provider === ctx.provider.name) {
        if (paymentRef && paymentRef !== payment.providerRef) throw new PaymentKitError('ambiguous refund reference', 'refund_reconciliation_required');
        paymentRef = payment.providerRef;
      }
    }
  }
  if (refundRef && paymentRef && hasRefundLookup(ctx.provider)) {
    const refund = await ctx.provider.getRefund({ paymentRef, refundRef });
    if (refund?.providerRef === refundRef) {
      const type = refundEventTypes[refund.status];
      return { ...ctx.event, type, paymentRef, refundRef, amount: refund.amount };
    }
  }
  await notifier.send({ type: 'reconcile.mismatch', customerId: null, payload: {
    provider: ctx.provider.name, eventId: ctx.event.id, reason: 'authoritative refund could not be identified',
  } });
  throw new PaymentKitError('authoritative refund could not be identified', 'refund_reconciliation_required');
}
