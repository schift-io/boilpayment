"""boilpayment — core contract.

Mirrors packages/core/ts/src/types.ts exactly (snake_case ↔ camelCase).
See docs/ARCHITECTURE.md §3.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, runtime_checkable

# ── Value objects ────────────────────────────────────────────────────────────

ProviderName = Literal["stripe", "polar", "toss", "portone", "apple", "google_play"]


@dataclass(kw_only=True, slots=True)
class Money:
    amount_minor: int
    currency: str  # ISO 4217, upper-case


@dataclass(kw_only=True, slots=True)
class Period:
    start: datetime  # inclusive
    end: datetime  # exclusive


class Clock(Protocol):
    def now(self) -> datetime: ...


class IdGen(Protocol):
    def new_id(self) -> str: ...


# ── Policy (docs/EDGE_CASES.md) ──────────────────────────────────────────────

UpgradeMode = Literal[
    "immediate_prorate_reset_anchor", "immediate_prorate_keep_anchor", "next_period"
]
UpgradeCreditDelta = Literal["full_delta", "prorated_delta"]
RefundReasonCategory = Literal["technical_failure", "dissatisfied", "user_error", "other"]
RefundReasonFull = Literal["rules", "full"]
RefundReasonDissatisfied = Literal["rules", "evidence_required", "needs_human"]
RefundReasonUserError = Literal["rules", "deny"]
DowngradeMode = Literal["end_of_period", "immediate_keep", "immediate_clawback"]
ClawbackShortfall = Literal["clamp_to_zero", "allow_negative", "deny_downgrade"]
CancelMode = Literal["end_of_period", "immediate"]
CancelCredits = Literal["keep_until_period_end", "keep_forever", "revoke_immediately"]
IntervalChangeMode = Literal["treat_as_upgrade", "next_period"]
TrialCreditsOnConvert = Literal[
    "grant_full", "grant_full_keep_trial", "no_grant_until_next_period"
]
TrialCreditsOnCancel = Literal["revoke", "keep"]
TrialAbuseGuard = Literal["one_per_customer", "none"]
PauseMode = Literal["unsupported", "freeze_credits", "keep_running"]
UsageDuringGrace = Literal["allow", "block", "allow_existing_only"]
GrantDuringGrace = Literal["defer_until_paid", "grant_anyway"]
OnFinalFailure = Literal["revoke_unpaid_period", "revoke_all", "keep"]
OnRecovery = Literal["regrant_current_period", "regrant_all_missed", "no_regrant"]
MultipleSubscriptions = Literal["deny", "allow_separate_pools", "allow_merged_pool"]
Rollover = Literal["none", "banked", "full"]
BankReset = Literal["on_renewal", "never", "on_cancel"]
ConsumeOrder = Literal["expiring_first", "promo_first_then_expiring", "paid_first"]
NegativeBalance = Literal["block", "allow_to_floor", "allow_unbounded"]
GrantLagBehavior = Literal["reject", "optimistic_hold"]
NegativeOffset = Literal["offset_next_grant", "never"]
PoolMode = Literal["separate", "merged"]
RefundMethod = Literal["unused_credits", "time_prorated", "min_of_both", "deny"]
OveruseBehavior = Literal["deny", "refund_time_prorated_anyway"]
RefundRounding = Literal["floor_credits", "ceil_credits", "round_credits"]
RevokeShortfall = Literal["clamp_and_reduce_refund", "clamp_to_zero", "allow_negative"]
FeeBearer = Literal["merchant", "customer"]
AnnualRefundMethod = Literal["same_as_monthly", "deny_after_days"]
Overage = Literal["hard_block", "soft_cap_notify", "bill_overage"]
DisputeOnOpen = Literal["freeze_customer", "revoke_disputed_grant", "none"]
DisputeOnLost = Literal["revoke_and_ban", "revoke_only"]
CashReceiptMode = Literal["off", "manual", "auto"]
CashReceiptType = Literal["personal", "business"]
RegrantMode = Literal["auto", "manual_approve", "off"]
MonthEndAnchor = Literal["clamp_keep_original_day", "clamp_permanently"]
ProrationDenominator = Literal["actual_days_in_period", "fixed_30"]


@dataclass(kw_only=True, slots=True)
class PeriodPolicy:
    timezone: str = "UTC"
    month_end_anchor: MonthEndAnchor = "clamp_keep_original_day"


@dataclass(kw_only=True, slots=True)
class ProrationPolicy:
    denominator: ProrationDenominator = "actual_days_in_period"


@dataclass(kw_only=True, slots=True)
class CreditConversion:
    unit: str
    credits_per_unit: int


@dataclass(kw_only=True, slots=True)
class CreditExpiryDays:
    """EC:B19 -- default expiry in days per grant source when the caller passes no expires_at. None = never."""

    promo: int | None = None
    trial: int | None = None
    manual: int | None = None
    regrant: int | None = None


@dataclass(kw_only=True, slots=True)
class CreditsPolicy:
    rollover: Rollover = "none"
    bank_cap: int | None = None
    bank_reset: BankReset = "on_renewal"
    consume_order: ConsumeOrder = "expiring_first"
    negative_balance: NegativeBalance = "block"
    negative_floor: int = 0
    pools: PoolMode = "separate"
    topup_expiry_days: int | None = None
    grant_lag_behavior: GrantLagBehavior = "reject"
    # EC:B16 -- notify this many days before credits expire. None = no notice.
    expiry_notice_days: int | None = None
    # EC:B17 -- how a negative balance is settled when the next grant lands.
    negative_offset: NegativeOffset = "offset_next_grant"
    # EC:B19
    expiry_days: CreditExpiryDays = field(default_factory=CreditExpiryDays)


@dataclass(kw_only=True, slots=True)
class UpgradePolicy:
    mode: UpgradeMode = "immediate_prorate_reset_anchor"
    credit_delta: UpgradeCreditDelta = "full_delta"


@dataclass(kw_only=True, slots=True)
class DowngradePolicy:
    mode: DowngradeMode = "end_of_period"
    clawback_shortfall: ClawbackShortfall = "clamp_to_zero"


@dataclass(kw_only=True, slots=True)
class CancelPolicy:
    mode: CancelMode = "end_of_period"
    credits: CancelCredits = "keep_until_period_end"


@dataclass(kw_only=True, slots=True)
class IntervalChangePolicy:
    mode: IntervalChangeMode = "treat_as_upgrade"


@dataclass(kw_only=True, slots=True)
class TrialPolicy:
    credits_on_convert: TrialCreditsOnConvert = "grant_full"
    credits_on_cancel: TrialCreditsOnCancel = "revoke"
    abuse_guard: TrialAbuseGuard = "one_per_customer"


@dataclass(kw_only=True, slots=True)
class PausePolicy:
    mode: PauseMode = "unsupported"


@dataclass(kw_only=True, slots=True)
class DunningPolicy:
    grace_days: int = 7
    usage_during_grace: UsageDuringGrace = "allow"
    grant_during_grace: GrantDuringGrace = "defer_until_paid"
    on_final_failure: OnFinalFailure = "revoke_unpaid_period"
    on_recovery: OnRecovery = "regrant_current_period"
    pre_expiry_notice_days: int = 7
    # EC:A24 -- charge attempts inside the grace window (0 = only the provider's own).
    retry_attempts: int = 3
    # EC:A24 -- hours after the failure for each retry; a shorter list repeats its last value.
    retry_interval_hours: list[int] = field(default_factory=lambda: [24, 72, 120])


@dataclass(kw_only=True, slots=True)
class RefundReasons:
    """EC:D16 -- outcome per refund reason category. "rules" = the amount rules (D1-D5)."""

    technical_failure: RefundReasonFull = "rules"
    dissatisfied: RefundReasonDissatisfied = "rules"
    user_error: RefundReasonUserError = "rules"


@dataclass(kw_only=True, slots=True)
class RefundPolicy:
    no_questions_days: int = 7
    method: RefundMethod = "unused_credits"
    overuse_behavior: OveruseBehavior = "deny"
    rounding: RefundRounding = "floor_credits"
    revoke_shortfall: RevokeShortfall = "clamp_and_reduce_refund"
    fee_bearer: FeeBearer = "merchant"
    max_per_customer_per_year: int = 2
    annual_method: AnnualRefundMethod = "same_as_monthly"
    annual_deny_after_days: int | None = None
    reasons: RefundReasons = field(default_factory=RefundReasons)


@dataclass(kw_only=True, slots=True)
class UsagePolicy:
    overage: Overage = "hard_block"
    overage_unit_price_minor: int | None = None
    late_report_window_hours: int = 48
    included_quantity: int = 0
    # EC:C10 -- a reservation not committed or released within this many minutes is released by the sweep.
    reservation_ttl_minutes: int = 60
    credit_conversion: CreditConversion | None = None


@dataclass(kw_only=True, slots=True)
class DisputePolicy:
    on_open: DisputeOnOpen = "freeze_customer"
    on_lost: DisputeOnLost = "revoke_and_ban"
    # EC:B18 -- days to gather and submit evidence before the network's deadline.
    evidence_due_days: int = 7


@dataclass(kw_only=True, slots=True)
class CashReceiptPolicy:
    """EC:K2 -- KR 현금영수증 (cash receipt): a legal obligation for B2C payments in Korea."""

    mode: CashReceiptMode = "off"
    default_type: CashReceiptType = "personal"
    cancel_on_refund: bool = True


@dataclass(kw_only=True, slots=True)
class CsRegrantPolicy:
    mode: RegrantMode = "auto"


@dataclass(kw_only=True, slots=True)
class CsAutoApprovePolicy:
    max_amount_minor: int = 50_000
    max_credits: int = 10_000


@dataclass(kw_only=True, slots=True)
class CsFraudPolicy:
    refund_velocity: int = 2
    window_days: int = 30


@dataclass(kw_only=True, slots=True)
class CsPolicy:
    regrant: CsRegrantPolicy = field(default_factory=CsRegrantPolicy)
    auto_approve: CsAutoApprovePolicy = field(default_factory=CsAutoApprovePolicy)
    fraud: CsFraudPolicy = field(default_factory=CsFraudPolicy)


@dataclass(kw_only=True, slots=True)
class SubscriptionPolicy:
    multiple_per_customer: MultipleSubscriptions = "deny"


@dataclass(kw_only=True, slots=True)
class RetentionPolicy:
    """EC:J4 L4 -- how long operational rows are kept before a retention job prunes them."""

    operation_days: int = 7
    audit_log_days: int = 90


@dataclass(kw_only=True, slots=True)
class Policy:
    period: PeriodPolicy = field(default_factory=PeriodPolicy)
    proration: ProrationPolicy = field(default_factory=ProrationPolicy)
    credits: CreditsPolicy = field(default_factory=CreditsPolicy)
    upgrade: UpgradePolicy = field(default_factory=UpgradePolicy)
    downgrade: DowngradePolicy = field(default_factory=DowngradePolicy)
    cancel: CancelPolicy = field(default_factory=CancelPolicy)
    interval_change: IntervalChangePolicy = field(default_factory=IntervalChangePolicy)
    trial: TrialPolicy = field(default_factory=TrialPolicy)
    pause: PausePolicy = field(default_factory=PausePolicy)
    dunning: DunningPolicy = field(default_factory=DunningPolicy)
    refund: RefundPolicy = field(default_factory=RefundPolicy)
    usage: UsagePolicy = field(default_factory=UsagePolicy)
    dispute: DisputePolicy = field(default_factory=DisputePolicy)
    cash_receipt: CashReceiptPolicy = field(default_factory=CashReceiptPolicy)
    cs: CsPolicy = field(default_factory=CsPolicy)
    subscription: SubscriptionPolicy = field(default_factory=SubscriptionPolicy)
    retention: RetentionPolicy = field(default_factory=RetentionPolicy)


# ── Domain entities ──────────────────────────────────────────────────────────

CustomerStatus = Literal["active", "frozen", "banned"]


@dataclass(kw_only=True, slots=True)
class ProviderRef:
    provider: ProviderName
    ref: str


@dataclass(kw_only=True, slots=True)
class Customer:
    id: str
    email: str | None
    provider_refs: list[ProviderRef]
    status: CustomerStatus
    created_at: datetime


Interval = Literal["month", "year"] | None


@dataclass(kw_only=True, slots=True)
class PlanPrice:
    currency: str
    amount_minor: int
    provider_price_refs: dict[str, str] | None = None


@dataclass(kw_only=True, slots=True)
class Plan:
    id: str
    name: str
    interval: Interval  # None = one-time (top-up)
    credits_per_period: int
    usage_included: int
    trial_days: int
    prices: list[PlanPrice]


# EC:A27 -- paused (trial ended without a payment method) and incomplete (first payment not made)
# hold no entitlement: usage.check refuses them and dunning does not start for them.
SubscriptionStatus = Literal[
    "trialing", "active", "past_due", "canceled", "expired", "paused", "incomplete"
]
INACTIVE_SUBSCRIPTION_STATUSES: tuple[str, ...] = ("paused", "incomplete")


@dataclass(kw_only=True, slots=True)
class Subscription:
    id: str
    customer_id: str
    plan_id: str
    provider: ProviderName
    provider_ref: str | None
    status: SubscriptionStatus
    current_period: Period
    anchor_day: int  # 1..31 original day-of-month (EC:G1)
    cancel_at_period_end: bool
    grace_until: datetime | None
    billing_key: str | None  # Toss/Portone self-scheduling
    scheduled_plan_id: str | None  # pending downgrade / next_period change
    # EC:K1 -- optimistic lock. Every writer must pass the row it read; `Repo.subscriptions.put`
    # rejects a stale version with `PaymentKitError('subscription_version_conflict')` and bumps it on
    # success. Without it an upgrade racing a renewal webhook silently loses one of the two writes.
    version: int = 0
    created_at: datetime


PaymentStatus = Literal[
    "pending",
    "requires_action",
    "succeeded",
    "failed",
    "refunded",
    "partially_refunded",
    "disputed",
]
PaymentKind = Literal["subscription", "topup", "overage"]


@dataclass(kw_only=True, slots=True)
class PaymentFailure:
    code: str  # normalized: card_declined | insufficient_funds | expired_card | provider_unavailable | unknown
    provider_code: str | None
    retryable: bool
    user_message: str


@dataclass(kw_only=True, slots=True)
class CashReceiptRef:
    """EC:K2-K7 -- issued KR 현금영수증 (cash receipt) attached to a payment."""

    receipt_key: str
    issued_at: datetime
    type: CashReceiptType


@dataclass(kw_only=True, slots=True)
class Payment:
    id: str
    customer_id: str
    provider: ProviderName
    provider_ref: str
    subscription_id: str | None
    amount: Money
    status: PaymentStatus
    kind: PaymentKind
    period: Period | None
    occurred_at: datetime
    failure: PaymentFailure | None = None
    # EC:K2-K7 -- set once a cash receipt is issued for this payment (KR only).
    cash_receipt: CashReceiptRef | None = None
    raw: Any = None


Pool = Literal["paid", "promo", "trial"]
LedgerKind = Literal[
    "grant", "consume", "revoke", "expire", "hold", "release", "adjust"
]
LedgerSource = Literal[
    "subscription",
    "topup",
    "manual",
    "regrant",
    "refund",
    "downgrade",
    "dispute",
    "trial",
    "promo",
    "usage",
    "rollover",
]


@dataclass(kw_only=True, slots=True)
class LedgerReference:
    subscription_id: str | None = None
    period_start: datetime | None = None
    payment_id: str | None = None
    case_id: str | None = None
    grant_id: str | None = None
    refund_id: str | None = None
    # EC:L5 -- threaded from webhook.receive/process through the whole delivery so a ledger entry
    # can be traced back to the exact webhook that produced it. See docs/EDGE_CASES.md §L5.
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class NewLedgerEntry:
    customer_id: str
    pool: Pool
    kind: LedgerKind
    amount: int  # signed
    source: LedgerSource
    idempotency_key: str
    actor: str
    reference: LedgerReference = field(default_factory=LedgerReference)
    unit_price_minor: int | None = None
    currency: str | None = None
    expires_at: datetime | None = None
    reason: str | None = None


@dataclass(kw_only=True, slots=True)
class LedgerEntry(NewLedgerEntry):
    id: str
    created_at: datetime


@dataclass(kw_only=True, slots=True)
class ExpiringBucket:
    expires_at: datetime
    amount: int


@dataclass(kw_only=True, slots=True)
class Balance:
    customer_id: str
    pool: Pool | Literal["all"]
    available: int
    held: int
    expiring: list[ExpiringBucket]


@dataclass(kw_only=True, slots=True)
class UsageEvent:
    id: str
    customer_id: str
    meter: str
    quantity: int
    occurred_at: datetime
    received_at: datetime
    period_start: datetime
    idempotency_key: str
    meta: dict[str, Any] | None = None


RefundStatus = Literal["pending", "succeeded", "failed"]


@dataclass(kw_only=True, slots=True)
class Refund:
    id: str
    payment_id: str
    customer_id: str
    amount: Money
    status: RefundStatus
    provider_ref: str | None
    credits_revoked: int
    rule_id: str  # EC id that decided, e.g. "D1"
    reason: str | None
    failure: PaymentFailure | None
    created_at: datetime


@dataclass(kw_only=True, slots=True)
class RefundDecision:
    eligible: bool
    amount: Money
    credits_to_revoke: int
    rule_id: str
    reason: str
    needs_human: bool
    payment_id: str
    customer_id: str
    subscription_id: str | None


CsCaseKind = Literal[
    "regrant",
    "refund",
    "dispute",
    "double_charge",
    "refund_failed",
    "reconcile_mismatch",
]
CsCaseStatus = Literal[
    "open", "needs_human", "resolved_auto", "resolved_human", "rejected"
]


@dataclass(kw_only=True, slots=True)
class CsCase:
    id: str
    customer_id: str
    kind: CsCaseKind
    status: CsCaseStatus
    reference_id: str
    policy_snapshot: Policy
    decision: dict[str, Any] | None
    churn_reason: str | None
    churn_text: str | None
    opened_at: datetime
    resolved_at: datetime | None
    # EC:I9 finding (2026-09-09) -- when cs.escalate() moved a case to needs_human, distinct from
    # resolved_at (which resolve() sets and would otherwise clobber this timing). Defaults to None
    # so every existing CsCase(...) construction site keeps working unmodified -- packages/cs owns
    # filling it in.
    escalated_at: datetime | None = None


# ── Webhook / events ─────────────────────────────────────────────────────────

NormalizedEventType = Literal[
    "payment.succeeded",
    "payment.failed",
    "payment.requires_action",
    "payment.pending",
    "subscription.created",
    "subscription.updated",
    "subscription.canceled",
    "subscription.payment_failed",
    "refund.created",
    "refund.pending",
    "refund.failed",
    "dispute.opened",
    "dispute.closed",
    "unknown",
]


@dataclass(kw_only=True, slots=True)
class NormalizedEvent:
    id: str  # provider event id (idempotency key)
    provider: ProviderName
    type: NormalizedEventType
    occurred_at: datetime
    customer_ref: str | None
    subscription_ref: str | None
    payment_ref: str | None
    amount: Money | None
    raw: Any
    # Actual provider refund identifier, never the webhook delivery ID.
    refund_ref: str | None = None


WebhookEventStatus = Literal["received", "processing", "processed", "failed", "ignored"]


@dataclass(kw_only=True, slots=True)
class WebhookEventRecord:
    id: str
    provider: ProviderName
    type: NormalizedEventType
    status: WebhookEventStatus
    raw_body: str
    headers: dict[str, str]
    received_at: datetime
    processed_at: datetime | None
    error: str | None
    attempts: int
    # EC:I9 finding (2026-09-09, cs.timeline) -- the LOCAL customer/payment/subscription this event
    # is about, resolved by webhook.receive/process via (provider, provider_ref) lookup against
    # Repo -- never the provider-adapter's own ref fields (EC:E3: those are best-effort, not
    # trustworthy local identity). None when no local row could be matched. Defaults to None
    # (unlike the ts side, which has no pre-existing construction sites to protect) so
    # packages/cs/py/tests/test_timeline.py's existing WebhookEventRecord(...) construction keeps
    # working unmodified -- packages/cs is off-limits for this change.
    customer_id: str | None = None
    payment_id: str | None = None
    subscription_id: str | None = None
    # EC:L5 -- minted by webhook.receive as `corr_{provider_event_id}` (deterministic across
    # redeliveries), threaded by webhook.process into every handler invocation for this delivery.
    # Defaults to None (like customer_id/payment_id/subscription_id above) so
    # packages/cs/py/tests/test_timeline.py's existing WebhookEventRecord(...) construction keeps
    # working unmodified -- packages/cs is off-limits for this change.
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class OutboxItem:
    id: str
    kind: str  # "usage.report" | "notify" | ...
    payload: dict[str, Any]
    status: Literal["pending", "sent", "failed"]
    attempts: int
    next_attempt_at: datetime
    created_at: datetime


# EC:J1-J5 — operation-level idempotency record (see spec/core.pseudo.md [EC:J1 J2 J3 J4 J5]).
# `id` mirrors `key` (Table[T] is keyed by `id`); the two are always equal.
OperationStatus = Literal["in_progress", "done", "failed"]


@dataclass(kw_only=True, slots=True)
class Operation:
    id: str  # == key
    key: str
    kind: str  # e.g. "lifecycle.upgrade" | "refund.execute" | "credits.topup" | "cs.regrant"
    payload_hash: str  # sha256 of a stable-JSON-stringified payload
    status: OperationStatus
    created_at: datetime
    result: Any | None = (
        None  # JSON-serializable — see idempotent.py serialize*/deserialize*
    )
    error: str | None = None
    completed_at: datetime | None = None
    # EC:I9 finding (2026-09-09, cs.timeline) -- number of times run_idempotent has been invoked
    # for this key: 1 on first (real) execution, +1 on every subsequent replay of a 'done' result
    # or re-run after a 'failed' one. Mirrors WebhookEventRecord.attempts (same pattern already in
    # place there).
    attempts: int = 0


# ── Errors ───────────────────────────────────────────────────────────────────


class PaymentKitError(Exception):
    code = "payment_kit"

    def __init__(self, message: str, code: str | None = None, details: Any = None):
        super().__init__(message)
        if code:
            self.code = code
        self.details = details


class WebhookSignatureError(PaymentKitError):
    code = "webhook_signature"

    def __init__(self, message: str = "invalid webhook signature", details: Any = None):
        super().__init__(message, self.code, details)


class PolicyValidationError(PaymentKitError):
    code = "policy_invalid"

    def __init__(self, message: str, details: Any = None):
        super().__init__(message, self.code, details)


class InsufficientBalanceError(PaymentKitError):
    code = "insufficient_balance"

    def __init__(self, shortfall: int, details: Any = None):
        super().__init__(
            f"insufficient balance (shortfall {shortfall})", self.code, details
        )
        self.shortfall = shortfall


class ProviderError(PaymentKitError):
    code = "provider"

    def __init__(self, message: str, failure: PaymentFailure, details: Any = None):
        super().__init__(message, self.code, details)
        self.failure = failure


# ── Interfaces (DI) ──────────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class ProviderCapabilities:
    native_subscriptions: bool
    partial_refund: bool
    meters: bool
    scheduling: Literal["provider", "self"]
    webhook_signature: bool
    # EC:N1 -- "on_device" for in-app purchase stores (Apple, Google Play): the purchase happens in
    # the app and the server verifies the store's proof (see store.py). Default "hosted".
    checkout: Literal["hosted", "on_device"] = "hosted"


@dataclass(kw_only=True, slots=True)
class CreateCheckoutInput:
    customer_ref: str
    plan: Plan
    price: PlanPrice
    mode: Literal["subscription", "one_time"]
    success_url: str
    cancel_url: str
    idempotency_key: str
    metadata: dict[str, str] | None = None


@dataclass(kw_only=True, slots=True)
class Checkout:
    id: str
    url: str
    provider_ref: str


@runtime_checkable
class RefundLookupProvider(Protocol):
    """Optional authoritative lookup for incomplete refund webhook payloads."""

    async def get_refund(self, *, payment_ref: str, refund_ref: str) -> Refund | None: ...


class PaymentProvider(Protocol):
    name: ProviderName

    def capabilities(self) -> ProviderCapabilities: ...
    async def create_customer(
        self,
        *,
        email: str,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> dict[str, str]: ...  # {"ref": ...}
    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout: ...
    async def get_payment(self, provider_ref: str) -> Payment: ...
    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]: ...
    async def get_subscription(self, provider_ref: str) -> Subscription: ...
    async def change_subscription(
        self,
        provider_ref: str,
        *,
        new_price_ref: str,
        proration: Literal["immediate", "none"],
        reset_anchor: bool,
    ) -> Subscription: ...
    async def cancel_subscription(
        self, provider_ref: str, *, at_period_end: bool
    ) -> Subscription: ...
    # EC:A23 -- undo a pending (cancel_at_period_end) or in-period cancellation on the provider's
    # own side (mirrors cancel_subscription; together they let lifecycle.reactivate correct both
    # our Repo row and the provider's, closing the gap the A23 "계약 변경 제안" flagged). Native
    # providers (Stripe/Polar) implement this for real. Self-scheduling providers (Toss/PortOne,
    # capabilities().native_subscriptions == False) have no provider-side subscription to correct
    # and raise PaymentKitError('unsupported'), exactly like get_subscription/change_subscription.
    # A native provider whose subscription has already fully ended (not merely pending-cancel)
    # raises PaymentKitError('not_reactivatable') -- that state can't be revived, the caller needs
    # a new subscription.
    async def uncancel_subscription(self, provider_ref: str) -> Subscription: ...
    async def charge_billing_key(
        self,
        *,
        billing_key: str,
        amount: Money,
        order_id: str,
        customer_ref: str,
        idempotency_key: str,
    ) -> Payment: ...
    async def refund(
        self,
        *,
        payment_ref: str,
        amount: Money,
        reason: str,
        idempotency_key: str,
        extra: dict[str, Any] | None = None,
    ) -> Refund: ...
    async def report_usage(
        self,
        *,
        meter: str,
        customer_ref: str,
        quantity: int,
        occurred_at: datetime,
        idempotency_key: str,
    ) -> None: ...
    async def verify_webhook(
        self,
        *,
        headers: dict[str, str],
        raw_body: str,
        received_at: datetime | None = None,
    ) -> NormalizedEvent:
        """EC:E4 E17 -- verify signature and freshness. received_at (set by webhook.process
        when re-verifying a stored body) means: judge timestamp tolerance at that instant."""
        ...


@dataclass(kw_only=True, slots=True)
class ConsumeInput:
    customer_id: str
    pool_order: list[Pool]
    amount: int
    idempotency_key: str
    meta: LedgerReference
    now: datetime
    negative_balance: NegativeBalance
    negative_floor: int
    reason: str | None = None
    actor: str = "app"


@dataclass(kw_only=True, slots=True)
class ConsumeResult:
    ok: bool
    entries: list[LedgerEntry]
    shortfall: int
    duplicated: bool


@dataclass(kw_only=True, slots=True)
class AppendResult:
    entry: LedgerEntry
    duplicated: bool


T = TypeVar("T")


class LedgerStore(Protocol):
    async def append(self, entry: NewLedgerEntry) -> AppendResult: ...

    # EC:B14 expiry filtering happens against `now`. **`now` is required -- always pass the
    # injected Clock's now()** (clock.now()), never the wall clock. `pool` stays semantically
    # optional (pass None for "all pools") but the parameter itself is required so it can't be
    # skipped on the way to `now`. Previously `now` defaulted to wall-clock time when omitted,
    # which caused three separate real bugs (refund.evaluate FINDINGS#1, a dispute regression,
    # cs.timeline; see packages/core/spec/core.pseudo.md "계약 변경 제안" for why it wasn't fixed
    # outright until now -- 2026-09-09).
    async def balance(
        self, customer_id: str, pool: Pool | None, now: datetime
    ) -> Balance: ...
    async def entries(
        self,
        customer_id: str,
        *,
        pool: Pool | None = None,
        kind: LedgerKind | None = None,
        since: datetime | None = None,
        source: LedgerSource | None = None,
    ) -> list[LedgerEntry]: ...
    async def consume(self, input: ConsumeInput) -> ConsumeResult: ...
    async def transaction(
        self, customer_id: str, fn: Callable[[], Awaitable[T]]
    ) -> T: ...


class Table(Protocol[T]):
    async def get(self, id: str) -> T | None: ...
    async def put(self, row: T) -> T: ...
    async def list(self, **filter: Any) -> list[T]: ...


class OperationTable(Table[Operation], Protocol):
    async def claim(self, row: Operation) -> Operation | None: ...


class Repo(Protocol):
    customers: Table[Customer]
    plans: Table[Plan]
    subscriptions: Table[Subscription]
    payments: Table[Payment]
    usage_events: Table[UsageEvent]
    refunds: Table[Refund]
    cs_cases: Table[CsCase]
    webhook_events: Table[WebhookEventRecord]
    outbox: Table[OutboxItem]
    operations: OperationTable  # EC:J1-J5


NotifyType = Literal[
    "payment.failed",
    "grace.started",
    "grace.ending",
    "subscription.canceled",
    "refund.executed",
    "cs.needs_human",
    "reconcile.mismatch",
    "card.expiring",
    "usage.soft_cap",
    "credits.expiring",
]


@dataclass(kw_only=True, slots=True)
class Notification:
    type: NotifyType
    customer_id: str | None
    payload: dict[str, Any]


class Notifier(Protocol):
    async def send(self, n: Notification) -> None: ...


# ── Logger / audit trail (docs/EDGE_CASES.md §L) ────────────────────────────
# EC:L1 L2 L5 — every app-visible mutation and every provider HTTP exchange goes through this DI
# seam so a customer's production run leaves an evidence trail without the kit ever choosing to
# log PII (implementations redact -- see packages/core/py/src/boilpayment_core/logger.py
# `redact`/`BaseLogger`).
LogLevel = Literal["debug", "info", "warn", "error"]


class Logger(Protocol):
    # entry is a plain dict: {"level": ..., "event": ..., "at"?: datetime, **fields}. Mirrors ts
    # LogEntry (a flexible extra-fields object), not a dataclass, so callers pass through arbitrary
    # provider/webhook fields without a wrapper type per event kind.
    async def log(self, entry: dict[str, Any]) -> None: ...


@dataclass(kw_only=True, slots=True)
class Deps:
    clock: Clock
    ids: IdGen
    ledger: LedgerStore
    repo: Repo
    notifier: Notifier
    providers: dict[str, PaymentProvider]
    policy: Policy
    # EC:L1 — optional; every caller falls back to NoopLogger so no existing Deps construction breaks.
    logger: Logger | None = None
