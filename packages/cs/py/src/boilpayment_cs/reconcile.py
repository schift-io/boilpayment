"""spec/cs.pseudo.md — EC:E1 H4"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from math import isfinite

from boilpayment_core import (
    Clock,
    CsCase,
    IdGen,
    LedgerStore,
    PaymentKitError,
    PaymentProvider,
    Policy,
    Repo,
    deserialize_cs_case,
    iso_z,
    key_matches_instant,
    run_idempotent,
    serialize_cs_case,
)

from .cases import EscalateInput, OnCaseEvent, OpenCaseInput, escalate, open_case


@dataclass(kw_only=True, slots=True)
class ReconcileInput:
    customer_id: str | None = None
    providers: dict[str, PaymentProvider]
    ledger: LedgerStore
    repo: Repo
    policy: Policy
    clock: Clock
    ids: IdGen
    since: datetime
    on_case_event: OnCaseEvent | None = None
    registration_hold_hours: float = 24


def _held_payment(value) -> tuple[str, str, datetime] | None:
    if not isinstance(value, dict):
        return None
    payment_id = value.get("paymentId") or value.get("payment_id")
    customer_id = value.get("customerId") or value.get("customer_id")
    received_at = value.get("receivedAt") or value.get("received_at")
    if not all(isinstance(item, str) and item for item in (payment_id, customer_id, received_at)):
        return None
    try:
        return payment_id, customer_id, datetime.fromisoformat(received_at)
    except ValueError:
        return None


async def _reconcile_registration_holds(input: ReconcileInput) -> list[CsCase]:
    if not isfinite(input.registration_hold_hours) or input.registration_hold_hours < 0:
        raise PaymentKitError(
            "registration hold window must be non-negative",
            "registration_hold_window_invalid",
        )
    cases: list[CsCase] = []
    for operation in await input.repo.operations.list(kind="checkout.paymentHeld"):
        held = _held_payment(operation.result) if operation.status == "done" else None
        if held is None:
            continue
        payment_id, customer_id, received_at = held
        if input.customer_id and customer_id != input.customer_id:
            continue
        if await input.repo.operations.get(f"purchase-entitlement:{payment_id}") is not None:
            continue
        age_hours = (input.clock.now() - received_at).total_seconds() / 3600
        if age_hours < input.registration_hold_hours:
            continue

        async def open_held_case(
            held_customer_id: str = customer_id,
            held_payment_id: str = payment_id,
        ) -> CsCase:
            case = await open_case(OpenCaseInput(
                customer_id=held_customer_id,
                kind="reconcile_mismatch",
                reference_id=held_payment_id,
                policy=input.policy,
                repo=input.repo,
                clock=input.clock,
                ids=input.ids,
                on_case_event=input.on_case_event,
            ))
            return await escalate(EscalateInput(
                case=case,
                reason="payment checkout registration is still missing",
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
            ))

        recorded = await run_idempotent(
            repo=input.repo,
            clock=input.clock,
            key=f"registration-hold-case:{payment_id}",
            kind="cs.supportCase",
            payload={"payment_id": payment_id, "customer_id": customer_id},
            serialize=serialize_cs_case,
            deserialize=deserialize_cs_case,
            fn=open_held_case,
        )
        cases.append(recorded.result)
    return cases


async def reconcile(input: ReconcileInput) -> list[CsCase]:
    """EC:E1 -- cs.reconcile({customer_id?, providers, ledger, repo, policy, clock, ids, since}) -> CsCase[]"""
    if input.customer_id:
        customer = await input.repo.customers.get(input.customer_id)
        customers = [customer] if customer is not None else []
    else:
        customers = await input.repo.customers.list()

    cases: list[CsCase] = await _reconcile_registration_holds(input)
    for customer in customers:
        for pref in customer.provider_refs:
            provider = input.providers.get(pref.provider)
            if provider is None:
                continue
            payments = await provider.list_payments(
                customer_ref=pref.ref, since=input.since
            )
            for payment in payments:
                if payment.status != "succeeded":
                    continue
                if payment.kind == "subscription":
                    if payment.period is None:
                        continue
                    grant_key = f"grant:{payment.subscription_id}:{iso_z(payment.period.start)}"
                elif payment.kind == "topup":
                    grant_key = f"topup:{payment.id}"
                else:
                    continue  # overage payments aren't grant-backed
                grant_entries = await input.ledger.entries(customer.id, kind="grant")
                found = any(
                    e.idempotency_key == grant_key
                    or (
                        payment.kind == "subscription"
                        and payment.period is not None
                        and key_matches_instant(
                            e.idempotency_key, f"grant:{payment.subscription_id}:", payment.period.start
                        )
                    )
                    for e in grant_entries
                )
                if not found:
                    case = await open_case(
                        OpenCaseInput(
                            customer_id=customer.id,
                            kind="regrant",
                            reference_id=grant_key,
                            policy=input.policy,
                            repo=input.repo,
                            clock=input.clock,
                            ids=input.ids,
                            on_case_event=input.on_case_event,
                        )
                    )
                    cases.append(case)
    return cases


@dataclass(kw_only=True, slots=True)
class BalanceMismatch:
    customer_id: str
    ledger: int
    snapshot: int


async def check_balances(
    *,
    ledger: LedgerStore,
    repo: Repo,
    customer_ids: list[str] | None = None,
    clock: Clock,
) -> list[BalanceMismatch]:
    """EC:H4 -- optional balance cross-check. The core `Repo` contract (fixed; not owned by this
    package) has no `credit_balances` snapshot table, so this only activates if the concrete `repo`
    passed in happens to expose one (duck-typed via `repo.credit_balances`); otherwise it's a
    documented no-op. See final report "계약 변경 제안".
    """
    snapshot_table = getattr(repo, "credit_balances", None)
    if snapshot_table is None:
        return []
    ids = customer_ids or [c.id for c in await repo.customers.list()]
    mismatches: list[BalanceMismatch] = []
    for customer_id in ids:
        live = (
            await ledger.balance(customer_id, "paid", now=clock.now())
        ).available  # FINDINGS#1 class -- now required by LedgerStore.balance
        snap = await snapshot_table.get(customer_id)
        if snap is not None and snap.available != live:
            mismatches.append(
                BalanceMismatch(
                    customer_id=customer_id, ledger=live, snapshot=snap.available
                )
            )
    return mismatches
