"""Round-7 audit regressions (bp-audit7.md): A7-2 (EC:A55 every legacy key), A7-3 (EC:J13 older key
forms in Python), A7-5 (EC:A56 past_due behind), A7-6 (EC:A57 upgrade orderId), A7-4/A7-7 (EC:A58
close, void re-query, lease). Mirrors test/round7-lifecycle.test.ts; A7-3 is Python-only."""

from __future__ import annotations

import dataclasses
import re

import pytest
from boilpayment_core import (
    LedgerReference,
    NewLedgerEntry,
    Operation,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    hash_payload,
    resolve_policy,
)
from boilpayment_lifecycle import (
    ReactivateInput,
    UpgradeInput,
    reactivate,
    resolve_held_attempt,
    upgrade,
)
from boilpayment_lifecycle.charge_attempt import (
    attempt_payment_id,
    renewal_attempt_key,
    with_attempt_lease,
)
from test_round5 import T, d, mk_sub, retry_item, run

PRO = Plan(id="pro", name="pro", interval="month", credits_per_period=300, usage_included=0, trial_days=0,
           prices=[PlanPrice(currency="KRW", amount_minor=10000, provider_price_refs={})])
FEB = Period(start=d("2024-02-01T00:00:00Z"), end=d("2024-03-01T00:00:00Z"))
TOSS_ORDER_ID = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


async def held_renewal(t: T, status: str):  # type: ignore[no-untyped-def]
    t.provider.lose_next_answer = True
    await t.tick("2024-02-01T01:00:00Z")
    amount = 6000 if status == "succeeded" else 5000
    t.provider.lookup_override = lambda _id, found: (
        dataclasses.replace(found, status=status, amount=dataclasses.replace(found.amount, amount_minor=amount)) if found is not None else None
    )
    await t.tick("2024-02-01T01:10:00Z")
    (held,) = await t.repo.payments.list()
    assert len(t.notices("attempt_lookup_mismatch")) == 1
    return held


def resolve(t: T, held, decision: str, at: str):  # type: ignore[no-untyped-def]
    return resolve_held_attempt(payment_id=held.id, decision=decision, actor="ops@x", provider=t.provider, policy=t.policy,
                                ledger=t.ledger, repo=t.repo, notifier=t.notifier, clock=t.clk(at))


def test_a55_two_legacy_charges_the_second_is_found_and_told_once() -> None:
    async def body() -> None:
        t = await T(mk_sub("2023-12-01T00:00:00Z", "2024-01-01T00:00:00Z", "expired")).init()
        for n in (1, 2):
            await t.repo.outbox.put(dataclasses.replace(retry_item(n, "sent", f"2024-01-0{n}T01:00:00Z", "2024-01-02T01:00:00Z")))
            t.provider.seed_order(f"dunning-retry:sub_1:{n}", "succeeded")
        for at in ("2024-02-06T01:00:00Z", "2024-02-06T01:10:00Z", "2024-02-06T01:20:00Z"):
            await t.tick(at)
        rows = sorted(f"{p.provider_ref}={p.status}" for p in await t.repo.payments.list())
        assert rows == ["dunning-retry:sub_1:1=succeeded", "dunning-retry:sub_1:2=succeeded"]
        assert len(t.notices("renewal_settled_after_end")) == 1
        assert len(t.notices("renewal_double_charge")) == 1
        assert await t.usable("2024-01-20T00:00:00Z") == 100
        before = len(t.provider.lookups)
        await t.tick("2024-02-07T01:00:00Z")
        assert len(t.provider.lookups) == before

    run(body())


def test_a56_past_due_behind_after_an_unsent_charge_charges_the_current_period_once() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")).init()
        t.policy = resolve_policy({"dunning": {"grace_days": 45}})
        t.provider.next_charge_throws = True
        await t.tick("2024-02-01T01:00:00Z")
        assert (await t.cur()).status == "past_due"
        t.provider.next_charge_throws = False
        for at in ("2024-03-05T09:00:00Z", "2024-03-10T09:00:00Z", "2024-03-20T09:00:00Z"):
            await t.tick(at)
        assert t.moved("2024-02-01") == 0
        assert t.moved("2024-03-01") == 1
        feb = await t.repo.payments.get(attempt_payment_id(renewal_attempt_key(await t.cur(), FEB)))
        assert feb is not None and feb.failure is not None and feb.failure.code == "order_not_found"
        s = await t.cur()
        assert (s.status, s.current_period.start) == ("active", d("2024-03-01T00:00:00Z"))
        assert len(t.notices("missed_periods_skipped")) == 1

    run(body())


def upgrade_input(t: T, sub):  # type: ignore[no-untyped-def]
    from boilpayment_core import SequentialIdGen
    return UpgradeInput(sub=sub, new_plan=PRO, policy=t.policy, provider=t.provider, ledger=t.ledger, repo=t.repo,
                        clock=t.clk("2024-02-15T00:00:00Z"), ids=SequentialIdGen("u_"))


def test_a57_upgrade_sends_a_valid_order_id_and_a_retry_asks_first() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z")).init()
        await t.repo.plans.put(PRO)
        t.provider.lose_next_answer = True
        with pytest.raises(RuntimeError, match="socket hang up"):
            await upgrade(upgrade_input(t, await t.cur()))
        r = await upgrade(upgrade_input(t, await t.cur()))
        assert r.sub.plan_id == "pro"
        assert len(t.provider.money_moved) == 1
        assert len(t.provider.order_ids) == 1 and all(TOSS_ORDER_ID.match(o) for o in t.provider.order_ids)

    run(body())


def test_j13_a57_upgrade_left_by_an_earlier_release_in_its_own_time_form_is_found_not_charged_again() -> None:
    """A7-3: the earlier Python release keyed the operation and the charge with isoformat() (+09:00)."""
    async def body() -> None:
        t = await T(mk_sub("2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z")).init()
        await t.repo.plans.put(PRO)
        old = "2024-02-01T09:00:00+09:00"
        op_key = f"upgrade:sub_1:pro:{old}"
        await t.repo.operations.put(Operation(
            id=op_key, key=op_key, kind="lifecycle.upgrade", status="failed", result=None, error="ConnectionError",
            payload_hash=hash_payload({"sub_id": "sub_1", "new_plan_id": "pro", "period_start": old}),
            created_at=d("2024-02-14T00:00:00Z"), completed_at=d("2024-02-14T00:00:00Z"), attempts=1))
        t.provider.seed_order(f"charge:upgrade:sub_1:pro:{old}", "succeeded", 2500)
        r = await upgrade(upgrade_input(t, await t.cur()))
        assert r.sub.plan_id == "pro"
        assert t.provider.order_ids == []
        assert (await t.repo.operations.get(op_key)).status == "done"

    run(body())


def test_j13_reactivate_restores_credits_revoked_by_an_earlier_release() -> None:
    """A7-3: the cancel (revoke_immediately) was written with isoformat(); the reactivation restores it."""
    async def body() -> None:
        sub = dataclasses.replace(mk_sub("2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z"), cancel_at_period_end=True)
        t = await T(sub).init()
        old = "2024-02-01T09:00:00+09:00"
        g = await t.ledger.append(NewLedgerEntry(
            customer_id="c1", pool="paid", kind="grant", amount=100, source="subscription",
            reference=LedgerReference(subscription_id="sub_1", period_start=FEB.start), idempotency_key=f"grant:sub_1:{old}",
            actor="system", reason=None, unit_price_minor=None, currency=None, expires_at=FEB.end))
        await t.ledger.append(NewLedgerEntry(
            customer_id="c1", pool="paid", kind="revoke", amount=-100, source="subscription",
            reference=LedgerReference(subscription_id="sub_1", period_start=FEB.start, grant_id=g.entry.id),
            idempotency_key=f"revoke:cancel:sub_1:{old}", actor="system", reason="cancel",
            unit_price_minor=None, currency=None, expires_at=None))
        pol = resolve_policy({"cancel": {"credits": "revoke_immediately"}})
        r = await reactivate(ReactivateInput(sub=await t.cur(), policy=pol, provider=t.provider, ledger=t.ledger, repo=t.repo,
                                             clock=t.clk("2024-02-10T00:00:00Z")))
        assert r.restored.restored == 100
        assert await t.usable("2024-02-10T01:00:00Z") == 100

    run(body())


def test_a58_partly_refunded_held_order_void_refused_close_ends_the_period() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")).init()
        held = await held_renewal(t, "partially_refunded")
        with pytest.raises(PaymentKitError) as err:
            await resolve(t, held, "void", "2024-02-02T00:00:00Z")
        assert err.value.code == "held_order_moved_money"
        with pytest.raises(PaymentKitError) as err:
            await resolve(t, held, "settle", "2024-02-02T00:00:00Z")
        assert err.value.code == "held_order_not_paid"
        r = await resolve(t, held, "close", "2024-02-02T00:00:00Z")
        assert (r.payment.status, r.payment.failure.code) == ("failed", "review_closed")
        assert r.sub is not None and (r.sub.status, r.sub.current_period.start) == ("active", FEB.start)
        for at in ("2024-02-02T02:00:00Z", "2024-02-03T02:00:00Z"):
            await t.tick(at)
        assert t.moved("2024-02-01") == 1
        assert await t.usable("2024-02-05T00:00:00Z") == 0
        await t.tick("2024-03-01T01:00:00Z")
        assert t.moved("2024-03-01") == 1

    run(body())


def test_a58_void_refused_when_the_provider_shows_it_paid() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")).init()
        held = await held_renewal(t, "succeeded")
        with pytest.raises(PaymentKitError) as err:
            await resolve(t, held, "void", "2024-02-02T00:00:00Z")
        assert err.value.code == "held_order_moved_money"
        assert (await t.repo.payments.get(held.id)).status == "pending"

    run(body())


def test_a58_a_decision_while_another_worker_holds_the_attempt_is_refused() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")).init()
        held = await held_renewal(t, "succeeded")
        key = held.raw["boilpaymentAttemptKey"]
        codes: list[str] = []

        async def inner() -> None:
            try:
                await resolve(t, held, "settle", "2024-02-02T00:00:00Z")
            except PaymentKitError as e:
                codes.append(e.code)

        await with_attempt_lease(t.repo, t.clk("2024-02-02T00:00:00Z"), key, inner)
        assert codes == ["attempt_in_flight"]
        assert (await t.repo.payments.get(held.id)).status == "pending"
        r = await resolve(t, held, "settle", "2024-02-02T00:01:00Z")
        assert r.payment.status == "succeeded"

    run(body())
