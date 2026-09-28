"""EC:A85 regressions for paid top-ups completed after a customer restriction."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import anyio
from boilpayment_core import (
    Checkout,
    CollectingNotifier,
    CreateCheckoutInput,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    ProviderRef,
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
    ApplyPurchasedGrantInput,
    RegisterCompletedCheckoutInput,
    StartCheckoutInput,
    apply_purchased_grant,
    register_completed_checkout,
    start_checkout,
)

NOW = datetime(2026, 9, 28, tzinfo=UTC)
CUSTOMER_ID = "customer_a85"


class Grants:
    async def topup(self, **kwargs):
        return await topup(TopupInput(**kwargs))

    async def grant_for_period(self, **kwargs):
        return await grant_for_period(GrantForPeriodInput(**kwargs))


class Provider:
    name = "stripe"

    def __init__(self) -> None:
        self.checkout_entitlement_key = ""
        self.payment = Payment(
            id="provider_payment",
            customer_id="cus_a85",
            provider="stripe",
            provider_ref="pi_a85",
            subscription_id=None,
            amount=Money(amount_minor=1_000, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=NOW,
            failure=None,
        )

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=True,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout:
        self.checkout_entitlement_key = input.metadata["checkoutEntitlementKey"]
        return Checkout(
            id="checkout_a85",
            provider_ref="checkout_a85",
            url="https://example.test/checkout",
        )

    async def get_payment(self, ref: str) -> Payment:
        assert ref == self.payment.provider_ref
        return replace(
            self.payment,
            raw={
                "metadata": {
                    "checkoutEntitlementKey": self.checkout_entitlement_key
                }
            },
        )

    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]:
        assert customer_ref == "cus_a85"
        assert since <= NOW
        return [self.payment]


async def setup_paid_checkout_after_status_change(status: str):
    repo = InMemoryRepo()
    clock = FixedClock(NOW)
    ids = SequentialIdGen("a85_")
    ledger = InMemoryLedger(ids, clock)
    notifier = CollectingNotifier()
    provider = Provider()
    policy = resolve_policy()
    deps = {
        "policy": policy,
        "providers": {"stripe": provider},
        "ledger": ledger,
        "repo": repo,
        "clock": clock,
        "ids": ids,
        "notifier": notifier,
    }
    customer = Customer(
        id=CUSTOMER_ID,
        email=None,
        provider_refs=[ProviderRef(provider="stripe", ref="cus_a85")],
        status="active",
        created_at=NOW,
    )
    await repo.customers.put(customer)
    await repo.plans.put(
        Plan(
            id="topup_a85",
            name="100 credits",
            interval=None,
            credits_per_period=100,
            usage_included=0,
            trial_days=0,
            prices=[PlanPrice(
                currency="USD", amount_minor=1_000,
                provider_price_refs={"stripe": "price_a85"},
            )],
        )
    )

    await start_checkout(
        StartCheckoutInput(
            **deps,
            customer_id=CUSTOMER_ID,
            plan_id="topup_a85",
            provider="stripe",
            currency="USD",
            request_id="request_a85",
            success_url="https://example.test/success",
            cancel_url="https://example.test/cancel",
        )
    )
    await repo.customers.put(replace(customer, status=status))
    payment = await register_completed_checkout(
        RegisterCompletedCheckoutInput(
            **deps,
            customer_id=CUSTOMER_ID,
            checkout_id="checkout_a85",
            payment_ref="pi_a85",
        )
    )
    grant_input = ApplyPurchasedGrantInput(
        **deps,
        customer_id=CUSTOMER_ID,
        payment_id=payment.id,
        grants=Grants(),
    )
    return deps, payment, grant_input


def test_ec_a85_banned_customer_paid_topup_is_sent_to_one_refund_review() -> None:
    async def scenario() -> None:
        # Given: an active customer starts checkout, is banned, and the paid purchase is recorded.
        deps, payment, grant_input = await setup_paid_checkout_after_status_change(
            "banned"
        )
        assert await deps["repo"].payments.get(payment.id) == payment

        # When: both the initial delivery and a redelivery reach the shared grant seam.
        await apply_purchased_grant(grant_input)
        await apply_purchased_grant(grant_input)

        # Then: no credits are granted and one human refund review owns the payment.
        assert await deps["ledger"].entries(CUSTOMER_ID, kind="grant") == []
        active_cases = [
            case
            for case in await deps["repo"].cs_cases.list(customer_id=CUSTOMER_ID)
            if case.status in ("open", "needs_human")
        ]
        assert [
            (case.kind, case.status, case.reference_id) for case in active_cases
        ] == [("refund", "needs_human", payment.id)]
        assert [notice.type for notice in deps["notifier"].sent] == [
            "cs.needs_human"
        ]

    anyio.run(scenario)


def test_ec_a85_frozen_customer_paid_topup_keeps_normal_grant_behavior() -> None:
    async def scenario() -> None:
        # Given: an active customer starts checkout, is frozen, and the payment is recorded.
        deps, payment, grant_input = await setup_paid_checkout_after_status_change(
            "frozen"
        )

        # When: the shared purchased-grant seam fulfills the top-up.
        await apply_purchased_grant(grant_input)

        # Then: the frozen customer receives the normal grant without a refund-review case.
        customer = await deps["repo"].customers.get(CUSTOMER_ID)
        assert customer is not None and customer.status == "frozen"
        entries = await deps["ledger"].entries(CUSTOMER_ID, kind="grant")
        assert [(entry.amount, entry.reference.payment_id) for entry in entries] == [
            (100, payment.id)
        ]
        assert await deps["repo"].cs_cases.list(customer_id=CUSTOMER_ID) == []
        assert deps["notifier"].sent == []

    anyio.run(scenario)
