"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A47. Mirrors missed-periods.ts.

A self-scheduled subscription more than one period behind (a stopped cron, an upgrade from a release
that never renewed it) is never billed one missed period per tick. Policy
``subscription.missed_periods``: ``skip_and_notify`` charges only the period containing now and lists
the skipped periods in one case; ``needs_human_only`` charges nothing and parks the subscription
past_due (no grace clock) for a person.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from boilpayment_core import (
    Clock,
    Notification,
    Notifier,
    Payment,
    PaymentProvider,
    Period,
    Plan,
    Policy,
    Repo,
    Subscription,
)

from .charge_attempt import iso_z, settle_attempt_by_lookup
from .period import next_period


@dataclass(kw_only=True, slots=True)
class CatchUp:
    previous: Period
    target: Period
    skipped: list[Period] = field(default_factory=list)


def catch_up_periods(sub: Subscription, plan: Plan, policy: Policy, now: datetime) -> CatchUp | None:
    """None when the subscription is at most one period behind (the ordinary renewal)."""

    def step(p: Period) -> Period:
        return next_period(p, plan.interval or "month", sub.anchor_day, policy.period.timezone, policy.period.month_end_anchor)

    previous = sub.current_period
    target = step(previous)
    if target.end > now:
        return None
    skipped: list[Period] = []
    guard = 0
    while target.end <= now and guard < 100_000:
        skipped.append(target)
        previous = target
        target = step(target)
        guard += 1
    return CatchUp(previous=previous, target=target, skipped=skipped)


@dataclass(kw_only=True, slots=True)
class MissedPeriodsOutcome:
    kind: Literal["none", "parked", "skipped"]
    sub: Subscription | None = None
    target: Period | None = None


async def apply_missed_periods(*, sub: Subscription, plan: Plan, policy: Policy, repo: Repo, notifier: Notifier, clock: Clock) -> MissedPeriodsOutcome:
    cu = catch_up_periods(sub, plan, policy, clock.now())
    if cu is None:
        return MissedPeriodsOutcome(kind="none")
    if policy.subscription.missed_periods == "needs_human_only":
        parked = dataclasses.replace(sub, status="past_due", grace_until=None)
        saved = await repo.subscriptions.put(parked) or parked
        await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
            "kind": "missed_periods_parked", "subscription_id": sub.id,
            "missed": [iso_z(p.start) for p in [*cu.skipped, cu.target]]}))
        return MissedPeriodsOutcome(kind="parked", sub=saved)
    advanced = dataclasses.replace(sub, current_period=cu.previous)
    saved = await repo.subscriptions.put(advanced) or advanced
    await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
        "kind": "missed_periods_skipped", "subscription_id": sub.id,
        "skipped": [iso_z(p.start) for p in cu.skipped], "charging": iso_z(cu.target.start)}))
    return MissedPeriodsOutcome(kind="skipped", sub=saved, target=cu.target)


async def settle_open_attempt_if_behind(*, provider: PaymentProvider, repo: Repo, clock: Clock, notifier: Notifier,
                                        sub: Subscription, plan: Plan, policy: Policy, open_row: Payment) -> Payment:
    """EC:A47 (A6-4) -- an attempt left open (written, maybe never sent) for a period that has already
    ended, more than one period behind: ask the provider before anything is (re-)sent. No such order
    closes the row (failed, order_not_found) so the missed periods are skipped; a paid order settles it;
    no answer leaves it as it was. Mirrors settleOpenAttemptIfBehind in missed-periods.ts."""
    if catch_up_periods(sub, plan, policy, clock.now()) is None:
        return open_row
    done = await settle_attempt_by_lookup(provider=provider, repo=repo, clock=clock, row=open_row, notifier=notifier)
    return done or await repo.payments.get(open_row.id) or open_row
