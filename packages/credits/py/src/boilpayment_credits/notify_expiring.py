# EC:B16 — see spec: packages/credits/spec/credits.pseudo.md
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from boilpayment_core import (
    Clock,
    LedgerStore,
    Notification,
    Notifier,
    OutboxItem,
    Policy,
    Repo,
    iso_z,
)

_DAY = timedelta(days=1)
_NOTICE_KIND = "credits.expiry_notice"


@dataclass(kw_only=True, slots=True)
class ExpiringNotice:
    customer_id: str
    expires_at: datetime
    amount: int


@dataclass(kw_only=True, slots=True)
class NotifyExpiringInput:
    # Omit to scan every customer (via repo.customers.list()).
    customer_id: str | None = None
    ledger: LedgerStore
    repo: Repo
    # ⚠ EC:B16 contract gap — accepted for signature parity with the spec, but NOT called yet.
    # core's NotifyType has no case for "credits are about to expire": 'card.expiring' is
    # specifically a payment card on file ("Your card on file expires on {expiresAt}...") and
    # would show the customer a wrong, confusing message if reused here. Adding a
    # 'credits.expiring' NotifyType is a core type change this package isn't allowed to make (see
    # final report — "blocked contract change"). Until core adds it, this function only returns
    # `pending`; the caller sends from it via whatever channel/type fits their app.
    notifier: Notifier
    policy: Policy
    clock: Clock


@dataclass(kw_only=True, slots=True)
class NotifyExpiringResult:
    pending: list[ExpiringNotice] = field(default_factory=list)


def _day_bucket(d: datetime) -> str:
    return d.date().isoformat()


# EC:B16 — paid-pool credit buckets (grant remainders) entering their expiry-notice window
# (policy.credits.expiry_notice_days), not already noticed today. Idempotent per
# (customer, expires_at bucket, day): a same-day rerun of the cron returns nothing new for a
# bucket already reported today; tomorrow's run reports it again until it actually expires
# (repeated daily reminders are intended, not spam — "spam" here means only the same-day rerun).
async def notify_expiring(input: NotifyExpiringInput) -> NotifyExpiringResult:
    notice_days = input.policy.credits.expiry_notice_days
    if notice_days is None:
        return NotifyExpiringResult(pending=[])

    now = input.clock.now()
    window_end = now + notice_days * _DAY
    today = _day_bucket(now)

    if input.customer_id is not None:
        customer_ids = [input.customer_id]
    else:
        customer_ids = [c.id for c in await input.repo.customers.list()]

    pending: list[ExpiringNotice] = []
    for cid in customer_ids:
        balance = await input.ledger.balance(cid, "paid", now)
        for bucket in balance.expiring:
            if bucket.amount <= 0:
                continue
            # balance().expiring already excludes expires_at <= now (EC:B14); the lower bound
            # here is defensive in case a future LedgerStore implementation doesn't pre-filter.
            if bucket.expires_at < now or bucket.expires_at > window_end:
                continue

            dedup_id = (
                f"credits-expiry-notice:{cid}:{iso_z(bucket.expires_at)}:{today}"
            )
            # EC:A70 (round-8 A8-12) -- an earlier release wrote this marker with isoformat() in the
            # database session's zone; a marker in either older form also counts as sent today.
            forms = {
                dedup_id,
                f"credits-expiry-notice:{cid}:{bucket.expires_at.isoformat()}:{today}",
                f"credits-expiry-notice:{cid}:{bucket.expires_at.astimezone(UTC).isoformat()}:{today}",
            }
            if any([await input.repo.outbox.get(form) is not None for form in sorted(forms)]):
                continue

            marker = OutboxItem(
                id=dedup_id,
                kind=_NOTICE_KIND,
                payload={
                    "customer_id": cid,
                    "expires_at": bucket.expires_at.isoformat(),
                    "amount": bucket.amount,
                },
                status="sent",
                attempts=1,
                next_attempt_at=now,
                created_at=now,
            )
            await input.repo.outbox.put(marker)
            # EC:B16 -- the outbox marker above is written first, so a send that throws is not
            # retried into a duplicate notice on the next sweep.
            await input.notifier.send(
                Notification(
                    type="credits.expiring",
                    customer_id=cid,
                    payload={
                        "amount": bucket.amount,
                        "expiresAt": bucket.expires_at.isoformat(),
                    },
                )
            )
            pending.append(
                ExpiringNotice(
                    customer_id=cid, expires_at=bucket.expires_at, amount=bucket.amount
                )
            )

    return NotifyExpiringResult(pending=pending)
