"""Immutable sale records held in reserved operation rows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from boilpayment_core import (
    Payment,
    PaymentKitError,
    Plan,
    PlanPrice,
    Policy,
    ProviderName,
    Repo,
    policy_from_dict,
)

JsonValue: TypeAlias = (
    str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
)


@dataclass(frozen=True, slots=True, kw_only=True)
class CheckoutSnapshot:
    intent_key: str
    checkout_id: str | None
    checkout_provider_ref: str | None
    customer_id: str
    customer_ref: str
    provider: ProviderName
    plan: Plan
    price: PlanPrice
    policy: Policy
    captured_at: str
    allow_discount_codes: bool = False
    preset_discount_code: str | None = None
    affiliate_id: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class PurchaseSnapshot(CheckoutSnapshot):
    payment_id: str
    payment_ref: str
    purchased_at: str
    subscription_id: str | None
    period: dict[str, str] | None


def _record(value: JsonValue) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise PaymentKitError(
            "purchase snapshot object missing", "purchase_snapshot_invalid"
        )
    return value


def _text(value: JsonValue) -> str:
    if not isinstance(value, str) or not value:
        raise PaymentKitError(
            "invalid purchase snapshot string", "purchase_snapshot_invalid"
        )
    return value


def _number(value: JsonValue) -> int:
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise PaymentKitError(
            "invalid purchase snapshot amount", "purchase_snapshot_invalid"
        )
    return value


def _provider(value: JsonValue) -> ProviderName:
    match value:
        case "stripe" | "polar" | "toss" | "portone" | "apple" | "google_play":
            return value
        case _:
            raise PaymentKitError(
                "invalid purchase provider", "purchase_snapshot_invalid"
            )


def _price(value: JsonValue) -> PlanPrice:
    row = _record(value)
    refs = row.get("provider_price_refs")
    provider_refs: dict[ProviderName, str] = {}
    if isinstance(refs, dict):
        provider_refs = {_provider(name): _text(ref) for name, ref in refs.items()}
    return PlanPrice(
        currency=_text(row["currency"]),
        amount_minor=_number(row["amount_minor"]),
        provider_price_refs=provider_refs,
    )


def parse_checkout_snapshot(value: JsonValue) -> CheckoutSnapshot:
    row = _record(value)
    plan = _record(row["plan"])
    prices = plan["prices"]
    if not isinstance(prices, list) or plan["interval"] not in (None, "month", "year"):
        raise PaymentKitError("invalid purchase plan", "purchase_snapshot_invalid")
    return CheckoutSnapshot(
        intent_key=_text(row["intent_key"]),
        checkout_id=_text(row["checkout_id"]) if row.get("checkout_id") else None,
        checkout_provider_ref=_text(row["checkout_provider_ref"])
        if row.get("checkout_provider_ref")
        else None,
        customer_id=_text(row["customer_id"]),
        customer_ref=_text(row["customer_ref"]),
        provider=_provider(row["provider"]),
        plan=Plan(
            id=_text(plan["id"]),
            name=_text(plan["name"]),
            interval=plan["interval"],
            credits_per_period=_number(plan["credits_per_period"]),
            usage_included=_number(plan["usage_included"]),
            trial_days=_number(plan["trial_days"]),
            prices=[_price(price) for price in prices],
        ),
        price=_price(row["price"]),
        policy=policy_from_dict(_record(row["policy"])),
        captured_at=_text(row["captured_at"]),
        allow_discount_codes=row.get("allow_discount_codes") is True,
        preset_discount_code=_text(row["preset_discount_code"])
        if row.get("preset_discount_code") is not None
        else None,
        affiliate_id=_text(row["affiliate_id"])
        if row.get("affiliate_id") is not None
        else None,
    )


def parse_purchase_snapshot(value: JsonValue) -> PurchaseSnapshot:
    checkout = parse_checkout_snapshot(value)
    row = _record(value)
    period = _record(row["period"]) if row.get("period") is not None else None
    return PurchaseSnapshot(
        intent_key=checkout.intent_key,
        checkout_id=checkout.checkout_id,
        checkout_provider_ref=checkout.checkout_provider_ref,
        customer_id=checkout.customer_id,
        customer_ref=checkout.customer_ref,
        provider=checkout.provider,
        plan=checkout.plan,
        price=checkout.price,
        policy=checkout.policy,
        captured_at=checkout.captured_at,
        allow_discount_codes=checkout.allow_discount_codes,
        preset_discount_code=checkout.preset_discount_code,
        affiliate_id=checkout.affiliate_id,
        payment_id=_text(row["payment_id"]),
        payment_ref=_text(row["payment_ref"]),
        purchased_at=_text(row["purchased_at"]),
        subscription_id=_text(row["subscription_id"])
        if row.get("subscription_id")
        else None,
        period={"start": _text(period["start"]), "end": _text(period["end"])}
        if period
        else None,
    )


async def get_purchase_snapshot(
    *, payment_id: str, repo: Repo
) -> PurchaseSnapshot | None:
    operation = await repo.operations.get(f"purchase-entitlement:{payment_id}")
    return (
        parse_purchase_snapshot(operation.result)
        if operation
        and operation.status == "done"
        and operation.kind == "purchase.entitlement"
        else None
    )


def matches_checkout_payment(
    snapshot: CheckoutSnapshot, raw: JsonValue, payment_ref: str
) -> bool:
    if snapshot.provider == "portone":
        return payment_ref == snapshot.checkout_id
    if not isinstance(raw, dict):
        return False
    if snapshot.provider == "toss":
        return raw.get("orderId") == snapshot.checkout_id
    metadata = raw.get("metadata")
    return (
        isinstance(metadata, dict)
        and metadata.get("checkoutEntitlementKey") == snapshot.intent_key
    ) or (
        snapshot.provider == "polar" and raw.get("checkout_id") == snapshot.checkout_id
    )


def matches_captured_sale_amount(snapshot: CheckoutSnapshot, payment: Payment) -> bool:
    """Accept list price, or a lower amount backed by provider discount arithmetic."""
    if snapshot.price.currency != payment.amount.currency or payment.amount.amount_minor < 0:
        return False
    if snapshot.price.amount_minor == payment.amount.amount_minor:
        return True
    evidence = payment.sale_evidence
    if (
        evidence is None
        or evidence.provider_subtotal.currency != snapshot.price.currency
        or evidence.discount_amount.currency != snapshot.price.currency
        or evidence.provider_subtotal.amount_minor != snapshot.price.amount_minor
        or evidence.discount_amount.amount_minor <= 0
        or evidence.provider_subtotal.amount_minor - evidence.discount_amount.amount_minor
        != payment.amount.amount_minor
    ):
        return False
    captured_price_ref = (snapshot.price.provider_price_refs or {}).get(snapshot.provider)
    return (
        not captured_price_ref
        or not evidence.price_ref
        or captured_price_ref == evidence.price_ref
    )
