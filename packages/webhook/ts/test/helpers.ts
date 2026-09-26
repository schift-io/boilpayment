// Shared test doubles for Phase 6 webhook regression tests.
// FakeProvider implements every PaymentProvider method; any method not given an
// explicit impl throws "unexpected call: <method>" so tests can prove a method
// was (or was not) invoked — modeled on examples/e2e/round-trip.ts's FakeProvider
// and packages/webhook/ts/examples/smoke.ts's FakeProvider/TossLikeProvider.
import { WebhookSignatureError } from 'boilpayment-core';
import type { NormalizedEvent, Payment, PaymentProvider, ProviderCapabilities, ProviderName, Subscription } from 'boilpayment-core';

export interface FakeProviderOpts {
  name?: ProviderName;
  nativeSubscriptions?: boolean;
  verify: (input: { headers: Record<string, string>; rawBody: string }) => NormalizedEvent;
  getPaymentImpl?: (providerRef: string) => Payment;
  getSubscriptionImpl?: (providerRef: string) => Subscription;
}

export class FakeProvider implements PaymentProvider {
  readonly name: ProviderName;
  getPaymentCalled = false;
  getSubscriptionCalled = false;

  constructor(private readonly opts: FakeProviderOpts) {
    this.name = opts.name ?? 'stripe';
  }

  capabilities(): ProviderCapabilities {
    return {
      nativeSubscriptions: this.opts.nativeSubscriptions ?? true,
      partialRefund: true,
      meters: false,
      scheduling: 'provider',
      webhookSignature: true,
    };
  }

  async createCustomer(): Promise<never> {
    throw new Error('unexpected call: createCustomer');
  }
  async createCheckout(): Promise<never> {
    throw new Error('unexpected call: createCheckout');
  }
  async getPayment(providerRef: string): Promise<Payment> {
    this.getPaymentCalled = true;
    if (!this.opts.getPaymentImpl) throw new Error('unexpected call: getPayment');
    return this.opts.getPaymentImpl(providerRef);
  }
  async listPayments(): Promise<never> {
    throw new Error('unexpected call: listPayments');
  }
  async getSubscription(providerRef: string): Promise<Subscription> {
    this.getSubscriptionCalled = true;
    if (!this.opts.getSubscriptionImpl) throw new Error('unexpected call: getSubscription');
    return this.opts.getSubscriptionImpl(providerRef);
  }
  async changeSubscription(): Promise<never> {
    throw new Error('unexpected call: changeSubscription');
  }
  async cancelSubscription(): Promise<never> {
    throw new Error('unexpected call: cancelSubscription');
  }
  async chargeBillingKey(): Promise<never> {
    throw new Error('unexpected call: chargeBillingKey');
  }
  async refund(): Promise<never> {
    throw new Error('unexpected call: refund');
  }
  async reportUsage(): Promise<void> {
    throw new Error('unexpected call: reportUsage');
  }
  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string }): Promise<NormalizedEvent> {
    return this.opts.verify(input);
  }
}

/** x-sig:'ok' required, else WebhookSignatureError; JSON body -> NormalizedEvent (mirrors examples/smoke.ts). */
export function jsonVerify(name: ProviderName = 'stripe') {
  return (input: { headers: Record<string, string>; rawBody: string }): NormalizedEvent => {
    if (input.headers['x-sig'] !== 'ok') throw new WebhookSignatureError();
    const parsed = JSON.parse(input.rawBody);
    return {
      id: parsed.id,
      provider: name,
      type: parsed.type,
      occurredAt: new Date(parsed.occurredAt),
      customerRef: parsed.customerRef ?? null,
      subscriptionRef: parsed.subscriptionRef ?? null,
      paymentRef: parsed.paymentRef ?? null,
      amount: null,
      raw: parsed,
    };
  };
}
