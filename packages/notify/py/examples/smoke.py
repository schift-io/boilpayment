"""Smoke test -- real code path (no mocks of our own modules), real network attempts against
unreachable/fake endpoints to prove send() never throws. Run:
.venv/bin/python packages/notify/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from schift_payment_kit_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryRepo,
    Notification,
)
from schift_payment_kit_notify import (
    composite,
    flush_notify_outbox,
    render,
    resend,
    slack,
    smtp,
    with_outbox,
)

# with_outbox() stamps next_attempt_at with the real wall clock (it takes no `clock` param per
# ARCHITECTURE.md §3.5's `withOutbox(notifier, repo)` signature) — set this comfortably in the
# future so flush_notify_outbox's `clock.now()` reliably clears the item regardless of wall-clock drift.
clock = FixedClock(datetime(2027, 1, 1, tzinfo=UTC))


class BrokenResendClient:
    """Deterministic offline stand-in for httpx.AsyncClient -- injected via resend(client=...) so
    the composite scenario below doesn't depend on real network access."""

    async def post(self, *args, **kwargs):
        raise RuntimeError("network down")


async def main() -> None:
    # -- Templates: EN + KO render for one NotifyType --
    en = render(
        "usage.soft_cap", "en", {"meter": "api_call", "overage": 2, "included": 5}
    )
    ko = render(
        "usage.soft_cap", "ko", {"meter": "api_call", "overage": 2, "included": 5}
    )
    print(
        "[template en]",
        json.dumps({"subject": en.subject, "text": en.text}, ensure_ascii=False),
    )
    print(
        "[template ko]",
        json.dumps({"subject": ko.subject, "text": ko.text}, ensure_ascii=False),
    )

    notification = Notification(
        type="usage.soft_cap",
        customer_id="cust_1",
        payload={"meter": "api_call", "overage": 2, "included": 5},
    )

    # -- composite([collecting, slack-to-unreachable, resend-to-unreachable]) -- must never throw --
    collecting = CollectingNotifier()
    slack_unreachable = slack(
        webhook_url="http://127.0.0.1:1/unreachable"
    )  # port 1: connection refused, fast
    resend_unreachable = resend(
        api_key="sk_fake",
        from_="a@example.com",
        to="b@example.com",
        client=BrokenResendClient(),
    )
    fan_out = composite([collecting, slack_unreachable, resend_unreachable])

    await fan_out.send(notification)  # must not throw
    print(
        "[composite.send] did not throw. collecting.sent:",
        json.dumps(
            [
                {"type": n.type, "customer_id": n.customer_id, "payload": n.payload}
                for n in collecting.sent
            ]
        ),
    )

    # -- smtp adapter against an unreachable host -- must never throw --
    smtp_unreachable = smtp(
        host="127.0.0.1", port=1, from_="a@example.com", to="b@example.com"
    )
    await smtp_unreachable.send(notification)  # must not throw
    print("[smtp.send to unreachable host] did not throw")

    # -- with_outbox + flush_notify_outbox: durable delivery via repo.outbox --
    repo = InMemoryRepo()
    durable = with_outbox(collecting, repo)
    await durable.send(notification)  # enqueues, does not call collecting directly
    pending_before = await repo.outbox.list(kind="notify", status="pending")
    print(
        "[with_outbox] enqueued:",
        len(pending_before),
        "collecting.sent still:",
        len(collecting.sent),
    )

    flushed = await flush_notify_outbox(repo=repo, notifier=collecting, clock=clock)
    print(
        "[flush_notify_outbox]",
        json.dumps(
            {"sent": flushed.sent, "failed": flushed.failed, "retried": flushed.retried}
        ),
    )
    pending_after = await repo.outbox.list(kind="notify", status="pending")
    print(
        "[with_outbox] pending after flush:",
        len(pending_after),
        "collecting.sent now:",
        len(collecting.sent),
    )

    print("\nsmoke: OK")


if __name__ == "__main__":
    asyncio.run(main())
