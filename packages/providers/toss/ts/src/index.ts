// boilpayment — Toss Payments provider.
// See spec/toss.pseudo.md for the full contract. Endpoints/enums verified against
// docs.tosspayments.com/reference and docs.tosspayments.com/reference/using-api/webhook-events (2026-09).
import { createHash } from 'node:crypto';
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
import { PaymentKitError, WebhookSignatureError, ProviderError, NoopLogger } from 'boilpayment-core';

const BASE_URL = 'https://api.tosspayments.com';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ── pure normalizers (exported for smoke/unit use) ──────────────────────────

/** EC:E8 — WAITING_FOR_DEPOSIT must map to pending; grants only happen on DONE. */
export function normalizeTossStatus(status: string): PaymentStatus {
  switch (status) {
    case 'READY':
    case 'IN_PROGRESS':
    case 'WAITING_FOR_DEPOSIT':
      return 'pending';
    case 'DONE':
      return 'succeeded';
    case 'CANCELED':
      return 'refunded';
    case 'PARTIAL_CANCELED':
      return 'partially_refunded';
    case 'ABORTED':
    case 'EXPIRED':
      return 'failed';
    default:
      return 'pending';
  }
}

export type CashReceiptType = 'personal' | 'business';
export type CashReceiptStatus = 'in_progress' | 'issued' | 'canceled' | 'failed';

/** EC:K2 K3 K5 K6 — normalized cash receipt shape shared by issue/cancel/get. */
export interface CashReceipt {
  receiptKey: string;
  orderId: string;
  type: CashReceiptType;
  status: CashReceiptStatus;
  amount: Money;
  issueNumber: string | null;
  receiptUrl: string | null;
  failure: { code: string | null; message: string | null } | null;
  raw: unknown;
}

/** EC:K3 — Toss `type` is the literal Korean string, not an enum code. */
function toTossCashReceiptType(type: CashReceiptType): string {
  return type === 'business' ? '지출증빙' : '소득공제';
}
function fromTossCashReceiptType(type: string): CashReceiptType {
  return type === '지출증빙' ? 'business' : 'personal';
}

/**
 * EC:K2 K5 K6. Confirmed live 2026-09-09 against the real Toss test API
 * (POST /v1/cash-receipts, response fields: receiptKey/orderId/orderName/type/issueNumber/
 * receiptUrl/businessNumber/transactionType/amount/taxFreeAmount/issueStatus/failure/
 * customerIdentityNumber/requestedAt — `issueStatus` observed value in test env was
 * always `IN_PROGRESS`; `COMPLETED`/`FAILED` are documented but not observed live).
 * `transactionType` distinguishes an issue response (`CONFIRM`) from a cancel response (`CANCEL`).
 */
export function normalizeTossCashReceipt(raw: any): CashReceipt {
  const issueStatus = String(raw.issueStatus ?? '').toUpperCase();
  const isCancel = raw.transactionType === 'CANCEL';
  let status: CashReceiptStatus;
  if (issueStatus === 'FAILED') status = 'failed';
  else if (isCancel) status = 'canceled';
  else if (issueStatus === 'COMPLETED') status = 'issued';
  else status = 'in_progress';
  return {
    receiptKey: raw.receiptKey,
    orderId: raw.orderId,
    type: fromTossCashReceiptType(raw.type),
    status,
    amount: { amountMinor: raw.amount, currency: 'KRW' },
    issueNumber: raw.issueNumber ?? null,
    receiptUrl: raw.receiptUrl ?? null,
    failure: raw.failure ? { code: raw.failure.code ?? null, message: raw.failure.message ?? null } : null,
    raw,
  };
}

// EC:E9 pattern applied to Toss. Not exhaustive — unmapped codes fall back to
// {code:'unknown', retryable:false} and preserve providerCode for later extension.
const TOSS_FAILURE_MAP: Record<string, { code: string; retryable: boolean }> = {
  REJECT_CARD_COMPANY: { code: 'card_declined', retryable: true },
  INVALID_STOPPED_CARD: { code: 'card_declined', retryable: false },
  RESTRICTED_TRANSFER_ACCOUNT: { code: 'card_declined', retryable: false },
  EXCEED_MAX_DAILY_PAYMENT_COUNT: { code: 'card_declined', retryable: true },
  INVALID_CARD_EXPIRATION: { code: 'expired_card', retryable: false },
  EXPIRED_CARD: { code: 'expired_card', retryable: false },
  NOT_ENOUGH_BALANCE: { code: 'insufficient_funds', retryable: true },
  // Confirmed live 2026-09-09 against the real test API via `TossPayments-Test-Code:
  // REJECT_CARD_PAYMENT` (test_sk_ keys only) — real response body:
  // {"code":"REJECT_CARD_PAYMENT","message":"한도초과 혹은 잔액부족으로 결제에 실패했습니다."}.
  // Was previously unmapped (fell through to {code:'unknown', retryable:false}) — real bug.
  REJECT_CARD_PAYMENT: { code: 'insufficient_funds', retryable: true },
  EXCEED_MAX_PAYMENT_AMOUNT: { code: 'card_declined', retryable: false },
  INVALID_CARD_NUMBER: { code: 'card_declined', retryable: false },
  CARD_PROCESSING_ERROR: { code: 'provider_unavailable', retryable: true },
  FAILED_INTERNAL_SYSTEM_PROCESSING: { code: 'provider_unavailable', retryable: true },
  PROVIDER_ERROR: { code: 'provider_unavailable', retryable: true },
  EXCEED_MAX_ONE_DAY_WITHDRAW_AMOUNT: { code: 'card_declined', retryable: false },
  EXCEED_MAX_ONE_TIME_WITHDRAW_AMOUNT: { code: 'card_declined', retryable: false },
};

export function normalizeTossFailure(failure: { code?: string | null; message?: string | null } | null | undefined): PaymentFailure | null {
  if (!failure || !failure.code) return null;
  const mapped = TOSS_FAILURE_MAP[failure.code];
  return {
    code: mapped?.code ?? 'unknown',
    providerCode: failure.code,
    retryable: mapped?.retryable ?? false,
    userMessage: failure.message ?? '결제에 실패했습니다.',
  };
}

/** EC:F/E8/E9. `raw` is the Toss Payment object from confirm/get/billing responses. */
export function normalizeTossPayment(raw: any): Payment {
  const status = normalizeTossStatus(raw.status);
  return {
    id: raw.paymentKey,
    customerId: raw.customerKey ?? '',
    provider: 'toss',
    providerRef: raw.paymentKey,
    subscriptionId: null,
    amount: { amountMinor: raw.totalAmount, currency: raw.currency ?? 'KRW' },
    status,
    kind: 'subscription',
    period: null,
    occurredAt: new Date(raw.approvedAt ?? raw.requestedAt ?? Date.now()),
    failure: status === 'failed' ? normalizeTossFailure(raw.failure) : null,
    cashReceipt: null,
    raw,
  };
}

function normalizeTossRefund(raw: any, input: { paymentRef: string; amount: Money; reason: string }): Refund {
  const cancels: any[] = raw.cancels ?? [];
  const last = cancels.find((cancel) => cancel.transactionKey === raw.lastTransactionKey) ?? {};
  return {
    id: last.transactionKey ?? '',
    paymentId: raw.paymentKey,
    // NOTE (contract gap — see spec "계약 변경 제안"): the provider adapter has no
    // access to our internal customerId/ruleId. refund.execute must overwrite these.
    customerId: '',
    amount: { amountMinor: last.cancelAmount ?? input.amount.amountMinor, currency: raw.currency ?? input.amount.currency },
    status: last.cancelStatus === 'DONE' ? 'succeeded' : 'pending',
    providerRef: last.transactionKey ?? null,
    creditsRevoked: 0,
    ruleId: '',
    reason: input.reason,
    failure: null,
    createdAt: new Date(last.canceledAt ?? raw.approvedAt ?? Date.now()),
  } as Refund;
}

/** EC:E3/E4 — normalizes the notification only; caller MUST re-fetch before acting. */
export function mapTossWebhook(body: any): NormalizedEvent {
  const eventType: string = body.eventType ?? body.event_type ?? 'UNKNOWN';
  const data = body.data ?? {};
  const cancellation = eventType === 'CANCEL_STATUS_CHANGED' ? data
    : (data.cancels ?? []).find((cancel: { transactionKey?: string }) => cancel.transactionKey === data.lastTransactionKey);
  let type: NormalizedEventType = 'unknown';
  if (eventType === 'PAYMENT_STATUS_CHANGED' || eventType === 'DEPOSIT_CALLBACK') {
    switch (data.status) {
      case 'DONE':
        type = 'payment.succeeded';
        break;
      case 'CANCELED':
      case 'PARTIAL_CANCELED':
        type = 'refund.created';
        break;
      case 'WAITING_FOR_DEPOSIT':
        type = 'payment.pending';
        break;
      case 'EXPIRED':
      case 'ABORTED':
        type = 'payment.failed';
        break;
      default:
        type = 'unknown';
    }
  } else if (eventType === 'CANCEL_STATUS_CHANGED') {
    type = data.cancelStatus === 'DONE' ? 'refund.created' : 'refund.pending';
  } else if (eventType === 'BILLING_DELETED') {
    type = 'subscription.canceled';
  }
  const createdAt = body.createdAt ?? data.approvedAt ?? new Date().toISOString();
  // Kit compatibility rule: offset-free webhook times use Korea time, never host time.
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(createdAt)
    ? `${createdAt}+09:00`
    : createdAt;
  return {
    // Toss webhook bodies carry no unique eventId; synthesize one. createdAt is the
    // original event time so retries reuse the same value → stable idempotency key.
    id: `${eventType}:${data.paymentKey ?? 'na'}${cancellation?.transactionKey ? `:${cancellation.transactionKey}` : ''}:${data.cancelStatus ?? data.status ?? 'na'}:${createdAt}`,
    provider: 'toss',
    type,
    occurredAt: new Date(timestamp),
    customerRef: data.customerKey ?? null,
    subscriptionRef: null,
    paymentRef: data.paymentKey ?? null,
    refundRef: type.startsWith('refund.') ? cancellation?.transactionKey ?? null : null,
    amount: type.startsWith('refund.')
      ? (typeof cancellation?.cancelAmount === 'number' && typeof data.currency === 'string' ? { amountMinor: cancellation.cancelAmount, currency: data.currency } : null)
      : (typeof data.totalAmount === 'number' ? { amountMinor: data.totalAmount, currency: data.currency ?? 'KRW' } : null),
    raw: body,
  };
}

// ── config / extra types ─────────────────────────────────────────────────────

export interface TossProviderConfig {
  secretKey: string;
  clientKey?: string;
  /** Remote IPs allowed to call the webhook endpoint (EC:E4 variant — Toss webhooks are unsigned). */
  allowedWebhookIps?: string[];
  /** Overrides the API host, e.g. the local mock: "http://127.0.0.1:12211". Defaults to the real Toss API. */
  apiBase?: string;
  /**
   * NOT part of normal operation. Injects the `TossPayments-Test-Code` header on every request,
   * which forces the real Toss test API to respond as if that failure occurred (confirmed live
   * 2026-09-09, e.g. `REJECT_CARD_PAYMENT` → real `{"code":"REJECT_CARD_PAYMENT", "message":
   * "한도초과 혹은 잔액부족으로 결제에 실패했습니다."}`) — for exercising failure-path normalization
   * (`normalizeTossFailure`) against real Toss responses in `boilpayment live`. Only works with
   * `test_sk_` keys; the constructor throws otherwise.
   */
  testCode?: string;
  /** EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2). Defaults to NoopLogger. */
  logger?: Logger;
  /** EC:L5 — overrides the correlationId logged for every `provider.request` event from this
   * instance (otherwise falls back to the per-call idempotencyKey, as before). Prefer
   * `provider.withCorrelationId(id)` over setting this directly. */
  correlationId?: string;
}

export interface TossConfirmInput {
  paymentKey: string;
  orderId: string;
  amount: number;
}

export interface TossIssueBillingKeyInput {
  authKey: string;
  customerKey: string;
}

export interface TossBillingKeyResult {
  billingKey: string;
  customerKey: string;
  raw: unknown;
}

export interface TossIssueBillingKeyByCardInput {
  customerKey: string;
  cardNumber: string;
  cardExpirationYear: string;
  cardExpirationMonth: string;
  customerIdentityNumber: string;
  /** Optional in practice — confirmed live 2026-09-09 that Toss's test API issues a billing key
   * without it; kept as an optional field rather than dropped in case a future test-account
   * policy starts requiring it. */
  cardPassword?: string;
  customerName?: string;
  customerEmail?: string;
}

/** EC:K2 K3 K4. `paymentRef` is our Payment.providerRef == Toss `paymentKey`. */
export interface TossIssueCashReceiptInput {
  paymentRef: string;
  type: CashReceiptType;
  /** Personal: phone number / cash receipt card number. Business: 사업자등록번호. */
  customerIdentityNumber: string;
  orderName?: string;
  taxFreeAmountMinor?: number;
}

/** EC:K5 — omit amountMinor for a full cancel. */
export interface TossCancelCashReceiptInput {
  receiptKey: string;
  amountMinor?: number;
}

type FetchLike = typeof fetch;

export class TossProvider implements PaymentProvider {
  readonly name = 'toss' as const;
  private readonly secretKey: string;
  readonly clientKey?: string;
  private readonly allowedWebhookIps?: string[];
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly testCode?: string;
  private readonly logger: Logger;
  // EC:L5 — set only via config.correlationId / withCorrelationId(); overrides the per-call
  // idempotencyKey-derived value for every `provider.request` log line from this instance.
  private readonly correlationIdOverride: string | null;

  constructor(config: TossProviderConfig, fetchImpl: FetchLike = fetch) {
    this.secretKey = config.secretKey;
    this.clientKey = config.clientKey;
    this.allowedWebhookIps = config.allowedWebhookIps;
    this.baseUrl = config.apiBase ?? BASE_URL;
    this.fetchImpl = fetchImpl;
    if (config.testCode && !config.secretKey.startsWith('test_sk_')) {
      throw new PaymentKitError('testCode option requires a test_sk_ secret key', 'test_keys_only');
    }
    this.testCode = config.testCode;
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
    const clone = Object.create(TossProvider.prototype) as TossProvider;
    Object.assign(clone, this, { correlationIdOverride: correlationId });
    return clone;
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self', webhookSignature: false, checkout: 'hosted' };
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(this.secretKey + ':').toString('base64');
  }

  // EC:L1 — one `provider.request` event per HTTP call, redacted (EC:L2) by the Logger implementation.
  private async request(method: string, path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<any> {
    const headers: Record<string, string> = { Authorization: this.authHeader(), 'Content-Type': 'application/json' };
    if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (this.testCode) headers['TossPayments-Test-Code'] = this.testCode;
    const startedAt = Date.now();
    let status: number | undefined;
    let json: any;
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const failure = normalizeTossFailure(json) ?? { code: 'unknown', providerCode: json.code ?? null, retryable: false, userMessage: json.message ?? 'toss api error' };
        await this.logger.log({
          level: 'warn', event: 'provider.request', provider: 'toss', method, path, status,
          durationMs: Date.now() - startedAt, correlationId: this.correlationIdOverride ?? opts?.idempotencyKey ?? null,
          providerErrorCode: failure.code, requestBody: body, responseBody: json,
        });
        throw new ProviderError(json.message ?? `toss api error (${res.status})`, failure, json);
      }
      await this.logger.log({
        level: 'info', event: 'provider.request', provider: 'toss', method, path, status,
        durationMs: Date.now() - startedAt, correlationId: this.correlationIdOverride ?? opts?.idempotencyKey ?? null,
        providerErrorCode: null, requestBody: body, responseBody: json,
      });
      return json;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      await this.logger.log({
        level: 'error', event: 'provider.request', provider: 'toss', method, path, status: status ?? null,
        durationMs: Date.now() - startedAt, correlationId: this.correlationIdOverride ?? opts?.idempotencyKey ?? null,
        providerErrorCode: 'network_error', requestBody: body, error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async createCustomer(input: { email: string; name?: string; metadata?: Record<string, string> }): Promise<{ ref: string }> {
    // EC:F — Toss has no customer object; customerKey is generated or supplied.
    const provided = input.metadata?.customerKey;
    if (provided) return { ref: provided };
    return { ref: 'cus_' + sha256(input.email).slice(0, 40) };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
    if (input.price.currency !== 'KRW') {
      throw new PaymentKitError(`toss only supports KRW, got ${input.price.currency}`, 'currency_unsupported'); // EC:E10
    }
    const orderId = 'ord_' + sha256(input.idempotencyKey).slice(0, 40); // EC:E6 — double-click reuses same order
    const sep = input.successUrl.includes('?') ? '&' : '?';
    const url = `${input.successUrl}${sep}orderId=${encodeURIComponent(orderId)}&amount=${input.price.amountMinor}`;
    return { id: orderId, url, providerRef: orderId };
  }

  /** Extra method (not in core PaymentProvider) — EC:E13, server-side confirm is mandatory. */
  async confirmPayment(input: TossConfirmInput): Promise<Payment> {
    const raw = await this.request('POST', '/v1/payments/confirm', {
      paymentKey: input.paymentKey,
      orderId: input.orderId,
      amount: input.amount,
    });
    return normalizeTossPayment(raw);
  }

  /** Extra method — EC:F billing key issuance. */
  async issueBillingKey(input: TossIssueBillingKeyInput): Promise<TossBillingKeyResult> {
    const raw = await this.request('POST', '/v1/billing/authorizations/issue', {
      authKey: input.authKey,
      customerKey: input.customerKey,
    });
    return { billingKey: raw.billingKey, customerKey: raw.customerKey, raw };
  }

  /**
   * NOT part of the PaymentProvider contract. Test-mode-only escape hatch for `boilpayment live`
   * (docs/ARCHITECTURE.md live-verification tooling): issues a billing key directly from raw
   * card fields (`POST /v1/billing/authorizations/card`), skipping the widget/browser authKey
   * flow entirely. Per Toss docs (docs.tosspayments.com/guides/v2/billing/integration-api,
   * fetched 2026-09-09): in the test environment only the card's first six digits (BIN) need to
   * be valid — the remaining digits, expiration date, and identity number can be arbitrary, and
   * `cardPassword` can be omitted entirely (confirmed live 2026-09-09: a real billing key was
   * issued without it). Not every BIN classifies to a chargeable card type in the test
   * environment though — BIN 490625 (BC, confirmed live 2026-09-09) issues a billing key that
   * `chargeBillingKey` can actually charge; some other BINs issue a key that later fails
   * `chargeBillingKey` with a real `NOT_SUPPORTED_CARD_TYPE` error. Guarded to `test_sk_` keys —
   * this direct-card path is test-environment-only (live keys need separate Toss approval).
   */
  async issueBillingKeyByCard(input: TossIssueBillingKeyByCardInput): Promise<TossBillingKeyResult> {
    if (!this.secretKey.startsWith('test_sk_')) {
      throw new PaymentKitError('issueBillingKeyByCard refuses to run against a non-test secret key', 'test_keys_only');
    }
    const raw = await this.request('POST', '/v1/billing/authorizations/card', {
      customerKey: input.customerKey,
      cardNumber: input.cardNumber,
      cardExpirationYear: input.cardExpirationYear,
      cardExpirationMonth: input.cardExpirationMonth,
      customerIdentityNumber: input.customerIdentityNumber,
      cardPassword: input.cardPassword,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
    });
    return { billingKey: raw.billingKey, customerKey: raw.customerKey, raw };
  }

  async chargeBillingKey(input: { billingKey: string; amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment> {
    const raw = await this.request(
      'POST',
      `/v1/billing/${encodeURIComponent(input.billingKey)}`,
      { customerKey: input.customerRef, amount: input.amount.amountMinor, orderId: input.orderId, orderName: 'Subscription charge' },
      { idempotencyKey: input.idempotencyKey },
    );
    return normalizeTossPayment(raw);
  }

  async getPayment(providerRef: string): Promise<Payment> {
    const raw = await this.request('GET', `/v1/payments/${encodeURIComponent(providerRef)}`);
    return normalizeTossPayment(raw);
  }

  async listPayments(input: { customerRef: string; since: Date }): Promise<Payment[]> {
    // EC:H4 — Toss has no list-by-customer API. Best-effort via /v1/transactions;
    // matches only when the transaction row happens to carry customerKey. See spec.
    // Toss rejects `...sssZ` with INVALID_DATE (verified against the real test API); it accepts an
    // ISO-8601 string with an explicit offset, which is what py's isoformat() emits.
    const tossDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const startDate = tossDate(input.since);
    const endDate = tossDate(new Date());
    const raw = await this.request('GET', `/v1/transactions?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
    const list: any[] = Array.isArray(raw) ? raw : (raw.transactions ?? []);
    const matched = list.filter((t) => t.customerKey && t.customerKey === input.customerRef);
    // BUG FIX (found via live mock round trip): /v1/transactions rows are TransactionDto, not
    // Payment — the field names differ (`amount`/`transactionAt` vs `totalAmount`/`approvedAt`).
    // Calling normalizeTossPayment directly on a transaction row silently produced amountMinor:
    // undefined. Remap to Payment-object field names first.
    return matched.map((t) =>
      normalizeTossPayment({
        paymentKey: t.paymentKey,
        customerKey: t.customerKey,
        totalAmount: t.amount,
        currency: t.currency,
        status: t.status,
        approvedAt: t.transactionAt,
        requestedAt: t.transactionAt,
        failure: null,
      }),
    );
  }

  async getSubscription(_providerRef: string): Promise<Subscription> {
    // See spec/toss.pseudo.md "계약 변경 제안" — cannot fabricate Subscription fields.
    throw new PaymentKitError('toss has no native subscription; read from Repo.subscriptions', 'unsupported');
  }

  async changeSubscription(): Promise<Subscription> {
    throw new PaymentKitError('toss has no native subscription; self-scheduler manages plan changes via Repo', 'unsupported');
  }

  async cancelSubscription(): Promise<Subscription> {
    throw new PaymentKitError('toss has no native subscription; self-scheduler manages cancellation via Repo', 'unsupported');
  }

  // EC:A23 — same reasoning as getSubscription/changeSubscription/cancelSubscription above.
  async uncancelSubscription(): Promise<Subscription> {
    throw new PaymentKitError('toss has no native subscription; self-scheduler manages cancellation via Repo', 'unsupported');
  }

  async refund(input: { paymentRef: string; amount: Money; reason: string; idempotencyKey: string; extra?: Record<string, unknown> }): Promise<Refund> {
    const rawPayment = await this.request('GET', `/v1/payments/${encodeURIComponent(input.paymentRef)}`);
    const method = String(rawPayment.method ?? '');
    const extra = input.extra ?? {};
    if (method.includes('가상계좌') && !extra.refundReceiveAccount) {
      throw new PaymentKitError('refundReceiveAccount required for Toss virtual account refunds', 'refund_receive_account_required'); // EC:D13
    }
    const body: Record<string, unknown> = { cancelReason: input.reason };
    if (input.amount) body.cancelAmount = input.amount.amountMinor; // EC:D4 partial refund
    if (extra.refundReceiveAccount) body.refundReceiveAccount = extra.refundReceiveAccount;
    const raw = await this.request('POST', `/v1/payments/${encodeURIComponent(input.paymentRef)}/cancel`, body, { idempotencyKey: input.idempotencyKey });
    return normalizeTossRefund(raw, input);
  }

  async getRefund(input: { paymentRef: string; refundRef: string }): Promise<Refund | null> {
    const raw = await this.request('GET', `/v1/payments/${encodeURIComponent(input.paymentRef)}`);
    const cancellation = (raw.cancels ?? []).find((cancel: { transactionKey?: string }) => cancel.transactionKey === input.refundRef);
    if (!cancellation) return null;
    return normalizeTossRefund({ ...raw, lastTransactionKey: input.refundRef }, {
      paymentRef: input.paymentRef, amount: { amountMinor: cancellation.cancelAmount, currency: raw.currency }, reason: cancellation.cancelReason ?? '',
    });
  }

  /**
   * Extra method (not in core PaymentProvider) — EC:K2 K3 K4. `POST /v1/cash-receipts`.
   * Confirmed live 2026-09-09 against the real Toss test API (test_sk_ key): this endpoint is a
   * standalone "수동 발급" (manual issuance) resource — it does NOT itself validate that the
   * given `orderId` belongs to an existing cash-eligible payment (a bare `orderId` with no
   * matching payment issued successfully, HTTP 200). So the card-payment exclusion (EC:K4) MUST
   * be enforced here, client-side, by re-fetching the payment and checking `method` — the
   * provider will not reject it for us.
   */
  async issueCashReceipt(input: TossIssueCashReceiptInput): Promise<CashReceipt> {
    const rawPayment = await this.request('GET', `/v1/payments/${encodeURIComponent(input.paymentRef)}`);
    const method = String(rawPayment.method ?? '');
    if (method.includes('카드')) {
      // EC:K4 — card payments are not cash-receipt eligible (card sales slips serve that role).
      throw new PaymentKitError(
        `cash receipts are not issuable for card payments (paymentRef=${input.paymentRef}, method=${method})`,
        'cash_receipt_unsupported_for_payment_method',
      );
    }
    const body: Record<string, unknown> = {
      orderId: rawPayment.orderId,
      orderName: input.orderName ?? rawPayment.orderName ?? 'Payment',
      amount: rawPayment.totalAmount,
      type: toTossCashReceiptType(input.type),
      customerIdentityNumber: input.customerIdentityNumber,
    };
    if (input.taxFreeAmountMinor) body.taxFreeAmount = input.taxFreeAmountMinor;
    const raw = await this.request('POST', '/v1/cash-receipts', body);
    return normalizeTossCashReceipt(raw);
  }

  /**
   * Extra method — EC:K5 K6. `POST /v1/cash-receipts/{receiptKey}/cancel`. Confirmed live
   * 2026-09-09: omitting `amount` cancels the receipt in full; passing `amount` does a partial
   * cancel (mirrors the payment-cancel endpoint's `cancelAmount` semantics, EC:D4).
   */
  async cancelCashReceipt(input: TossCancelCashReceiptInput): Promise<CashReceipt> {
    const body: Record<string, unknown> = {};
    if (input.amountMinor != null) body.amount = input.amountMinor;
    const raw = await this.request('POST', `/v1/cash-receipts/${encodeURIComponent(input.receiptKey)}/cancel`, body);
    return normalizeTossCashReceipt(raw);
  }

  /**
   * Extra method — EC:K7 duplicate-issuance guard support. Toss has no `GET` by `receiptKey`
   * (confirmed live 2026-09-09: `GET /v1/cash-receipts/{receiptKey}` 404s as an unrouted path,
   * not a Toss-shaped error) — the only lookup is `GET /v1/cash-receipts?requestDate=yyyy-MM-dd`
   * (list-by-date, confirmed live: `requestDate` is required, `startDate`/`endDate` are rejected
   * as INVALID_REQUEST). This filters that list client-side by `orderId`. NOTE: with the given
   * public test key this list call itself real-404s with `NOT_FOUND_MERCHANT_BUSINESS_NUMBER`
   * (confirmed live 2026-09-09) because the shared test merchant has no registered business
   * number — the endpoint shape is verified, a successful list response is not.
   */
  async getCashReceipt(input: { orderId: string; requestDate: string }): Promise<CashReceipt | null> {
    const raw = await this.request('GET', `/v1/cash-receipts?requestDate=${encodeURIComponent(input.requestDate)}`);
    const list: any[] = Array.isArray(raw) ? raw : (raw.data ?? raw.cashReceipts ?? []);
    const match = list.find((c) => c.orderId === input.orderId);
    return match ? normalizeTossCashReceipt(match) : null;
  }

  async reportUsage(): Promise<void> {
    throw new PaymentKitError('toss has no meters API', 'unsupported'); // capabilities().meters === false
  }

  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string }): Promise<NormalizedEvent> {
    const body = JSON.parse(input.rawBody);
    if (this.allowedWebhookIps && this.allowedWebhookIps.length > 0) {
      // EC:E4 variant — Toss payment webhooks carry no signature; IP allowlist is the defense.
      const remoteIp = input.headers['x-paykit-remote-ip'] ?? input.headers['X-Paykit-Remote-Ip'];
      if (!remoteIp || !this.allowedWebhookIps.includes(remoteIp)) {
        throw new WebhookSignatureError(`toss webhook ip not allowed: ${remoteIp ?? 'unknown'}`);
      }
    }
    return mapTossWebhook(body); // EC:E3 — caller must re-fetch before acting
  }
}
