"""Regression tests for redact() / Logger implementations.
spec: packages/core/spec/core.pseudo.md [EC:L1] [EC:L2] [EC:L5], docs/EDGE_CASES.md §L.

pytest-asyncio is not installed here: every async test wraps its body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from schift_payment_kit_core import (
    BaseLogger,
    CollectingLogger,
    ConsoleLogger,
    NoopLogger,
    redact,
)


def test_redacts_customer_identity_number() -> None:
    out = redact({"customerIdentityNumber": "900101-1234567", "ok": "fine"})
    assert out["customerIdentityNumber"] == "[redacted]"
    assert out["ok"] == "fine"


def test_masks_card_pan_first6_last4_wherever_it_appears() -> None:
    out = redact({"cardNumber": "4906251234123456"})
    assert (
        out["cardNumber"] == "[redacted]"
    )  # sensitive-key redaction wins over PAN masking
    nested = redact({"raw": {"some_other_field": "4906 2512 3412 3456"}})
    assert nested["raw"]["some_other_field"] == "490625******3456"


def test_masks_billing_key_instead_of_dropping_it() -> None:
    out = redact({"billingKey": "bk_abcdefgh12345678"})
    assert out["billingKey"] == "bk_a***********5678"
    assert out["billingKey"] != "bk_abcdefgh12345678"


def test_redacts_snake_case_and_differently_cased_keys_too() -> None:
    out = redact(
        {
            "customer_identity_number": "900101-1234567",
            "SECRET_KEY": "sk_live_xxx",
            "Authorization": "Bearer xxx",
        }
    )
    assert out["customer_identity_number"] == "[redacted]"
    assert out["SECRET_KEY"] == "[redacted]"
    assert out["Authorization"] == "[redacted]"


def test_recurses_into_nested_dicts_and_lists() -> None:
    out = redact({"items": [{"cardPassword": "12"}, {"apiKey": "k"}]})
    assert out["items"][0]["cardPassword"] == "[redacted]"
    assert out["items"][1]["apiKey"] == "[redacted]"


def test_leaves_non_sensitive_fields_datetimes_numbers_booleans_untouched() -> None:
    at = datetime(2026, 9, 9, tzinfo=UTC)
    out = redact(
        {"amount": 1000, "active": True, "at": at, "event": "provider.request"}
    )
    assert out["amount"] == 1000
    assert out["active"] is True
    assert out["at"] == at
    assert out["event"] == "provider.request"


def test_a_payload_with_identity_number_and_pan_together_comes_out_scrubbed() -> None:
    payload = {
        "cardNumber": "4906251234123456",
        "customerIdentityNumber": "900101-1234567",
        "customerName": "ok to keep",
    }
    out = redact(payload)
    assert out == {
        "cardNumber": "[redacted]",
        "customerIdentityNumber": "[redacted]",
        "customerName": "ok to keep",
    }


def test_noop_logger_does_nothing_and_never_raises() -> None:
    async def run() -> None:
        await NoopLogger().log(
            {"level": "error", "event": "x", "secretKey": "leak-if-broken"}
        )

    asyncio.run(run())


def test_collecting_logger_redacts_before_write_is_ever_called() -> None:
    async def run() -> None:
        logger = CollectingLogger()
        await logger.log(
            {
                "level": "info",
                "event": "provider.request",
                "cardNumber": "4906251234123456",
                "ok": 1,
            }
        )
        assert len(logger.entries) == 1
        assert logger.entries[0]["cardNumber"] == "[redacted]"
        assert logger.entries[0]["ok"] == 1
        assert isinstance(logger.entries[0]["at"], datetime)

    asyncio.run(run())


def test_collecting_logger_preserves_a_caller_supplied_at() -> None:
    async def run() -> None:
        logger = CollectingLogger()
        at = datetime(2020, 1, 1, tzinfo=UTC)
        await logger.log({"level": "info", "event": "x", "at": at})
        assert logger.entries[0]["at"] == at

    asyncio.run(run())


def test_a_subclass_cannot_bypass_redaction() -> None:
    seen: dict = {}

    class Spy(BaseLogger):
        async def write(self, entry: dict) -> None:
            seen.update(entry)

    async def run() -> None:
        await Spy().log({"level": "warn", "event": "x", "apiSecret": "super-secret"})

    asyncio.run(run())
    assert seen["apiSecret"] == "[redacted]"


def test_console_logger_redacts_before_printing(capsys) -> None:
    async def run() -> None:
        logger = ConsoleLogger()
        await logger.log({"level": "info", "event": "a", "secretKey": "leak-if-broken"})

    asyncio.run(run())
    captured = capsys.readouterr()
    assert "leak-if-broken" not in captured.out
    assert "[redacted]" in captured.out
