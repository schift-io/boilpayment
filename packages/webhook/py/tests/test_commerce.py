# allow: SIZE_OK -- paired provider contract scenarios intentionally share one fixture matrix.
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from _helpers import FakeProvider
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    NormalizedEvent,
    Operation,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SaleEvidence,
    SequentialIdGen,
    Subscription,
)
from boilpayment_webhook import HandlerCtx, default_handlers

NOW = datetime(2026, 9, 28, tzinfo=UTC)


def _plan(provider: str, interval: str | None = None) -> Plan:
    return Plan(
        id=f"plan-{interval or 'once'}",
        name="Plan",
        interval=interval,
        credits_per_period=100,
        usage_included=0,
        trial_days=0,
        prices=[
            PlanPrice(
                currency="USD",
                amount_minor=2_000,
                provider_price_refs={provider: "price-1"},
            )
        ],
    )


def _remote(provider: str, **overrides) -> Payment:
    values = {
        "id": "provider-payment",
        "customer_id": "",
        "provider": provider,
        "provider_ref": "pi-canonical",
        "subscription_id": None,
        "amount": Money(amount_minor=1_600, currency="USD"),
        "status": "succeeded",
        "kind": "topup",
        "period": None,
        "occurred_at": NOW,
        "failure": None,
        "cash_receipt": None,
        "sale_evidence": SaleEvidence(
            provider_subtotal=Money(amount_minor=2_000, currency="USD"),
            discount_amount=Money(amount_minor=400, currency="USD"),
            price_ref="price-1",
            checkout_id=None,
            payment_link_id="plink-1",
            link_reference="valid",
        ),
        "affiliate_id": None,
    }
    values.update(overrides)
    return Payment(**values)


def _event(provider: str, subscription_ref: str | None = None) -> NormalizedEvent:
    return NormalizedEvent(
        id="event-1",
        provider=provider,
        type="payment.succeeded",
        occurred_at=NOW,
        customer_ref=None,
        subscription_ref=subscription_ref,
        payment_ref="checkout-session-ref",
        amount=None,
        raw={},
    )


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_ot09_records_and_holds_unregistered_checkout_once(provider_name: str) -> None:
    async def run() -> None:
        # Given
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        provider_payment = _remote(
            provider_name,
            sale_evidence=SaleEvidence(
                provider_subtotal=Money(amount_minor=2_000, currency="USD"),
                discount_amount=Money(amount_minor=0, currency="USD"),
                price_ref="price-1",
                checkout_id="checkout-1",
                payment_link_id=None,
                link_reference=None,
            ),
        )
        await repo.operations.put(Operation(
            id="checkout-entitlement-by-id:checkout-1",
            key="checkout-entitlement-by-id:checkout-1",
            kind="checkout.entitlement",
            payload_hash="snapshot",
            status="done",
            result={
                "customer_id": "customer-1",
                "plan": {"id": "plan-1", "interval": None},
                "affiliate_id": "affiliate-1",
            },
            error=None,
            created_at=NOW,
            completed_at=NOW,
            attempts=1,
        ))
        provider = FakeProvider(
            name=provider_name,
            verify=lambda _headers, _body: _event(provider_name),
            get_payment_impl=lambda _ref: provider_payment,
        )
        grants: list[str] = []

        async def grant(payment, plan, subscription) -> None:
            grants.append(payment.id)

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=InMemoryLedger(),
            repo=repo,
            notifier=CollectingNotifier(),
            clock=clock,
            ids=SequentialIdGen("id-"),
            grant_link_payment=grant,
            credits=type(
                "Credits",
                (),
                {
                    "topup": lambda *_args, **_kwargs: (_ for _ in ()).throw(
                        AssertionError("held checkout replay must not grant")
                    )
                },
            )(),
            resolve_topup_credits=lambda _payment: asyncio.sleep(0, result=None),
        )
        handler = handlers["payment.succeeded"]

        # When
        await handler(HandlerCtx(event=_event(provider_name), provider=provider, repo=repo, clock=clock, correlation_id="correlation-1"))
        provider_payment.status = "refunded"
        await handler(HandlerCtx(event=_event(provider_name), provider=provider, repo=repo, clock=clock, correlation_id="correlation-2"))

        # Then
        payments = await repo.payments.list()
        assert len(payments) == 1
        assert payments[0].id == f"payment:{provider_name}:pi-canonical"
        assert payments[0].affiliate_id == "affiliate-1"
        held = await repo.operations.get(
            f"checkout-payment-held:payment:{provider_name}:pi-canonical"
        )
        assert held is not None
        assert held.kind == "checkout.paymentHeld"
        assert grants == []

    asyncio.run(run())


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_pl02_and_af_grant_valid_link_and_accrue_once(provider_name: str) -> None:
    async def run() -> None:
        # Given
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        await repo.plans.put(_plan(provider_name))
        await repo.customers.put(Customer(
            id="customer-1",
            email=None,
            provider_refs=[],
            status="active",
            created_at=NOW,
        ))
        provider_payment = _remote(provider_name)
        if provider_name == "polar":
            provider_payment.sale_evidence.payment_link_id = None
        provider = FakeProvider(
            name=provider_name,
            verify=lambda _headers, _body: _event(provider_name),
            get_payment_impl=lambda _ref: provider_payment,
        )
        grants: list[str] = []

        async def grant(payment, plan, subscription) -> None:
            grants.append(payment.id)

        async def commission(_payment: Payment) -> Money:
            return Money(amount_minor=160, currency="USD")

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=InMemoryLedger(),
            repo=repo,
            notifier=CollectingNotifier(),
            clock=clock,
            ids=SequentialIdGen("id-"),
            decode_link_reference=lambda _reference: {
                "customer_id": "customer-1",
                "affiliate_id": "affiliate-1",
            },
            grant_link_payment=grant,
            commission_for_payment=commission,
            credits=type("Credits", (), {"topup": lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("link replay must not use checkout grants"))})(),
            resolve_topup_credits=lambda _payment: asyncio.sleep(0, result=None),
        )
        handler = handlers["payment.succeeded"]

        # When
        await handler(HandlerCtx(event=_event(provider_name), provider=provider, repo=repo, clock=clock, correlation_id="correlation-1"))
        second = _event(provider_name)
        second.id = "event-2"
        second.payment_ref = "pi-canonical"
        await handler(HandlerCtx(event=second, provider=provider, repo=repo, clock=clock, correlation_id="correlation-2"))

        # Then
        assert grants == [f"payment:{provider_name}:pi-canonical"]
        payments = await repo.payments.list()
        assert len(payments) == 1
        assert payments[0].amount.amount_minor == 1_600
        assert payments[0].affiliate_id == "affiliate-1"
        commissions = await repo.affiliate_commissions.list(
            affiliate_id="affiliate-1"
        )
        assert len(commissions) == 1

    asyncio.run(run())


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
@pytest.mark.parametrize(
    ("reason", "reference", "decoded"),
    [
        ("missing_reference", None, None),
        ("invalid_reference", "invalid", None),
        (
            "unknown_customer",
            "valid",
            {"customer_id": "missing-customer", "affiliate_id": None},
        ),
    ],
)
def test_pl03_records_and_parks_unmatched_link_once(
    provider_name: str,
    reason: str,
    reference: str | None,
    decoded,
) -> None:
    async def run() -> None:
        # Given
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        await repo.plans.put(_plan(provider_name))
        provider_payment = _remote(
            provider_name,
            sale_evidence=SaleEvidence(
                provider_subtotal=Money(amount_minor=2_000, currency="USD"),
                discount_amount=Money(amount_minor=400, currency="USD"),
                price_ref="price-1",
                checkout_id=None,
                payment_link_id=(
                    None
                    if provider_name == "polar" and reason == "missing_reference"
                    else "plink-1"
                ),
                link_reference=reference,
            ),
        )
        provider = FakeProvider(
            name=provider_name,
            verify=lambda _headers, _body: _event(provider_name),
            get_payment_impl=lambda _ref: provider_payment,
        )
        opened: list[str] = []

        async def open_case(payment, actual_reason) -> None:
            opened.append(actual_reason)

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=InMemoryLedger(),
            repo=repo,
            notifier=CollectingNotifier(),
            clock=clock,
            ids=SequentialIdGen("id-"),
            decode_link_reference=lambda _reference: decoded,
            open_link_mismatch_case=open_case,
            credits=type(
                "Credits",
                (),
                {
                    "topup": lambda *_args, **_kwargs: (_ for _ in ()).throw(
                        AssertionError("link mismatch replay must not grant")
                    )
                },
            )(),
            resolve_topup_credits=lambda _payment: asyncio.sleep(0, result=None),
        )
        handler = handlers["payment.succeeded"]

        # When
        await handler(HandlerCtx(event=_event(provider_name), provider=provider, repo=repo, clock=clock, correlation_id="correlation-1"))
        provider_payment.status = "refunded"
        await handler(HandlerCtx(event=_event(provider_name), provider=provider, repo=repo, clock=clock, correlation_id="correlation-2"))

        # Then
        assert opened == [reason]
        assert len(await repo.payments.list()) == 1
        customers = await repo.customers.list()
        assert customers[0].status == "frozen"
        if reason == "unknown_customer":
            assert customers[0].id == f"unmatched-link:{provider_name}:pi-canonical"

    asyncio.run(run())


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
@pytest.mark.parametrize("status", ["frozen", "banned"])
def test_pl03_records_but_never_grants_inactive_customer(provider_name: str, status: str) -> None:
    async def run() -> None:
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        await repo.plans.put(_plan(provider_name))
        await repo.customers.put(Customer(id="customer-1", email=None, provider_refs=[], status=status, created_at=NOW))
        provider = FakeProvider(name=provider_name, verify=lambda _h, _b: _event(provider_name),
                                get_payment_impl=lambda _ref: _remote(provider_name))
        grants: list[str] = []
        opened: list[str] = []

        async def grant(payment, plan, subscription) -> None:
            grants.append(payment.id)

        async def open_case(payment, reason) -> None:
            opened.append(reason)

        handlers = default_handlers(
            policy=DEFAULT_POLICY, ledger=InMemoryLedger(), repo=repo,
            notifier=CollectingNotifier(), clock=clock, ids=SequentialIdGen("id-"),
            decode_link_reference=lambda _ref: {"customer_id": "customer-1", "affiliate_id": None},
            grant_link_payment=grant, open_link_mismatch_case=open_case,
        )
        await handlers["payment.succeeded"](HandlerCtx(
            event=_event(provider_name), provider=provider, repo=repo, clock=clock,
            correlation_id="correlation-1",
        ))
        assert grants == []
        assert opened == ["customer_inactive"]
        assert len(await repo.payments.list()) == 1

    asyncio.run(run())


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_pl02_refuses_non_succeeded_authoritative_payment(provider_name: str) -> None:
    async def run() -> None:
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        await repo.plans.put(_plan(provider_name))
        await repo.customers.put(Customer(id="customer-1", email=None, provider_refs=[], status="active", created_at=NOW))
        provider = FakeProvider(name=provider_name, verify=lambda _h, _b: _event(provider_name),
                                get_payment_impl=lambda _ref: _remote(provider_name, status="pending"))
        grants: list[str] = []

        async def grant(payment, plan, subscription) -> None:
            grants.append(payment.id)

        handlers = default_handlers(
            policy=DEFAULT_POLICY, ledger=InMemoryLedger(), repo=repo,
            notifier=CollectingNotifier(), clock=clock, ids=SequentialIdGen("id-"),
            decode_link_reference=lambda _ref: {"customer_id": "customer-1", "affiliate_id": None},
            grant_link_payment=grant,
        )
        with pytest.raises(Exception) as excinfo:
            await handlers["payment.succeeded"](HandlerCtx(
                event=_event(provider_name), provider=provider, repo=repo, clock=clock,
                correlation_id="correlation-1",
            ))
        assert getattr(excinfo.value, "code", None) == "topup_payment_not_succeeded"
        assert grants == []
        assert await repo.payments.list() == []

    asyncio.run(run())


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_pl02_subscription_uses_price_ref_and_actual_discounted_amount(
    provider_name: str,
) -> None:
    async def run() -> None:
        # Given
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        current_plan = _plan(provider_name, "month")
        await repo.plans.put(current_plan)
        await repo.customers.put(Customer(
            id="customer-1",
            email=None,
            provider_refs=[],
            status="active",
            created_at=NOW,
        ))
        period = Period(start=NOW, end=datetime(2026, 10, 28, tzinfo=UTC))
        provider_sub = Subscription(
            id="provider-sub",
            customer_id="",
            plan_id="",
            provider=provider_name,
            provider_ref="provider-sub",
            status="active",
            current_period=period,
            anchor_day=28,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            version=0,
            created_at=NOW,
        )
        provider_payment = _remote(
            provider_name,
            kind="subscription",
            subscription_id="provider-sub",
            period=period,
        )
        if provider_name == "polar":
            provider_payment.sale_evidence.payment_link_id = None
        provider = FakeProvider(
            name=provider_name,
            verify=lambda _headers, _body: _event(provider_name, "provider-sub"),
            get_payment_impl=lambda _ref: provider_payment,
            get_subscription_impl=lambda _ref: provider_sub,
        )
        granted: list[tuple[int, str, str | None]] = []

        async def grant(payment, resolved_plan, subscription) -> None:
            granted.append(
                (
                    payment.amount.amount_minor,
                    resolved_plan.id,
                    subscription.affiliate_id if subscription is not None else None,
                )
            )

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=InMemoryLedger(),
            repo=repo,
            notifier=CollectingNotifier(),
            clock=clock,
            ids=SequentialIdGen("id-"),
            decode_link_reference=lambda _reference: {
                "customer_id": "customer-1",
                "affiliate_id": "affiliate-1",
            },
            grant_link_payment=grant,
        )

        # When
        await handlers["payment.succeeded"](HandlerCtx(
            event=_event(provider_name, "provider-sub"),
            provider=provider,
            repo=repo,
            clock=clock,
            correlation_id="correlation-1",
        ))

        # Then
        assert granted == [(1_600, current_plan.id, "affiliate-1")]
        assert (await repo.payments.list())[0].amount.amount_minor == 1_600

    asyncio.run(run())


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
@pytest.mark.parametrize(
    ("renewals", "expected_commissions"),
    [("include", 1), ("first_only", 0)],
)
def test_dc05_and_af04_renew_by_plan_at_actual_charge_by_policy(
    provider_name: str,
    renewals: str,
    expected_commissions: int,
) -> None:
    async def run() -> None:
        # Given
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        current_plan = _plan(provider_name, "month")
        await repo.plans.put(current_plan)
        period = Period(start=NOW, end=datetime(2026, 10, 28, tzinfo=UTC))
        local_sub = Subscription(
            id="local-sub",
            customer_id="customer-1",
            plan_id=current_plan.id,
            provider=provider_name,
            provider_ref="provider-sub",
            status="active",
            current_period=period,
            anchor_day=28,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            version=0,
            created_at=NOW,
            affiliate_id="affiliate-1",
        )
        await repo.subscriptions.put(local_sub)
        provider_payment = _remote(
            provider_name,
            provider_ref="checkout-session-ref",
            kind="subscription",
            subscription_id="provider-sub",
            period=period,
            amount=Money(amount_minor=2_000, currency="USD"),
            sale_evidence=None,
            affiliate_id=None,
        )
        provider = FakeProvider(
            name=provider_name,
            verify=lambda _headers, _body: _event(provider_name, "provider-sub"),
            get_payment_impl=lambda _ref: provider_payment,
            get_subscription_impl=lambda _ref: local_sub,
        )
        renewed: list[tuple[str, int]] = []

        class Dunning:
            async def on_payment_failed(self, **kwargs) -> None:
                return None

        class Lifecycle:
            dunning = Dunning()

            async def on_renewal_paid(self, **kwargs) -> None:
                renewed.append(
                    (kwargs["sub"].plan_id, kwargs["payment"].amount.amount_minor)
                )

        async def commission(_payment: Payment) -> Money:
            return Money(amount_minor=200, currency="USD")

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=InMemoryLedger(),
            repo=repo,
            notifier=CollectingNotifier(),
            clock=clock,
            ids=SequentialIdGen("id-"),
            lifecycle=Lifecycle(),
            affiliate_renewals=renewals,
            commission_for_payment=commission,
        )

        # When
        await handlers["payment.succeeded"](HandlerCtx(
            event=_event(provider_name, "provider-sub"),
            provider=provider,
            repo=repo,
            clock=clock,
            correlation_id="correlation-1",
        ))
        await handlers["payment.succeeded"](HandlerCtx(
            event=_event(provider_name, "provider-sub"),
            provider=provider,
            repo=repo,
            clock=clock,
            correlation_id="correlation-2",
        ))

        # Then
        assert renewed == [(current_plan.id, 2_000), (current_plan.id, 2_000)]
        assert (await repo.payments.list())[0].amount.amount_minor == 2_000
        assert len(
            await repo.affiliate_commissions.list(affiliate_id="affiliate-1")
        ) == expected_commissions

    asyncio.run(run())


def test_ot09_stripe_payment_intent_before_registration_is_held_by_checkout_key() -> None:
    async def run() -> None:
        # Given -- a PaymentIntent names the kit's checkout key in metadata, never the session id
        repo = InMemoryRepo()
        clock = FixedClock(NOW)
        for key, result in (
            ("checkout-entitlement-by-id:checkout-1", {
                "customer_id": "customer-1", "plan": {"id": "plan-1", "interval": None}, "affiliate_id": None,
            }),
            ("checkout-id-by-key:intent-1", {"checkoutId": "checkout-1"}),
        ):
            await repo.operations.put(Operation(
                id=key, key=key, kind="checkout.entitlement", payload_hash="x", status="done",
                result=result, error=None, created_at=NOW, completed_at=NOW, attempts=1,
            ))
        intent = _remote(
            "stripe", sale_evidence=None,
            raw={"metadata": {"checkoutEntitlementKey": "intent-1"}},
        )
        provider = FakeProvider(
            name="stripe",
            verify=lambda _headers, _body: _event("stripe"),
            get_payment_impl=lambda _ref: intent,
        )
        grants: list[str] = []

        async def grant(payment, plan, subscription) -> None:
            grants.append(payment.id)

        handlers = default_handlers(
            policy=DEFAULT_POLICY, ledger=InMemoryLedger(), repo=repo, notifier=CollectingNotifier(),
            clock=clock, ids=SequentialIdGen("id-"), grant_link_payment=grant,
        )

        # When
        await handlers["payment.succeeded"](HandlerCtx(
            event=_event("stripe"), provider=provider, repo=repo, clock=clock, correlation_id="c-1",
        ))

        # Then
        held = await repo.operations.get("checkout-payment-held:payment:stripe:pi-canonical")
        assert held is not None and held.status == "done"
        assert len(await repo.payments.list()) == 1
        assert grants == []

    asyncio.run(run())
