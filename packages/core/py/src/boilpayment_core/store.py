"""EC:N1-N15 -- in-app purchase stores (Apple App Store, Google Play).

Mirrors packages/core/ts/src/store.ts. The purchase happens on the device; the app sends the
store's proof to the server; a store provider verifies it with the store and returns the facts
below. cs.register_store_purchase records and grants.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

from .money import ZERO_DECIMAL_CURRENCIES
from .types import Payment, Subscription

StoreProviderName = Literal["apple", "google_play"]
STORE_PROVIDERS: tuple[str, ...] = ("apple", "google_play")
StoreEnvironment = Literal["production", "sandbox"]


@dataclass(kw_only=True, slots=True)
class StoreProof:
    """Apple: StoreKit 2 jwsRepresentation. Google: purchase_token + product_id (+ subscription)."""

    signed_transaction: str | None = None
    purchase_token: str | None = None
    product_id: str | None = None
    subscription: bool | None = None


@dataclass(kw_only=True, slots=True)
class VerifiedStorePurchase:
    payment: Payment  # customer_id "" (stores have no customer object)
    amount_from_store: bool  # False: the store did not report a price (EC:N11)
    subscription_ref: str | None
    subscription: Subscription | None
    product_id: str
    account_token: str | None  # appAccountToken / obfuscatedExternalAccountId
    environment: StoreEnvironment
    ownership: Literal["purchased", "family_shared"]
    acknowledged: bool  # Google acknowledgement state; Apple reports True
    # EC:N9 -- Google linkedPurchaseToken: this purchase replaces that subscription.
    replaces_subscription_ref: str | None = None


@runtime_checkable
class StorePurchaseProvider(Protocol):
    async def verify_purchase(self, proof: StoreProof) -> VerifiedStorePurchase: ...


def is_store_purchase_provider(provider: object) -> bool:
    return callable(getattr(provider, "verify_purchase", None))


@dataclass(kw_only=True, slots=True)
class IapSettings:
    """Stored under `iap` in paykit.config.json (outside `policy`)."""

    environments: Literal["production_and_sandbox", "production_only"] = (
        "production_and_sandbox"  # EC:N3
    )
    account_link: Literal["require", "allow_first_claim"] = "require"  # EC:N4
    family_sharing: Literal["grant", "ignore"] = "grant"  # EC:N5
    # EC:N12 -- store commission per store as a fraction. No default: entered by the developer.
    store_fee_rate: dict[str, float] = field(default_factory=dict)


def iap_settings_from_dict(value: dict | None) -> IapSettings:
    v = value or {}
    return IapSettings(
        environments=v.get("environments", "production_and_sandbox"),
        account_link=v.get("accountLink", v.get("account_link", "require")),
        family_sharing=v.get("familySharing", v.get("family_sharing", "grant")),
        store_fee_rate=dict(v.get("storeFeeRate", v.get("store_fee_rate", {})) or {}),
    )


# Fixed namespace for account tokens. Changing it would unlink every existing purchase.
STORE_ACCOUNT_TOKEN_NAMESPACE = "91f7798e-f5e9-43a3-b1cf-d06287c59c87"


def store_account_token(customer_id: str) -> str:
    """EC:N4 -- UUIDv5 of the customer id, passed by the app as appAccountToken / obfuscatedAccountId."""
    return str(uuid.uuid5(uuid.UUID(STORE_ACCOUNT_TOKEN_NAMESPACE), customer_id))


def _exp(currency: str) -> int:
    return 0 if currency.upper() in ZERO_DECIMAL_CURRENCIES else 2


def _round_half_up(x: float) -> int:
    # Same as JS Math.round (Python's round() is half-to-even and would drift from the TS twin).
    return math.floor(x + 0.5)


def minor_units_from_decimal(units: int, nanos: int, currency: str) -> int:
    e = _exp(currency)
    return _round_half_up(units * 10**e + nanos / 10 ** (9 - e))


def minor_units_from_milliunits(milliunits: int, currency: str) -> int:
    return _round_half_up(milliunits * 10 ** _exp(currency) / 1000)
