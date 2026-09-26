# Durable delivery via repo.outbox. See spec/notify.pseudo.md.
from __future__ import annotations

import datetime
import uuid
from dataclasses import dataclass
from datetime import timedelta

from schift_payment_kit_core import Clock, Notification, Notifier, OutboxItem, Repo


class OutboxNotifier:
    def __init__(self, notifier: Notifier, repo: Repo) -> None:
        self._notifier = notifier
        self._repo = repo

    async def send(self, n: Notification) -> None:
        now = datetime.datetime.now(datetime.UTC)
        item = OutboxItem(
            id=str(uuid.uuid4()),
            kind="notify",
            payload={"notification": n},
            status="pending",
            attempts=0,
            next_attempt_at=now,
            created_at=now,
        )
        await self._repo.outbox.put(
            item
        )  # never throws — enqueue only; actual send via flush_notify_outbox


def with_outbox(notifier: Notifier, repo: Repo) -> OutboxNotifier:
    return OutboxNotifier(notifier, repo)


def _backoff_seconds(attempts: int) -> float:
    return min(60, 2**attempts) * 60.0


@dataclass(kw_only=True, slots=True)
class FlushNotifyOutboxResult:
    sent: int
    failed: int
    retried: int


async def flush_notify_outbox(
    *,
    repo: Repo,
    notifier: Notifier,
    clock: Clock,
    max_attempts: int = 8,
) -> FlushNotifyOutboxResult:
    now = clock.now()
    pending = await repo.outbox.list(kind="notify", status="pending")

    sent = 0
    failed = 0
    retried = 0

    for item in pending:
        if item.next_attempt_at > now:
            continue
        notification = item.payload["notification"]
        try:
            # underlying notifier never throws per the cross-cutting rule; kept in
            # try/except for defense in depth against non-conforming notifiers.
            await notifier.send(notification)
            item.status = "sent"
            await repo.outbox.put(item)
            sent += 1
        except Exception:  # noqa: BLE001 -- notifier must never throw
            item.attempts += 1
            if item.attempts >= max_attempts:
                item.status = "failed"
                failed += 1
            else:
                item.status = "pending"
                item.next_attempt_at = now + timedelta(
                    seconds=_backoff_seconds(item.attempts)
                )
                retried += 1
            await repo.outbox.put(item)

    return FlushNotifyOutboxResult(sent=sent, failed=failed, retried=retried)
