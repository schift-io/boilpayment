// boilpayment — Stripe provider.
// spec: ../../spec/stripe.pseudo.md
import Stripe from 'stripe';
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

export interface StripeProviderConfig {
  secretKey: string;
  webhookSecret: string;
  /** EC:E20 — secrets being rotated out; a stored webhook signed with one still re-verifies. */
  previousWebhookSecrets?: string[];
  apiVersion?: Stripe.LatestApiVersion;
  /** Override the API host, e.g. stripe-mock: { host: '127.0.0.1', port: 12111, protocol: 'http' }. */
  apiBase?: { host: string; port?: number; protocol?: 'http' | 'https' };
  /** EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2). Defaults to NoopLogger. */
  logger?: Logger;
  /** EC:L5 — overrides the correlationId logged for every `provider.request` event from this
   * instance (otherwise falls back to the per-call idempotencyKey, as before). Prefer
   * `provider.withCorrelationId(id)` over setting this directly — it's the scoped-clone helper
   * webhook.process uses to thread one delivery's correlationId through provider calls without
   * touching the `PaymentProvider` interface. */
  correlationId?: string;
}

// EC:E12 — failure code normalization table (see spec §실패 코드 정규화)
const FAILURE_MAP: Record<string, { code: string; retryable: boolean; userMessage: string }> = {
  insufficient_funds: { code: 'insufficient_funds', retryable: true, userMessage: '카드 잔액이 부족합니다. 다른 결제수단을 시도해 주세요.' },
  card_declined: { code: 'card_declined', retryable: false, userMessage: '카드가 거절되었습니다. 발급사에 문의하거나 다른 카드를 사용해 주세요.' },
  expired_card: { code: 'expired_card', retryable: false, userMessage: '카드가 만료되었습니다. 카드 정보를 업데이트해 주세요.' },
  processing_error: { code: 'processing_error', retryable: true, userMessage: '일시적인 처리 오류입니다. 잠시 후 다시 시도해 주세요.' },
  incorrect_cvc: { code: 'incorrect_cvc', retryable: true, userMessage: 'CVC 번호가 올바르지 않습니다.' },
  incorrect_number: { code: 'incorrect_number', retryable: true, userMessage: '카드 번호가 올바르지 않습니다.' },
  authentication_required: { code: 'authentication_required', retryable: true, userMessage: '추가 인증이 필요합니다.' },
  lost_card: { code: 'lost_card', retryable: false, userMessage: '카드가 사용 정지되었습니다.' },
  stolen_card: { code: 'stolen_card', retryable: false, userMessage: '카드가 사용 정지되었습니다.' },
  api_connection_error: { code: 'provider_unavailable', retryable: true, userMessage: 'PG사 연결 오류입니다. 잠시 후 다시 시도해 주세요.' },
  api_error: { code: 'provider_unavailable', retryable: true, userMessage: 'PG사 오류입니다. 잠시 후 다시 시도해 주세요.' },
  rate_limit_error: { code: 'provider_unavailable', retryable: true, userMessage: '일시적으로 요청이 몰렸습니다. 잠시 후 다시 시도해 주세요.' },
};

// EC:E12 — normalize Stripe error -> PaymentFailure (pure)
export function normalizeFailure(input: { code?: string | null; declineCode?: string | null; message?: string | null }): PaymentFailure {
  const key = input.declineCode || input.code || '';
  const mapped = FAILURE_MAP[key];
  if (mapped) {
    return { code: mapped.code, providerCode: key, retryable: mapped.retryable, userMessage: mapped.userMessage };
  }
  return { code: 'unknown', providerCode: key || null, retryable: false, userMessage: input.message || '결제 중 알 수 없는 오류가 발생했습니다.' };
}

// EC:J8 — the core money() checks the amount is a safe integer at the provider boundary.
function money(amountMinor: number, currency: string): Money {
  return coreMoney(amountMinor, currency);
}

// EC:E7 — PaymentIntent.status -> PaymentStatus
function mapIntentStatus(status: Stripe.PaymentIntent.Status): PaymentStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
      return 'requires_action';
    case 'processing':
    case 'requires_capture':
      return 'pending';
    case 'canceled':
      return 'failed';
    default:
      return 'pending';
  }
}

function mapInvoiceStatus(status: Stripe.Invoice.Status | null): PaymentStatus {
  switch (status) {
    case 'paid':
      return 'succeeded';
    case 'open':
    case 'draft':
      return 'pending';
    case 'uncollectible':
    case 'void':
      return 'failed';
    default:
      return 'pending';
  }
}

function invoicePeriod(invoice: Stripe.Invoice): { start: Date; end: Date } | null {
  const line = invoice.lines?.data?.[0];
  if (!line?.period) return null;
  return { start: new Date(line.period.start * 1000), end: new Date(line.period.end * 1000) };
}

function failureFromLastError(err: Stripe.PaymentIntent.LastPaymentError | null | undefined): PaymentFailure | null {
  if (!err) return null;
  const declineCode = (err as { decline_code?: string }).decline_code ?? null;
  return normalizeFailure({ code: err.code ?? null, declineCode, message: err.message ?? null });
}

type SubscriptionInvoice = Stripe.Invoice & {
  readonly parent?: { readonly subscription_details?: {
    readonly subscription?: string | { readonly id: string } | null;
    readonly metadata?: Stripe.Metadata | null;
  } | null } | null;
};

function invoiceSubscriptionRef(invoice: SubscriptionInvoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  return typeof subscription === 'string' ? subscription : (subscription?.id ?? null);
}

function invoiceSubscriptionMetadata(invoice: SubscriptionInvoice): Stripe.Metadata {
  return invoice.parent?.subscription_details?.metadata ?? invoice.subscription_details?.metadata ?? {};
}

type StripeLineItemWithPrice = {
  readonly price?: string | { readonly id: string } | null;
  readonly pricing?: { readonly price_details?: { readonly price?: string | { readonly id: string } | null } | null } | null;
};

function lineItemPriceRef(line: StripeLineItemWithPrice | undefined): string | null {
  const legacyPrice = line?.price;
  if (typeof legacyPrice === 'string') return legacyPrice;
  if (legacyPrice?.id) return legacyPrice.id;
  const price = line?.pricing?.price_details?.price;
  return typeof price === 'string' ? price : (price?.id ?? null);
}

function invoiceDiscountAmount(invoice: Stripe.Invoice): number {
  return (invoice.total_discount_amounts ?? []).reduce((total, item) => total + item.amount, 0);
}

function invoiceSaleEvidence(invoice: Stripe.Invoice) {
  const subtotal = invoice.subtotal;
  if (subtotal == null) return null;
  return {
    providerSubtotal: money(subtotal, invoice.currency),
    discountAmount: money(invoiceDiscountAmount(invoice), invoice.currency),
    priceRef: lineItemPriceRef(invoice.lines?.data?.[0]),
    checkoutId: null,
    paymentLinkId: null,
    linkReference: null,
  };
}

// EC:E23 — a PaymentIntent stays 'succeeded' after its charge is refunded or disputed; the charge
// says what happened to the money. Only an expanded charge object is read (a bare id says nothing).
function chargeAdjustedStatus(status: PaymentStatus, charge: Stripe.PaymentIntent['latest_charge']): PaymentStatus {
  if (status !== 'succeeded' || !charge || typeof charge === 'string') return status;
  if (charge.disputed) return 'disputed';
  const refunded = charge.amount_refunded ?? 0;
  if (refunded <= 0) return status;
  return charge.refunded || refunded >= (charge.amount_captured ?? charge.amount ?? 0) ? 'refunded' : 'partially_refunded';
}

// EC:E7 E12 — normalize PaymentIntent -> Payment (pure)
export function normalizePaymentIntent(pi: Stripe.PaymentIntent, invoice?: Stripe.Invoice | null): Payment {
  const kind: PaymentKind = invoice ? 'subscription' : 'topup';
  const subscriptionId = invoice ? invoiceSubscriptionRef(invoice) : null;
  return {
    id: pi.id,
    customerId: '',
    provider: 'stripe',
    providerRef: pi.id,
    subscriptionId,
    amount: money(pi.amount, pi.currency),
    status: chargeAdjustedStatus(mapIntentStatus(pi.status), pi.latest_charge),
    kind,
    period: invoice ? invoicePeriod(invoice) : null,
    occurredAt: new Date(pi.created * 1000),
    failure: failureFromLastError(pi.last_payment_error),
    cashReceipt: null,
    saleEvidence: invoice ? invoiceSaleEvidence(invoice) : null,
    affiliateId: pi.metadata?.affiliateId ?? (invoice ? invoiceSubscriptionMetadata(invoice).affiliateId : undefined) ?? null,
    raw: invoice ? { ...pi, metadata: { ...pi.metadata, ...invoiceSubscriptionMetadata(invoice) } } : pi,
    providerRefAliases: refAliases([invoice?.id, (pi as unknown as { invoice?: unknown }).invoice, pi.latest_charge]), // EC:E24
  };
}

/** EC:E24 — the other ids Stripe uses for one payment (invoice, PaymentIntent, charge), as strings. */
function refAliases(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const id = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// EC:F(Stripe) — normalize Invoice -> Payment (subscription kind, pure)
export function normalizeInvoiceAsPayment(invoice: Stripe.Invoice, pi?: Stripe.PaymentIntent | null): Payment {
  const status = mapInvoiceStatus(invoice.status);
  const failure = invoice.status === 'open' && pi ? failureFromLastError(pi.last_payment_error) : null;
  return {
    id: invoice.id ?? invoice.number ?? '',
    customerId: '',
    provider: 'stripe',
    providerRef: invoice.id ?? '',
    subscriptionId: invoiceSubscriptionRef(invoice),
    amount: money(invoice.status === 'paid' ? invoice.amount_paid : (invoice.amount_paid || invoice.amount_due), invoice.currency),
    status,
    kind: 'subscription',
    period: invoicePeriod(invoice),
    occurredAt: new Date(invoice.created * 1000),
    failure,
    cashReceipt: null,
    saleEvidence: invoiceSaleEvidence(invoice),
    affiliateId: invoice.metadata?.affiliateId ?? invoiceSubscriptionMetadata(invoice).affiliateId ?? pi?.metadata?.affiliateId ?? null,
    raw: { ...invoice, metadata: { ...invoice.metadata, ...invoiceSubscriptionMetadata(invoice) } },
    providerRefAliases: refAliases([invoicePaymentIntentRef(invoice), pi?.latest_charge]), // EC:E24
  };
}

type ExpandedCheckoutSession = Stripe.Checkout.Session & {
  readonly payment_intent?: string | Stripe.PaymentIntent | null;
  readonly invoice?: string | Stripe.Invoice | null;
  readonly line_items?: { readonly data?: readonly StripeLineItemWithPrice[] } | null;
};

function checkoutSaleEvidence(session: ExpandedCheckoutSession) {
  if (session.amount_subtotal == null || session.amount_total == null) return null;
  return {
    providerSubtotal: money(session.amount_subtotal, session.currency ?? 'usd'),
    discountAmount: money(session.total_details?.amount_discount ?? 0, session.currency ?? 'usd'),
    priceRef: lineItemPriceRef(session.line_items?.data?.[0]),
    checkoutId: session.id,
    paymentLinkId: typeof session.payment_link === 'string' ? session.payment_link : (session.payment_link?.id ?? null),
    linkReference: session.client_reference_id ?? null,
  };
}

export function normalizeCheckoutSessionAsPayment(session: ExpandedCheckoutSession): Payment {
  const invoice = typeof session.invoice === 'object' && session.invoice ? session.invoice : null;
  const intent = typeof session.payment_intent === 'object' && session.payment_intent ? session.payment_intent : null;
  const noPaymentRequired = session.payment_status === 'no_payment_required' || session.amount_total === 0;
  // DC-07 — a 100% discount leaves Checkout with neither PaymentIntent nor invoice; the sale is a paid-zero
  // payment keyed by the session so the webhook can record it (and hand it to a person) instead of failing.
  const zeroBase: Payment | null = !invoice && !intent && noPaymentRequired ? {
    id: session.id, customerId: '', provider: 'stripe', providerRef: session.id, subscriptionId: null,
    amount: money(0, session.currency ?? 'usd'), status: 'succeeded', kind: 'topup', period: null,
    occurredAt: new Date(session.created * 1000), failure: null, cashReceipt: null, saleEvidence: null,
    affiliateId: null, raw: session, providerRefAliases: [],
  } : null;
  const base = invoice ? normalizeInvoiceAsPayment(invoice, intent) : intent ? normalizePaymentIntent(intent, null) : zeroBase;
  if (!base) {
    throw new PaymentKitError(`stripe checkout session ${session.id} has no payable reference`, 'provider_shape');
  }
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? base.subscriptionId);
  return {
    ...base,
    subscriptionId,
    kind: session.mode === 'subscription' ? 'subscription' : 'topup',
    saleEvidence: checkoutSaleEvidence(session),
    affiliateId: session.metadata?.affiliateId ?? base.affiliateId ?? null,
    raw: session,
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

/** Invoice → PaymentIntent id. Legacy API: `invoice.payment_intent`; API >= 2025-03-31 (basil): `invoice.payments.data[].payment.payment_intent`. */
export function invoicePaymentIntentRef(invoice: Stripe.Invoice): string | null {
  const anyInv = invoice as unknown as {
    payment_intent?: string | { id: string } | null;
    payments?: { data?: Array<{ payment?: { payment_intent?: string | { id: string } | null } }> } | null;
  };
  const legacy = anyInv.payment_intent;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy === 'object') return legacy.id;
  for (const p of anyInv.payments?.data ?? []) {
    const ref = p.payment?.payment_intent;
    if (typeof ref === 'string') return ref;
    if (ref && typeof ref === 'object') return ref.id;
  }
  return null;
}

// EC:F(Stripe) — normalize Subscription (pure). See spec "계약 메모" for id/customerId/planId sourcing.
/** Stripe API >= 2025-03-31 moved current_period_* from Subscription to SubscriptionItem. Read both. */
function subscriptionPeriod(sub: Stripe.Subscription): { start: number; end: number } {
  const anySub = sub as unknown as { current_period_start?: number; current_period_end?: number; items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> } };
  const item = anySub.items?.data?.[0];
  const start = anySub.current_period_start ?? item?.current_period_start;
  const end = anySub.current_period_end ?? item?.current_period_end;
  if (typeof start !== 'number' || typeof end !== 'number') {
    throw new PaymentKitError(`stripe subscription ${sub.id} has no current period (neither on subscription nor items[0])`, 'provider_shape');
  }
  return { start, end };
}

export function normalizeSubscription(sub: Stripe.Subscription): Subscription {
  const md = sub.metadata ?? {};
  const anchorDate = new Date(sub.billing_cycle_anchor * 1000);
  const period = subscriptionPeriod(sub);
  return {
    id: md.subscriptionId || sub.id,
    customerId: md.customerId || (typeof sub.customer === 'string' ? sub.customer : sub.customer.id),
    planId: md.planId || '',
    provider: 'stripe',
    providerRef: sub.id,
    status: SUB_STATUS[sub.status] ?? 'expired',
    currentPeriod: { start: new Date(period.start * 1000), end: new Date(period.end * 1000) },
    anchorDay: anchorDate.getUTCDate(),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    graceUntil: null,
    billingKey: null,
    billingCustomerRef: null, // EC:A60 — rendered like the Python dataclass field
    scheduledPlanId: null,
    currency: sub.currency ? sub.currency.toUpperCase() : null, // EC:A28
    version: 0, // provider-side row; the local repo row owns the EC:K1 optimistic lock
    createdAt: new Date(sub.created * 1000),
  };
}

function mapRefundStatus(status: string | null): RefundStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'pending';
  }
}

function mapRefundReason(reason: string): Stripe.RefundCreateParams.Reason {
  if (reason === 'duplicate' || reason === 'fraudulent') return reason;
  return 'requested_by_customer';
}

// EC:D4 D6 — normalize Refund (pure)
export function normalizeRefund(refund: Stripe.Refund, customerId: string, ruleId: string): Refund {
  return {
    id: refund.id,
    paymentId: typeof refund.payment_intent === 'string' ? refund.payment_intent : (refund.payment_intent?.id ?? ''),
    customerId,
    amount: money(refund.amount, refund.currency),
    status: mapRefundStatus(refund.status),
    providerRef: refund.id,
    creditsRevoked: 0,
    ruleId,
    reason: refund.reason ?? null,
    failure: refund.status === 'failed' ? normalizeFailure({ code: refund.failure_reason ?? null, message: refund.failure_reason ?? null }) : null,
    createdAt: new Date(refund.created * 1000),
  };
}

// EC:F(Stripe) — webhook event type mapping (pure). See spec "Webhook 이벤트 매핑"
export function mapEventType(event: Stripe.Event): NormalizedEventType {
  switch (event.type) {
    case 'invoice.paid':
      return 'payment.succeeded';
    case 'invoice.payment_failed':
      return 'subscription.payment_failed';
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      return session.mode === 'subscription' && !session.payment_link
        ? 'subscription.created'
        : 'payment.succeeded';
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      // avoid double-trigger with invoice.paid (E3)
      return pi.invoice ? 'unknown' : 'payment.succeeded';
    }
    case 'payment_intent.payment_failed':
      return 'payment.failed';
    case 'customer.subscription.created':
      return 'subscription.created';
    case 'customer.subscription.updated':
      return 'subscription.updated';
    case 'customer.subscription.deleted':
      return 'subscription.canceled';
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated':
      switch (mapRefundStatus(event.data.object.status)) {
        case 'succeeded': return 'refund.created';
        case 'failed': return 'refund.failed';
        case 'pending': return 'refund.pending';
      }
    case 'charge.refunded':
      return 'unknown'; // Charge totals are cumulative, not one refund operation.
    case 'charge.dispute.created':
      return 'dispute.opened';
    case 'charge.dispute.closed':
      return 'dispute.closed';
    default:
      return 'unknown';
  }
}

// EC:F(Stripe) — event -> NormalizedEvent (pure)
export function toNormalizedEvent(event: Stripe.Event): NormalizedEvent {
  const type = mapEventType(event);
  const obj = event.data.object as unknown as Record<string, unknown>;
  let customerRef: string | null = null;
  let subscriptionRef: string | null = null;
  let paymentRef: string | null = null;
  let refundRef: string | null = null;
  let disputeOutcome: 'won' | 'lost' | null = null;
  let amount: Money | null = null;

  switch (event.type) {
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const inv = obj as unknown as Stripe.Invoice;
      customerRef = typeof inv.customer === 'string' ? inv.customer : (inv.customer?.id ?? null);
      subscriptionRef = invoiceSubscriptionRef(inv);
      paymentRef = inv.id ?? null;
      amount = money(inv.amount_paid || inv.amount_due, inv.currency);
      break;
    }
    case 'checkout.session.completed': {
      const s = obj as unknown as Stripe.Checkout.Session;
      const paymentLinkId = typeof s.payment_link === 'string' ? s.payment_link : s.payment_link?.id;
      customerRef = paymentLinkId
        ? s.client_reference_id ?? null
        : (typeof s.customer === 'string' ? s.customer : s.customer?.id) ?? s.client_reference_id ?? null;
      subscriptionRef = typeof s.subscription === 'string' ? s.subscription : null;
      paymentRef = s.id;
      if (s.amount_total != null) amount = money(s.amount_total, s.currency ?? 'usd');
      break;
    }
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed': {
      const pi = obj as unknown as Stripe.PaymentIntent;
      customerRef = typeof pi.customer === 'string' ? pi.customer : (pi.customer?.id ?? null);
      paymentRef = pi.id;
      amount = money(pi.amount, pi.currency);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = obj as unknown as Stripe.Subscription;
      customerRef = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      subscriptionRef = sub.id;
      break;
    }
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated': {
      const refund = event.data.object;
      refundRef = refund.id;
      paymentRef = typeof refund.payment_intent === 'string' ? refund.payment_intent : (refund.payment_intent?.id ?? null);
      amount = money(refund.amount, refund.currency);
      break;
    }
    case 'charge.refunded': {
      const charge = obj as unknown as Stripe.Charge;
      customerRef = typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? null);
      paymentRef = typeof charge.payment_intent === 'string' ? charge.payment_intent : (charge.payment_intent?.id ?? null);
      amount = money(charge.amount_refunded, charge.currency);
      break;
    }
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const dispute = obj as unknown as Stripe.Dispute;
      paymentRef = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : (dispute.payment_intent?.id ?? null);
      amount = money(dispute.amount, dispute.currency);
      // EC:D21 — the verdict lives on the Dispute object (status won | lost | warning_closed | ...).
      if (event.type === 'charge.dispute.closed') disputeOutcome = dispute.status === 'won' ? 'won' : dispute.status === 'lost' ? 'lost' : null;
      break;
    }
    default:
      break;
  }

  return {
    id: event.id,
    provider: 'stripe',
    type,
    occurredAt: new Date(event.created * 1000),
    customerRef,
    subscriptionRef,
    paymentRef,
    refundRef,
    amount,
    disputeOutcome,
    raw: event,
  };
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly client: Stripe;
  private readonly webhookSecret: string;
  private readonly previousWebhookSecrets: string[];
  private readonly secretKey: string;
  private readonly logger: Logger;
  private readonly config: StripeProviderConfig;
  // EC:L5 — set only via config.correlationId / withCorrelationId(); overrides the per-call
  // idempotencyKey-derived value for every `provider.request` log line from this instance.
  private readonly correlationIdOverride: string | null;

  constructor(config: StripeProviderConfig) {
    this.config = config;
    this.client = new Stripe(config.secretKey, {
      ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
      ...(config.apiBase ? { host: config.apiBase.host, port: config.apiBase.port, protocol: config.apiBase.protocol } : {}),
    });
    this.webhookSecret = config.webhookSecret;
    this.previousWebhookSecrets = config.previousWebhookSecrets ?? [];
    this.secretKey = config.secretKey;
    this.logger = config.logger ?? new NoopLogger();
    this.correlationIdOverride = config.correlationId ?? null;
    // EC:L1 — the stripe-node SDK has no single request() choke point (every call site uses
    // `this.client.<resource>.<method>()` directly), but it does emit one 'response' event per
    // HTTP call regardless of which method triggered it — including on non-2xx responses, before
    // the SDK throws. That's the one hook point that covers every call site without touching each
    // of them individually. Trade-off (documented, not fixed — out of this task's scope): the event
    // only carries `status`, not the parsed Stripe error body, so `providerErrorCode` isn't
    // available here the way it is for the other 3 providers' hand-rolled request() wrappers.
    this.client.on('response', (event) => {
      void this.logger.log({
        level: event.status >= 400 ? 'warn' : 'info',
        event: 'provider.request',
        provider: 'stripe',
        method: event.method,
        path: event.path,
        status: event.status,
        durationMs: event.elapsed,
        correlationId: this.correlationIdOverride ?? event.idempotency_key ?? null,
        providerErrorCode: event.status >= 400 ? 'unknown' : null,
      });
    });
  }

  // EC:L5 — a scoped clone carrying a fixed correlationId for every `provider.request` log line it
  // emits. Not part of the `PaymentProvider` interface (duck-typed — webhook.process checks for it
  // with `typeof provider.withCorrelationId === 'function'`) so this stays additive: no change to
  // the shared core interface, no ripple into lifecycle/refund/credits/cs call sites. Reconstructs
  // the Stripe SDK client (cheap — no network I/O at construction) rather than shallow-cloning,
  // because the 'response' listener closure above is bound to the instance it was registered on;
  // a shallow clone sharing `this.client` would still log the ORIGINAL instance's correlationId.
  withCorrelationId(correlationId: string): PaymentProvider {
    return new StripeProvider({ ...this.config, correlationId });
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: true, meters: true, scheduling: 'provider', webhookSignature: true, checkout: 'hosted', upgradeGrant: 'sync' };
  }

  async createCustomer(input: { email: string; name?: string; metadata?: Record<string, string> }): Promise<{ ref: string }> {
    const customer = await this.client.customers.create({ email: input.email, name: input.name, metadata: input.metadata });
    return { ref: customer.id };
  }

  // DC-07 — 100% discounts are not supported: refuse before any provider session exists.
  private async refuseFullDiscount(code: string, price: { readonly amountMinor: number; readonly currency: string }): Promise<void> {
    const promotion = await this.client.promotionCodes.retrieve(code) as unknown as { coupon?: unknown; promotion?: { coupon?: unknown } | null };
    let coupon = promotion.coupon ?? promotion.promotion?.coupon;
    if (typeof coupon === 'string') coupon = await this.client.coupons.retrieve(coupon);
    const c = coupon as { percent_off?: number | null; amount_off?: number | null; currency?: string | null } | null | undefined;
    if (!c) return;
    const percentFull = typeof c.percent_off === 'number' && c.percent_off >= 100;
    const amountFull = typeof c.amount_off === 'number' && c.amount_off >= price.amountMinor
      && (!c.currency || c.currency.toUpperCase() === price.currency.toUpperCase());
    if (percentFull || amountFull) {
      throw new PaymentKitError('100% discounts are not supported', 'full_discount_unsupported', { code });
    }
  }

  // EC:E6 — idempotencyKey passed through to Stripe request options
  async createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
    const priceRef = input.price.providerPriceRefs?.stripe;
    if (!priceRef) {
      throw new PaymentKitError(
        `set plan_prices.provider_price_refs for plan ${input.plan.id} / ${input.price.currency} (see docs/GUIDE.md)`,
        'missing_provider_price_ref',
        { planId: input.plan.id },
      );
    }
    const mode: Stripe.Checkout.SessionCreateParams.Mode = input.mode === 'subscription' ? 'subscription' : 'payment';
    const metadata = {
      ...(input.metadata ?? {}),
      planId: input.plan.id,
      ...(input.affiliateId ? { affiliateId: input.affiliateId } : {}),
    };
    try {
      if (input.presetDiscountCode) await this.refuseFullDiscount(input.presetDiscountCode, input.price);
      const session = await this.client.checkout.sessions.create(
        {
          mode,
          client_reference_id: input.customerRef,
          customer: input.customerRef,
          line_items: [{ price: priceRef, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata,
          ...(input.presetDiscountCode
            ? { discounts: [{ promotion_code: input.presetDiscountCode }] }
            : input.allowDiscountCodes ? { allow_promotion_codes: true } : {}),
          ...(mode === 'subscription'
            ? {
                subscription_data: {
                  metadata,
                  // SB-03 — Stripe must own the trial so Checkout does not charge on day one.
                  ...(input.plan.trialDays > 0 ? { trial_period_days: input.plan.trialDays } : {}),
                },
              }
            : { payment_intent_data: { metadata } }),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: session.id, url: session.url ?? '', providerRef: session.id };
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError)) throw error;
      const statusCode = error.statusCode;
      const definitive = statusCode !== undefined && statusCode >= 400 && statusCode < 500
        && statusCode !== 408 && statusCode !== 409 && statusCode !== 429;
      const normalized = normalizeFailure({ code: error.code ?? error.rawType, declineCode: error.decline_code, message: error.message });
      // OT-03 — the CS layer needs a typed status-bearing error to distinguish a definitive
      // provider rejection from a timeout, connection loss, conflict, rate limit, or 5xx.
      throw new ProviderError(
        error.message,
        { ...normalized, retryable: !definitive },
        { status: statusCode, providerCode: normalized.providerCode },
        statusCode,
      );
    }
  }

  // EC:E7 E12 — accepts pi_... or in_...
  async getPayment(providerRef: string): Promise<Payment> {
    if (providerRef.startsWith('cs_')) {
      const session = await this.client.checkout.sessions.retrieve(providerRef, {
        expand: ['line_items', 'payment_intent', 'invoice'],
      });
      const withIntent = typeof session.payment_intent === 'string'
        ? { ...session, payment_intent: await this.client.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] }) }
        : session;
      const withInvoice = typeof withIntent.invoice === 'string'
        ? { ...withIntent, invoice: await this.client.invoices.retrieve(withIntent.invoice) }
        : withIntent;
      return normalizeCheckoutSessionAsPayment(withInvoice);
    }
    if (providerRef.startsWith('in_')) {
      // No `expand: ['payment_intent']` — the field does not exist on API >= 2025-03-31 and the expand would 400.
      const invoice = await this.client.invoices.retrieve(providerRef);
      const piRef = invoicePaymentIntentRef(invoice);
      const pi = piRef ? await this.client.paymentIntents.retrieve(piRef) : null;
      return normalizeInvoiceAsPayment(invoice, pi);
    }
    // EC:E23 — latest_charge carries refunds/disputes the PaymentIntent status never shows.
    const pi = await this.client.paymentIntents.retrieve(providerRef, { expand: ['invoice', 'latest_charge'] });
    const invoice = typeof pi.invoice === 'object' && pi.invoice ? pi.invoice : null;
    return normalizePaymentIntent(pi, invoice);
  }

  // EC:H4 E1 — dedup invoices vs bare payment intents
  async listPayments(input: { customerRef: string; since: Date }): Promise<Payment[]> {
    const gte = Math.floor(input.since.getTime() / 1000);
    const invoices = await this.client.invoices.list({ customer: input.customerRef, created: { gte } });
    const invoicePIs = new Set(invoices.data.map((inv) => invoicePaymentIntentRef(inv)).filter(Boolean));
    const payments: Payment[] = invoices.data.map((inv) => normalizeInvoiceAsPayment(inv));
    const intents = await this.client.paymentIntents.list({ customer: input.customerRef, created: { gte } });
    for (const pi of intents.data) {
      if (invoicePIs.has(pi.id)) continue;
      payments.push(normalizePaymentIntent(pi, null));
    }
    return payments;
  }

  // EC:E3 — re-fetch current state
  async getSubscription(providerRef: string): Promise<Subscription> {
    const sub = await this.client.subscriptions.retrieve(providerRef);
    return normalizeSubscription(sub);
  }

  // EC:A1 — proration + anchor reset
  async changeSubscription(
    providerRef: string,
    input: { newPriceRef: string; proration: 'immediate' | 'none'; resetAnchor: boolean },
  ): Promise<Subscription> {
    const current = await this.client.subscriptions.retrieve(providerRef);
    const item = current.items.data[0];
    const sub = await this.client.subscriptions.update(providerRef, {
      items: [{ id: item.id, price: input.newPriceRef }],
      // I-4 — an immediate change invoices the proration now and fails when that payment fails, so the
      // kit grants the upgrade's credits only for money Stripe collected (not a later invoice, and not an
      // incomplete change Stripe applies under its default allow_incomplete).
      ...(input.proration === 'immediate'
        ? { proration_behavior: 'always_invoice' as const, payment_behavior: 'error_if_incomplete' as const }
        : { proration_behavior: 'none' as const }),
      ...(input.resetAnchor ? { billing_cycle_anchor: 'now' } : {}),
    });
    return normalizeSubscription(sub);
  }

  // EC:A5
  async cancelSubscription(providerRef: string, input: { atPeriodEnd: boolean }): Promise<Subscription> {
    const sub = input.atPeriodEnd
      ? await this.client.subscriptions.update(providerRef, { cancel_at_period_end: true })
      : await this.client.subscriptions.cancel(providerRef);
    return normalizeSubscription(sub);
  }

  // EC:A23 — undo `cancel_at_period_end`. Stripe rejects an `update` on a subscription whose
  // status is already fully `canceled` (there's nothing left to un-set), so this pre-checks status
  // and throws our own `not_reactivatable` with the real Stripe status rather than surfacing a raw
  // Stripe API error to the caller.
  async uncancelSubscription(providerRef: string): Promise<Subscription> {
    const current = await this.client.subscriptions.retrieve(providerRef);
    if (current.status === 'canceled') {
      throw new PaymentKitError(
        `stripe subscription ${providerRef} is fully canceled and cannot be reactivated (status=${current.status})`,
        'not_reactivatable',
        { id: providerRef, status: current.status },
      );
    }
    const sub = await this.client.subscriptions.update(providerRef, { cancel_at_period_end: false });
    return normalizeSubscription(sub);
  }

  async chargeBillingKey(): Promise<Payment> {
    throw new PaymentKitError('billing key charge unsupported for stripe (native subscriptions)', 'unsupported');
  }

  // EC:D4 D6
  async refund(input: { paymentRef: string; amount: Money; reason: string; idempotencyKey: string; extra?: Record<string, unknown> }): Promise<Refund> {
    let paymentIntentRef = input.paymentRef;
    let customerId = '';
    if (input.paymentRef.startsWith('in_')) {
      const invoice = await this.client.invoices.retrieve(input.paymentRef);
      const piRef = invoicePaymentIntentRef(invoice);
      if (!piRef) throw new PaymentKitError(`invoice ${input.paymentRef} has no payment intent to refund`, 'provider_shape');
      paymentIntentRef = piRef;
      customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? '');
    }
    const refund = await this.client.refunds.create(
      { payment_intent: paymentIntentRef, amount: input.amount.amountMinor, reason: mapRefundReason(input.reason) },
      { idempotencyKey: input.idempotencyKey },
    );
    return normalizeRefund(refund, customerId, 'D4');
  }

  // EC:C4 — outbox reports through here; local usage_events remains source of truth
  async reportUsage(input: { meter: string; customerRef: string; quantity: number; occurredAt: Date; idempotencyKey: string }): Promise<void> {
    await this.client.billing.meterEvents.create({
      event_name: input.meter,
      payload: { stripe_customer_id: input.customerRef, value: String(input.quantity) },
      identifier: input.idempotencyKey,
      timestamp: Math.floor(input.occurredAt.getTime() / 1000),
    });
  }

  // EC:E4
  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string; receivedAt?: Date }): Promise<NormalizedEvent> {
    const sig = input.headers['stripe-signature'] ?? input.headers['Stripe-Signature'];
    if (!sig) throw new WebhookSignatureError('missing stripe-signature header');
    // EC:E17 — freshness (300 s) is enforced at receipt against the wall clock; a re-verify of a
    // stored row (receivedAt set) checks the signature only. stripe-node treats 0 as "default"
    // (`tolerance || 300`) and skips the age check only for tolerance <= 0 after that, hence -1.
    // EC:E20 — the current secret first, then secrets being rotated out.
    let lastError: unknown;
    // EC:E21 — secrets being rotated out only re-verify stored rows (receivedAt set); at receipt only
    // the current secret counts, so a secret rotated out after a leak cannot sign new events.
    for (const secret of input.receivedAt ? [this.webhookSecret, ...this.previousWebhookSecrets] : [this.webhookSecret]) {
      try {
        return toNormalizedEvent(this.client.webhooks.constructEvent(input.rawBody, sig, secret, input.receivedAt ? -1 : 300));
      } catch (err) {
        lastError = err;
      }
    }
    throw new WebhookSignatureError((lastError as Error).message);
  }

  /**
   * NOT part of the PaymentProvider contract. Test-mode-only escape hatch for `boilpayment live`
   * (docs/ARCHITECTURE.md live-verification tooling): creates and confirms a real Stripe
   * PaymentIntent server-side using the `pm_card_visa` test payment method, so a "real round
   * trip" can be proven without a browser completing Stripe Checkout. Guarded to `sk_test_`
   * keys so it can never fire against live mode even if called by mistake.
   */
  async createTestPayment(input: { amount: Money; customerRef?: string; idempotencyKey: string }): Promise<Payment> {
    if (!this.secretKey.startsWith('sk_test_')) {
      throw new PaymentKitError('createTestPayment refuses to run against a non-test-mode secret key', 'test_mode_required');
    }
    const pi = await this.client.paymentIntents.create(
      {
        amount: input.amount.amountMinor,
        currency: input.amount.currency.toLowerCase(),
        customer: input.customerRef,
        payment_method: 'pm_card_visa',
        payment_method_types: ['card'],
        confirm: true,
        off_session: true,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return normalizePaymentIntent(pi, null);
  }
}
