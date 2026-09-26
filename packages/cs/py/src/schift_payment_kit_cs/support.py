"""Stored customer/payment evidence for the identifier-only support APIs."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import timedelta

from schift_payment_kit_core import (
    Clock,
    CsCase,
    IdGen,
    LedgerStore,
    Notifier,
    Payment,
    PaymentKitError,
    PaymentProvider,
    Policy,
    ProviderName,
    Repo,
    deserialize_cs_case,
    run_idempotent,
    serialize_cs_case,
)

from .cases import (
    EscalateInput,
    OnCaseEvent,
    OpenCaseInput,
    RejectInput,
    escalate,
    open_case,
    reject,
)
from .metrics import LicenseReporter
from .purchase_snapshot import get_purchase_snapshot


@dataclass(frozen=True, slots=True, kw_only=True)
class SupportDeps:
    policy: Policy
    providers: Mapping[ProviderName, PaymentProvider]
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    ids: IdGen
    notifier: Notifier | None = None
    on_case_event: OnCaseEvent | None = None
    reporter: LicenseReporter | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class SupportPaymentInput(SupportDeps):
    customer_id: str
    payment_id: str


@dataclass(frozen=True, slots=True)
class VerifiedPayment:
    case: CsCase
    payment: Payment
    provider: PaymentProvider


@dataclass(frozen=True, slots=True)
class UnverifiedPayment:
    case: CsCase


async def verify_support_payment(
    input: SupportPaymentInput, *, kind: str, case_key: str = ""
) -> VerifiedPayment | UnverifiedPayment:
    """Require local ownership and corroborating provider facts before changing funds or credits."""

    async def create_case() -> CsCase:
        return await open_case(
            OpenCaseInput(
                customer_id=input.customer_id,
                reference_id=input.payment_id,
                kind=kind,
                policy=input.policy,
                repo=input.repo,
                clock=input.clock,
                ids=input.ids,
                on_case_event=input.on_case_event,
            )
        )

    created = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"support-case:{kind}:{input.customer_id}:{input.payment_id}:{case_key}",
        kind="cs.supportCase",
        payload={
            "customer_id": input.customer_id,
            "payment_id": input.payment_id,
            "kind": kind,
        },
        serialize=serialize_cs_case,
        deserialize=deserialize_cs_case,
        fn=create_case,
    )
    case = await input.repo.cs_cases.get(created.result.id) or created.result
    payment = await input.repo.payments.get(input.payment_id)
    customer = await input.repo.customers.get(input.customer_id)
    if customer is None or payment is None or payment.customer_id != input.customer_id:
        return UnverifiedPayment(
            await reject(
                RejectInput(
                    case=case,
                    reason="customer payment not found",
                    reporter=input.reporter,
                    repo=input.repo,
                    clock=input.clock,
                    on_case_event=input.on_case_event,
                )
            )
        )

    async def hold(reason: str) -> UnverifiedPayment:
        return UnverifiedPayment(
            await escalate(
                EscalateInput(
                    case=case,
                    reason=reason,
                    repo=input.repo,
                    clock=input.clock,
                    notifier=input.notifier,
                    on_case_event=input.on_case_event,
                )
            )
        )

    provider = input.providers.get(payment.provider)
    customer_ref = next(
        (ref.ref for ref in customer.provider_refs if ref.provider == payment.provider),
        None,
    )
    if provider is None or provider.name != payment.provider or customer_ref is None:
        return await hold("payment provider ownership evidence is unavailable")
    try:
        live = await provider.get_payment(payment.provider_ref)
        owner_matches = live.customer_id in (input.customer_id, customer_ref)
        if not owner_matches and live.customer_id == "":
            listed = await provider.list_payments(
                customer_ref=customer_ref,
                since=payment.occurred_at - timedelta(milliseconds=1),
            )
            owner_matches = any(
                candidate.provider_ref == payment.provider_ref
                and candidate.amount == payment.amount
                for candidate in listed
            )
        if (
            not owner_matches
            or live.provider_ref != payment.provider_ref
            or live.provider != payment.provider
            or live.amount != payment.amount
        ):
            return await hold("local payment and provider evidence disagree")
        if live.status not in ("succeeded", "partially_refunded"):
            return await hold(f"provider payment is {live.status}")
        if payment.status in ("refunded", "disputed", "failed"):
            return await hold("local payment requires reconciliation")
        verified = replace(payment, status=live.status)
        await input.repo.payments.put(verified)
        return VerifiedPayment(case, verified, provider)
    except (PaymentKitError, OSError, TimeoutError, RuntimeError):
        return await hold(
            "provider payment verification failed; retry after reconciliation"
        )


async def resolve_topup_credits(*, payment: Payment, repo: Repo) -> int | None:
    """Only an immutable sale snapshot establishes a top-up entitlement."""
    snapshot = await get_purchase_snapshot(payment_id=payment.id, repo=repo)
    if (
        payment.kind != "topup"
        or not snapshot
        or snapshot.plan.interval is not None
        or snapshot.customer_id != payment.customer_id
        or snapshot.payment_ref != payment.provider_ref
        or snapshot.provider != payment.provider
        or snapshot.price.currency != payment.amount.currency
        or snapshot.price.amount_minor != payment.amount.amount_minor
    ):
        return None
    return (
        snapshot.plan.credits_per_period
        if snapshot.plan.credits_per_period > 0
        else None
    )
