"""Stored-sale support flow through real core/credit/refund implementations."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import anyio
import pytest
from boilpayment_core import (
    Checkout,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    PaymentKitError,
    Plan,
    PlanPrice,
    ProviderRef,
    Refund,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_credits import (
    GrantForPeriodInput,
    TopupInput,
    grant_for_period,
    topup,
)
from boilpayment_cs import (
    FinishRefundCasesInput,
    RecoverMissingGrantInput,
    RegisterCompletedCheckoutInput,
    RequestRefundInput,
    StartCheckoutInput,
    finish_refund_cases,
    recover_missing_grant,
    register_completed_checkout,
    request_refund,
    resolve_topup_credits,
    start_checkout,
)


class Grants:
    async def topup(self, **kwargs):
        return await topup(TopupInput(**kwargs))

    async def grant_for_period(self, **kwargs):
        return await grant_for_period(GrantForPeriodInput(**kwargs))


class Provider:
    name = "stripe"

    def __init__(self, payment):
        self.payment = payment
        self.checkout_key = ""
        self.refund_calls = 0
        self.checkout_calls = 0
        self.refund_status = "succeeded"

    async def create_checkout(self, input):
        self.checkout_calls += 1
        self.checkout_key = input.metadata["checkoutEntitlementKey"]
        return Checkout(
            id="cs_1", provider_ref="cs_1", url="https://example.test/checkout"
        )

    async def get_payment(self, ref):
        return replace(
            self.payment,
            customer_id="cus_1",
            raw={"metadata": {"checkoutEntitlementKey": self.checkout_key}},
        )

    async def list_payments(self, **kwargs):
        return [self.payment]

    async def refund(self, *, amount, **kwargs):
        self.refund_calls += 1
        return Refund(
            id="refund",
            payment_id=self.payment.id,
            customer_id=self.payment.customer_id,
            amount=amount,
            status=self.refund_status,
            provider_ref="re_1",
            credits_revoked=0,
            rule_id="",
            reason=None,
            failure=None,
            created_at=self.payment.occurred_at,
        )


async def setup(mode="auto", reasons=None):
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
    ids = SequentialIdGen("support_")
    repo, ledger = InMemoryRepo(), InMemoryLedger(ids)
    policy = resolve_policy({"cs": {"regrant": {"mode": mode}}, **({"refund": {"reasons": reasons}} if reasons else {})})
    payment = Payment(
        id="payment",
        customer_id="customer",
        provider="stripe",
        provider_ref="pi_1",
        subscription_id=None,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.customers.put(
        Customer(
            id="customer",
            email=None,
            provider_refs=[ProviderRef(provider="stripe", ref="cus_1")],
            status="active",
            created_at=clock.now(),
        )
    )
    await repo.plans.put(
        Plan(
            id="credits100",
            name="100 credits",
            interval=None,
            credits_per_period=100,
            usage_included=0,
            trial_days=0,
            prices=[PlanPrice(currency="USD", amount_minor=1000)],
        )
    )
    provider = Provider(payment)
    deps = {
        "clock": clock,
        "ids": ids,
        "repo": repo,
        "ledger": ledger,
        "policy": policy,
        "providers": {"stripe": provider},
    }
    await start_checkout(
        StartCheckoutInput(
            **deps,
            customer_id="customer",
            plan_id="credits100",
            provider="stripe",
            currency="USD",
            request_id="sale",
            success_url="https://example.test/ok",
            cancel_url="https://example.test/cancel",
        )
    )
    recorded = await register_completed_checkout(
        RegisterCompletedCheckoutInput(
            **deps, customer_id="customer", checkout_id="cs_1", payment_ref="pi_1"
        )
    )
    return deps, provider, recorded


def test_recovery_and_partial_refund_use_persisted_sale_and_replay_once():
    async def go():
        deps, provider, payment = await setup()
        input = RecoverMissingGrantInput(
            **deps, customer_id="customer", payment_id=payment.id, grants=Grants()
        )
        assert (await recover_missing_grant(input)).status == "resolved_auto"
        assert await resolve_topup_credits(payment=payment, repo=deps["repo"]) == 100
        await topup(
            TopupInput(
                customer_id="customer",
                payment=payment,
                credits=100,
                policy=deps["policy"],
                repo=deps["repo"],
                ledger=deps["ledger"],
                clock=deps["clock"],
            )
        )
        assert len(await deps["ledger"].entries("customer", kind="grant")) == 1
        request = RequestRefundInput(
            **deps,
            customer_id="customer",
            payment_id=payment.id,
            request_id="request1",
            requested_amount=Money(amount_minor=500, currency="USD"),
        )
        assert (await request_refund(request)).status == "resolved_auto"
        await request_refund(request)
        assert provider.refund_calls == 1
        assert (
            await deps["ledger"].balance("customer", "paid", deps["clock"].now())
        ).available == 50

    anyio.run(go)


@pytest.mark.parametrize("mode", ["manual_approve", "off"])
def test_recovery_obeys_rules_without_customer_approval(mode):
    async def go():
        deps, _, payment = await setup(mode)
        result = await recover_missing_grant(
            RecoverMissingGrantInput(
                **deps, customer_id="customer", payment_id=payment.id, grants=Grants()
            )
        )
        assert result.status == ("rejected" if mode == "off" else "needs_human")
        assert await deps["ledger"].entries("customer") == []

    anyio.run(go)


def test_captured_entitlement_survives_plan_edit():
    async def go():
        deps, _, payment = await setup()
        plan = await deps["repo"].plans.get("credits100")
        await deps["repo"].plans.put(replace(plan, credits_per_period=500))
        result = await recover_missing_grant(
            RecoverMissingGrantInput(
                **deps, customer_id="customer", payment_id=payment.id, grants=Grants()
            )
        )
        assert result.status == "resolved_auto"
        assert (
            await deps["ledger"].balance("customer", "paid", deps["clock"].now())
        ).available == 100

    anyio.run(go)


def test_missing_snapshot_is_actionable_without_invented_credits():
    async def go():
        deps, _, payment = await setup()
        await deps["repo"].payments.put(replace(payment, id="orphan"))
        result = await recover_missing_grant(
            RecoverMissingGrantInput(
                **deps, customer_id="customer", payment_id="orphan", grants=Grants()
            )
        )
        assert result.status == "needs_human"
        assert await deps["ledger"].entries("customer") == []

    anyio.run(go)


def test_cross_customer_request_never_refunds():
    async def go():
        deps, provider, payment = await setup()
        result = await request_refund(
            RequestRefundInput(**deps, customer_id="other", payment_id=payment.id)
        )
        assert result.status == "rejected"
        assert provider.refund_calls == 0

    anyio.run(go)


def test_checkout_retry_does_not_create_another_provider_checkout():
    async def go():
        deps, provider, _ = await setup()
        await start_checkout(
            StartCheckoutInput(
                **deps,
                customer_id="customer",
                plan_id="credits100",
                provider="stripe",
                currency="USD",
                request_id="sale",
                success_url="https://example.test/ok",
                cancel_url="https://example.test/cancel",
            )
        )
        assert provider.checkout_calls == 1

    anyio.run(go)


def test_concurrent_recovery_produces_one_case_grant_and_report():
    async def go():
        deps, _, payment = await setup()

        class Reporter:
            count = 0

            async def report_case(self, input):
                self.count += 1

        reporter = Reporter()
        input = RecoverMissingGrantInput(
            **deps,
            customer_id="customer",
            payment_id=payment.id,
            grants=Grants(),
            reporter=reporter,
        )

        async def run():
            try:
                await recover_missing_grant(input)
            except PaymentKitError as error:
                assert error.code == "idempotency_in_progress"

        async with anyio.create_task_group() as group:
            group.start_soon(run)
            group.start_soon(run)
        replay = await recover_missing_grant(input)
        assert replay.status == "resolved_auto"
        cases = await deps["repo"].cs_cases.list(
            kind="regrant", reference_id=payment.id
        )
        assert len(cases) == 1
        assert cases[0].id == replay.id
        assert len(await deps["ledger"].entries("customer", kind="grant")) == 1
        assert reporter.count == 1

    anyio.run(go)


def test_refund_replay_reads_latest_case_after_confirmed_settlement():
    async def go():
        deps, provider, payment = await setup()
        await recover_missing_grant(
            RecoverMissingGrantInput(
                **deps, customer_id="customer", payment_id=payment.id, grants=Grants()
            )
        )
        provider.refund_status = "pending"
        input = RequestRefundInput(
            **deps, customer_id="customer", payment_id=payment.id
        )
        pending = await request_refund(input)
        assert pending.status == "needs_human"
        refunds = await deps["repo"].refunds.list(payment_id=payment.id)
        await deps["repo"].refunds.put(replace(refunds[0], status="succeeded"))
        completed = await finish_refund_cases(
            FinishRefundCasesInput(repo=deps["repo"], clock=deps["clock"])
        )
        assert completed[0].id == pending.id
        assert (await request_refund(input)).status == "resolved_auto"
        assert provider.refund_calls == 1

    anyio.run(go)


# EC:D16 -- the reason reaches refund.evaluate through request_refund (mirrors support.test.ts)
def test_refund_reason_rules_apply_through_request_refund():
    from boilpayment_refund import RefundReasonInput

    async def go():
        deps, provider, payment = await setup("auto", {"userError": "deny", "dissatisfied": "evidence_required"})
        await recover_missing_grant(
            RecoverMissingGrantInput(**deps, customer_id="customer", payment_id=payment.id, grants=Grants())
        )

        def req(rid, reason):
            return RequestRefundInput(
                **deps, customer_id="customer", payment_id=payment.id, request_id=rid, reason=reason
            )

        assert (await request_refund(req("r-user", RefundReasonInput(category="user_error")))).status == "rejected"
        assert provider.refund_calls == 0
        assert (await request_refund(req("r-dis", RefundReasonInput(category="dissatisfied")))).status == "needs_human"
        assert provider.refund_calls == 0
        ok = await request_refund(req("r-dis-ev", RefundReasonInput(category="dissatisfied", evidence_ref="job_1")))
        assert ok.status == "resolved_auto"
        assert provider.refund_calls == 1

    anyio.run(go)
