// Shared test fixtures for packages/usage/ts — real core doubles only, no hand-rolled fakes
// except a PaymentProvider stub that implements every method (throwing on any unexpected call).
import {
  DEFAULT_POLICY,
  Money,
  Payment,
  PaymentProvider,
  ProviderCapabilities,
  Refund,
  Subscription,
} from 'boilpayment-core';

export function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1',
    customerId: 'cust_1',
    planId: 'plan_pro',
    provider: 'stripe',
    providerRef: 'sub_stripe_1',
    status: 'active',
    currentPeriod: { start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-06-01T00:00:00Z') },
    anchorDay: 1,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    billingKey: null,
    scheduledPlanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export const basePolicy = DEFAULT_POLICY;

/**
 * Implements EVERY PaymentProvider method. Every method not needed by a given test scenario
 * throws loudly, so an accidental/unexpected call fails the test instead of silently no-op'ing.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  reportUsageCalls: { customerRef: string; meter: string; quantity: number }[] = [];
  private callCount = 0;

  constructor(
    private readonly opts: { meters?: boolean; failFirstN?: number; alwaysFail?: boolean } = {},
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      nativeSubscriptions: true,
      partialRefund: true,
      meters: this.opts.meters ?? true,
      scheduling: 'provider',
      webhookSignature: true,
    };
  }
  async createCustomer(): Promise<{ ref: string }> { throw new Error('unexpected call: createCustomer'); }
  async createCheckout(): Promise<never> { throw new Error('unexpected call: createCheckout'); }
  async getPayment(): Promise<Payment> { throw new Error('unexpected call: getPayment'); }
  async listPayments(): Promise<Payment[]> { throw new Error('unexpected call: listPayments'); }
  async getSubscription(): Promise<Subscription> { throw new Error('unexpected call: getSubscription'); }
  async changeSubscription(): Promise<Subscription> { throw new Error('unexpected call: changeSubscription'); }
  async cancelSubscription(): Promise<Subscription> { throw new Error('unexpected call: cancelSubscription'); }
  async chargeBillingKey(): Promise<Payment> { throw new Error('unexpected call: chargeBillingKey'); }
  async refund(): Promise<Refund> { throw new Error('unexpected call: refund'); }
  async verifyWebhook(): Promise<never> { throw new Error('unexpected call: verifyWebhook'); }

  async reportUsage(input: { meter: string; customerRef: string; quantity: number }): Promise<void> {
    this.callCount += 1;
    this.reportUsageCalls.push({ customerRef: input.customerRef, meter: input.meter, quantity: input.quantity });
    if (this.opts.alwaysFail || this.callCount <= (this.opts.failFirstN ?? 0)) {
      throw new Error('provider unavailable');
    }
  }
}

export function money(amountMinor: number, currency = 'USD'): Money {
  return { amountMinor, currency };
}
