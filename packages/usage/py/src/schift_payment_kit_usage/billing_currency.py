"""Resolve settlement currency without inventing money units."""

import re

from schift_payment_kit_core import PaymentKitError, Repo


async def billing_currency(
    repo: Repo, plan_id: str, selected: str | None = None
) -> str:
    if selected is not None:
        if re.fullmatch(r"[A-Z]{3}", selected):
            return selected
        raise PaymentKitError(
            "Billing currency must be an uppercase ISO currency code",
            "billing_currency_required",
        )
    plan = await repo.plans.get(plan_id)
    currencies = {price.currency for price in plan.prices} if plan else set()
    if len(currencies) == 1:
        currency = next(iter(currencies))
        if re.fullmatch(r"[A-Z]{3}", currency):
            return currency
    raise PaymentKitError(
        "Select a billing currency when the plan has no unique currency",
        "billing_currency_required",
    )
