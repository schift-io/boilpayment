"""Recover missing credit grants from verified payments and persisted entitlements."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Literal, Protocol, assert_never

from boilpayment_core import (
    Clock,
    CsCase,
    LedgerEntry,
    LedgerStore,
    Payment,
    Period,
    Plan,
    Policy,
    Repo,
    Subscription,
    deserialize_cs_case,
    is_zero_sale_handled,
    key_matches_instant,
    next_period,
    open_zero_sale_case,
    run_idempotent,
    serialize_cs_case,
)

from .apply_purchased_grant import apply_purchased_grant
from .cases import EscalateInput, RejectInput, ResolveInput, escalate, reject, resolve
from .purchase_snapshot import get_purchase_snapshot, matches_captured_sale_amount
from .support import (
    SupportDeps,
    SupportPaymentInput,
    UnverifiedPayment,
    VerifiedPayment,
    verify_support_payment,
)


class SupportGrantOutcome(Protocol):
    entry: LedgerEntry | None
    duplicated: bool
    deferred: bool


class SupportGrants(Protocol):
    async def topup(
        self,
        *,
        customer_id: str,
        payment: Payment,
        credits: int,
        policy: Policy,
        ledger: LedgerStore,
        repo: Repo,
        clock: Clock,
    ) -> SupportGrantOutcome: ...
    async def grant_for_period(
        self,
        *,
        sub: Subscription,
        plan: Plan,
        period: Period,
        payment: Payment,
        policy: Policy,
        ledger: LedgerStore,
        clock: Clock,
    ) -> SupportGrantOutcome: ...


@dataclass(frozen=True, slots=True, kw_only=True)
class RecoverMissingGrantInput(SupportPaymentInput):
    grants: SupportGrants
    # Appends the affiliate commission accrual for a granted payment; idempotent per payment.
    accrue_affiliate: Callable[[Payment], Awaitable[None]] | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class RecoverMissingGrantsInput(SupportDeps):
    grants: SupportGrants
    accrue_affiliate: Callable[[Payment], Awaitable[None]] | None = None
    # AF-04 -- whether a recovered native renewal accrues ("include") or only a first purchase does.
    affiliate_renewals: Literal["first_only", "include"] = "first_only"
    customer_id: str | None = None
    since: datetime | None = None


def _raw_contains(value: Any, expected: str) -> bool:
    if value == expected:
        return True
    if isinstance(value, list):
        return any(_raw_contains(item, expected) for item in value)
    if isinstance(value, dict):
        return any(_raw_contains(item, expected) for item in value.values())
    return False


def _preserved_trial_opening_invoice_raw(
    payment: Payment, existing: Payment | None,
) -> dict[str, Any] | None:
    raw = payment.raw if isinstance(payment.raw, dict) else {}
    existing_raw = existing.raw if existing and isinstance(existing.raw, dict) else {}
    if existing_raw.get("boilpaymentTrialOpeningInvoice") is True:
        return {**(raw or existing_raw), "boilpaymentTrialOpeningInvoice": True}
    return None


async def _open_reconcile_mismatch(
    sub: Subscription, payment: Payment, input: RecoverMissingGrantsInput,
    actual_plan_id: str | None, reason: str | None = None,
) -> CsCase:
    case_id = f"reconcile_mismatch:{payment.id}"
    existing = await input.repo.cs_cases.get(case_id)
    if existing is not None:
        return existing
    now = input.clock.now()
    mismatch_case = CsCase(
        id=case_id, customer_id=sub.customer_id, kind="reconcile_mismatch", status="needs_human",
        reference_id=payment.id, policy_snapshot=deepcopy(input.policy), decision={
            "subscriptionId": sub.id, "expectedPlanId": sub.scheduled_plan_id or sub.plan_id,
            "actualPlanId": actual_plan_id,
            "amountMinor": payment.amount.amount_minor, "currency": payment.amount.currency,
            **({"reason": reason} if reason else {}),
        }, churn_reason=None, churn_text=None, opened_at=now, resolved_at=None, escalated_at=now,
    )
    await input.repo.cs_cases.put(mismatch_case)
    return mismatch_case


async def _resolve_reconciled_plan(
    sub: Subscription, payment: Payment, input: RecoverMissingGrantsInput,
) -> tuple[Plan | None, CsCase | None]:
    expected_plan_id = sub.scheduled_plan_id or sub.plan_id
    expected = await input.repo.plans.get(expected_plan_id)
    currency = payment.amount.currency.upper()
    expected_matches = (
        expected is not None
        and expected.interval is not None
        and any(
            (
                (price.provider_price_refs or {}).get(payment.provider) is not None
                and (
                    payment.sale_evidence is not None
                    and payment.sale_evidence.price_ref == (price.provider_price_refs or {})[payment.provider]
                    or _raw_contains(payment.raw, (price.provider_price_refs or {})[payment.provider])
                )
            )
            or (
                price.currency.upper() == currency
                and price.amount_minor == payment.amount.amount_minor
            )
            for price in expected.prices
        )
    )
    if expected_matches:
        return expected, None
    plans = [plan for plan in await input.repo.plans.list() if plan.interval is not None]
    by_provider_ref = [
        plan for plan in plans
        if any(
            (price.provider_price_refs or {}).get(payment.provider) is not None
            and (
                payment.sale_evidence is not None
                and payment.sale_evidence.price_ref == (price.provider_price_refs or {})[payment.provider]
                or _raw_contains(payment.raw, (price.provider_price_refs or {})[payment.provider])
            )
            for price in plan.prices
        )
    ]
    by_amount = [
        plan for plan in plans
        if any(price.currency.upper() == currency and price.amount_minor == payment.amount.amount_minor
               for price in plan.prices)
    ]
    candidates = by_provider_ref if by_provider_ref else by_amount
    actual = candidates[0] if len(candidates) == 1 else None
    if actual is not None and actual.id == expected_plan_id:
        return actual, None

    # SB-14 -- a renewal charged at another (or ambiguous) price must never receive the scheduled
    # plan's credits. The deterministic case deduplicates late-webhook mismatch handling.
    mismatch_case = await _open_reconcile_mismatch(
        sub, payment, input, actual.id if actual else None,
    )
    return actual, mismatch_case


async def recover_missing_grant(input: RecoverMissingGrantInput) -> CsCase:
    """Replay original credit primitives; the customer cannot provide grant amounts or approval."""
    recorded = await input.repo.operations.get(
        f"support-case:regrant:{input.customer_id}:{input.payment_id}:"
    )
    if recorded and recorded.status == "done":
        stored = await input.repo.cs_cases.get(deserialize_cs_case(recorded.result).id)
        if stored and stored.status in ("resolved_auto", "resolved_human", "rejected"):
            return stored
    verification = await verify_support_payment(input, kind="regrant")
    match verification:
        case UnverifiedPayment(case=case):
            return case
        case VerifiedPayment(case=case, payment=payment):
            pass
        case unreachable:
            assert_never(unreachable)
    policy = case.policy_snapshot

    async def hold(reason: str) -> CsCase:
        return await escalate(
            EscalateInput(
                case=case,
                reason=reason,
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
                notifier=input.notifier,
            )
        )

    if payment.status != "succeeded":
        return await hold("only an unrefunded successful payment can recover credits")
    if policy.cs.regrant.mode == "off":
        return await reject(
            RejectInput(
                reporter=input.reporter,
                case=case,
                reason="cs.regrant.mode=off",
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
            )
        )
    snapshot = await get_purchase_snapshot(payment_id=payment.id, repo=input.repo)
    if (
        not snapshot
        or snapshot.customer_id != input.customer_id
        or snapshot.payment_ref != payment.provider_ref
        or snapshot.provider != payment.provider
        or not matches_captured_sale_amount(snapshot, payment)
        or snapshot.plan.credits_per_period <= 0
    ):
        return await hold("immutable purchase entitlement is missing or inconsistent")
    credits = snapshot.plan.credits_per_period
    grant_key = (
        f"topup:{payment.id}"
        if snapshot.plan.interval is None
        else f"grant:{snapshot.subscription_id}:{snapshot.period['start']}"
        if snapshot.subscription_id and snapshot.period
        else None
    )
    if not grant_key:
        return await hold("subscription purchase evidence missing")
    if policy.cs.regrant.mode == "manual_approve":
        return await hold("cs.regrant.mode=manual_approve, awaiting approval")

    async def accrue() -> None:
        if input.accrue_affiliate is not None:
            await input.accrue_affiliate(replace(
                payment, affiliate_id=payment.affiliate_id or snapshot.affiliate_id,
            ))

    async def complete() -> CsCase:
        entries = await input.ledger.entries(input.customer_id, kind="grant")
        existing = next(
            (
                entry
                for entry in entries
                if entry.idempotency_key == grant_key
                or (
                    snapshot.plan.interval is not None
                    and snapshot.subscription_id
                    and snapshot.period
                    and key_matches_instant(
                        entry.idempotency_key,
                        f"grant:{snapshot.subscription_id}:",
                        datetime.fromisoformat(str(snapshot.period["start"])),
                    )
                )
            ),
            None,
        )  # EC:J11
        if existing:
            await accrue()
            return await resolve(
                ResolveInput(
                    reporter=input.reporter,
                    case=case,
                    by="auto",
                    decision={
                        "granted": False,
                        "entryId": existing.id,
                        "paymentId": payment.id,
                        "idempotencyKey": grant_key,
                    },
                    repo=input.repo,
                    clock=input.clock,
                    on_case_event=input.on_case_event,
                )
            )
        outcome = await apply_purchased_grant(input)
        if outcome.entry is None or outcome.deferred:
            return await hold("credit grant was deferred")
        await accrue()
        return await resolve(
            ResolveInput(
                reporter=input.reporter,
                case=case,
                by="auto",
                decision={
                    "granted": not outcome.duplicated,
                    "entryId": outcome.entry.id,
                    "paymentId": payment.id,
                    "credits": credits,
                    "idempotencyKey": grant_key,
                },
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
            )
        )

    completed = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"support-recover-complete:{case.id}",
        kind="cs.recoverMissingGrant",
        payload={"grant_key": grant_key},
        serialize=serialize_cs_case,
        deserialize=deserialize_cs_case,
        fn=complete,
    )
    return await input.repo.cs_cases.get(completed.result.id) or completed.result


async def recover_missing_grants(input: RecoverMissingGrantsInput) -> list[CsCase]:
    """Reconcile native renewals, then scan local payments that still lack their grant."""
    # SB-06 -- Stripe/Polar can charge a native renewal even when its webhook is lost. Pull those
    # payments from each eligible local subscription and use the webhook's canonical grant key.
    reconciled_cases: list[CsCase] = []
    if input.since is not None:
        subscriptions = await input.repo.subscriptions.list(
            **({"customer_id": input.customer_id} if input.customer_id else {})
        )
        for listed in subscriptions:
            if listed.provider not in ("stripe", "polar") or listed.status not in ("active", "past_due"):
                continue
            if not listed.provider_ref:
                continue
            provider = input.providers.get(listed.provider)
            if provider is None or not provider.capabilities().native_subscriptions:
                continue
            customer = await input.repo.customers.get(listed.customer_id)
            customer_ref = next((ref.ref for ref in customer.provider_refs if ref.provider == listed.provider), None) if customer else None
            if customer_ref is None:
                continue
            remote_payments = await provider.list_payments(customer_ref=customer_ref, since=input.since)
            remote_payments.sort(key=lambda payment: payment.occurred_at)
            for remote in remote_payments:
                if (remote.provider != listed.provider or remote.kind != "subscription" or remote.status != "succeeded"
                        or remote.subscription_id != listed.provider_ref or remote.occurred_at < input.since):
                    continue
                current = await input.repo.subscriptions.get(listed.id)
                if current is None or current.status not in ("active", "past_due"):
                    continue
                matches = await input.repo.payments.list(provider=current.provider, provider_ref=remote.provider_ref)
                existing = matches[0] if matches else None
                if existing is not None and (existing.customer_id != current.customer_id or existing.subscription_id != current.id):
                    continue
                payment = Payment(
                    id=existing.id if existing else input.ids.new_id(), customer_id=current.customer_id,
                    provider=current.provider, provider_ref=remote.provider_ref, subscription_id=current.id,
                    amount=remote.amount, status=remote.status, kind="subscription",
                    period=remote.period or (existing.period if existing else None),
                    occurred_at=remote.occurred_at, failure=remote.failure,
                    cash_receipt=existing.cash_receipt if existing else None,
                    raw=remote.raw, provider_ref_aliases=remote.provider_ref_aliases,
                    sale_evidence=remote.sale_evidence or (existing.sale_evidence if existing else None),
                    affiliate_id=remote.affiliate_id or current.affiliate_id or (existing.affiliate_id if existing else None),
                )
                trial_opening_raw = _preserved_trial_opening_invoice_raw(
                    payment, existing,
                )
                if trial_opening_raw is not None:
                    await input.repo.payments.put(
                        replace(payment, raw=trial_opening_raw)
                    )
                    continue
                await input.repo.payments.put(payment)
                if payment.amount.amount_minor == 0:  # DC-07 -- a paid-zero renewal is never granted
                    zero_case = await open_zero_sale_case(
                        repo=input.repo, clock=input.clock, policy=input.policy,
                        payment=payment, notifier=input.notifier,
                    )
                    if all(case.id != zero_case.id for case in reconciled_cases):
                        reconciled_cases.append(zero_case)
                    continue
                plan, mismatch_case = await _resolve_reconciled_plan(current, payment, input)
                if mismatch_case is not None and all(case.id != mismatch_case.id for case in reconciled_cases):
                    reconciled_cases.append(mismatch_case)
                if plan is None:
                    continue
                if payment.period is None:
                    derived = (
                        next_period(
                            current.current_period, plan.interval, current.anchor_day,
                            input.policy.period.timezone, input.policy.period.month_end_anchor,
                        )
                        if payment.provider == "polar" and plan.interval is not None else None
                    )
                    safely_mapped = (
                        derived is not None and derived.start <= payment.occurred_at < derived.end
                    )
                    if derived is None or not safely_mapped:
                        period_case = await _open_reconcile_mismatch(
                            current, payment, input, plan.id, "renewal_period_unresolved",
                        )
                        if all(case.id != period_case.id for case in reconciled_cases):
                            reconciled_cases.append(period_case)
                        continue
                    payment = replace(payment, period=derived)
                    await input.repo.payments.put(payment)
                await input.grants.grant_for_period(
                    sub=replace(current, plan_id=plan.id, status="active"), plan=plan, period=payment.period,
                    payment=payment, policy=input.policy, ledger=input.ledger, clock=input.clock,
                )
                # AF-04 -- same rule as the webhook: renewals accrue only when configured, a first purchase always does.
                if input.accrue_affiliate is not None and (
                    input.affiliate_renewals == "include"
                    or (
                        (purchase := await input.repo.operations.get(f"purchase-entitlement:{payment.id}")) is not None
                        and purchase.kind == "purchase.entitlement"
                    )
                ):
                    await input.accrue_affiliate(payment)
                fresh = await input.repo.subscriptions.get(current.id)
                if fresh is not None and fresh.status in ("active", "past_due") and payment.period.end > fresh.current_period.end:
                    await input.repo.subscriptions.put(replace(
                        fresh, plan_id=plan.id, scheduled_plan_id=None, current_period=payment.period,
                        status="active", grace_until=None,
                    ))
    payments = (
        await input.repo.payments.list(customer_id=input.customer_id)
        if input.customer_id
        else await input.repo.payments.list()
    )
    results: list[CsCase] = [*reconciled_cases]
    for payment in payments:
        if (
            input.since and payment.occurred_at < input.since
        ) or payment.kind == "overage":
            continue
        # EC:A46 -- a declined charge bought nothing; a pending self-scheduled attempt belongs to the scheduler.
        if payment.status == "failed":
            continue
        # OT-09 -- a payment held for its registration is not a missing grant; only the registration-hold
        # path (reconcile, after the window) opens the single case for it.
        if (
            await input.repo.operations.get(f"checkout-payment-held:{payment.id}") is not None
            and await input.repo.operations.get(f"purchase-entitlement:{payment.id}") is None
        ):
            continue
        raw = payment.raw if isinstance(payment.raw, dict) else {}
        if raw.get("boilpaymentTrialOpeningInvoice") is True:
            continue
        if await is_zero_sale_handled(input.repo, payment.id):
            continue  # DC-07 -- a person already has the case
        if payment.status == "pending" and raw.get("boilpaymentAttemptKey"):
            continue
        entries = await input.ledger.entries(payment.customer_id, kind="grant")
        if any(entry.reference.payment_id == payment.id for entry in entries):
            continue
        if await input.repo.cs_cases.get(f"reconcile_mismatch:{payment.id}") is not None:
            continue
        # EC:A46 -- already handed to a person: report the open case again, do not re-notify.
        recorded = await input.repo.operations.get(f"support-case:regrant:{payment.customer_id}:{payment.id}:")
        if recorded and recorded.status == "done":
            open_case = await input.repo.cs_cases.get(deserialize_cs_case(recorded.result).id)
            if open_case is not None and open_case.status == "needs_human":
                results.append(open_case)
                continue
        results.append(
            await recover_missing_grant(
                RecoverMissingGrantInput(
                    customer_id=payment.customer_id,
                    payment_id=payment.id,
                    policy=input.policy,
                    providers=input.providers,
                    ledger=input.ledger,
                    repo=input.repo,
                    clock=input.clock,
                    ids=input.ids,
                    grants=input.grants,
                    notifier=input.notifier,
                    on_case_event=input.on_case_event,
                    accrue_affiliate=input.accrue_affiliate,
                )
            )
        )
    return results


ApplyPurchasedGrantInput = RecoverMissingGrantInput
