# EC:C1 EC:C5 EC:C6 EC:A14 EC:C8 — see spec/usage.pseudo.md
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

from boilpayment_core import (
    INACTIVE_SUBSCRIPTION_STATUSES,
    Clock,
    ConsumeInput,
    ConsumeOrder,
    IdGen,
    LedgerReference,
    LedgerStore,
    Policy,
    Pool,
    Repo,
    Subscription,
)

_POOL_ORDER: Final[dict[ConsumeOrder, list[Pool]]] = {
    "expiring_first": ["paid", "promo", "trial"],
    "promo_first_then_expiring": ["promo", "trial", "paid"],
    "paid_first": ["paid", "trial", "promo"],
}

CheckReason = Literal[
    "grace_block",
    "within_included",
    "hard_block",
    "soft_cap_notify",
    "bill_overage",
    "grace_block_overage",
    "credit_conversion",
    "credit_conversion_insufficient",
    "subscription_inactive",
]


@dataclass(kw_only=True, slots=True)
class CheckResult:
    allow: bool
    overage: int
    reason: CheckReason
    remaining: int
    notify: Literal["usage.soft_cap"] | None = None


async def check(
    *,
    customer_id: str,
    meter: str,
    quantity: int,
    sub: Subscription,
    policy: Policy,
    repo: Repo,
    ledger: LedgerStore,
    clock: Clock,
    ids: IdGen | None = None,
    included_quantity: int | None = None,
    idempotency_key: str | None = None,
) -> CheckResult:
    included = (
        included_quantity
        if included_quantity is not None
        else policy.usage.included_quantity
    )  # EC:C5

    # EC:A27 -- paused / incomplete subscriptions hold no entitlement. EC:C11 -- nor does one that
    # has ended (canceled = the period is over; expired).
    if has_no_entitlement(sub.status):
        return CheckResult(allow=False, overage=0, reason="subscription_inactive", remaining=0)

    # EC:A14 / EC:C6 — grace-period gating
    if sub.status == "past_due" and policy.dunning.usage_during_grace == "block":
        return CheckResult(allow=False, overage=0, reason="grace_block", remaining=0)
    block_grace_overage = (
        sub.status == "past_due"
        and policy.dunning.usage_during_grace == "allow_existing_only"
    )

    # EC:C8 — credit-conversion hybrid replaces quota math entirely
    if policy.usage.credit_conversion is not None:
        conv = policy.usage.credit_conversion
        credit_amount = quantity * conv.credits_per_unit
        key = (
            idempotency_key
            or f"usage:check:{customer_id}:{meter}:{(ids.new_id() if ids else clock.now().isoformat())}"
        )
        result = await ledger.consume(
            ConsumeInput(
                customer_id=customer_id,
                pool_order=_POOL_ORDER[policy.credits.consume_order],
                amount=credit_amount,
                idempotency_key=key,
                meta=LedgerReference(),
                now=clock.now(),
                negative_balance=policy.credits.negative_balance,
                negative_floor=policy.credits.negative_floor,
                reason=f"usage:{meter}",
            )
        )
        if result.ok:
            return CheckResult(
                allow=True,
                overage=0,
                reason="credit_conversion",
                remaining=-result.shortfall,
            )
        return CheckResult(
            allow=False, overage=0, reason="credit_conversion_insufficient", remaining=0
        )

    # EC:C1 — quota + overage mode
    period_events = await repo.usage_events.list(customer_id=customer_id, meter=meter)
    period_usage = sum(
        e.quantity for e in period_events if e.period_start == sub.current_period.start
    )
    projected = period_usage + quantity
    overage = max(0, projected - included)

    if overage == 0:
        return CheckResult(
            allow=True,
            overage=0,
            reason="within_included",
            remaining=max(0, included - projected),
        )
    remaining = max(0, included - period_usage)

    mode = policy.usage.overage
    if mode == "hard_block":
        return CheckResult(
            allow=False, overage=overage, reason="hard_block", remaining=remaining
        )
    if mode == "soft_cap_notify":
        if block_grace_overage:
            return CheckResult(
                allow=False,
                overage=overage,
                reason="grace_block_overage",
                remaining=remaining,
            )
        return CheckResult(
            allow=True,
            overage=overage,
            reason="soft_cap_notify",
            remaining=remaining,
            notify="usage.soft_cap",
        )
    # mode == "bill_overage"
    if block_grace_overage:
        return CheckResult(
            allow=False,
            overage=overage,
            reason="grace_block_overage",
            remaining=remaining,
        )
    return CheckResult(
        allow=True, overage=overage, reason="bill_overage", remaining=remaining
    )


def has_no_entitlement(status: str) -> bool:
    """EC:A27 C11 -- statuses that carry no usage entitlement."""
    return status in INACTIVE_SUBSCRIPTION_STATUSES or status in ("canceled", "expired")
