# Fan-out to multiple notifiers. See spec/notify.pseudo.md.
from __future__ import annotations

import asyncio

from boilpayment_core import Notification, Notifier


class CompositeNotifier:
    def __init__(self, notifiers: list[Notifier]) -> None:
        self._notifiers = notifiers

    async def send(self, n: Notification) -> None:
        # Defer invocation so a synchronous throw cannot interrupt task creation.
        async def deliver(notifier: Notifier) -> None:
            await notifier.send(n)

        await asyncio.gather(
            *[deliver(nt) for nt in self._notifiers], return_exceptions=True
        )


def composite(notifiers: list[Notifier]) -> CompositeNotifier:
    return CompositeNotifier(notifiers)
