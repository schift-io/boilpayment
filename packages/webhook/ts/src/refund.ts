import { PaymentKitError } from '@schift/payment-kit-core';
import type { NormalizedEvent, Notifier, PaymentProvider, Refund, RefundLookupProvider } from '@schift/payment-kit-core';
import type { HandlerCtx } from './process.js';

const refundEventTypes = { succeeded: 'refund.created', failed: 'refund.failed', pending: 'refund.pending' } as const satisfies Record<Refund['status'], NormalizedEvent['type']>;

function hasRefundLookup(provider: PaymentProvider): provider is PaymentProvider & RefundLookupProvider {
  return 'getRefund' in provider && typeof provider.getRefund === 'function';
}

/** Toss notifications are unsigned; PortOne notifications omit amount and final cancellation details. */
export async function authoritativeRefundEvent(ctx: HandlerCtx, notifier: Notifier): Promise<NormalizedEvent> {
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
