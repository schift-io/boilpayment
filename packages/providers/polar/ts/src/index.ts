// boilpayment — Polar provider.
// spec: ../../spec/polar.pseudo.md
//
// NOTE: implemented directly over Polar's REST API (fetch) rather than through `@polar-sh/sdk`.
// The installed TS SDK version (0.20.2) has no `refunds`/`events`/`meters` namespace at all, and its
// `checkouts` namespace is the deprecated legacy API (the current one lives under `checkouts.custom`).
// The installed py `polar-sdk` (0.32.0) is far newer and does have all of these. To keep both language
// implementations calling the identical endpoints/payloads (per docs/ARCHITECTURE.md: "consistency
// across languages matters more than SDK usage"), both ts and py talk to the REST API directly.
// Wire format for Polar's REST API is snake_case JSON (confirmed against the py SDK's field names,
// which mirror the wire format 1:1).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  Checkout,
  CreateCheckoutInput,
  Money,
  NormalizedEvent,
  NormalizedEventType,
  Payment,
  PaymentFailure,
  PaymentKind,
  PaymentProvider,
  PaymentStatus,
  ProviderCapabilities,
  Refund,
  RefundStatus,
  Subscription,
  SubscriptionStatus,
  Logger,
} from 'boilpayment-core';
import { PaymentKitError, ProviderError, WebhookSignatureError, NoopLogger, money as coreMoney } from 'boilpayment-core';

export interface PolarProviderConfig {
  accessToken: string;
  webhookSecret: string;
  /** EC:E20 — secrets being rotated out; a stored webhook signed with one still re-verifies. */
  previousWebhookSecrets?: string[];
  server?: 'production' | 'sandbox';
  /** Overrides the API host entirely, e.g. the local mock: "http://127.0.0.1:12213". Takes precedence over `server`. */
  apiBase?: string;
  /** EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2). Defaults to NoopLogger. */
  logger?: Logger;
  /** EC:L5 — overrides the correlationId logged for every `provider.request` event from this
   * instance (otherwise falls back to the per-call Idempotency-Key header, as before). Prefer
   * `provider.withCorrelationId(id)` over setting this directly. */
  correlationId?: string;
}

const SERVER_URLS = { production: 'https://api.polar.sh', sandbox: 'https://sandbox-api.polar.sh' } as const;

// EC:J8 — the core money() checks the amount is a safe integer at the provider boundary.
function money(amountMinor: number, currency: string): Money {
  return coreMoney(amountMinor, currency);
}

// EC:E12 — Polar exposes little failure detail on the provider side (see spec)
export function normalizeFailure(input: { message?: string | null }): PaymentFailure {
  return { code: 'unknown', providerCode: null, retryable: true, userMessage: input.message ?? '결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요.' };
}

function mapOrderStatus(order: Record<string, any>): PaymentStatus {
  if (order.status === 'refunded') return 'refunded';
  if (order.status === 'partially_refunded') return 'partially_refunded';
  if (order.status === 'paid' || order.paid) return 'succeeded';
  if (order.status === 'void') return 'failed';
  return 'pending';
}

// EC:E7 E12 — normalize Polar Order (raw REST, snake_case) -> Payment (pure)
export function normalizeOrder(order: Record<string, any>): Payment {
  const kind: PaymentKind = order.subscription_id ? 'subscription' : 'topup';
  return {
    id: order.id,
    customerId: '',
    provider: 'polar',
    providerRef: order.id,
    subscriptionId: order.subscription_id ?? null,
    amount: money(order.total_amount ?? order.net_amount ?? 0, order.currency),
    status: mapOrderStatus(order),
    kind,
    period: null,
    occurredAt: new Date(order.created_at),
    failure: null,
    cashReceipt: null,
    providerRefAliases: null, // EC:E24 — one ref per payment (py renders the key: parity)
    raw: order,
  };
}

const SUB_STATUS: Record<string, SubscriptionStatus> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'expired',
  incomplete: 'incomplete', // EC:A27 — never paid yet: no access, no dunning
  incomplete_expired: 'expired',
  paused: 'paused', // EC:A27 — trial ended without a payment method: no access
};

// EC:F(Polar) — normalize Subscription (raw REST) (pure). See spec "계약 메모".
export function normalizeSubscription(sub: Record<string, any>): Subscription {
  const md = (sub.metadata ?? {}) as Record<string, unknown>;
  const start = new Date(sub.current_period_start);
  return {
    id: (md.subscriptionId as string) || sub.id,
    customerId: (md.customerId as string) || sub.customer_id,
    planId: (md.planId as string) || '',
    provider: 'polar',
    providerRef: sub.id,
    status: SUB_STATUS[sub.status] ?? 'expired',
    currentPeriod: { start, end: new Date(sub.current_period_end) },
    anchorDay: start.getUTCDate(),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    graceUntil: null,
    billingKey: null,
    billingCustomerRef: null, // EC:A60 — rendered like the Python dataclass field
    scheduledPlanId: null,
    currency: typeof sub.currency === 'string' ? sub.currency.toUpperCase() : null, // EC:A28
    version: 0, // provider-side row; the local repo row owns the EC:K1 optimistic lock
    createdAt: new Date(sub.created_at),
  };
}

function mapRefundStatus(status: string | null | undefined): RefundStatus {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'canceled') return 'failed';
  return 'pending';
}

function mapRefundReason(reason: string): string {
  if (reason === 'duplicate' || reason === 'fraudulent') return reason;
  return 'customer_request';
}

// EC:D4 D6 — normalize Refund (raw REST) (pure)
export function normalizeRefund(refund: Record<string, any>, ruleId: string): Refund {
  return {
    id: refund.id,
    paymentId: refund.order_id,
    customerId: refund.customer_id ?? '',
    amount: money(refund.amount, refund.currency),
    status: mapRefundStatus(refund.status),
    providerRef: refund.id,
    creditsRevoked: 0,
    ruleId,
    reason: refund.reason ?? null,
    failure: refund.status === 'failed' ? normalizeFailure({}) : null,
    createdAt: new Date(refund.created_at),
  };
}

// EC:F(Polar) — webhook event type mapping (pure)
export function mapEventType(type: string, refundStatus?: string | null): NormalizedEventType {
  switch (type) {
    case 'order.paid':
      return 'payment.succeeded';
    case 'order.created':
      return 'payment.pending';
    case 'order.refunded':
      return 'unknown'; // Order totals do not identify a single refund.
    case 'refund.created':
    case 'refund.updated':
      switch (mapRefundStatus(refundStatus)) {
        case 'succeeded': return 'refund.created';
        case 'failed': return 'refund.failed';
        case 'pending': return 'refund.pending';
      }
    case 'subscription.created':
      return 'subscription.created';
    case 'subscription.updated':
    case 'subscription.active':
    case 'subscription.uncanceled':
      return 'subscription.updated';
    case 'subscription.canceled':
      return 'subscription.canceled';
    case 'subscription.revoked':
      return 'subscription.canceled';
    case 'subscription.past_due':
      return 'subscription.payment_failed';
    default:
      return 'unknown';
  }
}

// EC:F(Polar) — raw parsed webhook body -> NormalizedEvent (pure)
export function toNormalizedEvent(parsed: { type: string; data: Record<string, any>; id?: string; timestamp?: string }, deliveryId?: string): NormalizedEvent {
  const type = mapEventType(parsed.type, parsed.data?.status);
  const data = parsed.data ?? {};
  let customerRef: string | null = null;
  let subscriptionRef: string | null = null;
  let paymentRef: string | null = null;
  let refundRef: string | null = null;
  let amount: Money | null = null;

  if (parsed.type.startsWith('order.')) {
    customerRef = data.customer_id ?? null;
    subscriptionRef = data.subscription_id ?? null;
    paymentRef = data.id ?? null;
    if (data.total_amount != null) amount = money(data.total_amount, data.currency ?? 'usd');
  } else if (parsed.type.startsWith('subscription.')) {
    customerRef = data.customer_id ?? null;
    subscriptionRef = data.id ?? null;
  } else if (parsed.type === 'refund.created' || parsed.type === 'refund.updated') {
    refundRef = data.id ?? null;
    subscriptionRef = data.subscription_id ?? null;
    customerRef = data.customer_id ?? null;
    paymentRef = data.order_id ?? null;
    if (data.amount != null) amount = money(data.amount, data.currency ?? 'usd');
  }

  return {
    id: deliveryId ?? parsed.id ?? (data.id ? `${parsed.type}:${data.id}` : `${parsed.type}:${Date.now()}`),
    provider: 'polar',
    type,
    occurredAt: parsed.timestamp ? new Date(parsed.timestamp) : new Date(),
    customerRef,
    subscriptionRef,
    paymentRef,
    refundRef,
    disputeOutcome: null, // EC:D21 — Polar sends no dispute verdict
    amount,
    raw: parsed,
  };
}

// EC:webhookSignature — Standard Webhooks HMAC verification, implemented manually (see spec).
export function verifyStandardWebhookSignature(input: { headers: Record<string, string>; rawBody: string; secret: string; receivedAt?: Date }): void {
  const h = (name: string): string | undefined => input.headers[name] ?? input.headers[name.toLowerCase()] ?? input.headers[name.toUpperCase()];
  const id = h('webhook-id');
  const timestamp = h('webhook-timestamp');
  const sigHeader = h('webhook-signature');
  if (!id || !timestamp || !sigHeader) throw new WebhookSignatureError('missing webhook-id/webhook-timestamp/webhook-signature headers');

  // mirrors PortoneProvider.verifyWebhook — Standard Webhooks 5-minute replay tolerance
  const tsSec = Number(timestamp);
  // EC:E17 — freshness is enforced at receipt (wall clock); a re-verify of a stored row
  // (receivedAt set) checks the signature only.
  if (!Number.isFinite(tsSec) || (!input.receivedAt && Math.abs(Date.now() / 1000 - tsSec) > 300)) {
    throw new WebhookSignatureError('webhook timestamp outside 5-minute tolerance');
  }

  const secretRaw = input.secret.startsWith('whsec_') ? input.secret.slice('whsec_'.length) : input.secret;
  const key = Buffer.from(secretRaw, 'base64');
  const signedContent = `${id}.${timestamp}.${input.rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');

  const candidates = sigHeader
    .split(' ')
    .map((part) => (part.includes(',') ? part.split(',', 2)[1] : part))
    .filter((v): v is string => !!v);

  const matched = candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });
  if (!matched) throw new WebhookSignatureError('invalid polar webhook signature');
}

export class PolarProvider implements PaymentProvider {
  readonly name = 'polar' as const;
  private readonly accessToken: string;
  private readonly webhookSecret: string;
  private readonly previousWebhookSecrets: string[];
  private readonly baseUrl: string;
  private readonly logger: Logger;
  // EC:L5 — set only via config.correlationId / withCorrelationId(); overrides the per-call
  // Idempotency-Key-derived value for every `provider.request` log line from this instance.
  private readonly correlationIdOverride: string | null;

  constructor(config: PolarProviderConfig) {
    this.accessToken = config.accessToken;
    this.webhookSecret = config.webhookSecret;
    this.previousWebhookSecrets = config.previousWebhookSecrets ?? [];
    this.baseUrl = config.apiBase ?? SERVER_URLS[config.server ?? 'production'];
    this.logger = config.logger ?? new NoopLogger();
    this.correlationIdOverride = config.correlationId ?? null;
  }

  // EC:L5 — a scoped clone carrying a fixed correlationId for every `provider.request` log line it
  // emits. Not part of the `PaymentProvider` interface (duck-typed — webhook.process checks for it
  // with `typeof provider.withCorrelationId === 'function'`), so this stays additive: no change to
  // the shared core interface, no ripple into lifecycle/refund/credits/cs call sites. A cheap
  // shallow clone is correct here (unlike Stripe's provider) because `request()` below is a normal
  // prototype method that reads `this` at call time, not a closure bound at construction.
  withCorrelationId(correlationId: string): PaymentProvider {
    const clone = Object.create(PolarProvider.prototype) as PolarProvider;
    Object.assign(clone, this, { correlationIdOverride: correlationId });
    return clone;
  }

  // EC:L1 — one `provider.request` event per HTTP call, redacted (EC:L2) by the Logger implementation.
  private async request<T = any>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const correlationId = this.correlationIdOverride ?? extraHeaders?.['Idempotency-Key'] ?? null;
    const startedAt = Date.now();
    let status: number | undefined;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...(extraHeaders ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        await this.logger.log({
          level: 'warn', event: 'provider.request', provider: 'polar', method, path, status,
          durationMs: Date.now() - startedAt, correlationId, providerErrorCode: 'unknown', requestBody: body, responseBody: text,
        });
        throw new ProviderError(`polar ${method} ${path} failed: ${res.status}`, normalizeFailure({ message: text }), { status: res.status, body: text });
      }
      const json = res.status === 204 ? undefined : ((await res.json()) as T);
      await this.logger.log({
        level: 'info', event: 'provider.request', provider: 'polar', method, path, status,
        durationMs: Date.now() - startedAt, correlationId, providerErrorCode: null, requestBody: body, responseBody: json,
      });
      return json as T;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      await this.logger.log({
        level: 'error', event: 'provider.request', provider: 'polar', method, path, status: status ?? null,
        durationMs: Date.now() - startedAt, correlationId, providerErrorCode: 'network_error', requestBody: body,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: true, meters: true, scheduling: 'provider', webhookSignature: true, checkout: 'hosted' };
  }

  async createCustomer(input: { email: string; name?: string; metadata?: Record<string, string> }): Promise<{ ref: string }> {
    const customer = await this.request<{ id: string }>('POST', '/v1/customers/', {
      email: input.email,
      name: input.name,
      metadata: input.metadata,
    });
    return { ref: customer.id };
  }

  // EC:E6 — idempotencyKey is best-effort (Polar API doesn't document idempotency header support)
  async createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
    const productRef = input.price.providerPriceRefs?.polar;
    if (!productRef) throw new PaymentKitError('missing polar product ref for plan price', 'missing_provider_price_ref', { planId: input.plan.id });
    const checkout = await this.request<{ id: string; url: string }>(
      'POST',
      '/v1/checkouts/',
      {
        products: [productRef],
        customer_id: input.customerRef,
        metadata: { ...(input.metadata ?? {}), planId: input.plan.id },
        success_url: input.successUrl,
      },
      { 'Idempotency-Key': input.idempotencyKey },
    );
    return { id: checkout.id, url: checkout.url, providerRef: checkout.id };
  }

  // EC:E7 E12
  async getPayment(providerRef: string): Promise<Payment> {
    const order = await this.request<Record<string, any>>('GET', `/v1/orders/${providerRef}`);
    return normalizeOrder(order);
  }

  // EC:H4 E1 — Polar's list API has no `since` filter; filter client-side
  async listPayments(input: { customerRef: string; since: Date }): Promise<Payment[]> {
    const res = await this.request<{ items: Record<string, any>[] }>('GET', `/v1/orders/?customer_id=${encodeURIComponent(input.customerRef)}&limit=100`);
    return (res.items ?? []).filter((o) => new Date(o.created_at).getTime() >= input.since.getTime()).map(normalizeOrder);
  }

  // EC:E3
  async getSubscription(providerRef: string): Promise<Subscription> {
    const sub = await this.request<Record<string, any>>('GET', `/v1/subscriptions/${providerRef}`);
    return normalizeSubscription(sub);
  }

  // EC:A1 — resetAnchor has no Polar equivalent; ignored (see spec)
  async changeSubscription(
    providerRef: string,
    input: { newPriceRef: string; proration: 'immediate' | 'none'; resetAnchor: boolean },
  ): Promise<Subscription> {
    const sub = await this.request<Record<string, any>>('PATCH', `/v1/subscriptions/${providerRef}`, {
      product_id: input.newPriceRef,
      proration_behavior: input.proration === 'immediate' ? 'prorate' : 'next_period',
    });
    return normalizeSubscription(sub);
  }

  // EC:A5
  async cancelSubscription(providerRef: string, input: { atPeriodEnd: boolean }): Promise<Subscription> {
    const sub = input.atPeriodEnd
      ? await this.request<Record<string, any>>('PATCH', `/v1/subscriptions/${providerRef}`, { cancel_at_period_end: true })
      : await this.request<Record<string, any>>('DELETE', `/v1/subscriptions/${providerRef}`);
    return normalizeSubscription(sub);
  }

  // EC:A23 — undo `cancel_at_period_end` via the same PATCH endpoint changeSubscription/
  // cancelSubscription use. Confirmed against Polar's docs (polar.sh/docs/features/subscriptions/
  // manage, 2026-09-09): uncancelling is a PATCH of `cancel_at_period_end` back to `false`, and is
  // rejected once the subscription has actually ended — there is no separate uncancel endpoint.
  // Pre-checks status so a fully-ended subscription throws our own `not_reactivatable` (with the
  // real Polar status) instead of surfacing whatever error the PATCH returns.
  async uncancelSubscription(providerRef: string): Promise<Subscription> {
    const current = await this.request<Record<string, any>>('GET', `/v1/subscriptions/${providerRef}`);
    if (current.status === 'canceled' || current.status === 'revoked') {
      throw new PaymentKitError(
        `polar subscription ${providerRef} is fully canceled and cannot be reactivated (status=${current.status})`,
        'not_reactivatable',
        { id: providerRef, status: current.status },
      );
    }
    const sub = await this.request<Record<string, any>>('PATCH', `/v1/subscriptions/${providerRef}`, { cancel_at_period_end: false });
    return normalizeSubscription(sub);
  }

  async chargeBillingKey(): Promise<Payment> {
    throw new PaymentKitError('billing key charge unsupported for polar (native subscriptions)', 'unsupported');
  }

  // EC:D4 D6
  async refund(input: { paymentRef: string; amount: Money; reason: string; idempotencyKey: string; extra?: Record<string, unknown> }): Promise<Refund> {
    const refund = await this.request<Record<string, any>>('POST', '/v1/refunds/', {
      order_id: input.paymentRef,
      amount: input.amount.amountMinor,
      reason: mapRefundReason(input.reason),
    });
    return normalizeRefund(refund, 'D4');
  }

  // EC:C4
  async reportUsage(input: { meter: string; customerRef: string; quantity: number; occurredAt: Date; idempotencyKey: string }): Promise<void> {
    await this.request('POST', '/v1/events/ingest', {
      events: [
        {
          name: input.meter,
          customer_id: input.customerRef,
          timestamp: input.occurredAt.toISOString(),
          external_id: input.idempotencyKey,
          metadata: { value: input.quantity },
        },
      ],
    });
  }

  // EC:E4 — manual Standard Webhooks verification (see spec "SDK 버전 불일치")
  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string; receivedAt?: Date }): Promise<NormalizedEvent> {
    // EC:E20 — the current secret first, then secrets being rotated out.
    let verified = false; let lastError: unknown;
    // EC:E21 — rotated-out secrets only re-verify stored rows (receivedAt set), never new events.
    for (const secret of input.receivedAt ? [this.webhookSecret, ...this.previousWebhookSecrets] : [this.webhookSecret]) {
      try { verifyStandardWebhookSignature({ headers: input.headers, rawBody: input.rawBody, secret, receivedAt: input.receivedAt }); verified = true; break; } catch (err) { lastError = err; }
    }
    if (!verified) throw lastError;
    let parsed: { type: string; data: Record<string, any>; id?: string; timestamp?: string };
    try {
      parsed = JSON.parse(input.rawBody);
    } catch (err) {
      throw new WebhookSignatureError('invalid webhook payload json');
    }
    return toNormalizedEvent(parsed, input.headers['webhook-id'] ?? input.headers['WEBHOOK-ID']);
  }
}
