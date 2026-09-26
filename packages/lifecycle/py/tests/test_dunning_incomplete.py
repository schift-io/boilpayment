"""[EC:A27] A failed first payment of an incomplete subscription starts no grace and no dunning."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryRepo,
    resolve_policy,
)
from boilpayment_lifecycle.dunning import OnPaymentFailedInput, on_payment_failed
from test_dunning import mk_sub


def test_ec_a27_incomplete_no_dunning() -> None:
    async def run():
        repo, notifier = InMemoryRepo(), CollectingNotifier()
        sub = mk_sub(status="incomplete")
        await repo.subscriptions.put(sub)
        res = await on_payment_failed(OnPaymentFailedInput(sub=sub, policy=resolve_policy(), repo=repo, notifier=notifier,
                                                           clock=FixedClock(datetime(2024, 1, 1, 1, tzinfo=UTC))))
        stored = await repo.subscriptions.get(sub.id)
        return res.sub.status, stored.status, stored.grace_until, len(notifier.sent)

    assert asyncio.run(run()) == ("incomplete", "incomplete", None, 0)
