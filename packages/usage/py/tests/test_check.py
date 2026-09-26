"""EC:C1 (overage modes) EC:C5 (included_quantity) EC:A14/EC:C6 (dunning grace gating)
EC:C8 (credit conversion). spec: packages/usage/spec/usage.pseudo.md
Mirrors packages/usage/ts/test/check.test.ts (same cases, same expected numbers).

pytest-asyncio is not installed -- every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

from fixtures import BASE_POLICY, mk_sub
from schift_payment_kit_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    SequentialIdGen,
)
from schift_payment_kit_usage import UsageEventInput, check, record
from schift_payment_kit_usage.record import (
    RecordResult,  # noqa: F401 (documents return type)
)


def harness():
    ids = SequentialIdGen("id_")
    clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
    ledger = InMemoryLedger(ids)
    repo = InMemoryRepo()
    return ids, clock, ledger, repo


def with_usage_policy(**usage_overrides):
    usage = dataclasses.replace(DEFAULT_POLICY.usage, **usage_overrides)
    return dataclasses.replace(DEFAULT_POLICY, usage=usage)


def with_usage_and_dunning(usage_overrides, dunning_overrides):
    usage = dataclasses.replace(DEFAULT_POLICY.usage, **usage_overrides)
    dunning = dataclasses.replace(DEFAULT_POLICY.dunning, **dunning_overrides)
    return dataclasses.replace(DEFAULT_POLICY, usage=usage, dunning=dunning)


# ── EC:C1 three overage modes ────────────────────────────────────────────────────────────────


def test_c1_hard_block_denies_once_projected_exceeds_included():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub()
        policy = with_usage_policy(included_quantity=5, overage="hard_block")
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=5,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e1",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=3,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is False
        assert result.overage == 3
        assert result.reason == "hard_block"
        assert result.remaining == 0

    asyncio.run(run())


def test_c1_soft_cap_notify_allows_with_notify_payload():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub()
        policy = with_usage_policy(included_quantity=5, overage="soft_cap_notify")
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=5,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e2",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=2,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is True
        assert result.overage == 2
        assert result.reason == "soft_cap_notify"
        assert result.remaining == 0
        assert result.notify == "usage.soft_cap"

    asyncio.run(run())


def test_c1_bill_overage_allows_no_notify():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub()
        policy = with_usage_policy(
            included_quantity=5, overage="bill_overage", overage_unit_price_minor=250
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=5,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e3",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=4,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is True
        assert result.overage == 4
        assert result.reason == "bill_overage"
        assert result.remaining == 0
        assert result.notify is None

    asyncio.run(run())


def test_c1_within_included_allows_zero_overage():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub()
        policy = with_usage_policy(included_quantity=5, overage="hard_block")
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=2,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e4",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=2,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is True
        assert result.overage == 0
        assert result.reason == "within_included"
        assert result.remaining == 1  # 5 - (2+2) = 1

    asyncio.run(run())


# ── EC:C5 included_quantity ──────────────────────────────────────────────────────────────────


def test_c5_included_quantity_defaults_to_zero():
    async def run():
        _ids, clock, ledger, repo = harness()
        sub = mk_sub()
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=1,
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is False
        assert result.overage == 1
        assert result.reason == "hard_block"
        assert result.remaining == 0

    asyncio.run(run())


def test_c5_per_call_included_quantity_overrides_policy():
    async def run():
        _ids, clock, ledger, repo = harness()
        sub = mk_sub()
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=3,
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            ledger=ledger,
            clock=clock,
            included_quantity=10,
        )
        assert result.allow is True
        assert result.overage == 0
        assert result.reason == "within_included"
        assert result.remaining == 7

    asyncio.run(run())


# ── EC:A14 dunning grace gating ──────────────────────────────────────────────────────────────


def test_a14_usage_during_grace_block_denies_all():
    async def run():
        _ids, clock, ledger, repo = harness()
        sub = mk_sub(status="past_due")
        policy = with_usage_and_dunning(
            {"included_quantity": 5, "overage": "hard_block"},
            {"usage_during_grace": "block"},
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=1,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is False
        assert result.overage == 0
        assert result.reason == "grace_block"
        assert result.remaining == 0

    asyncio.run(run())


def test_a14_usage_during_grace_allow_imposes_no_restriction():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub(status="past_due")
        policy = with_usage_and_dunning(
            {"included_quantity": 5, "overage": "soft_cap_notify"},
            {"usage_during_grace": "allow"},
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=5,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e_grace_allow",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=1,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is True
        assert result.overage == 1
        assert result.reason == "soft_cap_notify"
        assert result.remaining == 0
        assert result.notify == "usage.soft_cap"

    asyncio.run(run())


def test_a14_allow_existing_only_permits_usage_within_quota():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub(status="past_due")
        policy = with_usage_and_dunning(
            {"included_quantity": 5, "overage": "soft_cap_notify"},
            {"usage_during_grace": "allow_existing_only"},
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=2,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e_grace_existing",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=2,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is True
        assert result.overage == 0
        assert result.reason == "within_included"
        assert result.remaining == 1

    asyncio.run(run())


def test_a14_allow_existing_only_denies_new_overage_soft_cap():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub(status="past_due")
        policy = with_usage_and_dunning(
            {"included_quantity": 5, "overage": "soft_cap_notify"},
            {"usage_during_grace": "allow_existing_only"},
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=5,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e_grace_over",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=1,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is False
        assert result.overage == 1
        assert result.reason == "grace_block_overage"
        assert result.remaining == 0

    asyncio.run(run())


def test_a14_allow_existing_only_denies_new_overage_bill_overage():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub(status="past_due")
        policy = with_usage_and_dunning(
            {
                "included_quantity": 5,
                "overage": "bill_overage",
                "overage_unit_price_minor": 250,
            },
            {"usage_during_grace": "allow_existing_only"},
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=5,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e_grace_over_bill",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=1,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is False
        assert result.overage == 1
        assert result.reason == "grace_block_overage"
        assert result.remaining == 0

    asyncio.run(run())


def test_a14_allow_existing_only_hard_block_ignores_grace_switch():
    async def run():
        ids, clock, ledger, repo = harness()
        sub = mk_sub(status="past_due")
        policy = with_usage_and_dunning(
            {"included_quantity": 5, "overage": "hard_block"},
            {"usage_during_grace": "allow_existing_only"},
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=5,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e_grace_over_hard",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=1,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
        )
        assert result.allow is False
        assert result.overage == 1
        assert (
            result.reason == "hard_block"
        )  # stays hard_block, not grace_block_overage
        assert result.remaining == 0

    asyncio.run(run())


# ── EC:C8 credit-conversion hybrid ───────────────────────────────────────────────────────────


def test_c8_sufficient_balance_consumes_and_allows():
    async def run():
        _ids, clock, ledger, repo = harness()
        sub = mk_sub()
        from schift_payment_kit_core.types import CreditConversion

        policy = with_usage_policy(
            credit_conversion=CreditConversion(unit="call", credits_per_unit=10)
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=50,
                currency=None,
                source="promo",
                reference=LedgerReference(),
                idempotency_key="grant_1",
                actor="test",
            )
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=3,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
            idempotency_key="chk_1",
        )
        assert result.allow is True
        assert result.overage == 0
        assert result.reason == "credit_conversion"
        assert result.remaining == 0
        bal = await ledger.balance(sub.customer_id, None, clock.now())
        assert bal.available == 20  # 50 - (3*10)

    asyncio.run(run())


def test_c8_insufficient_balance_denies_and_leaves_balance_untouched():
    async def run():
        _ids, clock, ledger, repo = harness()
        sub = mk_sub()
        from schift_payment_kit_core.types import CreditConversion

        policy = with_usage_policy(
            credit_conversion=CreditConversion(unit="call", credits_per_unit=10)
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=10,
                currency=None,
                source="promo",
                reference=LedgerReference(),
                idempotency_key="grant_2",
                actor="test",
            )
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=3,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
            idempotency_key="chk_2",
        )
        assert result.allow is False
        assert result.overage == 0
        assert result.reason == "credit_conversion_insufficient"
        assert result.remaining == 0
        bal = await ledger.balance(sub.customer_id, None, clock.now())
        assert bal.available == 10

    asyncio.run(run())


def test_c8_bypasses_quota_policy_entirely():
    async def run():
        _ids, clock, ledger, repo = harness()
        sub = mk_sub()
        from schift_payment_kit_core.types import CreditConversion

        policy = with_usage_policy(
            included_quantity=0,
            overage="hard_block",
            credit_conversion=CreditConversion(unit="call", credits_per_unit=5),
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=100,
                currency=None,
                source="promo",
                reference=LedgerReference(),
                idempotency_key="grant_3",
                actor="test",
            )
        )
        result = await check(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=4,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
            idempotency_key="chk_3",
        )
        assert result.reason == "credit_conversion"
        assert result.allow is True
        bal = await ledger.balance(sub.customer_id, None, clock.now())
        assert bal.available == 80  # 100 - (4*5)

    asyncio.run(run())
