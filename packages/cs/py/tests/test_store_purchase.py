"""EC:N1-N11 -- register_store_purchase policy rules (mirrors packages/cs/ts/test/storePurchase.test.ts)."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import anyio
import pytest
from boilpayment_core import (
    Customer,
    FixedClock,
    IapSettings,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    SequentialIdGen,
    StoreProof,
    Subscription,
    VerifiedStorePurchase,
    resolve_policy,
    store_account_token,
)
from boilpayment_credits import GrantForPeriodInput, TopupInput, grant_for_period, topup
from boilpayment_cs import (
    RegisterStorePurchaseInput,
    reack_store_purchases,
    register_store_purchase,
)

NOW = datetime(2026, 1, 10, tzinfo=UTC)
DAY = timedelta(days=1)


class Grants:
    async def topup(self, **kwargs):
        return await topup(TopupInput(**kwargs))

    async def grant_for_period(self, **kwargs):
        return await grant_for_period(GrantForPeriodInput(**kwargs))


def purchase(kind: str = "sub", **over) -> VerifiedStorePurchase:
    sub = kind == "sub"
    ref = "txn-1" if sub else "txn-c"
    period = Period(start=NOW - DAY, end=NOW + 29 * DAY) if sub else None
    payment = Payment(
        id=ref,
        customer_id="",
        provider="apple",
        provider_ref=ref,
        subscription_id="orig-1" if sub else None,
        amount=Money(amount_minor=999, currency="USD"),
        status=over.pop("status", "succeeded"),
        kind="subscription" if sub else "topup",
        period=period,
        occurred_at=NOW - DAY,
        failure=None,
        cash_receipt=None,
    )
    subscription = (
        Subscription(
            id="orig-1",
            customer_id="",
            plan_id="",
            provider="apple",
            provider_ref="orig-1",
            status="active",
            current_period=period,
            anchor_day=9,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            version=0,
            created_at=period.start,
        )
        if sub
        else None
    )
    base = {
        "payment": payment,
        "amount_from_store": True,
        "product_id": "pro.monthly" if sub else "coins.100",
        "subscription_ref": "orig-1" if sub else None,
        "subscription": subscription,
        "account_token": store_account_token("alice"),
        "environment": "production",
        "ownership": "purchased",
        "acknowledged": True,
    }
    base.update(over)
    return VerifiedStorePurchase(**base)


class Store:
    name = "apple"

    def __init__(self, verified, ack=None):
        self.verified, self._ack, self.acks = verified, ack, 0
        if ack is None:
            self.acknowledge = None  # type: ignore[assignment]

    def capabilities(self):
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=False,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
            checkout="on_device",
        )

    async def verify_purchase(self, proof):
        return self.verified()

    async def acknowledge(self, ref):
        self.acks += 1
        return await self._ack()


async def setup(verified, ack=None):
    clock, ids = FixedClock(NOW), SequentialIdGen("iap_")
    repo, ledger = InMemoryRepo(), InMemoryLedger(ids)
    for cid in ("alice", "bob"):
        await repo.customers.put(
            Customer(
                id=cid, email=None, provider_refs=[], status="active", created_at=NOW
            )
        )
    refs = {"apple": "pro.monthly", "google_play": "pro.monthly"}
    await repo.plans.put(
        Plan(
            id="pro",
            name="Pro",
            interval="month",
            credits_per_period=100,
            usage_included=0,
            trial_days=0,
            prices=[
                PlanPrice(currency="USD", amount_minor=999, provider_price_refs=refs)
            ],
        )
    )
    coin_refs = {"apple": "coins.100", "google_play": "coins.100"}
    await repo.plans.put(
        Plan(
            id="coins",
            name="Coins",
            interval=None,
            credits_per_period=50,
            usage_included=0,
            trial_days=0,
            prices=[
                PlanPrice(
                    currency="KRW", amount_minor=1100, provider_price_refs=coin_refs
                )
            ],
        )
    )
    store = Store(verified, ack)
    deps = {
        "clock": clock,
        "ids": ids,
        "repo": repo,
        "ledger": ledger,
        "policy": resolve_policy({}),
        "providers": {"apple": store},
    }

    async def run(customer_id="alice", iap=None):
        return await register_store_purchase(
            RegisterStorePurchaseInput(
                **deps,
                customer_id=customer_id,
                provider="apple",
                proof=StoreProof(signed_transaction="jws"),
                grants=Grants(),
                iap=iap,
            )
        )

    return deps, run, store


def code_of(fn) -> str:
    try:
        anyio.run(fn)
    except PaymentKitError as err:
        return err.code
    return "ok"


def test_records_grants_once_and_replay_is_noop():
    async def go():
        deps, run, _ = await setup(lambda: purchase())
        first = await run()
        assert (first.replayed, first.acknowledged, first.payment.id) == (
            False,
            True,
            "payment:apple:txn-1",
        )
        assert first.payment.subscription_id == "subscription:apple:orig-1"
        again = await run()
        assert again.replayed is True
        grants = await deps["ledger"].entries("alice", kind="grant")
        assert [(g.amount, g.source) for g in grants] == [(100, "subscription")]
        assert (
            await deps["repo"].subscriptions.get("subscription:apple:orig-1")
        ).plan_id == "pro"

    anyio.run(go)


def test_account_mismatch_refused_and_nothing_written():
    async def go():
        deps, run, _ = await setup(lambda: purchase())
        with pytest.raises(PaymentKitError) as err:
            await run("bob")
        assert err.value.code == "iap_account_mismatch"
        assert await deps["repo"].payments.list() == []

    anyio.run(go)


def test_missing_token_needs_first_claim_then_belongs_to_claimer():
    async def go():
        _, run, _ = await setup(lambda: purchase(account_token=None))
        with pytest.raises(PaymentKitError) as err:
            await run("alice")
        assert err.value.code == "iap_account_mismatch"
        claim = IapSettings(account_link="allow_first_claim")
        await run("alice", claim)
        with pytest.raises(PaymentKitError) as err:
            await run("bob", claim)
        assert err.value.code == "iap_already_claimed"

    anyio.run(go)


def test_environment_family_pending_expired_unknown_product():
    async def sandbox():
        _, run, _ = await setup(lambda: purchase(environment="sandbox"))
        await run("alice", IapSettings(environments="production_only"))

    async def family():
        _, run, _ = await setup(lambda: purchase(ownership="family_shared"))
        await run("alice", IapSettings(family_sharing="ignore"))

    async def pending():
        _, run, _ = await setup(lambda: purchase(status="pending"))
        await run()

    async def expired():
        p = purchase()
        p.payment = replace(
            p.payment, period=Period(start=NOW - 40 * DAY, end=NOW - 10 * DAY)
        )
        _, run, _ = await setup(lambda: p)
        await run()

    async def unknown():
        _, run, _ = await setup(lambda: purchase(product_id="nope"))
        await run()

    assert code_of(sandbox) == "iap_wrong_environment"
    assert code_of(family) == "iap_family_shared_refused"
    assert code_of(pending) == "iap_payment_not_succeeded"
    assert code_of(expired) == "iap_purchase_expired"
    assert code_of(unknown) == "iap_unknown_product"


def test_catalog_price_when_store_reports_none():
    async def go():
        deps, run, _ = await setup(
            lambda: replace(purchase("coins"), amount_from_store=False)
        )
        r = await run()
        assert (
            r.payment.kind,
            r.payment.amount.amount_minor,
            r.payment.amount.currency,
        ) == ("topup", 1100, "KRW")
        grants = await deps["ledger"].entries("alice", kind="grant")
        assert [(g.amount, g.source) for g in grants] == [(50, "topup")]

    anyio.run(go)


def test_failed_ack_is_retried_by_reack():
    async def go():
        state = {"fail": True}

        async def ack():
            if state["fail"]:
                raise RuntimeError("store down")
            return {"acknowledged": True}

        deps, run, store = await setup(lambda: purchase(acknowledged=False), ack)
        assert (await run()).acknowledged is False
        state["fail"] = False
        args = {"providers": deps["providers"], "repo": deps["repo"], "clock": deps["clock"]}
        assert await reack_store_purchases(**args) == {"acknowledged": 1, "failed": []}
        assert await reack_store_purchases(**args) == {"acknowledged": 0, "failed": []}
        assert store.acks == 2

    anyio.run(go)


def test_linked_purchase_ends_the_old_subscription():
    async def go():
        deps, run, store = await setup(lambda: purchase())
        await run()
        nxt = purchase(subscription_ref="orig-2", replaces_subscription_ref="orig-1")
        nxt.payment = replace(
            nxt.payment, id="txn-2", provider_ref="txn-2", subscription_id="orig-2"
        )
        nxt.subscription = replace(nxt.subscription, id="orig-2", provider_ref="orig-2")
        store.verified = lambda: nxt
        await run()
        repo = deps["repo"]
        assert (
            await repo.subscriptions.get("subscription:apple:orig-1")
        ).status == "canceled"
        assert (
            await repo.subscriptions.get("subscription:apple:orig-2")
        ).status == "active"

    anyio.run(go)
