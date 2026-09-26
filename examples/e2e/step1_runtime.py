"""Generated Python kit against local provider HTTP, with in-memory storage.

Run through `bun examples/e2e/step1-run.ts --python` after the workspace build.
Uses the already provisioned workspace environment; installs no dependencies.
"""

from __future__ import annotations

import importlib.util
import json
import os
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import Request, urlopen

import anyio
from boilpayment_core import (
    CollectingNotifier,
    Customer,
    Deps,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    NoopLogger,
    Period,
    ProviderRef,
    SequentialIdGen,
    Subscription,
)
from boilpayment_portone import PortoneProvider, PortoneProviderConfig
from boilpayment_schema_postgres import (
    PostgresLedgerStore,
    PostgresRepo,
    migrate,
)
from boilpayment_usage import UsageEventInput


@dataclass(frozen=True, slots=True)
class Fixture:
    customer_id: str
    payment_id: str
    payment_ref: str
    sub: Subscription


async def main() -> None:
    base = os.environ["STEP1_MOCK_URL"]
    assert base.startswith("http://127.0.0.1:")
    config = json.loads(Path("paykit.config.json").read_text())
    spec = importlib.util.spec_from_file_location("generated_step1", Path("paykit/index.py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    clock = FixedClock(datetime(2026, 3, 15, tzinfo=UTC))
    ids = SequentialIdGen("py_step1_")
    database_url = os.environ.get("STEP1_DATABASE_URL")
    if database_url:
        await migrate(conninfo=database_url)
    repo = PostgresRepo(database_url) if database_url else InMemoryRepo()
    ledger = PostgresLedgerStore(database_url) if database_url else InMemoryLedger(ids, clock)
    provider = PortoneProvider(PortoneProviderConfig(
        api_secret="test_step1", store_id="store_step1",
        webhook_secret=os.environ["STEP1_WEBHOOK_SECRET"], api_base=base,
    ))
    deps = Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, notifier=CollectingNotifier(),
                providers={}, policy=None, logger=NoopLogger())
    env = {"DATABASE_URL": database_url or "", "PORTONE_API_SECRET": "test_step1",
           "PORTONE_STORE_ID": "store_step1", "PORTONE_WEBHOOK_SECRET": os.environ["STEP1_WEBHOOK_SECRET"]}
    kit = module.create_payment_kit(config, deps, env, providers_override={"portone": provider})
    await kit["initialize"](verify_schema_first=bool(database_url))
    period = Period(start=datetime(2026, 3, 1, tzinfo=UTC), end=datetime(2026, 4, 1, tzinfo=UTC))
    evidence = []

    def control(path: str, body=None):
        payload = json.dumps(body).encode() if body is not None else None
        request = Request(f"{base}/__test/{path}", data=payload, headers={"content-type": "application/json"})
        with urlopen(request, timeout=5) as response:
            assert response.status == 200
            return json.load(response)

    async def seed(name: str, refund_status: str = "SUCCEEDED") -> Fixture:
        customer_id = f"py_{name}"
        sub = Subscription(id=f"sub_{customer_id}", customer_id=customer_id, plan_id="metered",
            provider="portone", provider_ref=None, status="active", current_period=period, anchor_day=1,
            cancel_at_period_end=False, grace_until=None, billing_key=f"bk_{customer_id}",
            scheduled_plan_id=None, created_at=period.start)
        await repo.customers.put(Customer(id=customer_id, email=f"{name}@example.test",
            provider_refs=[ProviderRef(provider="portone", ref=customer_id)], status="active", created_at=period.start))
        await repo.subscriptions.put(sub)
        checkout = await kit["checkout"](customer_id=customer_id, plan_id="default", provider="portone",
            currency="KRW", request_id=name, success_url="https://example.test/success", cancel_url="https://example.test/cancel")
        payment_ref = checkout.provider_ref
        assert payment_ref is not None
        control("seed", {"id": payment_ref, "status": "PAID", "amount": {"total": 1000},
            "currency": "KRW", "customer": {"id": customer_id}, "paidAt": clock.now().isoformat(),
            "requestedAt": clock.now().isoformat(), "cancellations": [], "testRefundStatus": refund_status})
        payment = await kit["register_completed_checkout"](customer_id=customer_id, checkout_id=checkout.id, payment_ref=payment_ref)
        return Fixture(customer_id, payment.id, payment_ref, sub)

    async def balance(customer_id: str) -> int:
        return (await ledger.balance(customer_id, "paid", clock.now())).available

    async def recover(fixture: Fixture):
        return await kit["support"]["recover_missing_grant"](customer_id=fixture.customer_id, payment_id=fixture.payment_id)

    async def request(fixture: Fixture, amount: int, request_id: str):
        return await kit["support"]["request_refund"](customer_id=fixture.customer_id,
            payment_id=fixture.payment_id, request_id=request_id, requested_amount=Money(amount_minor=amount, currency="KRW"))

    async def webhook(fixture: Fixture, event_type: str, event_id: str, cancellation_id: str | None = None) -> None:
        data = {"paymentId": fixture.payment_ref}
        if cancellation_id is not None:
            data["cancellationId"] = cancellation_id
        signed = control("sign", {"id": event_id, "type": event_type, "data": data})
        await kit["handle_webhook"](signed["rawBody"], signed["headers"], provider="portone")

    # Given persisted payment with missing credit grant; when support recovers it.
    recovery = await seed("recover")
    assert await balance(recovery.customer_id) == 0
    captured_plan = await repo.plans.get("default")
    assert captured_plan is not None
    await repo.plans.put(replace(captured_plan, credits_per_period=900))
    recovered = await recover(recovery)
    # Then retries and duplicate/late signed webhooks leave exactly one 100-credit grant.
    assert recovered.status == "resolved_auto"
    await recover(recovery)
    await webhook(recovery, "Transaction.Paid", "py_late_paid")
    await webhook(recovery, "Transaction.Paid", "py_late_paid")
    assert await balance(recovery.customer_id) == 100
    assert len(await ledger.entries(recovery.customer_id, kind="grant")) == 1
    await repo.plans.put(captured_plan)
    evidence.append({"scenario": "missing_grant_recovery_duplicate_late_webhook", "credits": 100, "grants": 1, "currentPlanCreditsIgnored": 900})

    # Given a policy-approved partial refund; when the same support request is retried.
    partial = await request(recovery, 400, "py_partial")
    await request(recovery, 400, "py_partial")
    # Then provider, refund record and ledger agree without a second execution.
    assert partial.status == "resolved_auto"
    assert await balance(recovery.customer_id) == 60
    refunds = await repo.refunds.list(payment_id=recovery.payment_id)
    assert len(refunds) == 1 and refunds[0].amount.amount_minor == 400 and refunds[0].status == "succeeded"
    assert len([r for r in control("state")["refunds"] if r["paymentId"] == recovery.payment_ref]) == 1
    evidence.append({"scenario": "partial_refund_replay", "amountMinor": 400, "credits": 60, "refunds": 1})

    # Given a refund above the automatic limit; when support evaluates it.
    manual = await seed("manual")
    await recover(manual)
    manual_case = await request(manual, 800, "py_manual")
    # Then the seller's rule requires a person, with no refund or credit mutation.
    assert manual_case.status == "needs_human"
    assert not await repo.refunds.list(payment_id=manual.payment_id)
    assert await balance(manual.customer_id) == 100
    evidence.append({"scenario": "policy_manual_limit", "status": manual_case.status, "credits": 100})

    # Given another customer's payment; when an unauthorized customer requests its refund.
    denied = await kit["support"]["request_refund"](customer_id=manual.customer_id,
        payment_id=recovery.payment_id, request_id="py_denied")
    # Then support rejects it without running a provider refund.
    assert denied.status == "rejected"
    assert len(await repo.refunds.list(customer_id=recovery.customer_id)) == 1
    evidence.append({"scenario": "ownership_denied", "status": denied.status})

    for terminal in ("SUCCEEDED", "FAILED"):
        # Given provider cancellation awaits settlement; credits are held, not revoked.
        fixture = await seed(f"pending_{terminal}", "REQUESTED")
        await recover(fixture)
        original_case = await request(fixture, 400, fixture.payment_id)
        pending, = await repo.refunds.list(payment_id=fixture.payment_id)
        assert pending.status == "pending" and original_case.status == "needs_human"
        assert await balance(fixture.customer_id) == 60
        assert not await ledger.entries(fixture.customer_id, kind="revoke")
        # When notification triggers authoritative settlement retrieval, twice.
        control("settle", {"id": pending.provider_ref, "status": terminal})
        success = terminal == "SUCCEEDED"
        event_type = "Transaction.PartialCancelled" if success else "Transaction.CancelPending"
        await webhook(fixture, event_type, f"py_{terminal}", pending.provider_ref)
        await webhook(fixture, event_type, f"py_{terminal}_repeat", pending.provider_ref)
        # Then original refund and case retain identity and settle exactly once.
        final_refund = await repo.refunds.get(pending.id)
        final_case = await repo.cs_cases.get(original_case.id)
        final_payment = await repo.payments.get(fixture.payment_id)
        assert final_refund and final_case and final_payment
        assert len(await repo.refunds.list(payment_id=fixture.payment_id)) == 1
        assert final_refund.status == ("succeeded" if success else "failed")
        assert final_case.status == ("resolved_auto" if success else "needs_human")
        assert final_payment.status == ("partially_refunded" if success else "succeeded")
        assert await balance(fixture.customer_id) == (60 if success else 100)
        evidence.append({"scenario": f"pending_refund_{terminal.lower()}", "refundIdPreserved": True,
                         "caseStatus": final_case.status, "credits": await balance(fixture.customer_id)})

    # Given 8 units, 5 included, 10 KRW per extra unit; when closing twice.
    usage = await seed("usage")
    await kit["record"](sub=usage.sub, event=UsageEventInput(customer_id=usage.customer_id,
        meter="calls", quantity=8, occurred_at=clock.now(), idempotency_key="py_usage"))
    clock.advance(int((period.end - clock.now()).total_seconds() * 1000))
    await kit["cron"]["close_periods"]()
    await kit["cron"]["close_periods"]()
    # Then exactly one local usage payment represents the 30 KRW provider charge.
    payments = [p for p in await repo.payments.list(customer_id=usage.customer_id) if p.kind == "overage"]
    assert len(payments) == 1 and payments[0].amount.amount_minor == 30
    charges = [c for c in control("state")["charges"] if c["paymentId"] == payments[0].provider_ref]
    assert len(charges) == 1 and charges[0]["amount"] == 30
    evidence.append({"scenario": "usage_overage_replay", "charges": 1, "amountMinor": 30})
    print(json.dumps({"language": "py", "storage": "isolated_postgres" if database_url else "in_memory", "provider": "real_portone_adapter_local_http", "evidence": evidence}))


anyio.run(main)
