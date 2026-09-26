"""Typed inputs and committed actions for usage settlement phases."""

from dataclasses import dataclass
from typing import Literal

from boilpayment_core import (
    Clock,
    LedgerStore,
    Money,
    Operation,
    Payment,
    PaymentProvider,
    Period,
    Policy,
    Repo,
    Subscription,
    UsageEvent,
)


@dataclass(frozen=True, slots=True)
class SettlePeriodResult:
    status: Literal[
        "not_due",
        "unchanged",
        "charged",
        "pending",
        "failed",
        "awaiting_provider_billing",
        "report_pending",
        "report_failed",
    ]
    total: int
    charged_amount: Money | None = None
    payment: Payment | None = None


@dataclass(frozen=True, slots=True)
class SettlementInput:
    sub: Subscription
    period: Period
    policy: Policy
    repo: Repo
    ledger: LedgerStore
    provider: PaymentProvider
    clock: Clock
    currency: str | None = None


@dataclass(frozen=True, slots=True)
class PreparedCharge:
    operation: Operation
    payment: Payment
    customer_ref: str
    billing_key: str
    total: int


@dataclass(frozen=True, slots=True)
class PreparedReport:
    events: list[UsageEvent]
    total: int
