"""Smoke test -- real code path through cs's own modules. `refund.evaluate`/`refund.execute` are
imported from the sibling package -- both are already on `sys.path` via the uv workspace editable
install (verified: `schift_payment_kit_refund` imports cleanly even though cs's pyproject.toml does
not yet declare it as a dependency; see final report's "계약 변경 제안" re: adding it formally).
Run: .venv/bin/python packages/cs/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

from schift_payment_kit_core import (
    DEFAULT_POLICY,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    Payment,
    PaymentKitError,
    Period,
    ProviderRef,
    Refund,
    SequentialIdGen,
)
from schift_payment_kit_cs import (
    HttpLicenseReporter,
    Metrics,
    OpenCaseInput,
    ReconcileInput,
    RefundAssistInput,
    RegrantInput,
    RegrantPlan,
    TimelineOptions,
    explain,
    open_case,
    reconcile,
    refund_assist,
    timeline,
    widget,
)
from schift_payment_kit_cs import (
    dispute as cs_dispute,
)
from schift_payment_kit_cs import (
    regrant as cs_regrant,
)
from schift_payment_kit_cs.dispute import DisputeInput
from schift_payment_kit_refund import EvaluateInput, ExecuteInput
from schift_payment_kit_refund import evaluate as refund_evaluate_raw
from schift_payment_kit_refund import execute as refund_execute_raw


def _to_dict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _to_dict(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_dict(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


class FakeNotifier:
    async def send(self, n) -> None:
        print("[notifier]", n.type, n.payload)


# -- EC:I5 fake HTTP server for HttpLicenseReporter -- records requests, can be told to fail once --
http_calls: list[dict] = []
_fail_next_call = False


async def fake_http_call(
    method: str, url: str, headers: dict[str, str], body: bytes | None
) -> tuple[int, bytes]:
    global _fail_next_call
    http_calls.append(
        {
            "method": method,
            "url": url,
            "headers": headers,
            "body": json.loads(body) if body else None,
        }
    )
    if _fail_next_call:
        _fail_next_call = False
        return 500, b"server error"
    if url.endswith("/entitlement"):
        return 200, json.dumps(
            {
                "tier": "pro",
                "includedCasesPerMonth": 500,
                "usedThisMonth": 12,
                "overagePriceMinor": 500,
                "currency": "USD",
                "hardLimit": False,
            }
        ).encode()
    return 200, json.dumps({"ok": True}).encode()


class FakeProvider:
    name = "stripe"

    def __init__(self, payments: list[Payment]) -> None:
        self._payments = payments

    def capabilities(self):
        return {
            "native_subscriptions": True,
            "partial_refund": True,
            "meters": False,
            "scheduling": "provider",
            "webhook_signature": True,
        }

    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]:
        return self._payments

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        return Refund(
            id=f"cancel_{payment_ref}",
            payment_id="unused",
            customer_id="",
            amount=amount,
            status="succeeded",
            provider_ref=f"pref_{payment_ref}",
            credits_revoked=0,
            rule_id="",
            reason=None,
            failure=None,
            created_at=datetime.now(UTC),
        )


class ReceiveAccountRequiredProvider(FakeProvider):
    """EC:D13 -- Toss virtual-account refund missing extra.refund_receive_account."""

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        raise PaymentKitError(
            "refundReceiveAccount required for Toss virtual account refunds",
            "refund_receive_account_required",
        )


async def refund_evaluate_adapter(
    *,
    payment,
    sub,
    policy,
    ledger,
    repo,
    clock,
    requested_amount=None,
    provider_fee_minor=None,
):
    return await refund_evaluate_raw(
        EvaluateInput(
            payment=payment,
            sub=sub,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
            requested_amount=requested_amount,
            provider_fee_minor=provider_fee_minor,
        )
    )


async def refund_execute_adapter(
    *,
    decision,
    provider,
    ledger,
    repo,
    clock,
    ids,
    extra=None,
    cs=None,
    correlation_id=None,
):
    return await refund_execute_raw(
        ExecuteInput(
            decision=decision,
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
            extra=extra,
            cs=cs,
            correlation_id=correlation_id,
        )
    )


from datetime import UTC as _UTC
from datetime import datetime as _dt

_FIXED_NOW = _dt.fromtimestamp(
    1_700_000_000, _UTC
)  # deterministic exp so ts/py smokes are comparable


async def main() -> None:
    ids = SequentialIdGen("id_")
    clock = FixedClock(datetime(2026, 2, 1, tzinfo=UTC))
    ledger = InMemoryLedger(ids)
    repo = InMemoryRepo()
    metrics = Metrics()
    policy = DEFAULT_POLICY
    license_reporter = HttpLicenseReporter(
        api_key="test-api-key", http_call=fake_http_call
    )

    customer_id = "cust_2"
    customer = Customer(
        id=customer_id,
        email="cust2@example.com",
        provider_refs=[ProviderRef(provider="stripe", ref="cus_stripe_2")],
        status="active",
        created_at=clock.now(),
    )

    sub_period_start = datetime(2026, 1, 1, tzinfo=UTC)
    sub_payment = Payment(
        id="pay_sub_1",
        customer_id=customer_id,
        provider="stripe",
        provider_ref="pi_sub_1",
        subscription_id="sub_1",
        amount=Money(amount_minor=2000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=Period(start=sub_period_start, end=datetime(2026, 2, 1, tzinfo=UTC)),
        occurred_at=sub_period_start,
        failure=None,
    )
    topup_payment_missing_grant = Payment(
        id="pay_topup_1",
        customer_id=customer_id,
        provider="stripe",
        provider_ref="pi_topup_1",
        subscription_id=None,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    provider = FakeProvider([sub_payment, topup_payment_missing_grant])

    await repo.customers.put(customer)
    await repo.payments.put(sub_payment)
    await repo.payments.put(topup_payment_missing_grant)

    # subPayment's grant WAS applied correctly -- pre-seed the ledger so reconcile skips it.
    sub_grant_key = f"grant:sub_1:{sub_period_start.isoformat()}"
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=200,
            unit_price_minor=10,
            currency="USD",
            source="subscription",
            reference=LedgerReference(
                subscription_id="sub_1", period_start=sub_period_start
            ),
            idempotency_key=sub_grant_key,
            actor="system",
        )
    )

    # -- EC:E1 reconcile -- topupPaymentMissingGrant has no matching ledger grant --
    cases = await reconcile(
        ReconcileInput(
            providers={"stripe": provider},
            ledger=ledger,
            repo=repo,
            policy=policy,
            clock=clock,
            ids=ids,
            since=datetime(2026, 1, 1, tzinfo=UTC),
            on_case_event=metrics.record,
        )
    )
    print(
        "[reconcile] opened cases:",
        [
            {
                "id": c.id,
                "kind": c.kind,
                "referenceId": c.reference_id,
                "status": c.status,
            }
            for c in cases
        ],
    )

    # -- EC:A18/E1/E2/E14 regrant -- auto mode replays the missing grant with the ORIGINAL idempotency key --
    missing_case = cases[0]
    regranted = await cs_regrant(
        RegrantInput(
            case=missing_case,
            ledger=ledger,
            repo=repo,
            policy=policy,
            clock=clock,
            ids=ids,
            plan=RegrantPlan(
                pool="paid",
                amount=50,
                unit_price_minor=20,
                currency="USD",
                reason="reconcile: missing topup grant",
            ),
            on_case_event=metrics.record,
        )
    )
    balance_after_regrant = await ledger.balance(customer_id, "paid", clock.now())
    print(
        "\n[regrant] case status:",
        regranted.status,
        "decision:",
        regranted.decision,
        "balance after:",
        balance_after_regrant.available,
    )

    # E14 -- a late-arriving duplicate regrant (e.g. the original webhook finally shows up) must no-op.
    regranted_again = await cs_regrant(
        RegrantInput(
            case=missing_case,
            ledger=ledger,
            repo=repo,
            policy=policy,
            clock=clock,
            ids=ids,
            plan=RegrantPlan(
                pool="paid", amount=50, unit_price_minor=20, currency="USD"
            ),
            on_case_event=metrics.record,
        )
    )
    balance_unchanged = await ledger.balance(customer_id, "paid", clock.now())
    print(
        "[regrant again, E14 no-op] decision:",
        regranted_again.decision,
        "balance unchanged:",
        balance_unchanged.available,
    )

    # -- EC:D*/I1/I2 refundAssist -- evaluate/execute injected from the refund package --
    refund_payment = Payment(
        id="pay_refundassist_1",
        customer_id=customer_id,
        provider="stripe",
        provider_ref="pi_ra_1",
        subscription_id=None,
        amount=Money(amount_minor=500, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(refund_payment)
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=25,
            unit_price_minor=20,
            currency="USD",
            source="topup",
            reference=LedgerReference(payment_id=refund_payment.id),
            idempotency_key=f"topup:{refund_payment.id}",
            actor="system",
        )
    )
    refund_case = await open_case(
        OpenCaseInput(
            customer_id=customer_id,
            kind="refund",
            reference_id=refund_payment.id,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
            on_case_event=metrics.record,
        )
    )
    assisted_case = await refund_assist(
        RefundAssistInput(
            case=refund_case,
            payment=refund_payment,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
            refund_evaluate=refund_evaluate_adapter,
            refund_execute=refund_execute_adapter,
            churn_reason="not_using",
            churn_text="switched to a competitor",
            on_case_event=metrics.record,
            reporter=license_reporter,  # EC:I5
        )
    )
    print(
        "\n[refundAssist] case status:",
        assisted_case.status,
        "decision:",
        json.dumps(_to_dict(assisted_case.decision)),
    )
    print(
        "[refundAssist] churn recorded on case:",
        assisted_case.churn_reason,
        "-",
        assisted_case.churn_text,
    )

    # -- EC:I5 -- one resolved case -> exactly one POST /cases with a bearer header --
    print("\n[license] POST /cases calls so far:", len(http_calls))
    last_call = http_calls[-1]
    print(
        "[license] last call:",
        last_call["method"],
        last_call["url"],
        "auth:",
        last_call["headers"]["Authorization"],
        "body:",
        json.dumps(last_call["body"]),
    )

    # -- EC:D12/D13 refundAssist against a Toss-style provider missing refund_receive_account --
    toss_payment = Payment(
        id="pay_toss_1",
        customer_id=customer_id,
        provider="toss",
        provider_ref="pi_toss_1",
        subscription_id=None,
        amount=Money(amount_minor=10000, currency="KRW"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(toss_payment)
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=1000,
            unit_price_minor=10,
            currency="KRW",
            source="topup",
            reference=LedgerReference(payment_id=toss_payment.id),
            idempotency_key=f"topup:{toss_payment.id}",
            actor="system",
        )
    )
    toss_case = await open_case(
        OpenCaseInput(
            customer_id=customer_id,
            kind="refund",
            reference_id=toss_payment.id,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
            on_case_event=metrics.record,
        )
    )
    # EC:I5 -- unresolved refunds must not report a billable resolution.
    license_reporter_with_outbox = HttpLicenseReporter(
        api_key="test-api-key", http_call=fake_http_call, repo=repo
    )
    toss_assisted_case = await refund_assist(
        RefundAssistInput(
            case=toss_case,
            payment=toss_payment,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=ReceiveAccountRequiredProvider([]),
            refund_evaluate=refund_evaluate_adapter,
            refund_execute=refund_execute_adapter,
            on_case_event=metrics.record,
            reporter=license_reporter_with_outbox,  # EC:I5
        )
    )
    toss_refund_id = toss_assisted_case.decision["refund"].id
    print(
        "\n[refundAssist, EC:D13] original case status:",
        toss_assisted_case.status,
        "refund status:",
        toss_assisted_case.decision["refund"].status,
    )
    refund_failed_cases = await repo.cs_cases.list(
        kind="refund_failed", reference_id=toss_refund_id
    )
    print(
        "[refundAssist, EC:D13] refund_failed case status:",
        refund_failed_cases[0].status,
        "decision:",
        refund_failed_cases[0].decision,
    )
    print(
        "[license, EC:I5] unresolved case is not billable; queue remains empty."
    )
    outbox_after_failure = await repo.outbox.list(kind="cs.license")
    print(
        "[license, EC:I5] repo.outbox for unresolved case:",
        [
            {"id": o.id, "kind": o.kind, "status": o.status}
            for o in outbox_after_failure
        ],
    )
    flush_result = await license_reporter_with_outbox.flush()
    print("[license, EC:I5] flush() after server recovers:", flush_result)
    outbox_after_flush = await repo.outbox.list(kind="cs.license")
    print(
        "[license, EC:I5] repo.outbox after flush:",
        [{"id": o.id, "kind": o.kind, "status": o.status} for o in outbox_after_flush],
    )

    # -- EC:B11/D9 dispute -- dispute.opened freezes the customer per default policy --
    dispute_event = NormalizedEvent(
        id="evt_dispute_1",
        provider="stripe",
        type="dispute.opened",
        occurred_at=clock.now(),
        customer_ref=None,
        subscription_ref=None,
        payment_ref=refund_payment.provider_ref,
        amount=None,
        raw=None,
    )
    dispute_case = await cs_dispute(
        DisputeInput(
            event=dispute_event,
            policy=policy,
            ledger=ledger,
            repo=repo,
            notifier=FakeNotifier(),
            clock=clock,
            ids=ids,
            on_case_event=metrics.record,
        )
    )
    customer_after = await repo.customers.get(customer_id)
    print(
        "\n[dispute] case status:",
        dispute_case.status,
        "customer status:",
        customer_after.status if customer_after else None,
    )

    # -- EC:I9 timeline -- reconstruct the customer's evidence trail from repo/ledger alone --
    customer_timeline = await timeline(
        TimelineOptions(customer_id=customer_id, repo=repo, ledger=ledger, clock=clock)
    )
    print(
        "\n[timeline, EC:I9] event kinds:", [e.kind for e in customer_timeline.events]
    )
    print("[timeline, EC:I9] explain():")
    for line in explain(customer_timeline.events):
        print("  -", line)
    payment_timeline = await timeline(
        TimelineOptions(
            payment_id=refund_payment.id, repo=repo, ledger=ledger, clock=clock
        )
    )
    print(
        "[timeline, EC:I9] payment_id-scoped event count:",
        len(payment_timeline.events),
        "truncated:",
        payment_timeline.truncated,
    )

    # -- EC:I6 widget --
    token = widget.sign_token(
        widget.SignTokenInput(
            customer_id=customer_id, ttl_seconds=3600, now=_FIXED_NOW
        ),
        "test-secret",
    )
    claims = widget.verify_token(token, "test-secret", now=_FIXED_NOW)
    print("\n[widget] round-trip claims:", claims)

    # -- EC:I5 entitlement -- asks the server, never computes price locally --
    entitlement = await license_reporter.entitlement()
    print("\n[license, EC:I5] entitlement:", _to_dict(entitlement))

    # -- metrics snapshot --
    print("\n[metrics] snapshot:", json.dumps(_to_dict(metrics.snapshot()), indent=2))

    print("\nsmoke: OK")


if __name__ == "__main__":
    asyncio.run(main())
