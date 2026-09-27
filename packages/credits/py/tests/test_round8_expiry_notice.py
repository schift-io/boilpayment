"""Round-8 A8-12 (EC:A70): a credits-expiry notice an earlier release recorded with isoformat() in the
database session's zone still counts as sent today; the upgrade day sends no second notice."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta, timezone

from boilpayment_core import (
    CollectingNotifier,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    OutboxItem,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_credits.notify_expiring import NotifyExpiringInput, notify_expiring

NOW = datetime(2026, 4, 10, 3, 0, tzinfo=UTC)
EXPIRES = datetime(2026, 4, 12, 0, 0, tzinfo=UTC)


def test_a70_older_marker_forms_count_as_sent() -> None:
    async def scenario() -> list[int]:
        sent: list[int] = []
        seoul = EXPIRES.astimezone(timezone(timedelta(hours=9)))  # a session in Asia/Seoul reads instants in +09:00
        for expires_at, old_id in (
            (seoul, f"credits-expiry-notice:c1:{seoul.isoformat()}:2026-04-10"),
            (EXPIRES, f"credits-expiry-notice:c1:{EXPIRES.isoformat()}:2026-04-10"),
        ):
            repo, ledger, notifier = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_")), CollectingNotifier()
            await repo.customers.put(Customer(id="c1", email=None, provider_refs=[], status="active", created_at=NOW))
            await ledger.append(NewLedgerEntry(customer_id="c1", pool="paid", kind="grant", amount=100, unit_price_minor=None, currency=None,
                                               expires_at=expires_at, source="manual", reference=LedgerReference(), idempotency_key="g1",
                                               actor="system", reason="t"))
            await repo.outbox.put(OutboxItem(id=old_id, kind="credits.expiry_notice", payload={}, status="sent", attempts=1,
                                             next_attempt_at=NOW, created_at=NOW))
            await notify_expiring(NotifyExpiringInput(customer_id="c1", ledger=ledger, repo=repo, notifier=notifier,
                                                      policy=resolve_policy({"credits": {"expiry_notice_days": 7}}), clock=FixedClock(NOW)))
            sent.append(len(notifier.sent))
        return sent

    assert asyncio.run(scenario()) == [0, 0]
