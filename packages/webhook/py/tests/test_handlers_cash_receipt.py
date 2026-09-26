"""EC:K2 K4 K6 K7 -- auto-issue of a KR 현금영수증 (cash receipt) from the payment.succeeded handler.
Mirrors packages/webhook/ts/test/handlers-cash-receipt.test.ts (same cases, same expectations)."""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime
from types import SimpleNamespace

from _helpers import FakeProvider, json_verify
from boilpayment_core import (
    DEFAULT_POLICY,
    CashReceiptRef,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    SequentialIdGen,
)
from boilpayment_webhook import default_handlers, process, receive

AUTO = dataclasses.replace(
    DEFAULT_POLICY,
    cash_receipt=dataclasses.replace(DEFAULT_POLICY.cash_receipt, mode="auto"),
)


class _Credits:
    async def topup(self, **_kwargs):
        return None


def _payment(clock, **overrides) -> Payment:
    base = {
        "id": "pay_cr",
        "customer_id": "cust_1",
        "provider": "toss",
        "provider_ref": "tviva_cr",
        "subscription_id": None,
        "amount": Money(amount_minor=9900, currency="KRW"),
        "status": "succeeded",
        "kind": "topup",
        "period": None,
        "occurred_at": clock.now(),
        "failure": None,
    }
    base.update(overrides)
    return Payment(**base)


async def _deliver(policy, issue, resolve_identity, payment_overrides=None, event_id="evt_cr"):
    clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
    repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("led_"))
    notifier = CollectingNotifier()
    payment = _payment(clock, **(payment_overrides or {}))
    await repo.payments.put(payment)

    provider = FakeProvider(verify=json_verify(), get_payment_impl=lambda _ref: payment)
    provider.name = "toss"
    if issue is not None:
        provider.issue_cash_receipt = issue

    handlers = default_handlers(
        policy=policy,
        ledger=ledger,
        repo=repo,
        notifier=notifier,
        clock=clock,
        ids=SequentialIdGen("id_"),
        credits=_Credits(),
        resolve_topup_credits=lambda _p: _async(10),
        resolve_cash_receipt_identity=resolve_identity,
    )
    raw_body = json.dumps(
        {
            "id": event_id,
            "type": "payment.succeeded",
            "occurredAt": clock.now().isoformat(),
            "paymentRef": payment.provider_ref,
        }
    )
    r = await receive(
        provider=provider, headers={"x-sig": "ok"}, raw_body=raw_body, repo=repo, clock=clock
    )
    await process(
        event_id=r.event_id, providers={"toss": provider}, handlers=handlers, repo=repo, clock=clock
    )
    return (
        await repo.webhook_events.get(r.event_id),
        await repo.payments.get(payment.id),
        notifier,
        clock,
    )


async def _async(value):
    return value


def test_k2_issues_and_records_the_receipt():
    async def run():
        calls = []

        async def issue(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(receipt_key="rk_1", type="personal")

        record, stored, _n, clock = await _deliver(
            AUTO, issue, lambda _p: _async({"customer_identity_number": "01012345678"})
        )
        assert record.status == "processed"
        assert len(calls) == 1
        assert stored.cash_receipt == CashReceiptRef(
            receipt_key="rk_1", issued_at=clock.now(), type="personal"
        )

    asyncio.run(run())


def test_k7_does_not_issue_twice_on_redelivery():
    async def run():
        calls = []

        async def issue(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(receipt_key="rk_2", type="personal")

        existing = CashReceiptRef(
            receipt_key="rk_existing",
            issued_at=datetime(2026, 1, 1, tzinfo=UTC),
            type="personal",
        )
        _record, stored, _n, _c = await _deliver(
            AUTO,
            issue,
            lambda _p: _async({"customer_identity_number": "01012345678"}),
            payment_overrides={"cash_receipt": existing},
        )
        assert calls == []
        assert stored.cash_receipt.receipt_key == "rk_existing"

    asyncio.run(run())


def test_k6_issuance_failure_never_fails_the_payment():
    async def run():
        async def issue(**_kwargs):
            raise RuntimeError("NOT_FOUND_MERCHANT_BUSINESS_NUMBER")

        record, stored, notifier, _c = await _deliver(
            AUTO, issue, lambda _p: _async({"customer_identity_number": "01012345678"})
        )
        assert record.status == "processed"  # payment side succeeded
        assert stored.cash_receipt is None
        assert any(
            n.payload.get("kind") == "cash_receipt_issue_failed" for n in notifier.sent
        )

    asyncio.run(run())


def test_k2_off_mode_does_nothing():
    async def run():
        calls = []

        async def issue(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(receipt_key="rk_3", type="personal")

        _record, stored, _n, _c = await _deliver(
            DEFAULT_POLICY, issue, lambda _p: _async({"customer_identity_number": "01012345678"})
        )
        assert calls == []
        assert stored.cash_receipt is None

    asyncio.run(run())
