"""DC-03/DC-04 paid-base refunds and AF-03 append-only reversals."""

from __future__ import annotations

from datetime import UTC, datetime

import anyio
import anyio.lowlevel
import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    AffiliateCommission,
    AffiliateCommissionKind,
    ConsumeInput,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    Payment,
    Refund,
    RefundDecision,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_refund import (
    EvaluateInput,
    ExecuteInput,
    OnExternalRefundInput,
    evaluate,
    execute,
    on_external_refund,
)
from boilpayment_refund.affiliate_reversal import (
    AppendAffiliateReversalsInput,
    append_affiliate_reversals,
)

CUSTOMER_ID = "customer_discount"


class RefundProvider:
    name = "stripe"

    def __init__(self) -> None:
        self.calls = 0

    async def refund(
        self,
        *,
        payment_ref: str,
        amount: Money,
        reason: str,
        idempotency_key: str,
        extra: dict[str, str | int | bool] | None = None,
    ) -> Refund:
        self.calls += 1
        return Refund(
            id=f"refund_{payment_ref}_{amount.amount_minor}",
            payment_id="",
            customer_id="",
            amount=amount,
            status="succeeded",
            provider_ref=f"provider_{payment_ref}_{amount.amount_minor}",
            credits_revoked=0,
            rule_id="",
            reason=None,
            failure=None,
            created_at=datetime.now(UTC),
        )


class Cs:
    async def open_reconcile_mismatch_case(
        self, *, customer_id: str | None, reference_id: str, reason: str
    ) -> None:
        return None


class FailOnceReversalTable:
    def __init__(self, delegate) -> None:
        self._delegate = delegate
        self._failed = False

    async def append(self, row: AffiliateCommission) -> AffiliateCommission:
        if row.kind == "reversal" and not self._failed:
            self._failed = True
            raise RuntimeError("reversal append interrupted")
        return await self._delegate.append(row)

    async def list(
        self,
        *,
        affiliate_id: str | None = None,
        payment_id: str | None = None,
        kind: AffiliateCommissionKind | None = None,
    ) -> list[AffiliateCommission]:
        return await self._delegate.list(
            affiliate_id=affiliate_id,
            payment_id=payment_id,
            kind=kind,
        )


class YieldingListCommissionTable:
    """Force simultaneous helpers to observe the same pre-append snapshot without locking."""

    def __init__(self, delegate) -> None:
        self._delegate = delegate

    async def append(self, row: AffiliateCommission) -> AffiliateCommission:
        return await self._delegate.append(row)

    async def list(
        self,
        *,
        affiliate_id: str | None = None,
        payment_id: str | None = None,
        kind: AffiliateCommissionKind | None = None,
    ) -> list[AffiliateCommission]:
        rows = await self._delegate.list(
            affiliate_id=affiliate_id, payment_id=payment_id, kind=kind
        )
        await anyio.lowlevel.checkpoint()
        return rows


def setup() -> tuple[FixedClock, SequentialIdGen, InMemoryLedger, InMemoryRepo]:
    clock = FixedClock(datetime(2026, 9, 28, tzinfo=UTC))
    ids = SequentialIdGen("refund_test_")
    return clock, ids, InMemoryLedger(ids, clock), InMemoryRepo()


async def payment(
    repo: InMemoryRepo,
    clock: FixedClock,
    id: str,
    paid_minor: int,
    affiliate_id: str | None = None,
) -> Payment:
    row = Payment(
        id=id,
        customer_id=CUSTOMER_ID,
        provider="stripe",
        provider_ref=f"pi_{id}",
        subscription_id=None,
        amount=Money(amount_minor=paid_minor, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        affiliate_id=affiliate_id,
    )
    await repo.payments.put(row)
    return row


async def grant(
    ledger: InMemoryLedger, row: Payment, credits: int = 100
) -> None:
    await ledger.append(
        NewLedgerEntry(
            customer_id=CUSTOMER_ID,
            pool="paid",
            kind="grant",
            amount=credits,
            source="topup",
            reference=LedgerReference(payment_id=row.id),
            idempotency_key=f"grant:{row.id}",
            actor="system",
            unit_price_minor=10,
            currency="USD",
        )
    )


async def add_accrual(
    repo: InMemoryRepo, clock: FixedClock, row: Payment, amount_minor: int = 100
) -> None:
    await repo.affiliate_commissions.append(
        AffiliateCommission(
            id=f"accrual_{row.id}",
            kind="accrual",
            affiliate_id=row.affiliate_id or "affiliate_1",
            payment_id=row.id,
            refund_id=None,
            related_accrual_id=None,
            amount=Money(amount_minor=amount_minor, currency=row.amount.currency),
            idempotency_key=f"affiliate-accrual:{row.id}",
            created_at=clock.now(),
        )
    )


def refund_decision(row: Payment, amount_minor: int) -> RefundDecision:
    return RefundDecision(
        eligible=True,
        amount=Money(amount_minor=amount_minor, currency=row.amount.currency),
        credits_to_revoke=0,
        rule_id="D2",
        reason="test refund",
        needs_human=False,
        payment_id=row.id,
        customer_id=row.customer_id,
        subscription_id=None,
    )


def test_dc03_values_used_credits_from_discounted_paid_amount() -> None:
    async def run() -> None:
        # Given
        clock, _, ledger, repo = setup()
        row = await payment(repo, clock, "pay_rate_discount", 800)
        await grant(ledger, row)
        await ledger.consume(
            ConsumeInput(
                customer_id=CUSTOMER_ID,
                pool_order=["paid"],
                amount=25,
                idempotency_key="consume:discounted",
                meta=LedgerReference(),
                now=clock.now(),
                negative_balance="block",
                negative_floor=0,
                reason="usage",
            )
        )
        clock.advance(8 * 86_400_000)

        # When
        result = await evaluate(
            EvaluateInput(
                payment=row, policy=DEFAULT_POLICY, ledger=ledger, repo=repo, clock=clock
            )
        )

        # Then
        assert result.amount.amount_minor == 600
        assert result.credits_to_revoke == 75

    anyio.run(run)


def test_dc04_caps_fixed_discount_at_paid_without_reducing_unused_credits() -> None:
    async def run() -> None:
        # Given
        clock, _, ledger, repo = setup()
        row = await payment(repo, clock, "pay_fixed_discount", 500)
        await grant(ledger, row)
        clock.advance(8 * 86_400_000)

        # When
        result = await evaluate(
            EvaluateInput(
                payment=row,
                policy=resolve_policy({"refund": {"method": "unused_credits"}}),
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )

        # Then
        assert result.amount.amount_minor == 500
        assert result.credits_to_revoke == 100

    anyio.run(run)


@pytest.mark.parametrize(
    ("label", "paid_minor", "refund_minor", "expected"),
    [
        ("partial", 1000, 250, 25),
        ("full", 1000, 1000, 100),
    ],
)
def test_af03_support_reversal_is_exact_and_replay_safe(
    label: str, paid_minor: int, refund_minor: int, expected: int
) -> None:
    async def run() -> None:
        # Given
        clock, ids, ledger, repo = setup()
        row = await payment(repo, clock, f"pay_{label}", paid_minor, "affiliate_1")
        await add_accrual(repo, clock, row)
        provider = RefundProvider()
        input = ExecuteInput(
            decision=refund_decision(row, refund_minor),
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
            idempotency_key=f"support-refund:{row.id}",
        )

        # When
        await execute(input)
        await execute(input)

        # Then
        reversals = await repo.affiliate_commissions.list(
            payment_id=row.id, kind="reversal"
        )
        assert len(reversals) == 1
        assert reversals[0].amount == Money(amount_minor=expected, currency="USD")
        assert provider.calls == 1

    anyio.run(run)


@pytest.mark.parametrize(
    ("label", "paid_minor", "refund_minor", "accrual_minor", "expected"),
    [("partial", 1000, 333, 101, 34), ("zero_paid", 0, 0, 100, 0)],
)
def test_af03_external_reversal_is_exact_and_replay_safe(
    label: str,
    paid_minor: int,
    refund_minor: int,
    accrual_minor: int,
    expected: int,
) -> None:
    async def run() -> None:
        # Given
        clock, ids, ledger, repo = setup()
        row = await payment(repo, clock, f"pay_external_{label}", paid_minor, "affiliate_1")
        await add_accrual(repo, clock, row, accrual_minor)
        event = NormalizedEvent(
            id=f"evt_external_{label}",
            provider="stripe",
            type="refund.created",
            occurred_at=clock.now(),
            customer_ref=None,
            subscription_ref=None,
            payment_ref=row.provider_ref,
            amount=Money(amount_minor=refund_minor, currency="USD"),
            raw={},
            refund_ref=f"re_external_{label}",
        )
        input = OnExternalRefundInput(
            event=event, ledger=ledger, repo=repo, cs=Cs(), clock=clock, ids=ids
        )

        # When
        await on_external_refund(input)
        await on_external_refund(input)

        # Then
        reversals = await repo.affiliate_commissions.list(
            payment_id=row.id, kind="reversal"
        )
        assert len(reversals) == 1
        assert reversals[0].amount == Money(amount_minor=expected, currency="USD")

    anyio.run(run)


def test_af03_support_reversal_repairs_after_interrupted_append() -> None:
    async def run() -> None:
        clock, ids, ledger, repo = setup()
        row = await payment(repo, clock, "pay_support_repair", 1_000, "affiliate_1")
        await add_accrual(repo, clock, row, 101)
        repo.affiliate_commissions = FailOnceReversalTable(repo.affiliate_commissions)
        provider = RefundProvider()
        input = ExecuteInput(
            decision=refund_decision(row, 333), provider=provider, ledger=ledger,
            repo=repo, clock=clock, ids=ids,
            idempotency_key=f"support-refund:{row.id}",
        )

        with pytest.raises(RuntimeError, match="reversal append interrupted"):
            await execute(input)
        assert (await execute(input)).status == "succeeded"

        reversals = await repo.affiliate_commissions.list(
            payment_id=row.id, kind="reversal"
        )
        assert len(reversals) == 1
        assert provider.calls == 1

    anyio.run(run)


def test_af03_external_reversal_repairs_settled_refund_replay() -> None:
    async def run() -> None:
        clock, ids, ledger, repo = setup()
        row = await payment(repo, clock, "pay_external_repair", 1_000, "affiliate_1")
        await add_accrual(repo, clock, row, 101)
        repo.affiliate_commissions = FailOnceReversalTable(repo.affiliate_commissions)
        event = NormalizedEvent(
            id="evt_external_repair", provider="stripe", type="refund.created",
            occurred_at=clock.now(), customer_ref=None, subscription_ref=None,
            payment_ref=row.provider_ref, amount=Money(amount_minor=333, currency="USD"),
            raw={}, refund_ref="re_external_repair",
        )
        input = OnExternalRefundInput(
            event=event, ledger=ledger, repo=repo, cs=Cs(), clock=clock, ids=ids
        )

        with pytest.raises(RuntimeError, match="reversal append interrupted"):
            await on_external_refund(input)
        assert (await on_external_refund(input)).status == "succeeded"

        reversals = await repo.affiliate_commissions.list(
            payment_id=row.id, kind="reversal"
        )
        assert len(reversals) == 1

    anyio.run(run)


def test_af03_cumulative_reversals_never_exceed_accrual() -> None:
    async def run() -> None:
        clock, ids, ledger, repo = setup()
        row = await payment(
            repo, clock, "pay_external_cumulative", 100, "affiliate_1"
        )
        await add_accrual(repo, clock, row, 1)

        def event(suffix: str) -> NormalizedEvent:
            return NormalizedEvent(
                id=f"evt_{suffix}", provider="stripe", type="refund.created",
                occurred_at=clock.now(), customer_ref=None, subscription_ref=None,
                payment_ref=row.provider_ref, amount=Money(amount_minor=1, currency="USD"),
                raw={}, refund_ref=f"re_{suffix}",
            )

        await on_external_refund(OnExternalRefundInput(
            event=event("one"), ledger=ledger, repo=repo, cs=Cs(), clock=clock, ids=ids
        ))
        await on_external_refund(OnExternalRefundInput(
            event=event("two"), ledger=ledger, repo=repo, cs=Cs(), clock=clock, ids=ids
        ))

        reversals = await repo.affiliate_commissions.list(
            payment_id=row.id, kind="reversal"
        )
        assert [item.amount.amount_minor for item in reversals] == [1, 0]

    anyio.run(run)


def test_af03_concurrent_distinct_refunds_never_exceed_one_accrual() -> None:
    async def run() -> None:
        clock, _, ledger, repo = setup()
        row = await payment(repo, clock, "pay_concurrent_affiliate", 1000, "affiliate_1")
        await add_accrual(repo, clock, row, 100)
        repo.affiliate_commissions = YieldingListCommissionTable(
            repo.affiliate_commissions
        )

        def refund(id: str) -> Refund:
            return Refund(
                id=id, payment_id=row.id, customer_id=CUSTOMER_ID,
                amount=Money(amount_minor=750, currency="USD"), status="succeeded",
                provider_ref=id, credits_revoked=0, rule_id="D8", reason=None,
                failure=None, created_at=clock.now(),
            )

        async with anyio.create_task_group() as tasks:
            for id in ("refund_concurrent_1", "refund_concurrent_2"):
                tasks.start_soon(
                    append_affiliate_reversals,
                    AppendAffiliateReversalsInput(
                        repo=repo, ledger=ledger, clock=clock, payment=row, refund=refund(id)
                    ),
                )

        reversals = await repo.affiliate_commissions.list(
            payment_id=row.id, kind="reversal"
        )
        assert sum(item.amount.amount_minor for item in reversals) == 100

    anyio.run(run)
