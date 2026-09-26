"""spec/refund.pseudo.md — EC:D1 D2 D3 D4 D5 D6 D7 D10 B13 A22 B8"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from schift_payment_kit_core import (
    Clock,
    LedgerEntry,
    LedgerStore,
    Payment,
    Policy,
    RefundDecision,
    Repo,
    Subscription,
)

from .util import apply_rounding, days_between, proration_ratio, weighted_avg_unit_price


@dataclass(kw_only=True, slots=True)
class EvaluateInput:
    payment: Payment
    sub: Subscription | None = None
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    # CS-initiated partial refund request. Can only reduce the policy-computed amount, never raise it.
    requested_amount: dict | None = None  # {"amount_minor": int, "currency": str}
    # D7: PG fee, unknown to us unless the caller supplies it (provider-specific).
    provider_fee_minor: int | None = None


def _ineligible(
    payment: Payment, sub_id: str | None, rule_id: str, reason: str
) -> RefundDecision:
    return RefundDecision(
        eligible=False,
        amount=type(payment.amount)(amount_minor=0, currency=payment.amount.currency),
        credits_to_revoke=0,
        rule_id=rule_id,
        reason=reason,
        needs_human=False,
        payment_id=payment.id,
        customer_id=payment.customer_id,
        subscription_id=sub_id,
    )


async def _granted_by_payment(
    ledger: LedgerStore, customer_id: str, payment_id: str
) -> list[LedgerEntry]:
    entries = await ledger.entries(customer_id, kind="grant")
    return [
        e
        for e in entries
        if e.reference.payment_id == payment_id
        and e.source in ("subscription", "topup")
    ]


async def _consumed_from_grants(
    ledger: LedgerStore,
    customer_id: str,
    grants: list[LedgerEntry],
    total_granted: int,
    now: datetime,
) -> int:
    grant_ids = {g.id for g in grants}
    if not grant_ids:
        return 0
    consume_entries = [
        e
        for e in await ledger.entries(customer_id, kind="consume")
        if e.reference.grant_id is not None and e.reference.grant_id in grant_ids
    ]
    if consume_entries:
        return sum(-e.amount for e in consume_entries)
    # B8 fallback: ledger lacks grantId attribution -- approximate via current balance.
    balance = await ledger.balance(customer_id, "paid", now=now)
    return max(0, total_granted - min(balance.available, total_granted))


async def evaluate(input: EvaluateInput) -> RefundDecision:
    """EC:evaluate -- refund.evaluate({payment, sub, policy, ledger, repo, clock, requested_amount?}) -> RefundDecision"""
    payment, sub, policy, ledger, repo, clock = (
        input.payment,
        input.sub,
        input.policy,
        input.ledger,
        input.repo,
        input.clock,
    )
    sub_id = sub.id if sub else None
    if input.requested_amount is not None and (
        type(input.requested_amount["amount_minor"]) is not int
        or not 0 < input.requested_amount["amount_minor"] <= 9_007_199_254_740_991
        or input.requested_amount["currency"] != payment.amount.currency
    ):
        return _ineligible(payment, sub_id, "D-request", "requested amount must be a positive minor-unit integer in the payment currency")

    # Step 1 -- status guard
    if payment.status not in ("succeeded", "partially_refunded"):
        return _ineligible(
            payment,
            sub_id,
            "D-status",
            f"payment status '{payment.status}' is not refundable",
        )

    now = clock.now()
    days_since = days_between(payment.occurred_at, now)
    customer_id = payment.customer_id

    # Step 2 -- EC:D10 velocity (flagged now, applied at the end)
    window_start = now - timedelta(days=365)
    past_refunds = await repo.refunds.list(customer_id=customer_id)
    refund_count_last_year = len(
        [
            r
            for r in past_refunds
            if r.status == "succeeded" and r.created_at >= window_start
        ]
    )
    velocity_triggered = (
        refund_count_last_year >= policy.refund.max_per_customer_per_year
    )

    already_refunded_minor = sum(
        r.amount.amount_minor
        for r in await repo.refunds.list(payment_id=payment.id)
        if r.status == "succeeded"
    )

    grants = await _granted_by_payment(ledger, customer_id, payment.id)
    total_granted = sum(g.amount for g in grants)
    revoke_entries = await ledger.entries(customer_id, kind="revoke")
    already_revoked = sum(
        -e.amount
        for e in revoke_entries
        if e.reference.payment_id == payment.id and e.source == "refund"
    )

    if days_since <= policy.refund.no_questions_days:
        # EC:D1
        amount_minor = max(0, payment.amount.amount_minor - already_refunded_minor)
        credits_to_revoke = max(0, total_granted - already_revoked)
        rule_id = "D1"
        reason = f"D1: no-questions window ({days_since}/{policy.refund.no_questions_days}d) -> full {amount_minor} minor, revoke {credits_to_revoke} credits"
    else:
        # EC:D2 D3 D4 B8
        method = policy.refund.method
        if method == "deny":
            return _ineligible(payment, sub_id, "D2", "refund.method=deny")

        consumed = await _consumed_from_grants(
            ledger, customer_id, grants, total_granted, clock.now()
        )
        unit_price = weighted_avg_unit_price(grants)

        def compute_unused() -> tuple[int, int]:
            unused = max(0, total_granted - consumed)
            return round(unused * unit_price), unused

        def compute_time_prorated() -> tuple[int, int, str | None]:
            if payment.period is None:
                raise ValueError(
                    "refund.evaluate: time_prorated requires payment.period"
                )
            ratio = proration_ratio(payment.period, now, policy.proration.denominator)
            amount = round(payment.amount.amount_minor * ratio)
            elapsed_ratio = 1 - ratio
            consumed_ratio = (consumed / total_granted) if total_granted > 0 else 0
            if (
                consumed_ratio > elapsed_ratio
                and policy.refund.overuse_behavior == "deny"
            ):
                return (
                    0,
                    0,
                    f"overuse: consumed {consumed_ratio * 100:.1f}% > elapsed {elapsed_ratio * 100:.1f}%",
                )
            raw_credits = (amount / unit_price) if unit_price > 0 else 0
            return amount, apply_rounding(raw_credits, policy.refund.rounding), None

        rule_id = "D2"
        if method == "unused_credits":
            amount_minor, credits_to_revoke = compute_unused()
            reason = f"D2: unused_credits {credits_to_revoke} credits x {unit_price} minor/credit -> {amount_minor} minor"
        elif method == "time_prorated":
            amount_minor, credits_to_revoke, denied = compute_time_prorated()
            if denied:
                return _ineligible(payment, sub_id, "D3", denied)
            reason = f"D2: time_prorated -> {amount_minor} minor, revoke {credits_to_revoke} credits"
        else:
            # min_of_both
            a_amount, a_credits = compute_unused()
            b_amount, b_credits, b_denied = compute_time_prorated()
            if b_denied:
                return _ineligible(payment, sub_id, "D3", b_denied)
            elif a_amount <= b_amount:
                amount_minor, credits_to_revoke = a_amount, a_credits
                reason = f"D2: min_of_both -> unused_credits {a_amount} minor <= time_prorated {b_amount} minor"
            else:
                amount_minor, credits_to_revoke = b_amount, b_credits
                reason = f"D2: min_of_both -> time_prorated {b_amount} minor < unused_credits {a_amount} minor"

    # EC:D5 -- annual plan refund window
    if sub is not None:
        plan = await repo.plans.get(sub.plan_id)
        if (
            plan is not None
            and plan.interval == "year"
            and policy.refund.annual_method == "deny_after_days"
        ):
            limit = policy.refund.annual_deny_after_days
            if limit is not None and days_since > limit:
                return _ineligible(
                    payment,
                    sub_id,
                    "D5",
                    f"annual plan, deny_after_days={limit}, elapsed={days_since}",
                )

    remaining_minor = max(0, payment.amount.amount_minor - already_refunded_minor)
    if amount_minor > remaining_minor:
        credits_to_revoke = apply_rounding(
            credits_to_revoke * remaining_minor / amount_minor, policy.refund.rounding
        )
        amount_minor = remaining_minor
        reason += f"; remaining payment cap -> {amount_minor} minor, {credits_to_revoke} credits"

    # Requested amount can only reduce (CS-initiated partial refund), never raise, the policy-computed amount.
    if (
        input.requested_amount is not None
        and input.requested_amount["amount_minor"] < amount_minor
        and amount_minor > 0
    ):
        ratio = input.requested_amount["amount_minor"] / amount_minor
        amount_minor = input.requested_amount["amount_minor"]
        credits_to_revoke = apply_rounding(
            credits_to_revoke * ratio, policy.refund.rounding
        )
        reason += f"; requestedAmount override -> {amount_minor} minor, {credits_to_revoke} credits"

    # EC:D7 -- fee borne by customer
    if policy.refund.fee_bearer == "customer":
        fee = input.provider_fee_minor or 0
        if fee > 0:
            amount_minor = max(0, amount_minor - fee)
            reason += f"; D7 fee {fee} minor deducted (customer-borne)"

    # EC:B13 -- revoke shortfall
    available = max(0, (await ledger.balance(customer_id, "paid", now=clock.now())).available)
    if available < credits_to_revoke:
        behavior = policy.refund.revoke_shortfall
        if behavior == "clamp_and_reduce_refund":
            ratio = (
                (available / credits_to_revoke) if credits_to_revoke > 0 else 1
            )
            amount_minor = int(amount_minor * ratio)  # floor
            reason += f"; B13 clamp_and_reduce_refund: balance {available} < {credits_to_revoke} -> amount {amount_minor} minor, {available} credits"
            credits_to_revoke = available
        elif behavior == "clamp_to_zero":
            reason += f"; B13 clamp_to_zero: revoke only {available} of {credits_to_revoke}, amount unchanged"
            credits_to_revoke = available
        else:
            reason += f"; B13 allow_negative: revoking {credits_to_revoke} against balance {available}"

    if amount_minor <= 0:
        return _ineligible(payment, sub_id, "D-zero", "no refundable amount remains after applying policy")

    needs_human = (
        amount_minor > policy.cs.auto_approve.max_amount_minor
        or credits_to_revoke > policy.cs.auto_approve.max_credits
    )
    if velocity_triggered:
        needs_human = True
        rule_id = "D10"
        reason += f"; D10 velocity: {refund_count_last_year}/{policy.refund.max_per_customer_per_year} refunds in past year -> needs human"

    return RefundDecision(
        eligible=True,
        amount=type(payment.amount)(amount_minor=amount_minor, currency=payment.amount.currency),
        credits_to_revoke=credits_to_revoke,
        rule_id=rule_id,
        reason=reason,
        needs_human=needs_human,
        payment_id=payment.id,
        customer_id=customer_id,
        subscription_id=sub_id,
    )
