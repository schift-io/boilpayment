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
    Operation,
    Payment,
    PaymentFailure,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    ProviderError,
    ProviderRef,
    Refund,
    SequentialIdGen,
    Subscription,
    hash_payload,
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
    RecoverMissingGrantsInput,
    RegisterCompletedCheckoutInput,
    RequestRefundInput,
    StartCheckoutInput,
    finish_refund_cases,
    recover_missing_grant,
    recover_missing_grants,
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

    def capabilities(self):
        # The real Stripe adapter's capabilities (the fake follows the real interface).
        return ProviderCapabilities(native_subscriptions=True, partial_refund=True, meters=True, scheduling="provider",
                                    webhook_signature=True)

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
            prices=[PlanPrice(
                currency="USD", amount_minor=1000,
                provider_price_refs={"stripe": "price_credits100"},
            )],
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


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_ot_03_missing_provider_price_propagates_without_poisoning_retry(provider_name):
    async def go():
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        ids = SequentialIdGen("ot03_")
        repo, ledger = InMemoryRepo(), InMemoryLedger(ids)
        policy = resolve_policy()
        await repo.customers.put(
            Customer(
                id="ot03-customer",
                email=None,
                provider_refs=[ProviderRef(provider=provider_name, ref="cus_ot03")],
                status="active",
                created_at=clock.now(),
            )
        )
        await repo.plans.put(
            Plan(
                id="ot03-plan",
                name="OT-03",
                interval=None,
                credits_per_period=100,
                usage_included=0,
                trial_days=0,
                prices=[PlanPrice(currency="USD", amount_minor=1999)],
            )
        )
        placeholder = Payment(
            id="unused",
            customer_id="ot03-customer",
            provider=provider_name,
            provider_ref="unused",
            subscription_id=None,
            amount=Money(amount_minor=1999, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        provider = Provider(placeholder)
        provider.name = provider_name
        provider.capabilities = lambda: ProviderCapabilities(
            native_subscriptions=True, partial_refund=True, meters=False,
            scheduling="provider", webhook_signature=True, checkout="hosted",
        )
        calls = 0

        async def create_checkout(request):
            nonlocal calls
            calls += 1
            refs = request.price.provider_price_refs or {}
            if provider_name not in refs:
                raise PaymentKitError(
                    "set plan_prices.provider_price_refs for OT-03",
                    "missing_provider_price_ref",
                )
            return Checkout(
                id="cs_ot03",
                provider_ref="cs_ot03",
                url="https://example.test/checkout",
            )

        provider.create_checkout = create_checkout
        deps = {
            "clock": clock,
            "ids": ids,
            "repo": repo,
            "ledger": ledger,
            "policy": policy,
            "providers": {provider_name: provider},
        }
        request = StartCheckoutInput(
            **deps,
            customer_id="ot03-customer",
            plan_id="ot03-plan",
            provider=provider_name,
            currency="USD",
            request_id="ot-03",
            success_url="https://example.test/ok",
            cancel_url="https://example.test/cancel",
        )

        with pytest.raises(PaymentKitError) as excinfo:
            await start_checkout(request)
        assert excinfo.value.code == "missing_provider_price_ref"
        assert "plan_prices" in str(excinfo.value)
        assert calls == 0
        assert await repo.operations.get("checkout-result:ot03-customer:ot-03") is None

        legacy_key = "checkout-result:ot03-customer:ot-03"
        await repo.operations.put(Operation(
            id=legacy_key, key=legacy_key, kind="checkout.entitlement",
            payload_hash=hash_payload({
                "key": "checkout-entitlement:ot03-customer:ot-03",
                "success_url": request.success_url, "cancel_url": request.cancel_url,
            }),
            status="done", result={"checkout": None}, error=None,
            created_at=clock.now(), completed_at=clock.now(), attempts=1,
        ))
        with pytest.raises(PaymentKitError) as legacy_error:
            await start_checkout(request)
        assert legacy_error.value.code == "missing_provider_price_ref"
        assert (await repo.operations.get(legacy_key)).status == "failed"
        assert calls == 0

        await repo.plans.put(
            Plan(
                id="ot03-plan",
                name="OT-03",
                interval=None,
                credits_per_period=100,
                usage_included=0,
                trial_days=0,
                prices=[
                    PlanPrice(
                        currency="USD",
                        amount_minor=1999,
                        provider_price_refs={provider_name: "price_ot03"},
                    )
                ],
            )
        )
        assert (await start_checkout(request)).id == "cs_ot03"
        assert calls == 1

    anyio.run(go)


@pytest.mark.parametrize(
    ("status", "expected_code"),
    [(400, "provider"), (500, "checkout_outcome_unknown"), (None, "checkout_outcome_unknown")],
)
def test_ot_03_dc_06_only_uncertain_provider_http_outcomes_become_unknown(status, expected_code):
    async def go():
        deps, provider, _payment = await setup()

        async def create_checkout(_request):
            raise ProviderError(
                f"provider {status if status is not None else 'transport'}",
                PaymentFailure(
                    code="unknown", provider_code=str(status) if status is not None else None,
                    retryable=status is None or status >= 500,
                    user_message="failed",
                ),
                {"status": status} if status is not None else None,
                http_status=status,
            )

        provider.create_checkout = create_checkout
        request = StartCheckoutInput(
            **deps, customer_id="customer", plan_id="credits100", provider="stripe",
            currency="USD", request_id=f"provider-{status if status is not None else 'transport'}",
            success_url="https://example.test/ok", cancel_url="https://example.test/cancel",
        )
        with pytest.raises(PaymentKitError) as excinfo:
            await start_checkout(request)
        assert excinfo.value.code == expected_code
        if status == 400:
            assert await deps["repo"].operations.get(
                "checkout-entitlement:customer:provider-400"
            ) is None
            assert await deps["repo"].operations.get(
                "checkout-result:customer:provider-400"
            ) is None

    anyio.run(go)


@pytest.mark.parametrize(("trial_days", "accepted"), [(7, True), (0, False)])
def test_sb_03_only_trialing_plan_accepts_zero_amount_first_invoice(
    trial_days, accepted,
):
    async def go():
        deps, provider, _initial_payment = await setup()
        period = Period(
            start=deps["clock"].now(), end=datetime(2026, 2, 1, tzinfo=UTC),
        )
        plan = Plan(
            id=f"sb03-{trial_days}", name="SB-03", interval="month",
            credits_per_period=1000, usage_included=0, trial_days=trial_days,
            prices=[PlanPrice(
                currency="USD", amount_minor=1999,
                provider_price_refs={"stripe": f"price_sb03_{trial_days}"},
            )],
        )
        checkout_id = f"cs_sb03_{trial_days}"
        payment_ref = f"in_sb03_{trial_days}"
        subscription_ref = f"sub_sb03_{trial_days}"
        await deps["repo"].plans.put(plan)

        async def create_checkout(_request):
            return Checkout(
                id=checkout_id, provider_ref=checkout_id,
                url="https://example.test/sub",
            )

        invoice = Payment(
            id=f"payment-{payment_ref}", customer_id="cus_1", provider="stripe",
            provider_ref=payment_ref, subscription_id=subscription_ref,
            amount=Money(amount_minor=0, currency="USD"), status="succeeded",
            kind="subscription", period=period, occurred_at=deps["clock"].now(),
            failure=None,
            raw={"metadata": {
                "checkoutEntitlementKey": f"checkout-entitlement:customer:sb03-{trial_days}",
            }},
        )

        async def get_payment(_ref):
            return invoice

        async def list_payments(**_kwargs):
            return [invoice]

        async def get_subscription(_ref):
            return Subscription(
                id=subscription_ref, customer_id="cus_1", plan_id=plan.id,
                provider="stripe", provider_ref=subscription_ref, status="trialing",
                current_period=period, anchor_day=1, cancel_at_period_end=False,
                grace_until=None, billing_key=None, scheduled_plan_id=None,
                currency="USD", version=0, created_at=deps["clock"].now(),
            )

        provider.create_checkout = create_checkout
        provider.get_payment = get_payment
        provider.list_payments = list_payments
        provider.get_subscription = get_subscription
        await start_checkout(StartCheckoutInput(
            **deps, customer_id="customer", plan_id=plan.id, provider="stripe",
            currency="USD", request_id=f"sb03-{trial_days}",
            success_url="https://example.test/ok",
            cancel_url="https://example.test/cancel",
        ))

        request = RegisterCompletedCheckoutInput(
            **deps, customer_id="customer", checkout_id=checkout_id,
            payment_ref=payment_ref,
        )
        if not accepted:
            with pytest.raises(PaymentKitError) as excinfo:
                await register_completed_checkout(request)
            assert excinfo.value.code == "checkout_evidence_mismatch"
            return
        payment = await register_completed_checkout(request)
        assert payment.amount == Money(amount_minor=0, currency="USD")
        stored = await deps["repo"].subscriptions.get(
            f"subscription:stripe:{subscription_ref}"
        )
        assert stored.status == "trialing"
        assert stored.plan_id == plan.id
        assert await deps["ledger"].entries("customer", kind="grant") == []

    anyio.run(go)


def test_sb_03_reconcile_preserves_marked_trial_opening_invoice():
    async def go():
        deps, provider, initial_payment = await setup()
        await recover_missing_grant(RecoverMissingGrantInput(
            **deps,
            customer_id="customer",
            payment_id=initial_payment.id,
            grants=Grants(),
        ))
        trial_period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 1, 15, tzinfo=UTC),
        )
        active_period = Period(
            start=trial_period.end,
            end=datetime(2026, 2, 15, tzinfo=UTC),
        )
        plan = Plan(
            id="sb03-reconcile-plan",
            name="SB-03 reconcile",
            interval="month",
            credits_per_period=1000,
            usage_included=0,
            trial_days=14,
            prices=[PlanPrice(
                currency="USD",
                amount_minor=1999,
                provider_price_refs={"stripe": "price_sb03_reconcile"},
            )],
        )
        subscription = Subscription(
            id="subscription:stripe:sub_sb03_reconcile",
            customer_id="customer",
            plan_id=plan.id,
            provider="stripe",
            provider_ref="sub_sb03_reconcile",
            status="active",
            current_period=active_period,
            anchor_day=15,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            currency="USD",
            version=0,
            created_at=deps["clock"].now(),
        )
        opening_invoice = Payment(
            id="provider-payment-sb03-opening",
            customer_id="cus_1",
            provider="stripe",
            provider_ref="in_sb03_opening",
            subscription_id=subscription.provider_ref,
            amount=Money(amount_minor=0, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=trial_period,
            occurred_at=trial_period.start,
            failure=None,
            raw={"billing_reason": "subscription_create"},
        )
        await deps["repo"].plans.put(plan)
        await deps["repo"].subscriptions.put(subscription)
        await deps["repo"].payments.put(replace(
            opening_invoice,
            id="localized-sb03-opening",
            customer_id=subscription.customer_id,
            subscription_id=subscription.id,
            raw={
                **opening_invoice.raw,
                "boilpaymentTrialOpeningInvoice": True,
            },
        ))

        async def list_payments(**_kwargs):
            return [opening_invoice]

        provider.list_payments = list_payments
        scan = RecoverMissingGrantsInput(
            **deps,
            grants=Grants(),
            since=datetime(2025, 12, 31, tzinfo=UTC),
        )

        first_cases = await recover_missing_grants(scan)
        second_cases = await recover_missing_grants(replace(scan, since=None))
        recorded = next(
            payment
            for payment in await deps["repo"].payments.list()
            if payment.provider_ref == opening_invoice.provider_ref
        )

        assert recorded.raw["boilpaymentTrialOpeningInvoice"] is True
        assert first_cases == []
        assert second_cases == []
        assert await deps["repo"].cs_cases.list(reference_id=recorded.id) == []
        assert await deps["ledger"].entries(
            "customer", kind="grant", source="subscription"
        ) == []

    anyio.run(go)


def test_sb_03_reconcile_does_not_ignore_unmarked_zero_invoice():
    async def go():
        deps, provider, initial_payment = await setup()
        await recover_missing_grant(RecoverMissingGrantInput(
            **deps, customer_id="customer", payment_id=initial_payment.id,
            grants=Grants(),
        ))
        trial_period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 1, 15, tzinfo=UTC),
        )
        plan = Plan(
            id="sb03-unmarked-plan", name="SB-03 unmarked", interval="month",
            credits_per_period=1000, usage_included=0, trial_days=14,
            prices=[PlanPrice(
                currency="USD", amount_minor=1999,
                provider_price_refs={"stripe": "price_sb03_unmarked"},
            )],
        )
        subscription = Subscription(
            id="subscription:stripe:sub_sb03_unmarked", customer_id="customer",
            plan_id=plan.id, provider="stripe", provider_ref="sub_sb03_unmarked",
            status="active", current_period=Period(
                start=trial_period.end, end=datetime(2026, 2, 15, tzinfo=UTC),
            ),
            anchor_day=15, cancel_at_period_end=False, grace_until=None,
            billing_key=None, scheduled_plan_id=None, currency="USD", version=0,
            created_at=deps["clock"].now(),
        )
        opening_invoice = Payment(
            id="provider-payment-sb03-unmarked", customer_id="cus_1",
            provider="stripe", provider_ref="in_sb03_unmarked",
            subscription_id=subscription.provider_ref,
            amount=Money(amount_minor=0, currency="USD"), status="succeeded",
            kind="subscription", period=trial_period,
            occurred_at=trial_period.start, failure=None,
            raw={"billing_reason": "subscription_create"},
        )
        await deps["repo"].plans.put(plan)
        await deps["repo"].subscriptions.put(subscription)

        async def list_payments(**_kwargs):
            return [opening_invoice]

        provider.list_payments = list_payments
        cases = await recover_missing_grants(RecoverMissingGrantsInput(
            **deps, grants=Grants(), since=datetime(2025, 12, 31, tzinfo=UTC),
        ))
        recorded = next(
            payment for payment in await deps["repo"].payments.list()
            if payment.provider_ref == opening_invoice.provider_ref
        )

        assert len(cases) == 1
        assert cases[0].status == "needs_human"
        assert cases[0].kind == "reconcile_mismatch"
        assert recorded.raw.get("boilpaymentTrialOpeningInvoice") is None
        assert await deps["ledger"].entries(
            "customer", kind="grant", source="subscription"
        ) == []

    anyio.run(go)


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_sb_06_prefers_subscription_plan_when_catalog_matches_are_ambiguous(
    provider_name,
):
    async def go():
        deps, provider, initial_payment = await setup()
        await recover_missing_grant(RecoverMissingGrantInput(
            **deps, customer_id="customer", payment_id=initial_payment.id,
            grants=Grants(),
        ))
        provider.name = provider_name
        since = datetime(2025, 12, 31, tzinfo=UTC)
        previous_period = Period(
            start=datetime(2025, 12, 1, tzinfo=UTC),
            end=datetime(2026, 1, 1, tzinfo=UTC),
        )
        renewal_period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 2, 1, tzinfo=UTC),
        )
        shared_ref = (
            "product_sb06_shared" if provider_name == "polar"
            else "price_sb06_intended"
        )
        intended = Plan(
            id=f"sb06-{provider_name}-intended", name="Intended", interval="month",
            credits_per_period=1000, usage_included=0, trial_days=0,
            prices=[PlanPrice(
                currency="usd", amount_minor=1999,
                provider_price_refs={provider_name: shared_ref},
            )],
        )
        duplicate = Plan(
            id=f"sb06-{provider_name}-duplicate", name="Duplicate", interval="month",
            credits_per_period=2000, usage_included=0, trial_days=0,
            prices=[PlanPrice(
                currency="USD", amount_minor=1999,
                provider_price_refs={
                    provider_name: shared_ref if provider_name == "polar"
                    else "price_sb06_duplicate",
                },
            )],
        )
        subscription_id = f"subscription:{provider_name}:sub_sb06_ambiguous"
        sub = Subscription(
            id=subscription_id, customer_id="customer", plan_id=intended.id,
            provider=provider_name, provider_ref="sub_sb06_ambiguous", status="active",
            current_period=previous_period, anchor_day=1, cancel_at_period_end=False,
            grace_until=None, billing_key=None, scheduled_plan_id=None, currency="USD",
            version=0, created_at=deps["clock"].now(),
        )
        renewal = Payment(
            id="provider-payment-sb06-ambiguous", customer_id="cus_sb06_ambiguous",
            provider=provider_name, provider_ref=f"pay_sb06_{provider_name}",
            subscription_id=sub.provider_ref,
            amount=Money(amount_minor=1999, currency="USD"), status="succeeded",
            kind="subscription", period=None if provider_name == "polar" else renewal_period,
            occurred_at=renewal_period.start, failure=None,
            raw={"product": {"id": shared_ref}} if provider_name == "polar" else None,
        )
        await deps["repo"].customers.put(Customer(
            id="customer", email=None,
            provider_refs=[ProviderRef(provider=provider_name, ref=renewal.customer_id)],
            status="active", created_at=deps["clock"].now(),
        ))
        await deps["repo"].plans.put(intended)
        await deps["repo"].plans.put(duplicate)
        await deps["repo"].subscriptions.put(sub)

        async def list_payments(**_kwargs):
            return [renewal]

        async def get_subscription(_provider_ref):
            return replace(sub, current_period=renewal_period)

        provider.list_payments = list_payments
        provider.get_subscription = get_subscription
        scan = RecoverMissingGrantsInput(
            **{**deps, "providers": {provider_name: provider}},
            grants=Grants(), since=since,
        )

        cases = await recover_missing_grants(scan)
        await recover_missing_grants(scan)
        grants = await deps["ledger"].entries(
            "customer", kind="grant", source="subscription",
        )
        assert len(grants) == 1
        assert grants[0].amount == 1000
        assert cases == []
        assert await deps["repo"].cs_cases.list(kind="reconcile_mismatch") == []

    anyio.run(go)


@pytest.mark.parametrize(
    ("provider_name", "status"),
    [
        ("stripe", "active"),
        ("stripe", "past_due"),
        ("polar", "active"),
        ("polar", "past_due"),
    ],
)
def test_sb_06_provider_only_renewal_is_persisted_and_granted_once(
    provider_name, status
):
    async def go():
        deps, provider, initial_payment = await setup()
        await recover_missing_grant(
            RecoverMissingGrantInput(
                **deps,
                customer_id="customer",
                payment_id=initial_payment.id,
                grants=Grants(),
            )
        )
        provider.name = provider_name
        since = datetime(2025, 12, 31, tzinfo=UTC)
        previous_period = Period(
            start=datetime(2025, 12, 1, tzinfo=UTC),
            end=datetime(2026, 1, 1, tzinfo=UTC),
        )
        renewal_period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 2, 1, tzinfo=UTC),
        )
        plan = Plan(
            id="sb06-plan",
            name="SB-06",
            interval="month",
            credits_per_period=100,
            usage_included=0,
            trial_days=0,
            prices=[
                PlanPrice(
                    currency="USD",
                    amount_minor=1000,
                    provider_price_refs={provider_name: "price_sb06"},
                )
            ],
        )
        subscription_id = f"subscription:{provider_name}:sub_sb06"
        sub = Subscription(
            id=subscription_id,
            customer_id="customer",
            plan_id=plan.id,
            provider=provider_name,
            provider_ref="sub_sb06",
            status=status,
            current_period=previous_period,
            anchor_day=1,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            currency="USD",
            version=0,
            created_at=deps["clock"].now(),
        )
        renewal = Payment(
            id="provider-payment-sb06",
            customer_id="cus_sb06",
            provider=provider_name,
            provider_ref="pay_sb06",
            subscription_id="sub_sb06",
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=None if provider_name == "polar" else renewal_period,
            occurred_at=renewal_period.start,
            failure=None,
        )
        await deps["repo"].customers.put(
            Customer(
                id="customer",
                email=None,
                provider_refs=[ProviderRef(provider=provider_name, ref="cus_sb06")],
                status="active",
                created_at=deps["clock"].now(),
            )
        )
        await deps["repo"].plans.put(plan)
        await deps["repo"].subscriptions.put(sub)
        list_calls = []

        async def list_payments(**kwargs):
            list_calls.append(kwargs)
            return [renewal]

        async def get_subscription(_provider_ref):
            return replace(sub, current_period=renewal_period)

        provider.list_payments = list_payments
        provider.get_subscription = get_subscription
        scan_deps = {**deps, "providers": {provider_name: provider}}
        scan = RecoverMissingGrantsInput(
            **scan_deps,
            grants=Grants(),
            since=since,
        )

        await recover_missing_grants(scan)
        recorded = next(
            (
                payment
                for payment in await deps["repo"].payments.list()
                if payment.provider_ref == renewal.provider_ref
            ),
            None,
        )
        assert recorded is not None
        assert recorded.customer_id == "customer"
        assert recorded.subscription_id == subscription_id
        grants = await deps["ledger"].entries(
            "customer", kind="grant", source="subscription"
        )
        assert len(grants) == 1
        assert grants[0].amount == 100
        assert grants[0].idempotency_key == (
            f"grant:{subscription_id}:2026-01-01T00:00:00.000Z"
        )
        assert grants[0].reference.payment_id == recorded.id

        await recover_missing_grants(scan)
        await grant_for_period(
            GrantForPeriodInput(
                sub=replace(sub, status="active"),
                plan=plan,
                period=renewal_period,
                payment=recorded,
                policy=deps["policy"],
                ledger=deps["ledger"],
                clock=deps["clock"],
            )
        )
        grants = await deps["ledger"].entries(
            "customer", kind="grant", source="subscription"
        )
        assert len(grants) == 1
        assert list_calls == [
            {"customer_ref": "cus_sb06", "since": since},
            {"customer_ref": "cus_sb06", "since": since},
        ]

    anyio.run(go)


def test_sb_06_polar_maps_two_periodless_renewals_to_sequential_periods_once():
    async def go():
        deps, provider, initial_payment = await setup()
        await recover_missing_grant(RecoverMissingGrantInput(
            **deps, customer_id="customer", payment_id=initial_payment.id, grants=Grants(),
        ))
        provider.name = "polar"
        since = datetime(2025, 12, 31, tzinfo=UTC)
        p0 = Period(start=datetime(2025, 12, 1, tzinfo=UTC), end=datetime(2026, 1, 1, tzinfo=UTC))
        p1 = Period(start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC))
        p2 = Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=datetime(2026, 3, 1, tzinfo=UTC))
        plan = Plan(
            id="sb06-polar-plan", name="Polar monthly", interval="month", credits_per_period=100,
            usage_included=0, trial_days=0, prices=[PlanPrice(
                currency="USD", amount_minor=1000, provider_price_refs={"polar": "product_sb06"},
            )],
        )
        sub = Subscription(
            id="subscription:polar:sub_multi", customer_id="customer", plan_id=plan.id,
            provider="polar", provider_ref="sub_multi", status="active", current_period=p0,
            anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None,
            scheduled_plan_id=None, currency="USD", version=0, created_at=deps["clock"].now(),
        )

        def payment(ref: str, occurred_at: datetime) -> Payment:
            return Payment(
                id=f"remote-{ref}", customer_id="cus_multi", provider="polar", provider_ref=ref,
                subscription_id="sub_multi", amount=Money(amount_minor=1000, currency="USD"),
                status="succeeded", kind="subscription", period=None, occurred_at=occurred_at,
                failure=None, raw={"product_id": "product_sb06"},
            )

        await deps["repo"].customers.put(Customer(
            id="customer", email=None, provider_refs=[ProviderRef(provider="polar", ref="cus_multi")],
            status="active", created_at=deps["clock"].now(),
        ))
        await deps["repo"].plans.put(plan)
        await deps["repo"].subscriptions.put(sub)

        async def list_payments(**_kwargs):
            return [payment("order_2", p2.start), payment("order_1", p1.start)]

        provider.list_payments = list_payments
        scan = RecoverMissingGrantsInput(
            **{**deps, "providers": {"polar": provider}}, grants=Grants(), since=since,
        )
        await recover_missing_grants(scan)
        grants = await deps["ledger"].entries("customer", kind="grant", source="subscription")
        assert sorted(entry.idempotency_key for entry in grants) == [
            f"grant:{sub.id}:2026-01-01T00:00:00.000Z",
            f"grant:{sub.id}:2026-02-01T00:00:00.000Z",
        ]
        recorded = await deps["repo"].payments.list(subscription_id=sub.id)
        assert sorted(item.period.start for item in recorded) == [p1.start, p2.start]

        await recover_missing_grants(scan)
        assert len(await deps["ledger"].entries("customer", kind="grant", source="subscription")) == 2

    anyio.run(go)


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_sb_14_lost_renewal_webhook_grants_actual_charged_plan_and_opens_mismatch(
    provider_name,
):
    async def go():
        deps, provider, initial_payment = await setup()
        await recover_missing_grant(RecoverMissingGrantInput(
            **deps, customer_id="customer", payment_id=initial_payment.id, grants=Grants(),
        ))
        provider.name = provider_name
        since = datetime(2025, 12, 31, tzinfo=UTC)
        previous_period = Period(
            start=datetime(2025, 12, 1, tzinfo=UTC), end=datetime(2026, 1, 1, tzinfo=UTC),
        )
        renewal_period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC),
        )
        high = Plan(
            id="sb14-high", name="High", interval="month", credits_per_period=3000,
            usage_included=0, trial_days=0, prices=[PlanPrice(
                currency="USD", amount_minor=3000,
                provider_price_refs={provider_name: "price_sb14_high"},
            )],
        )
        low = Plan(
            id="sb14-low", name="Low", interval="month", credits_per_period=1000,
            usage_included=0, trial_days=0, prices=[PlanPrice(
                currency="USD", amount_minor=1000,
                provider_price_refs={provider_name: "price_sb14_low"},
            )],
        )
        subscription_id = f"subscription:{provider_name}:sub_sb14"
        sub = Subscription(
            id=subscription_id, customer_id="customer", plan_id=high.id,
            provider=provider_name, provider_ref="sub_sb14", status="active",
            current_period=previous_period, anchor_day=1, cancel_at_period_end=False,
            grace_until=None, billing_key=None, scheduled_plan_id=low.id, currency="USD",
            version=0, created_at=deps["clock"].now(),
        )
        remote = Payment(
            id="provider-payment-sb14", customer_id="cus_sb14", provider=provider_name,
            provider_ref="pay_sb14", subscription_id="sub_sb14",
            amount=Money(amount_minor=3000, currency="USD"), status="succeeded",
            kind="subscription", period=None if provider_name == "polar" else renewal_period,
            occurred_at=renewal_period.start,
            failure=None, raw={"line": {"price": "price_sb14_high"}},
        )
        await deps["repo"].customers.put(Customer(
            id="customer", email=None,
            provider_refs=[ProviderRef(provider=provider_name, ref="cus_sb14")],
            status="active", created_at=deps["clock"].now(),
        ))
        await deps["repo"].plans.put(high)
        await deps["repo"].plans.put(low)
        await deps["repo"].subscriptions.put(sub)

        async def list_payments(**_kwargs):
            return [remote]

        provider.list_payments = list_payments
        async def get_subscription(_provider_ref):
            return replace(sub, current_period=renewal_period)
        provider.get_subscription = get_subscription
        scan = RecoverMissingGrantsInput(
            **{**deps, "providers": {provider_name: provider}}, grants=Grants(), since=since,
        )

        cases = await recover_missing_grants(scan)
        recorded = next(
            (payment for payment in await deps["repo"].payments.list()
             if payment.provider_ref == remote.provider_ref),
            None,
        )
        assert recorded is not None
        assert recorded.raw == remote.raw
        grants = await deps["ledger"].entries("customer", kind="grant", source="subscription")
        assert len(grants) == 1
        assert grants[0].amount == 3000
        assert grants[0].reference.payment_id == recorded.id
        assert len(cases) == 1
        assert cases[0].id == f"reconcile_mismatch:{recorded.id}"
        assert cases[0].status == "needs_human"
        assert cases[0].decision["expectedPlanId"] == low.id
        assert cases[0].decision["actualPlanId"] == high.id
        updated = await deps["repo"].subscriptions.get(subscription_id)
        assert updated.plan_id == high.id
        assert updated.scheduled_plan_id is None
        assert updated.current_period == renewal_period

        await recover_missing_grants(scan)
        assert len(await deps["ledger"].entries("customer", kind="grant", source="subscription")) == 1
        assert len(await deps["repo"].cs_cases.list(reference_id=recorded.id)) == 1

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
