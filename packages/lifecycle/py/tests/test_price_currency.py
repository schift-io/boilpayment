"""[EC:A33] price ref in the subscription currency (mirrors the TS test)."""
from __future__ import annotations

import pytest
from boilpayment_core import PaymentKitError, Plan, PlanPrice
from boilpayment_lifecycle.internal import resolve_price_ref

PLAN = Plan(id="pro", name="Pro", interval="month", credits_per_period=100, usage_included=0, trial_days=0,
            prices=[PlanPrice(currency="KRW", amount_minor=13000, provider_price_refs={"stripe": "price_krw"})])


def test_ec_a33_other_currency_refused() -> None:
    with pytest.raises(PaymentKitError) as err:
        resolve_price_ref(PLAN, "stripe", "USD")
    assert err.value.code == "plan_price_missing"


def test_ec_a33_same_currency_and_no_currency() -> None:
    assert (resolve_price_ref(PLAN, "stripe", "KRW"), resolve_price_ref(PLAN, "stripe", None)) == ("price_krw", "price_krw")
