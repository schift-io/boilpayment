"""Round-8 audit regressions (bp-audit8.md): A8-2/A8-4 (EC:A61 one change at a time, against the stored
row), A8-3 (EC:A59 reset_anchor buys the whole new period), A8-5 (EC:A62 upgrade payment row), A8-8
(EC:A60 billing customer key), A8-6 (EC:A63 caller key from an earlier release). Mirrors
test/round8-upgrade.test.ts; A8-6 is Python-only."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import pytest
from boilpayment_core import (
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Operation,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    ProviderRef,
    SequentialIdGen,
    Subscription,
    hash_payload,
    resolve_policy,
)
from boilpayment_lifecycle import UpgradeInput, upgrade
from helpers import FakeSelfSchedulingProvider


def d(s: str) -> datetime:
    return datetime.fromisoformat(s)


def plan(pid: str, credits: int, price: int) -> Plan:
    return Plan(id=pid, name=pid, interval="month", credits_per_period=credits, usage_included=0, trial_days=0,
                prices=[PlanPrice(currency="KRW", amount_minor=price, provider_price_refs={})])


BASIC, PRO, MAX = plan("basic", 1000, 9900), plan("pro", 3000, 19900), plan("max", 8000, 29900)
KEEP = {"upgrade": {"mode": "immediate_prorate_keep_anchor"}}


class Gated(FakeSelfSchedulingProvider):
    def __init__(self) -> None:
        super().__init__()
        self.charges: list[dict[str, Any]] = []
        self.gate: asyncio.Event | None = None

    async def charge_billing_key(self, **kwargs: Any):  # type: ignore[no-untyped-def]
        self.charges.append({"amount": kwargs["amount"].amount_minor, "customer_ref": kwargs["customer_ref"]})
        if self.gate is not None:
            await self.gate.wait()
        return await super().charge_billing_key(**kwargs)


async def setup(status: str = "active", **extra: Any):  # type: ignore[no-untyped-def]
    repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_"))
    for p in (BASIC, PRO, MAX):
        await repo.plans.put(p)
    sub = Subscription(
        id="s1", customer_id="c1", plan_id="basic", provider="toss", provider_ref=None, status=status,  # type: ignore[arg-type]
        current_period=Period(start=d("2026-04-01T00:00:00Z"), end=d("2026-05-01T00:00:00Z")), anchor_day=1,
        cancel_at_period_end=False, grace_until=None, billing_key="bk1", scheduled_plan_id=None, version=0,
        created_at=d("2026-04-01T00:00:00Z"), currency="KRW", **extra,
    )
    await repo.subscriptions.put(sub)
    stored = await repo.subscriptions.get("s1")
    return repo, ledger, stored, Gated()


def up(repo, ledger, sub, provider, new_plan, policy=None, key=None):  # type: ignore[no-untyped-def]
    return upgrade(UpgradeInput(sub=sub, new_plan=new_plan, policy=policy or resolve_policy(KEEP), provider=provider, ledger=ledger,
                                repo=repo, clock=FixedClock(d("2026-04-11T00:00:00Z")), ids=SequentialIdGen("i_"), idempotency_key=key))


async def code(coro) -> str:  # type: ignore[no-untyped-def]
    try:
        await coro
        return "ok"
    except PaymentKitError as err:
        return err.code


def test_a61_pro_and_max_at_once_one_charges() -> None:
    async def scenario() -> None:
        repo, ledger, sub, provider = await setup()
        provider.gate = asyncio.Event()
        first = asyncio.create_task(up(repo, ledger, sub, provider, PRO))
        await asyncio.sleep(0.01)
        second = await code(up(repo, ledger, sub, provider, MAX))
        provider.gate.set()
        await first
        assert second == "subscription_change_in_flight"
        assert await code(up(repo, ledger, sub, provider, MAX)) == "subscription_changed"
        assert len(provider.charges) == 1
        fresh = await repo.subscriptions.get("s1")
        await up(repo, ledger, fresh, provider, MAX)
        assert [c["amount"] for c in provider.charges] == [6666, 6666]
        assert (await repo.subscriptions.get("s1")).plan_id == "max"

    asyncio.run(scenario())


@pytest.mark.parametrize("status", ["canceled", "expired", "past_due", "paused", "incomplete"])
def test_a61_inactive_subscription_is_refused(status: str) -> None:
    async def scenario() -> None:
        repo, ledger, sub, provider = await setup(status)
        assert await code(up(repo, ledger, sub, provider, PRO)) == "subscription_inactive"
        assert provider.charges == []

    asyncio.run(scenario())


def test_a59_reset_anchor_buys_the_whole_new_period() -> None:
    async def scenario() -> None:
        repo, ledger, sub, provider = await setup()
        res = await up(repo, ledger, sub, provider, PRO, policy=resolve_policy())
        assert [c["amount"] for c in provider.charges] == [13300]
        assert res.credit_delta == 2334
        assert res.sub.current_period == Period(start=d("2026-04-11T00:00:00Z"), end=d("2026-05-11T00:00:00Z"))

    asyncio.run(scenario())


def test_a60_customer_key_order() -> None:
    async def scenario() -> None:
        repo, ledger, sub, provider = await setup(billing_customer_ref="toss_cust_1")
        await up(repo, ledger, sub, provider, PRO)
        assert provider.charges[0]["customer_ref"] == "toss_cust_1"
        repo, ledger, sub, provider = await setup()
        await repo.customers.put(Customer(id="c1", email=None, provider_refs=[ProviderRef(provider="toss", ref="cus_abc")],
                                          status="active", created_at=d("2026-01-01T00:00:00Z")))
        await up(repo, ledger, sub, provider, PRO)
        assert provider.charges[0]["customer_ref"] == "cus_abc"
        repo, ledger, sub, provider = await setup()
        await up(repo, ledger, sub, provider, PRO)
        assert provider.charges[0]["customer_ref"] == "c1"

    asyncio.run(scenario())


def test_a62_upgrade_charge_has_a_payment_row() -> None:
    async def scenario() -> None:
        repo, ledger, sub, provider = await setup()
        res = await up(repo, ledger, sub, provider, PRO)
        rows = await repo.payments.list(subscription_id="s1")
        assert [(r.kind, r.status, r.amount.amount_minor, r.period) for r in rows] == [("subscription", "succeeded", 6666, None)]
        assert res.grant is not None and res.grant.reference.payment_id == rows[0].id

    asyncio.run(scenario())


def test_a63_caller_key_from_an_earlier_release_is_retried_not_refused() -> None:
    """An earlier release hashed period_start as isoformat() in the session's zone (+09:00). The retry with
    the same caller key replays that operation instead of raising idempotency_key_reused."""

    async def scenario() -> None:
        repo, ledger, sub, provider = await setup()
        seoul = sub.current_period.start.astimezone(__import__("zoneinfo").ZoneInfo("Asia/Seoul")).isoformat()
        payload = {"sub_id": "s1", "new_plan_id": "pro", "period_start": seoul}
        await repo.operations.put(Operation(id="req-1", key="req-1", kind="lifecycle.upgrade", payload_hash=hash_payload(payload),
                                            status="failed", result=None, error="ConnectionError", created_at=d("2026-04-11T00:00:00Z"),
                                            completed_at=d("2026-04-11T00:00:00Z"), attempts=1))
        res = await up(repo, ledger, sub, provider, PRO, key="req-1")
        assert res.sub.plan_id == "pro"
        assert len(provider.charges) == 1

    asyncio.run(scenario())


async def start_base():  # type: ignore[no-untyped-def]
    repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_"))
    await repo.plans.put(BASIC)
    return repo, ledger, Gated()


def start(repo, ledger, provider, request_id, **kw):  # type: ignore[no-untyped-def]
    from boilpayment_lifecycle import StartSubscriptionInput, start_subscription

    return start_subscription(StartSubscriptionInput(
        customer_id="u1", plan_id="basic", currency="KRW", billing_key="bk1", request_id=request_id, provider=provider,
        policy=resolve_policy(), ledger=ledger, repo=repo, clock=FixedClock(d("2026-04-11T03:00:00Z")), **kw,
    ))


def test_a65_start_charges_once_activates_and_grants() -> None:
    async def scenario() -> None:
        repo, ledger, provider = await start_base()
        first = await start(repo, ledger, provider, "signup-1", customer_ref="toss_cust_1")
        again = await start(repo, ledger, provider, "signup-1", customer_ref="toss_cust_1")
        assert first.sub.status == "active" and again.sub.id == first.sub.id
        assert [(c["amount"], c["customer_ref"]) for c in provider.charges] == [(9900, "toss_cust_1")]
        assert (await ledger.balance("u1", "paid", d("2026-04-11T03:00:00Z"))).available == 1000
        assert first.sub.current_period == Period(start=d("2026-04-11T03:00:00Z"), end=d("2026-05-11T03:00:00Z"))

    asyncio.run(scenario())


def test_a65_declined_start_stays_incomplete() -> None:
    async def scenario() -> None:
        repo, ledger, provider = await start_base()
        provider.next_charge_http_error = 402
        assert await code(start(repo, ledger, provider, "signup-2")) == "subscription_start_declined"
        (sub,) = await repo.subscriptions.list()
        assert sub.status == "incomplete"
        assert (await ledger.balance("u1", "paid", d("2026-04-11T03:00:00Z"))).available == 0

    asyncio.run(scenario())


def test_a65_frozen_customer_does_not_start() -> None:
    async def scenario() -> None:
        repo, ledger, provider = await start_base()
        await repo.customers.put(Customer(id="u1", email=None, provider_refs=[], status="frozen", created_at=d("2026-01-01T00:00:00Z")))
        assert await code(start(repo, ledger, provider, "r")) == "customer_frozen"
        assert provider.charges == []

    asyncio.run(scenario())


def test_a64_backfill_refuses_a_billing_key_of_another_customer_and_keeps_the_customer_key() -> None:
    from boilpayment_lifecycle import BackfillInput, BackfillRow, backfill

    async def scenario() -> None:
        repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_"))
        await repo.plans.put(BASIC)

        def mk(customer_id: str) -> BackfillRow:
            return BackfillRow(customer_id=customer_id, provider="toss", customer_ref="toss_cust_1", plan_id="basic", billing_key="bk1",
                               period_start=d("2026-03-05T00:00:00Z"), period_end=d("2026-04-05T00:00:00Z"), currency="KRW")

        report = await backfill(BackfillInput(rows=[mk("user_1"), mk("user_2")], repo=repo, ledger=ledger,
                                              providers={"toss": Gated()}, clock=FixedClock(d("2026-03-10T00:00:00Z")), ids=SequentialIdGen("s_")))
        assert [(r.status, r.reason) for r in report.results] == [("ok", None), ("error", "billing_key_owned_by_other_customer")]
        (sub,) = await repo.subscriptions.list(customer_id="user_1")
        assert sub.billing_customer_ref == "toss_cust_1"

    asyncio.run(scenario())


def test_a66_banned_customer_renewal_is_refused() -> None:
    from boilpayment_core import Money, Payment
    from boilpayment_lifecycle import OnRenewalPaidInput, on_renewal_paid

    async def scenario() -> None:
        repo, ledger, sub, _ = await setup("canceled")
        await repo.customers.put(Customer(id="c1", email=None, provider_refs=[], status="banned", created_at=d("2026-01-01T00:00:00Z")))
        payment = Payment(id="p1", customer_id="c1", provider="toss", provider_ref="pk", subscription_id="s1",
                          amount=Money(amount_minor=9900, currency="KRW"), status="succeeded", kind="subscription",
                          period=Period(start=d("2026-05-01T00:00:00Z"), end=d("2026-06-01T00:00:00Z")),
                          occurred_at=d("2026-05-01T00:00:00Z"), failure=None, cash_receipt=None)
        assert await code(on_renewal_paid(OnRenewalPaidInput(sub=sub, payment=payment, policy=resolve_policy(), ledger=ledger, repo=repo,
                                                             clock=FixedClock(d("2026-05-01T00:00:00Z"))))) == "customer_banned"
        assert (await ledger.balance("c1", "paid", d("2026-05-01T00:00:00Z"))).available == 0

    asyncio.run(scenario())
