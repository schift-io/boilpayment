"""Shared PaymentProvider fakes for lifecycle regression tests. Implement the full PaymentProvider
protocol; every method not exercised by a given scenario raises loudly instead of silently
succeeding, so a regression that starts calling an unexpected provider method fails the test.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from boilpayment_core import (
    Checkout,
    Money,
    NormalizedEvent,
    Payment,
    PaymentFailure,
    PaymentKitError,
    ProviderCapabilities,
    Refund,
    Subscription,
)


def _unexpected(name: str) -> Any:
    raise RuntimeError(f"unexpected call: {name} (not wired for this test)")


class FakeNativeProvider:
    """Native-subscription provider (Stripe-shaped): change_subscription/cancel_subscription succeed."""

    name = "stripe"

    def __init__(self) -> None:
        self.change_subscription_called = 0
        self.cancel_subscription_called = 0
        self._dummy_sub: Subscription | None = None

    def set_dummy_sub(self, sub: Subscription) -> None:
        self._dummy_sub = sub

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_customer(self, **kwargs: Any) -> dict[str, str]:
        return {"ref": "cus_fake"}

    async def create_checkout(self, **kwargs: Any) -> Checkout:
        return _unexpected("create_checkout")

    async def get_payment(self, provider_ref: str) -> Payment:
        return _unexpected("get_payment")

    async def list_payments(self, **kwargs: Any) -> list[Payment]:
        return []

    async def get_subscription(self, provider_ref: str) -> Subscription:
        return _unexpected("get_subscription")

    async def change_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        self.change_subscription_called += 1
        if self._dummy_sub is None:
            return _unexpected("change_subscription (no dummy_sub set)")
        return self._dummy_sub

    async def cancel_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        self.cancel_subscription_called += 1
        if self._dummy_sub is None:
            return _unexpected("cancel_subscription (no dummy_sub set)")
        return self._dummy_sub

    # Controls the outcome of the next uncancel_subscription() call — set to a PaymentKitError to
    # simulate e.g. 'unsupported' (adapter gap) or 'not_reactivatable' (Stripe already-canceled).
    uncancel_subscription_called: int = 0
    next_uncancel_throws: PaymentKitError | None = None

    async def uncancel_subscription(self, provider_ref: str) -> Subscription:
        self.uncancel_subscription_called += 1
        if self.next_uncancel_throws is not None:
            raise self.next_uncancel_throws
        if self._dummy_sub is None:
            return _unexpected("uncancel_subscription (no dummy_sub set)")
        return self._dummy_sub

    async def charge_billing_key(self, **kwargs: Any) -> Payment:
        return _unexpected("charge_billing_key")

    async def refund(self, **kwargs: Any) -> Refund:
        return _unexpected("refund")

    async def report_usage(self, **kwargs: Any) -> None:
        return None

    async def verify_webhook(self, **kwargs: Any) -> NormalizedEvent:
        return _unexpected("verify_webhook")


class FakeCorrelatingProvider:
    """EC:L5 — native provider that also implements the duck-typed with_correlation_id, logging
    every subscription-mutating call it receives into a Logger so tests can assert the
    correlation_id a scoped clone was given actually reaches the call site. Mirrors the real
    providers' with_correlation_id pattern (see each provider package's __init__.py)."""

    name = "stripe"

    def __init__(self, logger: Any, correlation_id: str | None = None) -> None:
        self._logger = logger
        self._correlation_id = correlation_id
        self._dummy_sub: Subscription | None = None

    def set_dummy_sub(self, sub: Subscription) -> None:
        self._dummy_sub = sub

    def with_correlation_id(self, correlation_id: str) -> FakeCorrelatingProvider:
        clone = FakeCorrelatingProvider(self._logger, correlation_id)
        clone._dummy_sub = self._dummy_sub
        return clone

    async def _log_call(self, event: str) -> None:
        await self._logger.log(
            {"level": "info", "event": event, "correlationId": self._correlation_id}
        )

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_customer(self, **kwargs: Any) -> dict[str, str]:
        return {"ref": "cus_fake"}

    async def create_checkout(self, **kwargs: Any) -> Checkout:
        return _unexpected("create_checkout")

    async def get_payment(self, provider_ref: str) -> Payment:
        return _unexpected("get_payment")

    async def list_payments(self, **kwargs: Any) -> list[Payment]:
        return []

    async def get_subscription(self, provider_ref: str) -> Subscription:
        return _unexpected("get_subscription")

    async def change_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        await self._log_call("provider.request")
        if self._dummy_sub is None:
            return _unexpected("change_subscription (no dummy_sub set)")
        return self._dummy_sub

    async def cancel_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        await self._log_call("provider.request")
        if self._dummy_sub is None:
            return _unexpected("cancel_subscription (no dummy_sub set)")
        return self._dummy_sub

    async def uncancel_subscription(self, provider_ref: str) -> Subscription:
        await self._log_call("provider.request")
        if self._dummy_sub is None:
            return _unexpected("uncancel_subscription (no dummy_sub set)")
        return self._dummy_sub

    async def charge_billing_key(self, **kwargs: Any) -> Payment:
        return _unexpected("charge_billing_key")

    async def refund(self, **kwargs: Any) -> Refund:
        return _unexpected("refund")

    async def report_usage(self, **kwargs: Any) -> None:
        return None

    async def verify_webhook(self, **kwargs: Any) -> NormalizedEvent:
        return _unexpected("verify_webhook")


class FakeSelfSchedulingProvider:
    """Self-scheduling provider (Toss/PortOne-shaped): no native subscription tracking.
    get_subscription/change_subscription/cancel_subscription raise PaymentKitError('unsupported')
    exactly like the real Toss/PortOne provider implementations.
    """

    name = "toss"

    def __init__(self) -> None:
        self.last_charge: dict[str, Any] | None = None
        self.next_charge_status: str = "succeeded"
        self.next_charge_throws = False
        self.next_charge_http_error: int | None = None
        self.order_ids: list[str] = []
        # Idempotency like Toss: a repeated Idempotency-Key replays the stored answer.
        self._answers: dict[str, Payment] = {}
        self.money_moved: set[str] = set()

    def settle(self, idempotency_key: str, status: str) -> None:
        """Test hook: the provider later settles an earlier answer (e.g. pending -> succeeded)."""
        import dataclasses
        prev = self._answers.get(idempotency_key)
        if prev is not None:
            self._answers[idempotency_key] = dataclasses.replace(prev, status=status)
        if status == "succeeded":
            self.money_moved.add(idempotency_key)

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=False,
            partial_refund=True,
            meters=False,
            scheduling="self",
            webhook_signature=False,
        )

    async def create_customer(self, **kwargs: Any) -> dict[str, str]:
        return {"ref": "cus_toss_fake"}

    async def create_checkout(self, **kwargs: Any) -> Checkout:
        return _unexpected("create_checkout")

    async def get_payment(self, provider_ref: str) -> Payment:
        return _unexpected("get_payment")

    async def list_payments(self, **kwargs: Any) -> list[Payment]:
        return []

    async def get_subscription(self, provider_ref: str) -> Subscription:
        raise PaymentKitError("unsupported", "unsupported")

    async def change_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        raise PaymentKitError("unsupported", "unsupported")

    async def cancel_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        raise PaymentKitError("unsupported", "unsupported")

    async def uncancel_subscription(self, provider_ref: str) -> Subscription:
        raise PaymentKitError("unsupported", "unsupported")

    async def charge_billing_key(self, **kwargs: Any) -> Payment:
        amount: Money = kwargs["amount"]
        self.last_charge = {
            "amount_minor": amount.amount_minor,
            "currency": amount.currency,
            "idempotency_key": kwargs["idempotency_key"],
        }
        self.order_ids.append(kwargs["order_id"])
        if self.next_charge_throws:
            raise RuntimeError("provider unavailable")
        if self.next_charge_http_error is not None:
            from boilpayment_core import PaymentFailure, ProviderError
            status = self.next_charge_http_error
            raise ProviderError(f"toss api error ({status})", PaymentFailure(
                code="provider_unavailable" if status >= 500 else "card_declined", provider_code=None,
                retryable=status >= 500, user_message="x"), {}, http_status=status)
        key = kwargs["idempotency_key"]
        if key in self._answers:
            return self._answers[key]
        answer = self._answer_for(kwargs, amount)
        self._answers[key] = answer
        if answer.status == "succeeded":
            self.money_moved.add(key)
        return answer

    # EC:A38 -- lookups by orderId (never charges); lookup_throws simulates an unreachable provider.
    lookups: list[str]
    lookup_throws: bool = False

    async def get_payment_by_order_id(self, order_id: str) -> Payment | None:
        if not hasattr(self, "lookups"):
            self.lookups = []
        self.lookups.append(order_id)
        if self.lookup_throws:
            raise RuntimeError("provider unavailable")
        return next((a for a in self._answers.values() if a.provider_ref == order_id), None)

    def seed_order(self, order_id: str, status: str, amount_minor: int = 5000) -> None:
        """Test hook: an order an earlier release charged (its orderId was the key itself)."""
        import dataclasses
        base = self._answer_for({"idempotency_key": order_id, "customer_ref": "c1", "order_id": order_id},
                                Money(amount_minor=amount_minor, currency="KRW"))
        self._answers[order_id] = dataclasses.replace(base, status=status)
        if status == "succeeded":
            self.money_moved.add(order_id)

    def _answer_for(self, kwargs: dict[str, Any], amount: Money) -> Payment:
        return Payment(
            id=f"pay_{kwargs['idempotency_key']}",
            customer_id=kwargs["customer_ref"],
            provider="toss",
            provider_ref=kwargs["order_id"],
            subscription_id=None,
            amount=amount,
            status=self.next_charge_status,
            kind="subscription",
            period=None,
            occurred_at=datetime.now(UTC),
            failure=PaymentFailure(
                code="card_declined",
                provider_code=None,
                retryable=True,
                user_message="declined",
            )
            if self.next_charge_status == "failed"
            else None,
        )

    async def refund(self, **kwargs: Any) -> Refund:
        return _unexpected("refund")

    async def report_usage(self, **kwargs: Any) -> None:
        return None

    async def verify_webhook(self, **kwargs: Any) -> NormalizedEvent:
        return _unexpected("verify_webhook")
