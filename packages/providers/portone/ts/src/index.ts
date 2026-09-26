// boilpayment — PortOne V2 provider.
// See spec/portone.pseudo.md for the full contract. Endpoints/request-response shapes
// verified 2026-09-09 against the real V2 OpenAPI spec (portone-io/server-sdk repo,
// codegen/openapi.json — the developers.portone.io site itself is JS-rendered and did
// not yield full schemas via fetch, so the raw OpenAPI source was used instead) and the
// Standard Webhooks spec. This resolved two previously-"unverified" endpoints and
// surfaced three additional real bugs in this file — see inline NOTE comments at
// normalizePortoneStatus, issueBillingKey, chargeBillingKey, schedulePayment,
// cancelSchedules, and listPayments.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  PaymentProvider,
  ProviderCapabilities,
  CreateCheckoutInput,
  Checkout,
  Payment,
  PaymentStatus,
  PaymentFailure,
  Subscription,
  Refund,
  Money,
  NormalizedEvent,
  NormalizedEventType,
  Logger,
} from 'boilpayment-core';
import { PaymentKitError, WebhookSignatureError, ProviderError, NoopLogger, money } from 'boilpayment-core'; // money(): EC:J8 safe-integer check at the provider boundary

const BASE_URL = 'https://api.portone.io';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ── pure normalizers (exported for smoke/unit use) ──────────────────────────

/**
 * EC:E8 — VIRTUAL_ACCOUNT_ISSUED must map to pending; grants only happen on PAID.
 * Status literals verified against the real V2 OpenAPI spec (Payment discriminator:
 * CANCELLED | FAILED | PAID | PARTIAL_CANCELLED | PAY_PENDING | READY |
 * VIRTUAL_ACCOUNT_ISSUED) — the pending "in flight" status is `PAY_PENDING`, not
 * `PENDING` as an earlier draft of this file assumed.
 */
export function normalizePortoneStatus(status: string): PaymentStatus {
  switch (status) {
    case 'READY':
    case 'PAY_PENDING':
    case 'VIRTUAL_ACCOUNT_ISSUED':
      return 'pending';
    case 'PAID':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'refunded';
    case 'PARTIAL_CANCELLED':
      return 'partially_refunded';
    default:
      return 'pending';
  }
}

export type CashReceiptType = 'personal' | 'business';
export type CashReceiptStatus = 'issued' | 'issue_failed' | 'canceled';

/** EC:K2 K3 K5 K6 — normalized cash receipt shape shared by issue/cancel/get. */
export interface CashReceipt {
  paymentRef: string;
  type: CashReceiptType | null;
  status: CashReceiptStatus;
  amount: Money | null;
  issueNumber: string | null;
  receiptUrl: string | null;
  raw: unknown;
}

/**
 * EC:K2 K3 K5 K6 K7. `raw` is a PortOne V2 CashReceipt (oneOf IssuedCashReceipt /
 * IssueFailedCashReceipt / CancelledCashReceipt, discriminated by `status`) — confirmed against
 * the real V2 OpenAPI spec (portone-io/server-sdk `codegen/openapi.json`, 2026-09-09; not
 * exercised against the live API — see `getCashReceipt`/`issueCashReceipt` doc comments).
 */
export function normalizePortoneCashReceipt(raw: any): CashReceipt {
  const status: CashReceiptStatus = raw.status === 'CANCELLED' ? 'canceled' : raw.status === 'ISSUE_FAILED' ? 'issue_failed' : 'issued';
  return {
    paymentRef: raw.paymentId,
    type: raw.type === 'CORPORATE' ? 'business' : raw.type === 'PERSONAL' ? 'personal' : null,
    status,
    amount: typeof raw.amount === 'number' ? money(raw.amount, raw.currency ?? 'KRW') : null,
    issueNumber: raw.issueNumber ?? null,
    receiptUrl: raw.url ?? null,
    raw,
  };
}

// EC:E9 — many PGs behind PortOne, each with its own failure codes. Heuristic only.
export function normalizePortoneFailure(failure: { pgCode?: string | null; pgMessage?: string | null; reason?: string | null } | null | undefined): PaymentFailure | null {
  if (!failure) return null;
  const pgCode = String(failure.pgCode ?? '').toUpperCase();
  let code = 'unknown';
  let retryable = false;
  if (pgCode.includes('INSUFFICIENT')) code = 'insufficient_funds';
  else if (pgCode.includes('EXPIRED')) code = 'expired_card';
  else if (pgCode.includes('DECLINE') || pgCode.includes('REJECT')) code = 'card_declined';
  else if (pgCode.includes('TIMEOUT') || pgCode.includes('NETWORK') || pgCode.includes('UNAVAILABLE')) {
    code = 'provider_unavailable';
    retryable = true;
  }
  return {
    code,
    providerCode: failure.pgCode ?? null,
    retryable,
    userMessage: failure.pgMessage ?? failure.reason ?? '결제에 실패했습니다.',
  };
}

/** EC:F/E8/E9. `raw` is the PortOne V2 Payment object. */
export function normalizePortonePayment(raw: any): Payment {
  const status = normalizePortoneStatus(raw.status);
  const amount = raw.amount ?? {};
  return {
    id: raw.id ?? raw.paymentId,
    customerId: raw.customer?.id ?? '',
    provider: 'portone',
    providerRef: raw.id ?? raw.paymentId,
    subscriptionId: null,
    amount: money(amount.total ?? amount, raw.currency ?? 'KRW'),
    status,
    kind: 'subscription',
    period: null,
    occurredAt: new Date(raw.paidAt ?? raw.requestedAt ?? Date.now()),
    failure: status === 'failed' ? normalizePortoneFailure(raw.failure) : null,
    cashReceipt: null,
    raw,
  };
}

function normalizePortoneRefund(raw: any, input: { paymentRef: string; amount: Money; reason: string }): Refund {
  const cancellation = raw.cancellation ?? raw;
  return {
    id: cancellation.id ?? '',
    paymentId: input.paymentRef,
    // NOTE (contract gap — see spec "계약 변경 제안"): customerId/ruleId unknown to the
    // provider adapter. refund.execute must overwrite these before persisting.
    customerId: '',
    amount: money(cancellation.totalAmount ?? cancellation.amount ?? input.amount.amountMinor, input.amount.currency),
    status: cancellation.status === 'SUCCEEDED' ? 'succeeded' : cancellation.status === 'FAILED' ? 'failed' : 'pending',
    providerRef: cancellation.id ?? null,
    creditsRevoked: 0,
    ruleId: '',
    reason: input.reason,
    failure: null,
    createdAt: new Date(cancellation.cancelledAt ?? cancellation.requestedAt ?? Date.now()),
  } as Refund;
}

/** EC:E3/E4 — normalizes the notification only; caller MUST re-fetch before acting. */
export function mapPortoneWebhook(body: any): NormalizedEvent {
  const type: string = body.type ?? 'unknown';
  const data = body.data ?? {};
  let normType: NormalizedEventType = 'unknown';
  switch (type) {
    case 'Transaction.Paid':
      normType = 'payment.succeeded';
      break;
    case 'Transaction.Failed':
      normType = 'payment.failed';
      break;
    case 'Transaction.Cancelled':
    case 'Transaction.PartialCancelled':
      normType = 'refund.created';
      break;
    case 'Transaction.VirtualAccountIssued':
    case 'Transaction.PayPending':
      normType = 'payment.pending';
      break;
    case 'Transaction.CancelPending':
      normType = 'refund.pending';
      break;
    case 'Transaction.DisputeCreated':
      normType = 'dispute.opened';
      break;
    case 'Transaction.DisputeResolved':
      normType = 'dispute.closed';
      break;
    default:
      normType = 'unknown'; // includes BillingKey.* — logged, not acted on (per brief)
  }
  const timestamp = body.timestamp ?? new Date().toISOString();
  return {
    // Overwritten with headers['webhook-id'] by verifyWebhook (the true Standard
    // Webhooks message id). This fallback is only used when mapping raw bodies directly.
    id: `${type}:${data.paymentId ?? data.billingKey ?? 'na'}${data.cancellationId ? `:${data.cancellationId}` : ''}:${timestamp}`,
    provider: 'portone',
    type: normType,
    occurredAt: new Date(timestamp),
    customerRef: null,
    subscriptionRef: null,
    paymentRef: data.paymentId ?? null,
    refundRef: normType.startsWith('refund.') ? data.cancellationId ?? null : null,
    amount: null,
    raw: body,
  };
}

// ── config / extra types ─────────────────────────────────────────────────────

export interface PortoneProviderConfig {
  apiSecret: string;
  storeId: string;
  webhookSecret: string; // "whsec_..." per Standard Webhooks
  /** EC:E20 — secrets being rotated out; a stored webhook signed with one still re-verifies. */
  previousWebhookSecrets?: string[];
  channelKey?: string;
  /**
   * EC:A43 — 'self' (default): lifecycle.scheduler.tick charges the billing key each period (the path the kit
   * implements and tests). 'provider' leaves renewals to PortOne's schedule API: the app must call
   * schedulePayment itself and route the resulting webhook; the kit does neither.
   */
  scheduling?: 'provider' | 'self';
  /** Override the API host, e.g. the local mock: "http://127.0.0.1:12212". Defaults to https://api.portone.io. */
  apiBase?: string;
  /** EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2). Defaults to NoopLogger. */
  logger?: Logger;
  /** EC:L5 — overrides the correlationId logged for every `provider.request` event from this
   * instance (`request()` has no per-call idempotencyKey threaded in today, so this is the only
   * source — previously every portone `provider.request` log line had none at all). Prefer
   * `provider.withCorrelationId(id)` over setting this directly. */
  correlationId?: string;
}

/** EC:K2 K3 K4 — `paymentRef` == our Payment.providerRef == PortOne `paymentId`. */
export interface PortoneIssueCashReceiptInput {
  paymentRef: string;
  type: CashReceiptType;
  /** Personal: phone number / cash receipt card number. Business: 사업자등록번호. */
  customerIdentityNumber: string;
  orderName?: string;
  taxFreeAmountMinor?: number;
  customerName?: string;
  customerEmail?: string;
  customerPhoneNumber?: string;
}

type FetchLike = typeof fetch;

export class PortoneProvider implements PaymentProvider {
  readonly name = 'portone' as const;
  private readonly apiSecret: string;
  private readonly storeId: string;
  private readonly webhookSecret: string;
  private readonly previousWebhookSecrets: string[];
  readonly channelKey?: string;
  private readonly scheduling: 'provider' | 'self';
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly logger: Logger;
  // EC:L5 — set only via config.correlationId / withCorrelationId(); the only source of
  // correlationId for `provider.request` log lines (request() has no per-call idempotencyKey).
  private readonly correlationIdOverride: string | null;

  constructor(config: PortoneProviderConfig, fetchImpl: FetchLike = fetch) {
    this.apiSecret = config.apiSecret;
    this.storeId = config.storeId;
    this.webhookSecret = config.webhookSecret;
    this.previousWebhookSecrets = config.previousWebhookSecrets ?? [];
    this.channelKey = config.channelKey;
    this.scheduling = config.scheduling ?? 'self';
    this.fetchImpl = fetchImpl;
    this.baseUrl = config.apiBase ?? BASE_URL;
    this.logger = config.logger ?? new NoopLogger();
    this.correlationIdOverride = config.correlationId ?? null;
  }

  // EC:L5 — a scoped clone carrying a fixed correlationId for every `provider.request` log line it
  // emits. Not part of the `PaymentProvider` interface (duck-typed — webhook.process checks for it
  // with `typeof provider.withCorrelationId === 'function'`), so this stays additive: no change to
  // the shared core interface, no ripple into lifecycle/refund/credits/cs call sites. A cheap
  // shallow clone is correct here because `request()` below is a normal prototype method that
  // reads `this` at call time, not a closure bound at construction.
  withCorrelationId(correlationId: string): PaymentProvider {
    const clone = Object.create(PortoneProvider.prototype) as PortoneProvider;
    Object.assign(clone, this, { correlationIdOverride: correlationId });
    return clone;
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: this.scheduling, webhookSignature: true, checkout: 'hosted' };
  }

  // EC:L1 — one `provider.request` event per HTTP call, redacted (EC:L2) by the Logger implementation.
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { Authorization: `PortOne ${this.apiSecret}`, 'Content-Type': 'application/json' };
    const startedAt = Date.now();
    let status: number | undefined;
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const failure = normalizePortoneFailure(json.failure ?? { pgCode: json.type, pgMessage: json.message }) ?? {
          code: 'unknown',
          providerCode: json.type ?? null,
          retryable: false,
          userMessage: json.message ?? 'portone api error',
        };
        await this.logger.log({
          level: 'warn', event: 'provider.request', provider: 'portone', method, path, status,
          durationMs: Date.now() - startedAt, correlationId: this.correlationIdOverride ?? null,
          providerErrorCode: failure.code, requestBody: body, responseBody: json,
        });
        throw new ProviderError(json.message ?? `portone api error (${res.status})`, failure, json, res.status);
      }
      await this.logger.log({
        level: 'info', event: 'provider.request', provider: 'portone', method, path, status,
        durationMs: Date.now() - startedAt, correlationId: this.correlationIdOverride ?? null,
        providerErrorCode: null, requestBody: body, responseBody: json,
      });
      return json;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      await this.logger.log({
        level: 'error', event: 'provider.request', provider: 'portone', method, path, status: status ?? null,
        durationMs: Date.now() - startedAt, correlationId: this.correlationIdOverride ?? null,
        providerErrorCode: 'network_error', requestBody: body,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async createCustomer(input: { email: string; name?: string; metadata?: Record<string, string> }): Promise<{ ref: string }> {
    // EC:F — PortOne V2 has no standalone customer-create API; customer is inline per payment.
    const provided = input.metadata?.customerId;
    if (provided) return { ref: provided };
    return { ref: 'cus_' + sha256(input.email).slice(0, 40) };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
    const paymentId = 'pay_' + sha256(input.idempotencyKey).slice(0, 40); // EC:E6
    const sep = input.successUrl.includes('?') ? '&' : '?';
    const url = `${input.successUrl}${sep}paymentId=${encodeURIComponent(paymentId)}`;
    return { id: paymentId, url, providerRef: paymentId };
  }

  /** Extra method — EC:E13/E10, server-side re-fetch + amount verification before granting. */
  async confirmPayment(paymentId: string, expectedAmount: Money): Promise<Payment> {
    const raw = await this.request('GET', `/payments/${encodeURIComponent(paymentId)}`);
    if (raw.status !== 'PAID') {
      throw new PaymentKitError(`portone payment ${paymentId} is not PAID (status=${raw.status})`, 'payment_not_paid');
    }
    const total = raw.amount?.total ?? raw.amount;
    if (total !== expectedAmount.amountMinor) {
      throw new PaymentKitError(`portone payment amount mismatch: expected ${expectedAmount.amountMinor}, got ${total}`, 'amount_mismatch'); // EC:E10
    }
    return normalizePortonePayment(raw);
  }

  /**
   * Extra method — EC:F billing key issuance.
   * Confirmed against the real V2 OpenAPI spec (portone-io/server-sdk `codegen/openapi.json`,
   * fetched 2026-09-09): `POST /billing-keys` (IssueBillingKeyBody -> IssueBillingKeyResponse)
   * IS a server-side issuance path (in addition to the client SDK's requestIssueBillingKey).
   * The response nests the key under `billingKeyInfo.billingKey`, not top-level `billingKey`
   * as an earlier draft of this file assumed — that was a real bug, fixed here.
   */
  async issueBillingKey(input: { customer: Record<string, unknown>; method?: Record<string, unknown> }): Promise<{ billingKey: string; raw: unknown }> {
    const raw = await this.request('POST', '/billing-keys', { storeId: this.storeId, channelKey: this.channelKey, ...input });
    return { billingKey: raw.billingKeyInfo?.billingKey, raw };
  }

  async chargeBillingKey(input: { billingKey: string; amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment> {
    // orderId is used as PortOne's {paymentId} path segment — PortOne's idempotency model
    // is "caller supplies a unique paymentId per attempt" rather than an Idempotency-Key header.
    let raw: any;
    try {
      raw = await this.request('POST', `/payments/${encodeURIComponent(input.orderId)}/billing-key`, {
        storeId: this.storeId,
        billingKey: input.billingKey,
        orderName: 'Subscription charge',
        amount: { total: input.amount.amountMinor },
        currency: input.amount.currency,
        customer: { id: input.customerRef },
      });
    } catch (err) {
      // EC:A34 — a retried charge whose paymentId was already paid: PortOne answers ALREADY_PAID. The
      // charge is idempotent per paymentId, so the answer is that payment, not an error or a decline.
      if (err instanceof ProviderError && (err.details as { type?: string } | undefined)?.type === 'ALREADY_PAID') {
        return this.getPayment(input.orderId);
      }
      throw err;
    }
    // Confirmed against the real V2 OpenAPI spec: PayWithBillingKeyResponse is
    // `{ payment: BillingKeyPaymentSummary }` where BillingKeyPaymentSummary is only
    // `{ pgTxId, paidAt }` — NOT a full Payment object as an earlier draft assumed
    // (normalizePortonePayment(raw.payment) would have produced a Payment with an
    // undefined status/amount/id). A 200 response here means the charge succeeded
    // synchronously (failures come back as a non-2xx PayWithBillingKeyError, handled by
    // request() above), so the normalized Payment is built from what we already know
    // (orderId, amount, currency, customerRef) plus the summary's paidAt/pgTxId.
    const summary = raw.payment ?? raw;
    return normalizePortonePayment({
      id: input.orderId,
      status: 'PAID',
      amount: { total: input.amount.amountMinor },
      currency: input.amount.currency,
      customer: { id: input.customerRef },
      paidAt: summary.paidAt,
      requestedAt: summary.paidAt,
      pgTxId: summary.pgTxId,
    });
  }

  /**
   * Extra method — EC:F, scheduling='provider' path: reserve the next charge with PortOne.
   * Confirmed against the real V2 OpenAPI spec: CreatePaymentScheduleBody is
   * `{ payment: BillingKeyPaymentScheduleInput, timeToPay }` — the billing-key payment
   * fields must be nested under `payment`, not sent flat as an earlier draft did.
   */
  async schedulePayment(input: { billingKey: string; amount: Money; orderId: string; customerRef: string; timeToPay: Date }): Promise<unknown> {
    return this.request('POST', `/payments/${encodeURIComponent(input.orderId)}/schedule`, {
      payment: {
        storeId: this.storeId,
        billingKey: input.billingKey,
        orderName: 'Subscription charge',
        amount: { total: input.amount.amountMinor },
        currency: input.amount.currency,
        customer: { id: input.customerRef },
      },
      timeToPay: input.timeToPay.toISOString(),
    });
  }

  /**
   * Extra method — EC:F.
   * Confirmed against the real V2 OpenAPI spec: the cancel-schedule endpoint is
   * `DELETE /payment-schedules` (NOT `/payments/{paymentId}/schedule` as an earlier draft
   * assumed — that path/method combination doesn't exist), taking `{ storeId, billingKey?,
   * scheduleIds? }` (at least one of billingKey/scheduleIds required) and returning
   * `{ revokedScheduleIds, revokedAt }`. There is no way to cancel schedules by paymentId.
   */
  async cancelSchedules(input: { billingKey?: string; scheduleIds?: string[] }): Promise<unknown> {
    if (!input.billingKey && !(input.scheduleIds && input.scheduleIds.length > 0)) {
      throw new PaymentKitError('cancelSchedules requires billingKey or scheduleIds', 'invalid_request');
    }
    const body: Record<string, unknown> = { storeId: this.storeId };
    if (input.billingKey) body.billingKey = input.billingKey;
    if (input.scheduleIds) body.scheduleIds = input.scheduleIds;
    return this.request('DELETE', '/payment-schedules', body);
  }

  async getPayment(providerRef: string): Promise<Payment> {
    const raw = await this.request('GET', `/payments/${encodeURIComponent(providerRef)}`);
    return normalizePortonePayment(raw);
  }

  // EC:A38 — the orderId the kit sends is the PortOne paymentId. 404 = no such payment.
  async getPaymentByOrderId(orderId: string): Promise<Payment | null> {
    try {
      return await this.getPayment(orderId);
    } catch (err) {
      if (err instanceof ProviderError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  async listPayments(input: { customerRef: string; since: Date }): Promise<Payment[]> {
    // Confirmed against the real V2 OpenAPI spec: GET /payments takes ONE query parameter
    // named `requestBody` whose value is the URL-encoded JSON body (GetPaymentsBody =
    // { page?, filter? }) — a PortOne convention for GET endpoints with complex filters,
    // not the `filter.from`/`filter.customer.id` flat query params an earlier draft used.
    // More importantly: PaymentFilterInput has NO customer-id field at all (its full field
    // list is merchantId/storeId/timestampType/from/until/status/methods/pgProvider/isTest/
    // isScheduled/sortBy/sortOrder/version/webhookStatus/platformType/currency/isEscrow/
    // escrowStatus/card*/giftCertificateType/cashReceipt*/textSearch) — server-side
    // customer filtering is not possible. This resolves the spec's "미검증" note
    // definitively rather than leaving it best-effort: we filter by date range only and
    // match customerRef client-side, exactly as spec/portone.pseudo.md's documented fallback.
    const requestBody = JSON.stringify({ filter: { from: input.since.toISOString() } });
    const query = new URLSearchParams({ requestBody });
    const raw = await this.request('GET', `/payments?${query.toString()}`);
    const list: any[] = raw.items ?? raw.payments ?? [];
    return list.filter((p) => p.customer?.id === input.customerRef).map(normalizePortonePayment);
  }

  async getSubscription(): Promise<Subscription> {
    // See spec/portone.pseudo.md "계약 변경 제안" — cannot fabricate Subscription fields.
    throw new PaymentKitError('portone has no native subscription; read from Repo.subscriptions', 'unsupported');
  }

  async changeSubscription(): Promise<Subscription> {
    throw new PaymentKitError('portone has no native subscription; scheduler manages plan changes via Repo', 'unsupported');
  }

  async cancelSubscription(): Promise<Subscription> {
    throw new PaymentKitError('portone has no native subscription; scheduler manages cancellation via Repo', 'unsupported');
  }

  // EC:A23 — same reasoning as getSubscription/changeSubscription/cancelSubscription above.
  async uncancelSubscription(): Promise<Subscription> {
    throw new PaymentKitError('portone has no native subscription; scheduler manages cancellation via Repo', 'unsupported');
  }

  async refund(input: { paymentRef: string; amount: Money; reason: string; idempotencyKey: string; extra?: Record<string, unknown> }): Promise<Refund> {
    const extra = input.extra ?? {};
    const body: Record<string, unknown> = { storeId: this.storeId, reason: input.reason };
    if (input.amount) body.amount = input.amount.amountMinor; // EC:D4 — PG may reject partials (EC:D14), propagated as ProviderError
    if (extra.refundAccount) body.refundAccount = extra.refundAccount; // EC:D13-equivalent for virtual accounts
    const raw = await this.request('POST', `/payments/${encodeURIComponent(input.paymentRef)}/cancel`, body);
    return normalizePortoneRefund(raw, input);
  }

  async getRefund(input: { paymentRef: string; refundRef: string }): Promise<Refund | null> {
    const raw = await this.request('GET', `/payments/${encodeURIComponent(input.paymentRef)}`);
    const cancellation = (raw.cancellations ?? []).find((cancel: { id?: string }) => cancel.id === input.refundRef);
    if (!cancellation) return null;
    return normalizePortoneRefund({ cancellation }, {
      paymentRef: input.paymentRef, amount: money(cancellation.totalAmount, raw.currency ?? 'KRW'), reason: cancellation.reason ?? '',
    });
  }

  /**
   * Extra method (not in core PaymentProvider) — EC:K2 K3 K4. `POST /cash-receipts`
   * (IssueCashReceiptBody -> IssueCashReceiptResponse). Confirmed against the real V2 OpenAPI
   * spec (portone-io/server-sdk `codegen/openapi.json`, 2026-09-09) — this resolves a real gap
   * in the brief this method was written against: there is **no** `POST /payments/{paymentId}/
   * cash-receipt` issuance endpoint in the V2 API (only `GET .../cash-receipt` and `POST
   * .../cash-receipt/cancel` are payment-scoped); issuance is the standalone `/cash-receipts`
   * resource, keyed by `paymentId` in the request body plus a required `channelKey`.
   * NOT exercised against the live PortOne API (no real cash-eligible payment was completable
   * server-side in this environment — see toss.pseudo.md/portone.pseudo.md "실측" notes and
   * `apps/cli/src/commands/live.ts`'s portone section, which has never completed a real payment
   * either). EC:K4 (card exclusion) is applied best-effort from `PaidPayment.method.type`
   * (`PaymentMethodCard` per the real schema) — PortOne fans out to many PGs with inconsistent
   * method reporting, so this is documented as heuristic-only, same caveat as
   * `normalizePortoneFailure` above.
   */
  async issueCashReceipt(input: PortoneIssueCashReceiptInput): Promise<CashReceipt> {
    if (!this.channelKey) {
      throw new PaymentKitError('channelKey is required to issue a PortOne cash receipt', 'channel_key_required');
    }
    const rawPayment = await this.request('GET', `/payments/${encodeURIComponent(input.paymentRef)}`);
    const methodType = String(rawPayment.method?.type ?? '');
    if (methodType === 'PaymentMethodCard') {
      // EC:K4 — card payments are not cash-receipt eligible (card sales slips serve that role).
      throw new PaymentKitError(
        `cash receipts are not issuable for card payments (paymentRef=${input.paymentRef})`,
        'cash_receipt_unsupported_for_payment_method',
      );
    }
    const total = rawPayment.amount?.total ?? rawPayment.amount;
    const body: Record<string, unknown> = {
      paymentId: input.paymentRef,
      channelKey: this.channelKey,
      type: input.type === 'business' ? 'CORPORATE' : 'PERSONAL',
      orderName: input.orderName ?? rawPayment.orderName ?? 'Payment',
      currency: rawPayment.currency ?? 'KRW',
      amount: { total, taxFree: input.taxFreeAmountMinor },
      customer: {
        identityNumber: input.customerIdentityNumber,
        name: input.customerName,
        email: input.customerEmail,
        phoneNumber: input.customerPhoneNumber,
      },
    };
    const raw = await this.request('POST', '/cash-receipts', body);
    // IssueCashReceiptResponse is `{ cashReceipt: CashReceiptSummary }` (issueNumber/url/pgReceiptId
    // only, per the real OpenAPI spec) — not a full CashReceipt object, so build ours from what we
    // already know (paymentId/type/amount) plus the summary's issueNumber/url.
    const summary = raw.cashReceipt ?? raw;
    return normalizePortoneCashReceipt({
      status: 'ISSUED',
      paymentId: input.paymentRef,
      type: input.type === 'business' ? 'CORPORATE' : 'PERSONAL',
      amount: total,
      currency: rawPayment.currency ?? 'KRW',
      issueNumber: summary.issueNumber,
      url: summary.url,
    });
  }

  /**
   * Extra method — EC:K5 K6. `POST /payments/{paymentId}/cash-receipt/cancel`. Confirmed against
   * the real V2 OpenAPI spec: response is `CancelCashReceiptResponse` (`{ cancelledAmount,
   * cancelledAt }` only — no receipt identity fields), so the returned `CashReceipt` is
   * synthesized from the input `paymentRef` plus the response's `cancelledAmount`. Not exercised
   * against the live API — see `issueCashReceipt` doc comment.
   */
  async cancelCashReceipt(input: { paymentRef: string }): Promise<CashReceipt> {
    const raw = await this.request('POST', `/payments/${encodeURIComponent(input.paymentRef)}/cash-receipt/cancel`, { storeId: this.storeId });
    return normalizePortoneCashReceipt({
      status: 'CANCELLED',
      paymentId: input.paymentRef,
      amount: raw.cancelledAmount,
    });
  }

  /**
   * Extra method — EC:K7 duplicate-issuance guard support. `GET /payments/{paymentId}/cash-receipt`
   * — confirmed against the real V2 OpenAPI spec; returns 404 `CashReceiptNotFoundError` when none
   * exists (mapped here to `null` rather than throwing, so callers can treat "no receipt yet" as a
   * normal case). Not exercised against the live API.
   */
  async getCashReceipt(input: { paymentRef: string }): Promise<CashReceipt | null> {
    try {
      const raw = await this.request('GET', `/payments/${encodeURIComponent(input.paymentRef)}/cash-receipt`);
      return normalizePortoneCashReceipt(raw);
    } catch (err) {
      if (err instanceof ProviderError && err.failure.providerCode === 'CashReceiptNotFoundError') return null;
      throw err;
    }
  }

  async reportUsage(): Promise<void> {
    throw new PaymentKitError('portone has no meters API', 'unsupported'); // capabilities().meters === false
  }

  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string; receivedAt?: Date }): Promise<NormalizedEvent> {
    const id = input.headers['webhook-id'] ?? input.headers['svix-id'];
    const timestamp = input.headers['webhook-timestamp'] ?? input.headers['svix-timestamp'];
    const sigHeader = input.headers['webhook-signature'] ?? input.headers['svix-signature'];
    if (!id || !timestamp || !sigHeader) {
      throw new WebhookSignatureError('missing Standard Webhooks headers (webhook-id/webhook-timestamp/webhook-signature)');
    }
    const tsSec = Number(timestamp);
    // EC:E17 — freshness is enforced at receipt (wall clock); a re-verify of a stored row
    // (receivedAt set) checks the signature only.
    if (!Number.isFinite(tsSec) || (!input.receivedAt && Math.abs(Date.now() / 1000 - tsSec) > 300)) {
      throw new WebhookSignatureError('webhook timestamp outside 5-minute tolerance');
    }
    const signedContent = `${id}.${timestamp}.${input.rawBody}`;
    const candidates = sigHeader
      .split(' ')
      .map((part) => {
        const idx = part.indexOf(',');
        return idx >= 0 ? part.slice(idx + 1) : part;
      })
      .filter(Boolean);
    // EC:E20 — the current secret first, then secrets being rotated out.
    // EC:E21 — rotated-out secrets only re-verify stored rows (receivedAt set), never new events.
    const ok = (input.receivedAt ? [this.webhookSecret, ...this.previousWebhookSecrets] : [this.webhookSecret]).some((secret) => {
      const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
      const expectedBuf = Buffer.from(createHmac('sha256', key).update(signedContent).digest('base64'), 'base64');
      return candidates.some((sig) => {
        try {
          const sigBuf = Buffer.from(sig, 'base64');
          return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
        } catch {
          return false;
        }
      });
    });
    if (!ok) throw new WebhookSignatureError('portone webhook signature mismatch');
    const body = JSON.parse(input.rawBody);
    const event = mapPortoneWebhook(body); // EC:E3 — caller must re-fetch before acting
    return { ...event, id }; // webhook-id is the stable Standard Webhooks message id
  }
}
