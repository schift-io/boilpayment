"""EC:I10 -- monthly settlement report. spec/cs.pseudo.md. Read-only: it never writes.

Mirrors ts/src/settlementReport.ts. Money is grouped by currency (never summed across currencies);
credits are grouped by ledger kind and source.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from boilpayment_core import LedgerStore, Repo


@dataclass(kw_only=True, slots=True)
class PaymentLine:
    currency: str
    kind: str
    status: str
    count: int
    amount_minor: int


@dataclass(kw_only=True, slots=True)
class RefundLine:
    currency: str
    count: int
    amount_minor: int


@dataclass(kw_only=True, slots=True)
class NetLine:
    currency: str
    amount_minor: int


@dataclass(kw_only=True, slots=True)
class CreditLine:
    kind: str
    source: str
    count: int
    amount: int


@dataclass(kw_only=True, slots=True)
class SettlementReport:
    start: datetime
    end: datetime
    payments: list[PaymentLine]
    refunds: list[RefundLine]
    net: list[NetLine]
    credits: list[CreditLine]


def _in_window(d: datetime, start: datetime, end: datetime) -> bool:
    return start <= d < end


async def settlement_report(*, repo: Repo, ledger: LedgerStore, start: datetime, end: datetime) -> SettlementReport:
    """EC:I10 -- aggregate payments, refunds and ledger movements in [start, end)."""
    if not start < end:
        raise ValueError("settlement_report: start must be before end")

    payments: dict[tuple[str, str, str], PaymentLine] = {}
    for p in await repo.payments.list():
        if not _in_window(p.occurred_at, start, end):
            continue
        key = (p.amount.currency, p.kind, p.status)
        line = payments.setdefault(
            key, PaymentLine(currency=key[0], kind=key[1], status=key[2], count=0, amount_minor=0)
        )
        line.count += 1
        line.amount_minor += p.amount.amount_minor

    refunds: dict[str, RefundLine] = {}
    for r in await repo.refunds.list():
        if r.status != "succeeded" or not _in_window(r.created_at, start, end):
            continue
        line = refunds.setdefault(r.amount.currency, RefundLine(currency=r.amount.currency, count=0, amount_minor=0))
        line.count += 1
        line.amount_minor += r.amount.amount_minor

    net: dict[str, int] = {}
    for pl in payments.values():
        if pl.status in ("succeeded", "partially_refunded"):
            net[pl.currency] = net.get(pl.currency, 0) + pl.amount_minor
    for rl in refunds.values():
        net[rl.currency] = net.get(rl.currency, 0) - rl.amount_minor

    credits: dict[tuple[str, str], CreditLine] = {}
    for c in await repo.customers.list():
        for e in await ledger.entries(c.id, since=start):
            if not _in_window(e.created_at, start, end):
                continue
            key = (e.kind, e.source)
            line = credits.setdefault(key, CreditLine(kind=key[0], source=key[1], count=0, amount=0))
            line.count += 1
            line.amount += e.amount

    return SettlementReport(
        start=start,
        end=end,
        payments=[payments[k] for k in sorted(payments)],
        refunds=[refunds[k] for k in sorted(refunds)],
        net=[NetLine(currency=k, amount_minor=net[k]) for k in sorted(net)],
        credits=[credits[k] for k in sorted(credits)],
    )
