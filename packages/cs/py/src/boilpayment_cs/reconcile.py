"""spec/cs.pseudo.md — EC:E1 H4"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from boilpayment_core import (
    Clock,
    CsCase,
    IdGen,
    LedgerStore,
    PaymentProvider,
    Policy,
    Repo,
)

from .cases import OnCaseEvent, OpenCaseInput, open_case


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


async def reconcile(input: ReconcileInput) -> list[CsCase]:
    """EC:E1 -- cs.reconcile({customer_id?, providers, ledger, repo, policy, clock, ids, since}) -> CsCase[]"""
    if input.customer_id:
        customer = await input.repo.customers.get(input.customer_id)
        customers = [customer] if customer is not None else []
    else:
        customers = await input.repo.customers.list()

    cases: list[CsCase] = []
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
                    grant_key = f"grant:{payment.subscription_id}:{payment.period.start.isoformat()}"
                elif payment.kind == "topup":
                    grant_key = f"topup:{payment.id}"
                else:
                    continue  # overage payments aren't grant-backed
                grant_entries = await input.ledger.entries(customer.id, kind="grant")
                found = any(e.idempotency_key == grant_key for e in grant_entries)
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
