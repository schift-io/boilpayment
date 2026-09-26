"""EC:K1 call-site helper. Not tied to one spec section -- used wherever a handler holds a
Subscription across an `await` that another writer (a webhook, a scheduler tick, a dunning sweep)
could touch before the final `repo.subscriptions.put`. Mirrors ts/src/retry.ts exactly.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TypeVar

from schift_payment_kit_core import PaymentKitError

T = TypeVar("T")


async def retry_on_version_conflict(
    fn: Callable[[], Awaitable[T]], attempts: int = 3
) -> T:
    """Retries `fn` when it raises `PaymentKitError('subscription_version_conflict')` (raised by
    `PostgresRepo.subscriptions.put` / `VersionedMemTable.put` -- see EC:K1), up to `attempts`
    times. Any other error, or a conflict still present on the last attempt, propagates.

    `fn` owns re-reading whatever it needs BEFORE writing on each attempt (typically
    `repo.subscriptions.get(id)`) -- retrying with the same stale object just fails again with the
    same conflict. See scheduler.py's `tick()` for the re-read-then-retry pattern in practice.
    """
    last_err: BaseException | None = None
    for _ in range(attempts):
        try:
            return await fn()
        except PaymentKitError as err:
            if err.code == "subscription_version_conflict":
                last_err = err
                continue
            raise
    assert last_err is not None
    raise last_err
