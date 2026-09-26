// Smoke test — no live Stripe keys. Exercises verifyWebhook against a self-signed payload and the
// pure normalize functions against fixture objects. Run: node_modules/.bin/tsx packages/providers/stripe/ts/examples/smoke.ts
import Stripe from 'stripe';
import {
  StripeProvider,
  normalizeFailure,
  normalizePaymentIntent,
  normalizeInvoiceAsPayment,
  normalizeSubscription,
  mapEventType,
  toNormalizedEvent,
} from '../src/index.js';
import { WebhookSignatureError } from '@schift/payment-kit-core';

async function main() {
  const webhookSecret = 'whsec_testsecret1234567890';
  const provider = new StripeProvider({ secretKey: 'sk_test_dummy', webhookSecret });

  // (1) construct provider with dummy keys — done above. capabilities() sanity check.
  console.log('=== capabilities ===');
  console.log(provider.capabilities());

  // (2) verifyWebhook with a payload signed with the same secret — print NormalizedEvent
  const now = 1_700_000_000; // fixed epoch so ts/py smokes are byte-comparable (parity.sh)
  const invoiceEvent = {
    id: 'evt_test_invoice_paid',
    object: 'event',
    type: 'invoice.paid',
    created: now,
    data: {
      object: {
        id: 'in_test_1',
        object: 'invoice',
        customer: 'cus_test_1',
        subscription: 'sub_test_1',
        amount_paid: 5000,
        amount_due: 5000,
        currency: 'krw',
        status: 'paid',
        created: now,
        lines: { data: [{ period: { start: now, end: now + 30 * 86400 } }] },
      },
    },
  };
  const payload = JSON.stringify(invoiceEvent);
  // Stripe SDK's own test-header generator implements the exact t=...,v1=... scheme we verify against.
  const signer = new Stripe('sk_test_dummy');
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

  console.log('\n=== verifyWebhook (valid signature, invoice.paid) ===');
  const normalized = await provider.verifyWebhook({ headers: { 'stripe-signature': header }, rawBody: payload });
  console.log(JSON.stringify(normalized, null, 2));

  // (3) bad signature must raise WebhookSignatureError
  console.log('\n=== verifyWebhook (bad signature) ===');
  try {
    await provider.verifyWebhook({ headers: { 'stripe-signature': 't=0,v1=deadbeef' }, rawBody: payload });
    console.log('FAIL: expected WebhookSignatureError, none thrown');
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      console.log('OK: rejected as WebhookSignatureError (code:', (err as { code?: string }).code, ')');
    } else {
      console.log('FAIL: wrong error type:', err);
      process.exitCode = 1;
    }
  }

  // (4) pure mapping functions with fixture objects
  console.log('\n=== normalizeFailure fixtures ===');
  console.log('insufficient_funds ->', normalizeFailure({ declineCode: 'insufficient_funds' }));
  console.log('unknown code ->', normalizeFailure({ code: 'some_weird_code', message: 'weird' }));

  console.log('\n=== normalizePaymentIntent fixture (topup, requires_action) ===');
  const pi = {
    id: 'pi_test_1',
    amount: 10000,
    currency: 'krw',
    status: 'requires_action',
    created: now,
    last_payment_error: null,
    invoice: null,
  } as unknown as Stripe.PaymentIntent;
  console.log(JSON.stringify(normalizePaymentIntent(pi, null), null, 2));

  console.log('\n=== normalizeInvoiceAsPayment fixture ===');
  const invoice = invoiceEvent.data.object as unknown as Stripe.Invoice;
  console.log(JSON.stringify(normalizeInvoiceAsPayment(invoice), null, 2));

  console.log('\n=== normalizeSubscription fixture ===');
  const sub = {
    id: 'sub_test_1',
    customer: 'cus_test_1',
    status: 'active',
    current_period_start: now,
    current_period_end: now + 30 * 86400,
    billing_cycle_anchor: now,
    cancel_at_period_end: false,
    created: now,
    metadata: { customerId: 'internal_cust_1', planId: 'plan_pro' },
  } as unknown as Stripe.Subscription;
  console.log(JSON.stringify(normalizeSubscription(sub), null, 2));

  console.log('\n=== mapEventType(checkout.session.completed, mode=subscription) ===');
  console.log(mapEventType({ type: 'checkout.session.completed', data: { object: { mode: 'subscription' } } } as unknown as Stripe.Event));

  console.log('\n=== toNormalizedEvent (charge.dispute.created fixture) ===');
  const disputeEvent = {
    id: 'evt_test_dispute',
    type: 'charge.dispute.created',
    created: now,
    data: { object: { payment_intent: 'pi_test_2', amount: 3000, currency: 'krw' } },
  } as unknown as Stripe.Event;
  console.log(JSON.stringify(toNormalizedEvent(disputeEvent), null, 2));

  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error('SMOKE FAILED', err);
  process.exitCode = 1;
});
