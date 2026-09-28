/**
 * boilpayment — core contract.
 * Mirrors packages/core/py/src/boilpayment_core/types.py exactly (camelCase ↔ snake_case).
 * See docs/ARCHITECTURE.md §3.
 */

// ── Value objects ────────────────────────────────────────────────────────────

export type ProviderName = 'stripe' | 'polar' | 'toss' | 'portone' | 'apple' | 'google_play';

export interface Money {
  amountMinor: number;
  currency: string; // ISO 4217, upper-case
}

export interface Period {
  start: Date; // inclusive
  end: Date; // exclusive
}

export interface Clock {
  now(): Date;
}

export interface IdGen {
  newId(): string;
}

// ── Policy (docs/EDGE_CASES.md) ──────────────────────────────────────────────

export type UpgradeMode = 'immediate_prorate_reset_anchor' | 'immediate_prorate_keep_anchor' | 'next_period';
export type UpgradeCreditDelta = 'full_delta' | 'prorated_delta';
export type DowngradeMode = 'end_of_period' | 'immediate_keep' | 'immediate_clawback';
export type ClawbackShortfall = 'clamp_to_zero' | 'allow_negative' | 'deny_downgrade';
export type CancelMode = 'end_of_period' | 'immediate';
export type CancelCredits = 'keep_until_period_end' | 'keep_forever' | 'revoke_immediately';
export type IntervalChangeMode = 'treat_as_upgrade' | 'next_period';
export type TrialCreditsOnConvert = 'grant_full' | 'grant_full_keep_trial' | 'no_grant_until_next_period';
export type TrialCreditsOnCancel = 'revoke' | 'keep';
export type TrialAbuseGuard = 'one_per_customer' | 'none';
export type PauseMode = 'unsupported' | 'freeze_credits' | 'keep_running';
export type UsageDuringGrace = 'allow' | 'block' | 'allow_existing_only';
export type GrantDuringGrace = 'defer_until_paid' | 'grant_anyway';
export type OnFinalFailure = 'revoke_unpaid_period' | 'revoke_all' | 'keep';
export type OnRecovery = 'regrant_current_period' | 'regrant_all_missed' | 'no_regrant';
export type MultipleSubscriptions = 'deny' | 'allow_separate_pools' | 'allow_merged_pool';
/** EC:A47 — a self-scheduled subscription more than one period behind (cron stopped, an upgrade from a
 * release that never renewed): charge only the period containing now, or charge nothing and ask a person. */
export type MissedPeriods = 'skip_and_notify' | 'needs_human_only';
export type Rollover = 'none' | 'banked' | 'full';
export type BankReset = 'on_renewal' | 'never' | 'on_cancel';
export type ConsumeOrder = 'expiring_first' | 'promo_first_then_expiring' | 'paid_first';
export type NegativeBalance = 'block' | 'allow_to_floor' | 'allow_unbounded';
export type GrantLagBehavior = 'reject' | 'optimistic_hold';
export type NegativeOffset = 'offset_next_grant' | 'never';
export type PoolMode = 'separate' | 'merged';
export type RefundReasonCategory = 'technical_failure' | 'dissatisfied' | 'user_error' | 'other';
export type RefundReasonFull = 'rules' | 'full';
export type RefundReasonDissatisfied = 'rules' | 'evidence_required' | 'needs_human';
export type RefundReasonUserError = 'rules' | 'deny';
export type RefundMethod = 'unused_credits' | 'time_prorated' | 'min_of_both' | 'deny';
export type OveruseBehavior = 'deny' | 'refund_time_prorated_anyway';
export type RefundRounding = 'floor_credits' | 'ceil_credits' | 'round_credits';
export type RevokeShortfall = 'clamp_and_reduce_refund' | 'clamp_to_zero' | 'allow_negative';
export type FeeBearer = 'merchant' | 'customer';
export type AnnualRefundMethod = 'same_as_monthly' | 'deny_after_days';
export type Overage = 'hard_block' | 'soft_cap_notify' | 'bill_overage';
export type DisputeOnOpen = 'freeze_customer' | 'revoke_disputed_grant' | 'none';
export type DisputeOnLost = 'revoke_and_ban' | 'revoke_only';
export type CashReceiptMode = 'off' | 'manual' | 'auto';
export type CashReceiptType = 'personal' | 'business';
export type RegrantMode = 'auto' | 'manual_approve' | 'off';
export type MonthEndAnchor = 'clamp_keep_original_day' | 'clamp_permanently';
export type ProrationDenominator = 'actual_days_in_period' | 'fixed_30';

export interface Policy {
  period: { timezone: string; monthEndAnchor: MonthEndAnchor };
  proration: { denominator: ProrationDenominator };
  credits: {
    rollover: Rollover;
    bankCap: number | null;
    bankReset: BankReset;
    consumeOrder: ConsumeOrder;
    negativeBalance: NegativeBalance;
    negativeFloor: number;
    pools: PoolMode;
    topupExpiryDays: number | null;
    grantLagBehavior: GrantLagBehavior;
    /** EC:B16 — notify this many days before credits expire. null = no notice. */
    expiryNoticeDays: number | null;
    /** EC:B17 — how a negative balance is settled when the next grant lands. */
    negativeOffset: NegativeOffset;
    /** EC:B19 — default expiry in days per grant source when the caller passes no expiresAt. null = never. */
    expiryDays: { promo: number | null; trial: number | null; manual: number | null; regrant: number | null };
  };
  upgrade: { mode: UpgradeMode; creditDelta: UpgradeCreditDelta };
  downgrade: { mode: DowngradeMode; clawbackShortfall: ClawbackShortfall };
  cancel: { mode: CancelMode; credits: CancelCredits };
  intervalChange: { mode: IntervalChangeMode };
  trial: { creditsOnConvert: TrialCreditsOnConvert; creditsOnCancel: TrialCreditsOnCancel; abuseGuard: TrialAbuseGuard };
  pause: { mode: PauseMode };
  dunning: {
    graceDays: number;
    usageDuringGrace: UsageDuringGrace;
    grantDuringGrace: GrantDuringGrace;
    onFinalFailure: OnFinalFailure;
    onRecovery: OnRecovery;
    preExpiryNoticeDays: number;
    /** EC:A24 — how many charge attempts inside the grace window (0 = only the provider's own). */
    retryAttempts: number;
    /** EC:A24 — hours after the failure for each retry; shorter than retryAttempts = last value repeats. */
    retryIntervalHours: number[];
  };
  refund: {
    noQuestionsDays: number;
    method: RefundMethod;
    overuseBehavior: OveruseBehavior;
    rounding: RefundRounding;
    revokeShortfall: RevokeShortfall;
    feeBearer: FeeBearer;
    maxPerCustomerPerYear: number;
    annualMethod: AnnualRefundMethod;
    annualDenyAfterDays: number | null;
    /** EC:D16 — outcome per refund reason category. 'rules' = the amount rules above (D1-D5). */
    reasons: { technicalFailure: RefundReasonFull; dissatisfied: RefundReasonDissatisfied; userError: RefundReasonUserError };
  };
  usage: {
    overage: Overage;
    overageUnitPriceMinor: number | null;
    lateReportWindowHours: number;
    includedQuantity: number;
    /** EC:C10 — a reservation not committed or released within this many minutes is released by the sweep. */
    reservationTtlMinutes: number;
    creditConversion: { unit: string; creditsPerUnit: number } | null;
  };
  dispute: {
    onOpen: DisputeOnOpen;
    onLost: DisputeOnLost;
    /** EC:B18 — days to gather and submit evidence before the network's deadline. */
    evidenceDueDays: number;
  };
  /** EC:K2 — KR 현금영수증 (cash receipt): a legal obligation for B2C payments in Korea. */
  cashReceipt: {
    mode: CashReceiptMode;
    /** Which document the receipt is issued against when issued automatically. */
    defaultType: CashReceiptType;
    /** Cancel the receipt when the payment is refunded (required by the NTS when the sale is voided). */
    cancelOnRefund: boolean;
  };
  cs: {
    regrant: { mode: RegrantMode };
    autoApprove: { maxAmountMinor: number; maxCredits: number };
    fraud: { refundVelocity: number; windowDays: number };
  };
  subscription: { multiplePerCustomer: MultipleSubscriptions; missedPeriods: MissedPeriods };
  /** EC:J4 L4 — how long operational rows are kept before a retention job prunes them. */
  retention: { operationDays: number; auditLogDays: number };
}

// ── Domain entities ──────────────────────────────────────────────────────────

export type CustomerStatus = 'active' | 'frozen' | 'banned';
export interface ProviderRef { provider: ProviderName; ref: string }
export interface Customer {
  id: string;
  email: string | null;
  providerRefs: ProviderRef[];
  status: CustomerStatus;
  createdAt: Date;
}

export type Interval = 'month' | 'year' | null;
export interface PlanPrice { currency: string; amountMinor: number; providerPriceRefs?: Partial<Record<ProviderName, string>> }
export interface Plan {
  id: string;
  name: string;
  interval: Interval; // null = one-time (top-up)
  creditsPerPeriod: number;
  usageIncluded: number;
  trialDays: number;
  prices: PlanPrice[];
}

/**
 * EC:A27 — `paused` (Stripe/Polar: trial ended without a payment method, no invoices) and
 * `incomplete` (first payment not made yet) are not entitled: usage.check refuses them and dunning
 * does not start for them.
 */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired' | 'paused' | 'incomplete';
/** EC:A27 — statuses that hold no entitlement and start no dunning. */
export const INACTIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['paused', 'incomplete'];
export interface Subscription {
  id: string;
  customerId: string;
  planId: string;
  provider: ProviderName;
  /** Null for self-scheduled subscriptions, which use billingKey instead. */
  providerRef: string | null;
  status: SubscriptionStatus;
  currentPeriod: Period;
  anchorDay: number; // 1..31, original day-of-month (EC:G1)
  cancelAtPeriodEnd: boolean;
  graceUntil: Date | null;
  billingKey: string | null; // Toss/Portone self-scheduling
  scheduledPlanId: string | null; // pending downgrade / next_period change
  /**
   * EC:A28 — the currency the subscription was bought in. Renewals, dunning retries and upgrade
   * proration charge the plan price in this currency. Null/absent on rows written before it
   * existed; those fall back to the plan's first price, as before.
   */
  currency?: string | null;
  /**
   * EC:A60 — the provider customer key the billing key was issued under (Toss customerKey). Renewal
   * and upgrade charges send it. Null/absent on rows written before it existed: they send the local
   * customer id, as before.
   */
  billingCustomerRef?: string | null;
  /**
   * EC:K1 — optimistic lock. Every writer must pass the row it read; `Repo.subscriptions.put` rejects
   * a stale version with `PaymentKitError('subscription_version_conflict')` and bumps it on success.
   * Without it an upgrade racing a renewal webhook silently loses one of the two writes.
   */
  version: number;
  createdAt: Date;
}

export type PaymentStatus =
  | 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded' | 'disputed';
export type PaymentKind = 'subscription' | 'topup' | 'overage';
/** EC:K2-K7 — issued KR 현금영수증 (cash receipt) attached to a payment. */
export interface CashReceiptRef {
  receiptKey: string;
  issuedAt: Date;
  type: CashReceiptType;
}

export interface Payment {
  id: string;
  customerId: string;
  provider: ProviderName;
  providerRef: string;
  subscriptionId: string | null;
  amount: Money;
  status: PaymentStatus;
  kind: PaymentKind;
  period: Period | null;
  occurredAt: Date;
  failure: PaymentFailure | null;
  /** EC:K2-K7 — set once a cash receipt is issued for this payment (KR only). Explicitly null,
   *  never undefined: py dataclasses always render the key and the two must serialize alike. */
  cashReceipt: CashReceiptRef | null;
  raw?: unknown;
  /** EC:E24 — other refs the provider uses for this same payment (Stripe invoice ↔ PaymentIntent ↔ charge).
   *  Set by provider adapters on fetched payments; the webhook records them as aliases. Not stored on the row. */
  providerRefAliases?: string[] | null;
}

export interface PaymentFailure {
  code: string; // normalized, e.g. 'card_declined' | 'insufficient_funds' | 'expired_card' | 'provider_unavailable' | 'unknown'
  providerCode: string | null;
  retryable: boolean;
  userMessage: string;
}

export type Pool = 'paid' | 'promo' | 'trial';
export type LedgerKind = 'grant' | 'consume' | 'revoke' | 'expire' | 'hold' | 'release' | 'adjust';
export type LedgerSource =
  | 'subscription' | 'topup' | 'manual' | 'regrant' | 'refund' | 'downgrade' | 'dispute' | 'trial' | 'promo' | 'usage' | 'rollover';
export interface LedgerReference {
  subscriptionId?: string;
  periodStart?: Date;
  paymentId?: string;
  caseId?: string;
  grantId?: string;
  refundId?: string;
  /** EC:L5 — threaded from webhook.receive/process through the whole delivery so a ledger entry
   * can be traced back to the exact webhook that produced it. See docs/EDGE_CASES.md §L5. */
  correlationId?: string;
}
export interface LedgerEntry {
  id: string;
  customerId: string;
  pool: Pool;
  kind: LedgerKind;
  amount: number; // signed
  unitPriceMinor: number | null;
  currency: string | null;
  expiresAt: Date | null;
  source: LedgerSource;
  reference: LedgerReference;
  idempotencyKey: string;
  actor: string;
  reason: string | null;
  createdAt: Date;
}
export type NewLedgerEntry = Omit<LedgerEntry, 'id' | 'createdAt'>;

export interface ExpiringBucket { expiresAt: Date; amount: number }
export interface Balance {
  customerId: string;
  pool: Pool | 'all';
  available: number;
  held: number;
  expiring: ExpiringBucket[];
}

export interface UsageEvent {
  id: string;
  customerId: string;
  meter: string;
  quantity: number;
  occurredAt: Date;
  receivedAt: Date;
  periodStart: Date;
  idempotencyKey: string;
  meta: Record<string, unknown> | null;
}

export type RefundStatus = 'pending' | 'succeeded' | 'failed';
export interface Refund {
  id: string;
  paymentId: string;
  customerId: string;
  amount: Money;
  status: RefundStatus;
  providerRef: string | null;
  creditsRevoked: number;
  ruleId: string; // EC id that decided, e.g. 'D1'
  reason: string | null;
  failure: PaymentFailure | null;
  createdAt: Date;
}

export interface RefundDecision {
  eligible: boolean;
  amount: Money;
  creditsToRevoke: number;
  ruleId: string;
  reason: string;
  needsHuman: boolean;
  paymentId: string;
  customerId: string;
  subscriptionId: string | null;
}

export type CsCaseKind = 'regrant' | 'refund' | 'dispute' | 'double_charge' | 'refund_failed' | 'reconcile_mismatch';
export type CsCaseStatus = 'open' | 'needs_human' | 'resolved_auto' | 'resolved_human' | 'rejected';
export interface CsCase {
  id: string;
  customerId: string;
  kind: CsCaseKind;
  status: CsCaseStatus;
  referenceId: string;
  policySnapshot: Policy;
  decision: Record<string, unknown> | null;
  churnReason: string | null;
  churnText: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  /**
   * EC:I9 finding (2026-09-09) — when `cs.escalate()` moved a case to `needs_human`, distinct
   * from `resolvedAt` (which `resolve()` sets and would otherwise clobber this timing). Optional
   * (not every existing CsCase construction site sets it — same non-breaking pattern as
   * `Deps.logger?`) — packages/cs owns filling it in.
   */
  escalatedAt?: Date | null;
}

// ── Webhook / events ─────────────────────────────────────────────────────────

export type NormalizedEventType =
  | 'payment.succeeded' | 'payment.failed' | 'payment.requires_action' | 'payment.pending'
  | 'subscription.created' | 'subscription.updated' | 'subscription.canceled' | 'subscription.payment_failed'
  | 'refund.created' | 'refund.pending' | 'refund.failed' | 'dispute.opened' | 'dispute.closed' | 'unknown';

export interface NormalizedEvent {
  id: string; // provider event id (idempotency key)
  provider: ProviderName;
  type: NormalizedEventType;
  occurredAt: Date;
  customerRef: string | null;
  subscriptionRef: string | null;
  paymentRef: string | null;
  amount: Money | null;
  raw: unknown;
  /** Actual provider refund identifier, never the webhook delivery ID. */
  refundRef?: string | null;
  /** EC:D21 — on `dispute.closed`: the provider's verdict. null/absent = the provider did not say
   *  (cs.dispute keeps the customer frozen and asks a person). */
  disputeOutcome?: 'won' | 'lost' | null;
}

export type WebhookEventStatus = 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
export interface WebhookEventRecord {
  id: string; // provider event id
  provider: ProviderName;
  type: NormalizedEventType;
  status: WebhookEventStatus;
  rawBody: string;
  headers: Record<string, string>;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
  attempts: number;
  /**
   * EC:I9 finding (2026-09-09, cs.timeline) — the LOCAL customer/payment/subscription this event
   * is about, resolved by `webhook.receive`/`process` via (provider, providerRef) lookup against
   * Repo — never the provider-adapter's own ref fields (EC:E3: those are best-effort, not
   * trustworthy local identity). null when no local row could be matched (e.g. the event predates
   * any local row). Lets a customer-scoped CS timeline actually answer "did a webhook that should
   * have granted your credits fail?" instead of only ever doing a global table scan.
   */
  customerId: string | null;
  paymentId: string | null;
  subscriptionId: string | null;
  /** EC:L5 — minted by webhook.receive as `corr_{providerEventId}` (deterministic across
   * redeliveries), threaded by webhook.process into every handler invocation for this delivery. */
  correlationId: string | null;
}

export interface OutboxItem {
  id: string;
  kind: string; // 'usage.report' | 'notify' | ...
  payload: Record<string, unknown>;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
}

// EC:J1-J5 — operation-level idempotency record (see spec/core.pseudo.md [EC:J1 J2 J3 J4 J5]).
// `id` mirrors `key` (Table<T> requires an `id` field); the two are always equal.
export type OperationStatus = 'in_progress' | 'done' | 'failed';
export interface Operation {
  id: string; // == key
  key: string;
  kind: string; // e.g. 'lifecycle.upgrade' | 'refund.execute' | 'credits.topup' | 'cs.regrant'
  payloadHash: string; // sha256 of a stable-JSON-stringified payload
  status: OperationStatus;
  result: unknown | null; // JSON-serializable — see idempotent.ts serialize*/deserialize*
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  /**
   * EC:I9 finding (2026-09-09, cs.timeline) — number of times `runIdempotent` has been invoked
   * for this key: 1 on first (real) execution, +1 on every subsequent replay of a 'done' result
   * or re-run after a 'failed' one. Without this, an operation retried 5 times (all replays) and
   * one executed exactly once look identical in storage — see WebhookEventRecord.attempts for the
   * same pattern already in place there.
   */
  attempts: number;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class PaymentKitError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = 'PaymentKitError';
  }
}
export class WebhookSignatureError extends PaymentKitError {
  constructor(message = 'invalid webhook signature', details?: unknown) { super(message, 'webhook_signature', details); this.name = 'WebhookSignatureError'; }
}
export class PolicyValidationError extends PaymentKitError {
  constructor(message: string, details?: unknown) { super(message, 'policy_invalid', details); this.name = 'PolicyValidationError'; }
}
export class InsufficientBalanceError extends PaymentKitError {
  constructor(public readonly shortfall: number, details?: unknown) { super(`insufficient balance (shortfall ${shortfall})`, 'insufficient_balance', details); this.name = 'InsufficientBalanceError'; }
}
export class ProviderError extends PaymentKitError {
  /**
   * EC:A34 — the provider's HTTP status when it answered. A 4xx (other than 408/409/429) is the
   * provider refusing the request (a decline); a 5xx, timeout or no answer proves nothing about
   * whether the money moved. Undefined for adapters that do not report it.
   */
  constructor(message: string, public readonly failure: PaymentFailure, details?: unknown, public readonly httpStatus?: number) { super(message, 'provider', details); this.name = 'ProviderError'; }
}

// ── Interfaces (DI) ──────────────────────────────────────────────────────────

export interface ProviderCapabilities {
  nativeSubscriptions: boolean;
  partialRefund: boolean;
  meters: boolean;
  scheduling: 'provider' | 'self';
  webhookSignature: boolean;
  /** EC:N1 — 'on_device' for in-app purchase stores (Apple, Google Play): the purchase happens in
   * the app and the server verifies the store's proof (see store.ts). Absent means 'hosted'. */
  checkout?: 'hosted' | 'on_device';
  /** EC:A77 — 'on_payment' when an immediate plan change is charged as its own provider order whose
   * payment arrives later (Polar): the upgrade's credits wait for that order's paid webhook. Absent
   * means the change is paid (or refused) before changeSubscription returns (Stripe error_if_incomplete). */
  upgradeGrant?: 'sync' | 'on_payment';
}

export interface CreateCheckoutInput {
  customerRef: string;
  plan: Plan;
  price: PlanPrice;
  mode: 'subscription' | 'one_time';
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}
export interface Checkout { id: string; url: string; providerRef: string }

/** Optional authoritative lookup for providers whose refund webhook omits settlement data. */
export interface RefundLookupProvider {
  getRefund(input: { paymentRef: string; refundRef: string }): Promise<Refund | null>;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  capabilities(): ProviderCapabilities;
  createCustomer(input: { email: string; name?: string; metadata?: Record<string, string> }): Promise<{ ref: string }>;
  createCheckout(input: CreateCheckoutInput): Promise<Checkout>;
  getPayment(providerRef: string): Promise<Payment>;
  /**
   * EC:A38 — optional: the payment for an orderId the kit sent (self-scheduled renewals), or null when
   * the provider has no such order (the request never arrived). Lets an attempt whose outcome was
   * unknown be settled without charging again. Toss: GET /v1/payments/orders/{orderId}; PortOne: the
   * orderId is the paymentId.
   */
  getPaymentByOrderId?(orderId: string): Promise<Payment | null>;
  listPayments(input: { customerRef: string; since: Date }): Promise<Payment[]>;
  getSubscription(providerRef: string): Promise<Subscription>;
  changeSubscription(providerRef: string, input: { newPriceRef: string; proration: 'immediate' | 'none'; resetAnchor: boolean }): Promise<Subscription>;
  cancelSubscription(providerRef: string, input: { atPeriodEnd: boolean }): Promise<Subscription>;
  /**
   * EC:A23 — undo a pending (`cancelAtPeriodEnd`) or in-period cancellation on the provider's own
   * side (mirrors `cancelSubscription`; the two together let `lifecycle.reactivate` correct both
   * our Repo row and the provider's, closing the gap the A23 "계약 변경 제안" flagged). Native
   * providers (Stripe/Polar) implement this for real. Self-scheduling providers (Toss/PortOne,
   * `capabilities().nativeSubscriptions === false`) have no provider-side subscription to correct
   * and throw `PaymentKitError('unsupported')`, exactly like their `getSubscription`/
   * `changeSubscription`. A native provider whose subscription has already fully ended (not merely
   * pending-cancel) throws `PaymentKitError('not_reactivatable')` — that state can't be revived,
   * the caller needs a new subscription.
   */
  uncancelSubscription(providerRef: string): Promise<Subscription>;
  chargeBillingKey(input: { billingKey: string; amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment>;
  refund(input: { paymentRef: string; amount: Money; reason: string; idempotencyKey: string; extra?: Record<string, unknown> }): Promise<Refund>;
  reportUsage(input: { meter: string; customerRef: string; quantity: number; occurredAt: Date; idempotencyKey: string }): Promise<void>;
  /**
   * EC:E4 E17 — verify signature and freshness. `receivedAt` (set by webhook.process when it
   * re-verifies a stored body) means "judge the timestamp tolerance at this instant": the body was
   * fresh when received, so a later retry must not fail on age. The signature is always checked.
   */
  verifyWebhook(input: { headers: Record<string, string>; rawBody: string; receivedAt?: Date; /** EC:E18 — the connection's peer address, from the app's socket (never a request header). */ remoteAddress?: string }): Promise<NormalizedEvent>;
}

export interface ConsumeInput {
  customerId: string;
  poolOrder: Pool[];
  amount: number;
  idempotencyKey: string;
  meta: LedgerReference & { reason?: string; actor?: string };
  now: Date;
  negativeBalance: NegativeBalance;
  negativeFloor: number;
}
export interface ConsumeResult { ok: boolean; entries: LedgerEntry[]; shortfall: number; duplicated: boolean }
export interface AppendResult { entry: LedgerEntry; duplicated: boolean }

export interface LedgerStore {
  append(entry: NewLedgerEntry): Promise<AppendResult>;
  /**
   * EC:B14 expiry filtering happens against `now`. **`now` is required — always pass the injected
   * `Clock`'s `now()`** (`clock.now()`), never the wall clock. `pool` stays semantically optional
   * (pass `undefined` for "all pools") but the parameter itself is required so it can't be skipped
   * on the way to `now`. This was previously `(customerId, pool?, now?)` with every concrete
   * implementation silently defaulting `now` to `new Date()` when omitted — that footgun caused
   * three separate real bugs (refund.evaluate FINDINGS#1, a dispute regression, cs.timeline; see
   * packages/core/spec/core.pseudo.md "계약 변경 제안" for the history of why it wasn't fixed
   * outright until now — 2026-09-09).
   */
  balance(customerId: string, pool: Pool | undefined, now: Date): Promise<Balance>;
  entries(customerId: string, filter?: { pool?: Pool; kind?: LedgerKind; since?: Date; source?: LedgerSource }): Promise<LedgerEntry[]>;
  consume(input: ConsumeInput): Promise<ConsumeResult>;
  transaction<T>(customerId: string, fn: () => Promise<T>): Promise<T>;
}

export interface Table<T extends { id: string }, F = Partial<T>> {
  get(id: string): Promise<T | null>;
  put(row: T): Promise<T>;
  list(filter?: F): Promise<T[]>;
}
export interface OperationTable extends Table<Operation> {
  /** Atomically acquire an absent or matching failed operation; null means another caller owns it.
   *  The claimed row carries `row.result` (EC:A48 — a lease is written with its token in the same statement). */
  claim(row: Operation): Promise<Operation | null>;
  /**
   * EC:A48 — write `next` only if the stored row still has `expected`'s status and result (compare and
   * set). False when another writer changed it first. Optional: a Repo without it keeps the plain put.
   */
  compareAndSet?(expected: Pick<Operation, 'key' | 'status' | 'result'>, next: Operation): Promise<boolean>;
}
export interface Repo {
  customers: Table<Customer>;
  plans: Table<Plan>;
  subscriptions: Table<Subscription>;
  payments: Table<Payment>;
  usageEvents: Table<UsageEvent>;
  refunds: Table<Refund>;
  csCases: Table<CsCase>;
  webhookEvents: Table<WebhookEventRecord>;
  outbox: Table<OutboxItem>;
  operations: OperationTable; // EC:J1-J5
}

export type NotifyType =
  | 'payment.failed' | 'grace.started' | 'grace.ending' | 'subscription.canceled' | 'refund.executed'
  | 'cs.needs_human' | 'reconcile.mismatch' | 'card.expiring' | 'usage.soft_cap' | 'credits.expiring';
export interface Notification { type: NotifyType; customerId: string | null; payload: Record<string, unknown> }
export interface Notifier { send(n: Notification): Promise<void> }

// ── Logger / audit trail (docs/EDGE_CASES.md §L) ─────────────────────────────
// EC:L1 L2 L5 — every app-visible mutation and every provider HTTP exchange goes through this DI
// seam so a customer's production run leaves an evidence trail without the kit ever choosing to
// log PII (implementations redact — see packages/core/ts/src/logger.ts `redact`/`BaseLogger`).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields {
  [key: string]: unknown;
}
export interface LogEntry extends LogFields {
  level: LogLevel;
  event: string; // e.g. 'provider.request' | 'webhook.received' | 'ledger.append'
  /** Defaults to "now" in the logger implementation if omitted — pass explicitly for deterministic tests. */
  at?: Date;
}
export interface Logger {
  log(entry: LogEntry): Promise<void>;
}

export interface Deps {
  clock: Clock;
  ids: IdGen;
  ledger: LedgerStore;
  repo: Repo;
  notifier: Notifier;
  providers: Partial<Record<ProviderName, PaymentProvider>>;
  policy: Policy;
  /** EC:L1 — optional; every caller falls back to NoopLogger so no existing Deps construction breaks. */
  logger?: Logger;
}
