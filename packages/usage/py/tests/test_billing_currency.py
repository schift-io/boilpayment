"""Billing currency resolution must never choose an arbitrary price."""

import anyio
import pytest
from boilpayment_core import InMemoryRepo, PaymentKitError, Plan, PlanPrice
from boilpayment_usage.billing_currency import billing_currency


@pytest.mark.parametrize("currencies", [("KRW",), ("USD", "KRW"), ()])
def test_currency_requires_unique_plan_price(currencies: tuple[str, ...]) -> None:
    async def run() -> None:
        # Given a plan's configured currencies.
        repo = InMemoryRepo()
        await repo.plans.put(
            Plan(
                id="plan",
                name="Pro",
                interval="month",
                credits_per_period=0,
                usage_included=0,
                trial_days=0,
                prices=[
                    PlanPrice(currency=currency, amount_minor=1000)
                    for currency in currencies
                ],
            )
        )
        # When resolved, then ambiguous or missing currencies require selection.
        if len(currencies) == 1:
            assert await billing_currency(repo, "plan") == "KRW"
        else:
            with pytest.raises(PaymentKitError) as error:
                await billing_currency(repo, "plan")
            assert error.value.code == "billing_currency_required"

    anyio.run(run)


def test_explicit_billing_currency_preserves_selection() -> None:
    async def run() -> None:
        # Given an explicit checkout selection, when resolved, then preserve it.
        assert await billing_currency(InMemoryRepo(), "plan", "KRW") == "KRW"

    anyio.run(run)
