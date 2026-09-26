"""[EC:E19] A top-up is granted only when the re-fetched payment has succeeded (mirrors the TS test)."""
from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

import pytest
from _helpers import FakeProvider, json_verify
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    SequentialIdGen,
)
from boilpayment_webhook import default_handlers, process, receive


def _run(status: str):
    async def go():
        clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
        repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("led_"))
        local = Payment(id="pay_va", customer_id="cust_1", provider="stripe", provider_ref="pi_va", subscription_id=None,
                        amount=Money(amount_minor=5000, currency="KRW"), status="pending", kind="topup", period=None,
                        occurred_at=clock.now(), failure=None)
        await repo.payments.put(local)
        provider = FakeProvider(verify=json_verify(), get_payment_impl=lambda ref: dataclasses.replace(local, status=status))
        granted: list[int] = []

        class _Credits:
            async def topup(self, **kw):
                granted.append(kw["credits"])

        async def resolve(p):
            return 5000

        handlers = default_handlers(policy=DEFAULT_POLICY, ledger=ledger, repo=repo, notifier=CollectingNotifier(),
                                    clock=clock, ids=SequentialIdGen("id_"), credits=_Credits(), resolve_topup_credits=resolve)
        raw = json.dumps({"id": f"evt_{status}", "type": "payment.succeeded", "occurredAt": clock.now().isoformat(), "paymentRef": "pi_va"})
        r = await receive(provider=provider, headers={"x-sig": "ok"}, raw_body=raw, repo=repo, clock=clock)
        await process(event_id=r.event_id, providers={"stripe": provider}, handlers=handlers, repo=repo, clock=clock)
        rec = await repo.webhook_events.get(r.event_id)
        return rec.status, rec.error, granted

    return asyncio.run(go())


@pytest.mark.parametrize("status", ["pending", "refunded", "failed"])
def test_ec_e19_not_succeeded_topup_refused(status: str) -> None:
    rec_status, error, granted = _run(status)
    assert (rec_status, "not succeeded" in (error or ""), granted) == ("failed", True, [])


def test_ec_e19_succeeded_topup_granted() -> None:
    assert _run("succeeded")[2] == [5000]
