// Shared PaymentProvider fakes for lifecycle regression tests. Implement the full PaymentProvider
// interface; every method not exercised by a given scenario throws loudly instead of silently
// succeeding, so a regression that starts calling an unexpected provider method fails the test.
import {
  Checkout,
  CreateCheckoutInput,
  Logger,
  Money,
  NormalizedEvent,
  Payment,
  PaymentKitError,
  PaymentProvider,
  PaymentStatus,
  ProviderCapabilities,
  Refund,
  ProviderError,
  Subscription,
} from 'boilpayment-core';

function unexpected(name: string): never {
  throw new Error(`unexpected call: ${name} (not wired for this test)`);
}

/** Native-subscription provider (Stripe-shaped): changeSubscription/cancelSubscription succeed. */
export class FakeNativeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  changeSubscriptionCalled = 0;
  cancelSubscriptionCalled = 0;
  private dummySub: Subscription | null = null;

  setDummySub(sub: Subscription): void {
    this.dummySub = sub;
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true };
  }
  async createCustomer(): Promise<{ ref: string }> {
    return { ref: 'cus_fake' };
  }
  async createCheckout(_input: CreateCheckoutInput): Promise<Checkout> {
    return unexpected('createCheckout');
  }
  async getPayment(): Promise<Payment> {
    return unexpected('getPayment');
  }
  async listPayments(): Promise<Payment[]> {
    return [];
  }
  async getSubscription(): Promise<Subscription> {
    return unexpected('getSubscription');
  }
  async changeSubscription(): Promise<Subscription> {
    this.changeSubscriptionCalled += 1;
    if (!this.dummySub) return unexpected('changeSubscription (no dummySub set)');
    return this.dummySub;
  }
  async cancelSubscription(): Promise<Subscription> {
    this.cancelSubscriptionCalled += 1;
    if (!this.dummySub) return unexpected('cancelSubscription (no dummySub set)');
    return this.dummySub;
  }
  uncancelSubscriptionCalled = 0;
  /** Controls the outcome of the next uncancelSubscription() call — set to a PaymentKitError to
   * simulate e.g. 'unsupported' (adapter gap) or 'not_reactivatable' (Stripe already-canceled). */
  nextUncancelThrows: PaymentKitError | null = null;
  async uncancelSubscription(): Promise<Subscription> {
    this.uncancelSubscriptionCalled += 1;
    if (this.nextUncancelThrows) throw this.nextUncancelThrows;
    if (!this.dummySub) return unexpected('uncancelSubscription (no dummySub set)');
    return this.dummySub;
  }
  async chargeBillingKey(): Promise<Payment> {
    return unexpected('chargeBillingKey');
  }
  async refund(): Promise<Refund> {
    return unexpected('refund');
  }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(): Promise<NormalizedEvent> {
    return unexpected('verifyWebhook');
  }
}

/**
 * EC:L5 — native provider that also implements the duck-typed `withCorrelationId`, logging every
 * subscription-mutating call it receives into a `Logger` so tests can assert the correlationId a
 * scoped clone was given actually reaches the call site. Mirrors the real providers'
 * `withCorrelationId` pattern (see each provider package's ts/src/index.ts).
 */
export class FakeCorrelatingProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private dummySub: Subscription | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly correlationId: string | null = null,
  ) {}

  setDummySub(sub: Subscription): void {
    this.dummySub = sub;
  }

  withCorrelationId(correlationId: string): PaymentProvider {
    const clone = new FakeCorrelatingProvider(this.logger, correlationId);
    clone.dummySub = this.dummySub;
    return clone;
  }

  private async logCall(event: string): Promise<void> {
    await this.logger.log({ level: 'info', event, correlationId: this.correlationId ?? null });
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true };
  }
  async createCustomer(): Promise<{ ref: string }> {
    return { ref: 'cus_fake' };
  }
  async createCheckout(): Promise<Checkout> {
    return unexpected('createCheckout');
  }
  async getPayment(): Promise<Payment> {
    return unexpected('getPayment');
  }
  async listPayments(): Promise<Payment[]> {
    return [];
  }
  async getSubscription(): Promise<Subscription> {
    return unexpected('getSubscription');
  }
  async changeSubscription(): Promise<Subscription> {
    await this.logCall('provider.request');
    if (!this.dummySub) return unexpected('changeSubscription (no dummySub set)');
    return this.dummySub;
  }
  async cancelSubscription(): Promise<Subscription> {
    await this.logCall('provider.request');
    if (!this.dummySub) return unexpected('cancelSubscription (no dummySub set)');
    return this.dummySub;
  }
  async uncancelSubscription(): Promise<Subscription> {
    await this.logCall('provider.request');
    if (!this.dummySub) return unexpected('uncancelSubscription (no dummySub set)');
    return this.dummySub;
  }
  async chargeBillingKey(): Promise<Payment> {
    return unexpected('chargeBillingKey');
  }
  async refund(): Promise<Refund> {
    return unexpected('refund');
  }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(): Promise<NormalizedEvent> {
    return unexpected('verifyWebhook');
  }
}

/**
 * Self-scheduling provider (Toss/PortOne-shaped): no native subscription tracking.
 * getSubscription/changeSubscription/cancelSubscription throw PaymentKitError('unsupported')
 * exactly like the real Toss/PortOne provider implementations, so a lifecycle regression that
 * calls one of them for a non-native provider fails loudly.
 */
export class FakeSelfSchedulingProvider implements PaymentProvider {
  readonly name = 'toss' as const;
  lastCharge: { amountMinor: number; currency: string; idempotencyKey: string } | null = null;
  /** Controls the outcome of the next chargeBillingKey() call. */
  nextChargeStatus: PaymentStatus = 'succeeded';
  nextChargeThrows = false;

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self', webhookSignature: false };
  }
  async createCustomer(): Promise<{ ref: string }> {
    return { ref: 'cus_toss_fake' };
  }
  async createCheckout(): Promise<Checkout> {
    return unexpected('createCheckout');
  }
  async getPayment(): Promise<Payment> {
    return unexpected('getPayment');
  }
  async listPayments(): Promise<Payment[]> {
    return [];
  }
  async getSubscription(): Promise<Subscription> {
    throw new PaymentKitError('unsupported', 'unsupported');
  }
  async changeSubscription(): Promise<Subscription> {
    throw new PaymentKitError('unsupported', 'unsupported');
  }
  async cancelSubscription(): Promise<Subscription> {
    throw new PaymentKitError('unsupported', 'unsupported');
  }
  async uncancelSubscription(): Promise<Subscription> {
    throw new PaymentKitError('unsupported', 'unsupported');
  }
  /** Every orderId sent (EC:A35 format checks). */
  readonly orderIds: string[] = [];
  /** Idempotency like Toss (a repeated Idempotency-Key replays the stored answer). */
  private readonly answers = new Map<string, Payment>();
  /** Keys whose charge actually moved money (succeeded), counted once per key. */
  readonly moneyMoved = new Set<string>();
  /** Test hook: the provider later settles an earlier answer (e.g. pending -> succeeded). */
  settle(idempotencyKey: string, status: PaymentStatus): void {
    const prev = this.answers.get(idempotencyKey);
    if (prev) this.answers.set(idempotencyKey, { ...prev, status });
    if (status === 'succeeded') this.moneyMoved.add(idempotencyKey);
  }
  /** Test hook: answer the next call with an HTTP error (a decline is a 4xx). */
  nextChargeHttpError: number | null = null;

  async chargeBillingKey(input: { billingKey: string; amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment> {
    this.lastCharge = { amountMinor: input.amount.amountMinor, currency: input.amount.currency, idempotencyKey: input.idempotencyKey };
    this.orderIds.push(input.orderId);
    if (this.nextChargeThrows) throw new Error('provider unavailable');
    if (this.nextChargeHttpError !== null) {
      const status = this.nextChargeHttpError;
      throw new ProviderError(`toss api error (${status})`, { code: status >= 500 ? 'provider_unavailable' : 'card_declined', providerCode: null, retryable: status >= 500, userMessage: 'x' }, {}, status);
    }
    const replay = this.answers.get(input.idempotencyKey);
    if (replay) return replay;
    const answer = this.answerFor(input);
    this.answers.set(input.idempotencyKey, answer);
    if (answer.status === 'succeeded') this.moneyMoved.add(input.idempotencyKey);
    return answer;
  }

  /** EC:A38 — lookups by orderId (never charges). `lookupThrows` simulates an unreachable provider. */
  readonly lookups: string[] = [];
  lookupThrows = false;
  async getPaymentByOrderId(orderId: string): Promise<Payment | null> {
    this.lookups.push(orderId);
    if (this.lookupThrows) throw new Error('provider unavailable');
    return [...this.answers.values()].find((a) => a.providerRef === orderId) ?? null;
  }
  /** Test hook: an order an earlier release charged (its orderId was the key itself). */
  seedOrder(orderId: string, status: PaymentStatus, amountMinor = 5000): void {
    this.answers.set(orderId, { ...this.answerFor({ amount: { amountMinor, currency: 'KRW' }, orderId, customerRef: 'c1', idempotencyKey: orderId }), status });
    if (status === 'succeeded') this.moneyMoved.add(orderId);
  }

  private answerFor(input: { amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Payment {
    return {
      id: `pay_${input.idempotencyKey}`,
      customerId: input.customerRef,
      provider: 'toss',
      providerRef: input.orderId,
      subscriptionId: null,
      amount: input.amount,
      status: this.nextChargeStatus,
      kind: 'subscription',
      period: null,
      occurredAt: new Date(),
      cashReceipt: null,
      failure: this.nextChargeStatus === 'failed' ? { code: 'card_declined', providerCode: null, retryable: true, userMessage: 'declined' } : null,
    };
  }
  async refund(): Promise<Refund> {
    return unexpected('refund');
  }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(): Promise<NormalizedEvent> {
    return unexpected('verifyWebhook');
  }
}
