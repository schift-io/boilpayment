"""EC:H5 -- GDPR/개인정보보호법 data export. Mirrors packages/cs/ts/test/exportCustomer.test.ts (same
cases). See docs/EDGE_CASES.md H5, packages/cs/spec/cs.pseudo.md [EC:H5].

pytest-asyncio is not installed in this workspace -- every test wraps its async body with
asyncio.run(...) inside a plain `def test_...():`, per packages/core/py/tests/test_ledger.py.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from boilpayment_core import (
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    ProviderRef,
    Refund,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_cs import (
    ExportCustomerInput,
    OpenCaseInput,
    export_customer,
    open_case,
)


def run(coro):
    return asyncio.run(coro)


CUSTOMER_ID = "cust_exp"


def _clock() -> FixedClock:
    return FixedClock(datetime(2026, 1, 1, tzinfo=UTC))


async def _seed(repo: InMemoryRepo, ledger: InMemoryLedger, clock: FixedClock, ids):
    customer = Customer(
        id=CUSTOMER_ID,
        email=f"{CUSTOMER_ID}@x.com",
        provider_refs=[ProviderRef(provider="stripe", ref="cus_exp")],
        status="active",
        created_at=clock.now(),
    )
    await repo.customers.put(customer)

    payment = Payment(
        id="pay_exp",
        customer_id=CUSTOMER_ID,
        provider="stripe",
        provider_ref="pi_exp",
        subscription_id=None,
        amount=Money(amount_minor=5000, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
        cash_receipt=None,
        raw={
            "customer_identity_number": "901231-1234567",
            "card_number": "4242424242424242",
        },
    )
    await repo.payments.put(payment)

    await ledger.append(
        NewLedgerEntry(
            customer_id=CUSTOMER_ID,
            pool="paid",
            kind="grant",
            amount=100,
            unit_price_minor=50,
            currency="USD",
            source="topup",
            reference=LedgerReference(payment_id=payment.id),
            idempotency_key=f"topup:{payment.id}",
            actor="system",
        )
    )

    await repo.refunds.put(
        Refund(
            id="ref_exp",
            payment_id=payment.id,
            customer_id=CUSTOMER_ID,
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            provider_ref="re_exp",
            credits_revoked=20,
            rule_id="D1",
            reason="no questions asked",
            failure=None,
            created_at=clock.now(),
        )
    )

    policy = resolve_policy({})
    await open_case(
        OpenCaseInput(
            customer_id=CUSTOMER_ID,
            kind="refund",
            reference_id=payment.id,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )
    return customer, payment


def test_h5_contains_every_section_and_is_json_round_trippable():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        await _seed(repo, ledger, clock, ids)

        result = await export_customer(
            ExportCustomerInput(
                customer_id=CUSTOMER_ID, repo=repo, ledger=ledger, clock=clock
            )
        )

        assert result["schema_version"] == 1
        assert isinstance(result["generated_at"], str)
        assert result["customer_id"] == CUSTOMER_ID
        assert result["customer"] is not None
        assert len(result["payments"]) == 1
        assert len(result["ledger_entries"]) == 1
        assert len(result["refunds"]) == 1
        assert len(result["cs_cases"]) == 1
        assert result["usage_events"] == []
        assert result["subscriptions"] == []
        assert len(result["timeline"]["events"]) > 0

        round_tripped = json.loads(json.dumps(result))
        assert round_tripped == result

    run(go())


def test_h5_redacts_pii_by_default():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        await _seed(repo, ledger, clock, ids)

        result = await export_customer(
            ExportCustomerInput(
                customer_id=CUSTOMER_ID, repo=repo, ledger=ledger, clock=clock
            )
        )
        assert result["redacted"] is True
        raw = result["payments"][0]["raw"]
        assert raw["customer_identity_number"] == "[redacted]"
        assert raw["card_number"] == "[redacted]"

    run(go())


def test_h5_does_not_redact_when_redact_false():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        await _seed(repo, ledger, clock, ids)

        result = await export_customer(
            ExportCustomerInput(
                customer_id=CUSTOMER_ID,
                repo=repo,
                ledger=ledger,
                clock=clock,
                redact=False,
            )
        )
        assert result["redacted"] is False
        raw = result["payments"][0]["raw"]
        assert raw["customer_identity_number"] == "901231-1234567"
        assert raw["card_number"] == "4242424242424242"

    run(go())
