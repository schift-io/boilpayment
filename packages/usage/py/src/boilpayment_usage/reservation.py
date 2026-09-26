"""EC:C10 -- usage reservations for long-running work. See spec/usage.pseudo.md.

reserve() holds credits for a job before the work starts; commit() charges what the job actually
used (<= the reservation) when it succeeds; release() drops the hold when it fails or is cancelled.
A reservation is a pair of ledger rows keyed by the job: a `hold` (negative) written by reserve()
and a `release` (positive, same size) written by commit/release/sweep. Holds already count against
`balance().available` in every store, so two reserves racing for the last credits are serialized by
the per-customer ledger transaction and exactly one wins. Mirrors ts/src/reservation.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Final, Literal

from boilpayment_core import (
    Clock,
    ConsumeInput,
    ConsumeOrder,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    PaymentKitError,
    Policy,
    Pool,
    Repo,
    Subscription,
)

from .check import has_no_entitlement

_POOL_ORDER: Final[dict[ConsumeOrder, list[Pool]]] = {
    "expiring_first": ["paid", "promo", "trial"],
    "promo_first_then_expiring": ["promo", "trial", "paid"],
    "paid_first": ["paid", "trial", "promo"],
}
_REASON_PREFIX: Final = "reservation:"

ReservationStatus = Literal["held", "committed", "released", "expired"]


@dataclass(kw_only=True, slots=True)
class Reservation:
    customer_id: str
    job_id: str
    amount: int
    status: ReservationStatus
    expires_at: datetime
    # Credits charged by commit(); None unless status == "committed".
    committed_amount: int | None = None


@dataclass(kw_only=True, slots=True)
class ReserveResult:
    ok: bool
    reservation: Reservation | None = None
    duplicated: bool = False
    reason: Literal["insufficient", "subscription_inactive"] | None = None
    need: int | None = None
    available: int | None = None


@dataclass(kw_only=True, slots=True)
class SettleResult:
    reservation: Reservation
    duplicated: bool


def _hold_key(c: str, j: str) -> str:
    return f"usage:reserve:{c}:{j}"


def _release_key(c: str, j: str) -> str:
    return f"usage:reserve:release:{c}:{j}"


def _commit_key(c: str, j: str) -> str:
    return f"usage:reserve:commit:{c}:{j}"


def _status_from(
    release_entry: LedgerEntry | None,
) -> tuple[ReservationStatus, int | None]:
    if release_entry is None:
        return "held", None
    tail = (release_entry.reason or "")[len(_REASON_PREFIX) :]
    if tail.startswith("committed:"):
        return "committed", int(tail[len("committed:") :])
    return ("expired" if tail == "expired" else "released"), None


async def _read_all(ledger: LedgerStore, customer_id: str) -> list[Reservation]:
    holds = [
        e
        for e in await ledger.entries(customer_id, kind="hold", source="usage")
        if e.idempotency_key.startswith("usage:reserve:")
    ]
    if not holds:
        return []
    releases = {
        e.idempotency_key: e
        for e in await ledger.entries(customer_id, kind="release", source="usage")
    }
    out: list[Reservation] = []
    for h in holds:
        job_id = (h.reason or "")[len(_REASON_PREFIX) :]
        status, committed = _status_from(
            releases.get(_release_key(customer_id, job_id))
        )
        assert h.expires_at is not None
        out.append(
            Reservation(
                customer_id=customer_id,
                job_id=job_id,
                amount=-h.amount,
                status=status,
                expires_at=h.expires_at,
                committed_amount=committed,
            )
        )
    return out


async def _read_one(
    ledger: LedgerStore, customer_id: str, job_id: str
) -> Reservation | None:
    return next(
        (r for r in await _read_all(ledger, customer_id) if r.job_id == job_id), None
    )


async def _close(ledger: LedgerStore, r: Reservation, how: str) -> None:
    await ledger.append(
        NewLedgerEntry(
            customer_id=r.customer_id,
            pool="paid",
            kind="release",
            amount=r.amount,
            source="usage",
            idempotency_key=_release_key(r.customer_id, r.job_id),
            actor="usage",
            reason=f"{_REASON_PREFIX}{how}",
        )
    )


async def _expire_due(ledger: LedgerStore, customer_id: str, now: datetime) -> int:
    n = 0
    for r in await _read_all(ledger, customer_id):
        if r.status == "held" and r.expires_at <= now:
            await _close(ledger, r, "expired")
            n += 1
    return n


def _check_job(customer_id: str, job_id: str) -> None:
    if not customer_id or not job_id:
        raise PaymentKitError(
            "reservation needs customer_id and job_id", "reservation_invalid"
        )


def _is_int(v: object) -> bool:
    return type(v) is int and abs(v) <= 2**53 - 1


async def reserve(
    *,
    customer_id: str,
    job_id: str,
    amount: int,
    policy: Policy,
    ledger: LedgerStore,
    clock: Clock,
    sub: Subscription | None = None,
) -> ReserveResult:
    """EC:C10 -- hold `amount` credits for `job_id`. Same job_id again returns the existing reservation.
    EC:C11 -- when `sub` is given, a subscription without entitlement is refused."""
    _check_job(customer_id, job_id)
    if not _is_int(amount) or amount <= 0:
        raise PaymentKitError(
            "reservation amount must be a positive integer", "reservation_invalid"
        )
    if sub is not None and has_no_entitlement(sub.status):
        return ReserveResult(ok=False, reason="subscription_inactive")

    async def run() -> ReserveResult:
        now = clock.now()
        existing = await _read_one(ledger, customer_id, job_id)
        if existing is not None:
            return ReserveResult(ok=True, reservation=existing, duplicated=True)
        await _expire_due(
            ledger, customer_id, now
        )  # stale holds of this customer stop blocking new work
        available = (await ledger.balance(customer_id, None, now)).available
        if available < amount:
            return ReserveResult(
                ok=False,
                reason="insufficient",
                need=amount,
                available=max(0, available),
            )
        expires_at = now + timedelta(minutes=policy.usage.reservation_ttl_minutes)
        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="hold",
                amount=-amount,
                source="usage",
                idempotency_key=_hold_key(customer_id, job_id),
                actor="usage",
                expires_at=expires_at,
                reason=f"{_REASON_PREFIX}{job_id}",
            )
        )
        return ReserveResult(
            ok=True,
            reservation=Reservation(
                customer_id=customer_id,
                job_id=job_id,
                amount=amount,
                status="held",
                expires_at=expires_at,
            ),
        )

    return await ledger.transaction(customer_id, run)


async def commit(
    *,
    customer_id: str,
    job_id: str,
    amount: int,
    policy: Policy,
    ledger: LedgerStore,
    clock: Clock,
) -> SettleResult:
    """EC:C10 -- the job succeeded: charge `amount` (<= reserved) and release the hold."""
    _check_job(customer_id, job_id)
    if not _is_int(amount) or amount < 0:
        raise PaymentKitError(
            "commit amount must be a non-negative integer", "reservation_invalid"
        )

    async def run() -> SettleResult:
        now = clock.now()
        r = await _read_one(ledger, customer_id, job_id)
        if r is None:
            raise PaymentKitError(
                f"no reservation for job {job_id}", "reservation_not_found"
            )
        if r.status == "committed":
            return SettleResult(reservation=r, duplicated=True)
        if r.status != "held":
            raise PaymentKitError(
                f"reservation for job {job_id} is {r.status}", "reservation_closed"
            )
        if r.expires_at <= now:
            await _close(ledger, r, "expired")
            raise PaymentKitError(
                f"reservation for job {job_id} expired at {r.expires_at.isoformat()}",
                "reservation_expired",
            )
        if amount > r.amount:
            raise PaymentKitError(
                f"commit {amount} exceeds reservation {r.amount}",
                "reservation_exceeded",
            )
        if amount > 0:
            # Charge before releasing: if the charge fails the hold stays and the caller can release().
            charged = await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=_POOL_ORDER[policy.credits.consume_order],
                    amount=amount,
                    idempotency_key=_commit_key(customer_id, job_id),
                    meta=LedgerReference(),
                    now=now,
                    negative_balance=policy.credits.negative_balance,
                    negative_floor=policy.credits.negative_floor,
                    reason=f"usage:reservation:{job_id}",
                )
            )
            if not charged.ok:
                raise PaymentKitError(
                    f"commit for job {job_id} short by {charged.shortfall}",
                    "reservation_commit_short",
                    {"shortfall": charged.shortfall},
                )
        await _close(ledger, r, f"committed:{amount}")
        return SettleResult(
            reservation=replace(r, status="committed", committed_amount=amount),
            duplicated=False,
        )

    return await ledger.transaction(customer_id, run)


async def release(
    *, customer_id: str, job_id: str, ledger: LedgerStore, **_: object
) -> SettleResult:
    """EC:C10 -- the job failed or was cancelled: drop the hold, charge nothing."""
    _check_job(customer_id, job_id)

    async def run() -> SettleResult:
        r = await _read_one(ledger, customer_id, job_id)
        if r is None:
            raise PaymentKitError(
                f"no reservation for job {job_id}", "reservation_not_found"
            )
        if r.status != "held":
            return SettleResult(reservation=r, duplicated=True)
        await _close(ledger, r, "released")
        return SettleResult(reservation=replace(r, status="released"), duplicated=False)

    return await ledger.transaction(customer_id, run)


async def sweep_reservations(
    *, repo: Repo, ledger: LedgerStore, clock: Clock
) -> dict[str, int]:
    """EC:C10 -- cron: release every reservation past its TTL."""
    now = clock.now()
    expired = 0
    for c in await repo.customers.list():
        cid = c.id

        async def run(cid: str = cid) -> int:
            return await _expire_due(ledger, cid, now)

        expired += await ledger.transaction(cid, run)
    return {"expired": expired}


async def list_reservations(
    *, customer_id: str, ledger: LedgerStore
) -> list[Reservation]:
    """Current reservations of a customer (any status), for dashboards and support."""
    return await _read_all(ledger, customer_id)
