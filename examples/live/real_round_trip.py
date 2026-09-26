"""paykit live — Python parity.

Env-driven REAL round trip against the actual provider test/sandbox environments
(api.stripe.com / api.tosspayments.com / api.portone.io / (sandbox-)api.polar.sh), using the
same paykit.config.json + .env a generated project would have. This is NOT
tools/mocks/* (that's CI regression, no network) — see tools/mocks/README.md and docs/PUBLIC_SANDBOX_VERIFICATION.md.

Mirrors apps/cli/src/commands/live.ts step-for-step so TS and Python users get the same proof.
No mocks anywhere in this file.

Usage:
  .venv/bin/python examples/live/real_round_trip.py --out <project-dir> [--config FILE] [--env FILE] [--dry-run]

Prints `PASS/FAIL/SKIP  <provider> <step>  <detail>` per step (never prints secret values) and
exits 1 if any step FAILed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

from schift_payment_kit_core import (
    CreateCheckoutInput,
    InMemoryRepo,
    Money,
    PaymentKitError,
    Plan,
    PlanPrice,
    ProviderError,
    SystemClock,
)
from schift_payment_kit_polar import PolarProvider
from schift_payment_kit_portone import PortoneProvider, PortoneProviderConfig
from schift_payment_kit_stripe import StripeProvider
from schift_payment_kit_toss import TossProvider, TossProviderConfig
from schift_payment_kit_webhook import process as process_webhook
from schift_payment_kit_webhook import receive as receive_webhook

REQUIRED_ENV: dict[str, list[str]] = {
    "stripe": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    "toss": ["TOSS_SECRET_KEY"],
    "portone": ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_WEBHOOK_SECRET"],
    "polar": ["POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET"],
}

_SECRETS: list[str] = []


def register_secret(value: str | None) -> None:
    if value and len(value) >= 6:
        _SECRETS.append(value)


def redact(text: str) -> str:
    out = text
    for s in _SECRETS:
        out = out.replace(s, "***REDACTED***")
    return " ".join(out.split())


_RESULTS: list[dict[str, str]] = []


def record(status: str, provider: str, step: str, detail: str) -> None:
    safe = redact(detail)
    _RESULTS.append(
        {"status": status, "provider": provider, "step": step, "detail": safe}
    )
    print(f"{status:<4}  {provider:<8} {step:<28}  {safe}")


def err_detail(err: Exception) -> str:
    parts = [str(err)]
    if isinstance(err, ProviderError):
        if err.failure.provider_code:
            parts.append(f"providerCode={err.failure.provider_code}")
    if isinstance(err, PaymentKitError):
        parts.append(f"code={err.code}")
    return " | ".join(parts)


def idem(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4()}"


# ── minimal .env parser — no dotenv dependency (ARCHITECTURE.md "pnpm add/uv sync 금지" spirit
#    applies equally to not adding new deps for this) ──────────────────────────────────────────
def parse_env_file(content: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = (
                value[1:-1]
                .replace("\\n", "\n")
                .replace('\\"', '"')
                .replace("\\\\", "\\")
            )
        elif len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        else:
            hash_idx = value.find(" #")
            if hash_idx != -1:
                value = value[:hash_idx].strip()
        out[key] = value
    return out


def load_env_file(file_path: Path) -> tuple[dict[str, str], bool]:
    file_vars: dict[str, str] = {}
    found = False
    if file_path.exists():
        file_vars = parse_env_file(file_path.read_text(encoding="utf-8"))
        found = True
    merged = dict(file_vars)
    for k, v in os.environ.items():
        if v:
            merged[k] = v
    return merged, found


def missing_env(provider: str, env: dict[str, str]) -> list[str]:
    return [k for k in REQUIRED_ENV[provider] if not env.get(k, "").strip()]


def first_plan_and_price(
    config: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    plans = config.get("plans") or []
    if not plans:
        return None
    plan = plans[0]
    prices = plan.get("prices") or []
    if not prices:
        return None
    return plan, prices[0]


def plan_from_dict(p: dict[str, Any]) -> Plan:
    return Plan(
        id=p["id"],
        name=p["name"],
        interval=p.get("interval"),
        credits_per_period=p.get("creditsPerPeriod", 0),
        usage_included=p.get("usageIncluded", 0),
        trial_days=p.get("trialDays", 0),
        prices=[],
    )


# ── stripe ───────────────────────────────────────────────────────────────────────────────────
async def _stripe_test_payment(
    secret_key: str, amount: Money, customer_ref: str | None, idempotency_key: str
) -> Any:
    """Mirrors StripeProvider.createTestPayment (ts) — not part of the schift_payment_kit_stripe
    package contract, so implemented directly here via the `stripe` package (already an indirect
    dependency of schift_payment_kit_stripe) rather than modifying that package. Guarded to
    sk_test_ keys only."""
    import stripe

    if not secret_key.startswith("sk_test_"):
        raise PaymentKitError(
            "createTestPayment refuses to run against a non-test-mode secret key",
            "test_mode_required",
        )
    client = stripe.StripeClient(api_key=secret_key)
    body: dict[str, Any] = {
        "amount": amount.amount_minor,
        "currency": amount.currency.lower(),
        "payment_method": "pm_card_visa",
        "payment_method_types": ["card"],
        "confirm": True,
        "off_session": True,
    }
    if customer_ref:
        body["customer"] = customer_ref
    return await client.v1.payment_intents.create_async(
        body, options={"idempotency_key": idempotency_key}
    )


def _command_exists(cmd: str) -> bool:
    try:
        subprocess.run(
            [cmd, "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=True,
        )
        return True
    except Exception:
        return False


async def run_stripe_webhook(env: dict[str, str]) -> None:
    p = "stripe"
    if not _command_exists("stripe"):
        record(
            "SKIP",
            p,
            "webhook",
            "stripe CLI not found on PATH — to verify manually: dashboard.stripe.com/test/webhooks → add endpoint pointing at your deployed /api/webhook/paykit (or run `stripe listen --forward-to localhost:<port>/api/webhook/paykit` + `stripe trigger payment_intent.succeeded` locally), then confirm your app logs a 200 and the event lands in repo.webhook_events.",
        )
        return

    port = 34621 + int(time.time()) % 500
    repo = InMemoryRepo()
    clock = SystemClock()
    state: dict[str, Any] = {"secret": None, "event_id": None, "error": None}
    loop = asyncio.get_event_loop()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            headers = {k.lower(): v for k, v in self.headers.items()}
            fut = asyncio.run_coroutine_threadsafe(self._handle(headers, body), loop)
            try:
                status = fut.result(timeout=10)
            except Exception as e:  # noqa: BLE001
                state["error"] = str(e)
                status = 400
            self.send_response(status)
            self.end_headers()

        async def _handle(self, headers: dict[str, str], body: str) -> int:
            if not state["secret"]:
                raise RuntimeError(
                    "no webhook secret captured from `stripe listen` yet"
                )
            provider = StripeProvider(
                secret_key=env["STRIPE_SECRET_KEY"], webhook_secret=state["secret"]
            )
            result = await receive_webhook(
                provider=provider,
                headers=headers,
                raw_body=body,
                repo=repo,
                clock=clock,
            )
            if result.event_id:
                state["event_id"] = result.event_id
                await process_webhook(
                    event_id=result.event_id,
                    providers={"stripe": provider},
                    handlers={},
                    repo=repo,
                    clock=clock,
                )
            return result.status

        def log_message(self, *args: Any) -> None:  # silence default stderr logging
            pass

    server = HTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        listen = subprocess.Popen(
            [
                "stripe",
                "listen",
                "--forward-to",
                f"http://127.0.0.1:{port}/webhook",
                "--events",
                "payment_intent.succeeded",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        secret: str | None = None
        deadline = time.time() + 15
        while time.time() < deadline:
            line = listen.stdout.readline() if listen.stdout else ""
            if not line:
                time.sleep(0.1)
                continue
            m = re.search(r"whsec_[A-Za-z0-9]+", line)
            if m:
                secret = m.group(0)
                break
        if not secret:
            record(
                "SKIP",
                p,
                "webhook",
                "stripe CLI found but `stripe listen` did not print a webhook signing secret within 15s — likely not logged in (`stripe login`)",
            )
            listen.terminate()
            return
        state["secret"] = secret
        register_secret(secret)

        subprocess.run(
            ["stripe", "trigger", "payment_intent.succeeded"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(4)
        listen.terminate()

        if state["error"]:
            record("FAIL", p, "webhook", f"receive/process failed: {state['error']}")
        elif state["event_id"]:
            record(
                "PASS",
                p,
                "webhook",
                f"stripe trigger payment_intent.succeeded → real signed delivery → webhook.receive+process handled event_id={state['event_id']}",
            )
        else:
            record(
                "SKIP",
                p,
                "webhook",
                "stripe trigger ran but no event was forwarded to the local listener within the wait window",
            )
    except Exception as e:  # noqa: BLE001
        record("SKIP", p, "webhook", f"stripe CLI invocation failed: {e}")
    finally:
        server.shutdown()


async def run_stripe(
    env: dict[str, str], config: dict[str, Any], dry_run: bool
) -> None:
    p = "stripe"
    missing = missing_env("stripe", env)
    if missing:
        record(
            "SKIP" if dry_run else "FAIL", p, "all steps", f"no keys in .env (missing: {', '.join(missing)})"
        )
        return
    register_secret(env.get("STRIPE_SECRET_KEY"))
    register_secret(env.get("STRIPE_WEBHOOK_SECRET"))
    if dry_run:
        record(
            "SKIP",
            p,
            "dry-run",
            "would run create_customer → create_checkout → createTestPayment → get_payment → refund(partial) → get_payment → list_payments → report_usage → webhook",
        )
        return
    if not env["STRIPE_SECRET_KEY"].startswith("sk_test_"):
        record(
            "FAIL",
            p,
            "preflight",
            "STRIPE_SECRET_KEY does not start with sk_test_ — refusing to run against a live-mode key",
        )
        return

    provider = StripeProvider(
        secret_key=env["STRIPE_SECRET_KEY"], webhook_secret=env["STRIPE_WEBHOOK_SECRET"]
    )

    customer_ref: str | None = None
    try:
        c = await provider.create_customer(
            email=f"paykit-live-{int(time.time())}@example.com", name="paykit live"
        )
        customer_ref = c["ref"]
        record("PASS", p, "create_customer", f"ref={c['ref']}")
    except Exception as e:  # noqa: BLE001
        record("FAIL", p, "create_customer", err_detail(e))
        return

    pp = first_plan_and_price(config)
    if pp:
        plan_dict, price_dict = pp
        price_ref = (price_dict.get("providerPriceRefs") or {}).get(
            "stripe"
        ) or env.get("STRIPE_TEST_PRICE_ID")
        if not price_ref:
            record(
                "SKIP",
                p,
                "create_checkout",
                "plans[0].prices[0] has no providerPriceRefs.stripe (contract gap — apps/cli PlanPriceConfig has no such field yet) and no STRIPE_TEST_PRICE_ID env override set",
            )
        else:
            try:
                plan = plan_from_dict(plan_dict)
                price = PlanPrice(
                    currency=price_dict["currency"],
                    amount_minor=price_dict["amountMinor"],
                    provider_price_refs={"stripe": price_ref},
                )
                checkout = await provider.create_checkout(
                    CreateCheckoutInput(
                        customer_ref=customer_ref,
                        plan=plan,
                        price=price,
                        mode="subscription"
                        if plan_dict.get("interval")
                        else "one_time",
                        success_url="https://example.com/success",
                        cancel_url="https://example.com/cancel",
                        idempotency_key=idem("live_checkout"),
                    )
                )
                record("PASS", p, "create_checkout", f"hosted url: {checkout.url}")
            except Exception as e:  # noqa: BLE001
                record("FAIL", p, "create_checkout", err_detail(e))
    else:
        record(
            "SKIP", p, "create_checkout", "paykit.config.json has no plans[0].prices[0]"
        )

    payment_ref: str | None = None
    try:
        pi = await _stripe_test_payment(
            env["STRIPE_SECRET_KEY"],
            Money(amount_minor=1099, currency="usd"),
            customer_ref,
            idem("live_pi"),
        )
        payment_ref = pi.id
        record(
            "PASS", p, "createTestPayment", f"provider_ref={pi.id} status={pi.status}"
        )
    except Exception as e:  # noqa: BLE001
        record("FAIL", p, "createTestPayment", err_detail(e))

    if payment_ref:
        try:
            payment = await provider.get_payment(payment_ref)
            record(
                "PASS",
                p,
                "get_payment",
                f"status={payment.status} amount={payment.amount.amount_minor}{payment.amount.currency}",
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "get_payment", err_detail(e))

        refund_ok = False
        try:
            refund = await provider.refund(
                payment_ref=payment_ref,
                amount=Money(amount_minor=500, currency="usd"),
                reason="requested_by_customer",
                idempotency_key=idem("live_refund"),
            )
            record(
                "PASS",
                p,
                "refund(partial)",
                f"refund_id={refund.id} status={refund.status} amount={refund.amount.amount_minor}",
            )
            refund_ok = True
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "refund(partial)", err_detail(e))

        try:
            payment = await provider.get_payment(payment_ref)
            ok = payment.status in ("partially_refunded", "refunded")
            record(
                "PASS" if (refund_ok and ok) else ("FAIL" if refund_ok else "SKIP"),
                p,
                "get_payment(after refund)",
                f"status={payment.status}",
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "get_payment(after refund)", err_detail(e))
    else:
        record("SKIP", p, "get_payment", "no payment_ref (createTestPayment failed)")
        record(
            "SKIP", p, "refund(partial)", "no payment_ref (createTestPayment failed)"
        )
        record(
            "SKIP",
            p,
            "get_payment(after refund)",
            "no payment_ref (createTestPayment failed)",
        )

    if customer_ref:
        try:
            from datetime import timedelta

            lst = await provider.list_payments(
                customer_ref=customer_ref, since=datetime.now(UTC) - timedelta(days=1)
            )
            found = (
                any(pmt.provider_ref == payment_ref for pmt in lst)
                if payment_ref
                else False
            )
            record(
                "PASS" if (not payment_ref or found) else "FAIL",
                p,
                "list_payments",
                f"count={len(lst)}"
                + (f" contains_payment={found}" if payment_ref else ""),
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "list_payments", err_detail(e))

    try:
        await provider.report_usage(
            meter="paykit_live_test",
            customer_ref=customer_ref or "cus_unknown",
            quantity=1,
            occurred_at=datetime.now(UTC),
            idempotency_key=idem("live_usage"),
        )
        record("PASS", p, "report_usage", "meter event accepted")
    except Exception as e:  # noqa: BLE001
        detail = err_detail(e)
        if "meter" in detail.lower():
            record(
                "SKIP",
                p,
                "report_usage",
                f'no meter named "paykit_live_test" exists in this Stripe test account — create one at dashboard.stripe.com/test/meters, error: {detail}',
            )
        else:
            record("FAIL", p, "report_usage", detail)

    await run_stripe_webhook(env)


# ── toss ─────────────────────────────────────────────────────────────────────────────────────
async def run_toss(env: dict[str, str], config: dict[str, Any], dry_run: bool) -> None:
    p = "toss"
    missing = missing_env("toss", env)
    if missing:
        record(
            "SKIP" if dry_run else "FAIL", p, "all steps", f"no keys in .env (missing: {', '.join(missing)})"
        )
        return
    register_secret(env.get("TOSS_SECRET_KEY"))
    if dry_run:
        record(
            "SKIP",
            p,
            "dry-run",
            "would run create_customer(local) → create_checkout(local url) → billing/authorizations/card(BIN-only test card) → charge_billing_key(x2 idempotent) → get_payment → refund(partial) → get_payment → get_payment(unknown key, expect real error) → billing/authorizations/issue(bogus authKey, expect real error) → list_payments → webhook instructions",
        )
        return

    provider = TossProvider(
        TossProviderConfig(
            secret_key=env["TOSS_SECRET_KEY"], client_key=env.get("TOSS_CLIENT_KEY")
        )
    )

    c = await provider.create_customer(
        email=f"paykit-live-{int(time.time())}@example.com"
    )
    record(
        "PASS",
        p,
        "create_customer",
        f"ref={c['ref']} (Toss has no customer API — local synthesized customerKey, not a network call)",
    )

    pp = first_plan_and_price(config)
    krw_price = (
        pp[1]
        if pp and pp[1].get("currency") == "KRW"
        else {"currency": "KRW", "amountMinor": 9900}
    )
    if pp:
        try:
            plan = plan_from_dict(pp[0])
            price = PlanPrice(
                currency=krw_price["currency"], amount_minor=krw_price["amountMinor"]
            )
            checkout = await provider.create_checkout(
                CreateCheckoutInput(
                    customer_ref=c["ref"],
                    plan=plan,
                    price=price,
                    mode="one_time",
                    success_url="https://example.com/success",
                    cancel_url="https://example.com/cancel",
                    idempotency_key=idem("live_checkout"),
                )
            )
            record(
                "PASS",
                p,
                "create_checkout",
                f"hosted url (local, no network call — Toss checkout is client-widget-driven): {checkout.url}",
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "create_checkout", err_detail(e))
    else:
        record("SKIP", p, "create_checkout", "paykit.config.json has no plans[0]")

    record(
        "SKIP",
        p,
        "confirm_payment",
        "requires a paymentKey issued by the Toss payment widget in a real browser — not scriptable server-side",
    )

    # ── browser-free path: issue a billing key directly from raw (BIN-only, test-mode) card
    # fields, then charge it. BIN 490625 (BC) confirmed live 2026-09-09 to issue a billing key
    # that charge_billing_key can actually charge (unlike an arbitrary synthetic BIN, which
    # issues fine but later fails charge_billing_key with a real NOT_SUPPORTED_CARD_TYPE — see
    # TossProvider.issue_billing_key_by_card docstring). Dummy card, Toss test environment
    # only, no real money moves. ──
    billing_key: str | None = None
    try:
        result = await provider.issue_billing_key_by_card(
            customer_key=c["ref"],
            card_number="4906251234123456",  # Toss test-env dummy card (BIN 490625/BC) — no real money moves
            card_expiration_year="30",
            card_expiration_month="12",
            customer_identity_number="900101",
            # card_password omitted — confirmed live 2026-09-09 that Toss's test API issues without it.
        )
        billing_key = result.billing_key
        record(
            "PASS",
            p,
            "billing/authorizations/card",
            "billingKey issued (network call to real Toss test API, dummy card 490625******3456)",
        )
    except Exception as e:  # noqa: BLE001
        record("FAIL", p, "billing/authorizations/card", err_detail(e))

    charge_amount = Money(
        amount_minor=krw_price.get("amountMinor") or 10000, currency="KRW"
    )
    payment_ref: str | None = None
    if billing_key:
        order_id = f"ord_live_{int(time.time())}"
        charge_idem_key = idem("live_charge")
        try:
            first = await provider.charge_billing_key(
                billing_key=billing_key,
                amount=charge_amount,
                order_id=order_id,
                customer_ref=c["ref"],
                idempotency_key=charge_idem_key,
            )
            payment_ref = first.provider_ref
            record(
                "PASS",
                p,
                "charge_billing_key",
                f"provider_ref={first.provider_ref} status={first.status} amount={first.amount.amount_minor}{first.amount.currency}",
            )

            second = await provider.charge_billing_key(
                billing_key=billing_key,
                amount=charge_amount,
                order_id=order_id,
                customer_ref=c["ref"],
                idempotency_key=charge_idem_key,
            )
            idempotent = second.provider_ref == first.provider_ref
            outcome_note = (
                "matches first call"
                if idempotent
                else f"MISMATCH vs first call's {first.provider_ref} — double charge risk"
            )
            record(
                "PASS" if idempotent else "FAIL",
                p,
                "charge_billing_key(idempotent replay)",
                f"same idempotency_key twice → provider_ref={second.provider_ref} ({outcome_note})",
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "charge_billing_key", err_detail(e))
    else:
        record(
            "SKIP",
            p,
            "charge_billing_key",
            "no billing_key (billing/authorizations/card failed)",
        )
        record(
            "SKIP",
            p,
            "charge_billing_key(idempotent replay)",
            "no billing_key (billing/authorizations/card failed)",
        )

    if payment_ref:
        try:
            payment = await provider.get_payment(payment_ref)
            record(
                "PASS",
                p,
                "get_payment",
                f"status={payment.status} amount={payment.amount.amount_minor}{payment.amount.currency}",
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "get_payment", err_detail(e))

        refund_ok = False
        try:
            partial = (
                3000
                if charge_amount.amount_minor > 3000
                else max(1, charge_amount.amount_minor // 2)
            )
            refund = await provider.refund(
                payment_ref=payment_ref,
                amount=Money(amount_minor=partial, currency="KRW"),
                reason="paykit live 실측",
                idempotency_key=idem("live_refund"),
            )
            record(
                "PASS",
                p,
                "refund(partial)",
                f"refund_id={refund.id} status={refund.status} amount={refund.amount.amount_minor}",
            )
            refund_ok = True
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "refund(partial)", err_detail(e))

        try:
            payment = await provider.get_payment(payment_ref)
            ok = payment.status in ("partially_refunded", "refunded")
            record(
                "PASS" if (refund_ok and ok) else ("FAIL" if refund_ok else "SKIP"),
                p,
                "get_payment(after refund)",
                f"status={payment.status} (Toss PARTIAL_CANCELED → partially_refunded)",
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "get_payment(after refund)", err_detail(e))
    else:
        record("SKIP", p, "get_payment", "no payment_ref (charge_billing_key failed)")
        record(
            "SKIP", p, "refund(partial)", "no payment_ref (charge_billing_key failed)"
        )
        record(
            "SKIP",
            p,
            "get_payment(after refund)",
            "no payment_ref (charge_billing_key failed)",
        )

    # ── EC:K2-K7 cash receipt proof. The billing-key charge above is a CARD payment, which is
    # NOT cash-receipt eligible (EC:K4) — real-only cash-eligible methods (계좌이체/가상계좌/휴대폰)
    # require a browser-completed checkout, same limitation as confirm_payment above. So this
    # proves the negative path against the real payment just charged: issue_cash_receipt must
    # refuse it.
    # IMPORTANT REAL FINDING (confirmed live 2026-09-09): the real Toss test API's
    # POST /v1/cash-receipts does NOT itself validate that the payment/orderId is card-based --
    # it happily returns 200 for an arbitrary orderId (see packages/providers/toss/spec/
    # toss.pseudo.md "[EC:K2 K3 K4 K5 K6 K7]"). So this step does NOT expect "a real Toss error";
    # it expects our OWN client-side guard (issue_cash_receipt's method re-fetch + check) to throw
    # before any POST /v1/cash-receipts call is made -- that is the actual, honest behavior. ──
    if payment_ref:
        try:
            await provider.issue_cash_receipt(
                payment_ref=payment_ref,
                type="personal",
                customer_identity_number="01012345678",
            )
            record(
                "FAIL",
                p,
                "issue_cash_receipt(card payment)",
                "expected our own cash_receipt_unsupported_for_payment_method guard to refuse a card payment, but it succeeded",
            )
        except Exception as e:  # noqa: BLE001
            is_expected_guard = (
                getattr(e, "code", None)
                == "cash_receipt_unsupported_for_payment_method"
            )
            record(
                "PASS" if is_expected_guard else "FAIL",
                p,
                "issue_cash_receipt(card payment)",
                f"client-side guard (NOT a real Toss rejection -- Toss's own /v1/cash-receipts does not validate this, confirmed live 2026-09-09): {err_detail(e)}",
            )
        record(
            "SKIP",
            p,
            "issue_cash_receipt(cash-eligible payment)",
            "no cash-eligible (계좌이체/가상계좌/휴대폰) payment exists in this run -- charge_billing_key above only produces CARD payments, and completing a cash-eligible payment requires the Toss widget in a real browser (not scriptable server-side, same limitation as confirm_payment). POST /v1/cash-receipts itself was confirmed live 2026-09-09 outside this script (see toss.pseudo.md) -- issue+cancel round trip on a real receipt_key, and duplicate-issue with the same order_id producing two distinct receipt_keys.",
        )
        record(
            "SKIP",
            p,
            "cancel_cash_receipt / get_cash_receipt",
            "no receipt_key to cancel/look up -- issue_cash_receipt above correctly refused (card payment)",
        )
    else:
        record(
            "SKIP",
            p,
            "issue_cash_receipt / cancel_cash_receipt / get_cash_receipt",
            "no payment_ref (charge_billing_key failed)",
        )

    # ── failure-path proof: force a real REJECT_CARD_PAYMENT via the TossPayments-Test-Code
    # header (test_sk_ keys only), confirmed live 2026-09-09, and check our own normalizer
    # against the real response instead of a hand-built fixture. ──
    if billing_key:
        try:
            test_code_provider = TossProvider(
                TossProviderConfig(
                    secret_key=env["TOSS_SECRET_KEY"], test_code="REJECT_CARD_PAYMENT"
                )
            )
            await test_code_provider.charge_billing_key(
                billing_key=billing_key,
                amount=charge_amount,
                order_id=f"ord_live_reject_{int(time.time())}",
                customer_ref=c["ref"],
                idempotency_key=idem("live_charge_reject"),
            )
            record(
                "FAIL",
                p,
                "charge_billing_key(TossPayments-Test-Code: REJECT_CARD_PAYMENT)",
                "expected a real Toss rejection but the call succeeded",
            )
        except Exception as e:  # noqa: BLE001
            failure = e.failure if isinstance(e, ProviderError) else None
            normalized_ok = (
                failure is not None
                and failure.code == "insufficient_funds"
                and failure.retryable is True
            )
            record(
                "PASS" if normalized_ok else "FAIL",
                p,
                "charge_billing_key(TossPayments-Test-Code: REJECT_CARD_PAYMENT)",
                f"real Toss response: {err_detail(e)} → normalize_toss_failure gave "
                f"code={failure.code if failure else 'n/a'} retryable={failure.retryable if failure else 'n/a'} "
                "(expected insufficient_funds/True)",
            )
    else:
        record(
            "SKIP",
            p,
            "charge_billing_key(TossPayments-Test-Code: REJECT_CARD_PAYMENT)",
            "no billing_key (billing/authorizations/card failed)",
        )

    try:
        await provider.get_payment(f"paykit_live_nonexistent_{int(time.time())}")
        record(
            "FAIL",
            p,
            "get_payment(unknown key)",
            "expected a real Toss NOT_FOUND-style error but the call succeeded",
        )
    except Exception as e:  # noqa: BLE001
        record(
            "PASS" if isinstance(e, ProviderError) and e.failure.provider_code == "NOT_FOUND_PAYMENT" else "FAIL",
            p,
            "get_payment(unknown key)",
            f"expected NOT_FOUND_PAYMENT; received: {err_detail(e)}",
        )

    try:
        await provider.issue_billing_key(
            auth_key=f"bogus-auth-key-{int(time.time())}", customer_key=c["ref"]
        )
        record(
            "FAIL",
            p,
            "billing/authorizations/issue(bogus authKey)",
            "expected a real Toss error but the call succeeded",
        )
    except Exception as e:  # noqa: BLE001
        record(
            "PASS" if isinstance(e, ProviderError) and e.failure.provider_code == "NOT_FOUND_BILLING" else "FAIL",
            p,
            "billing/authorizations/issue(bogus authKey)",
            f"expected NOT_FOUND_BILLING; received: {err_detail(e)}",
        )

    # NOTE (real limitation, confirmed live 2026-09-09 — not asserted below): Toss's
    # /v1/transactions has no reliable window/customer semantics for reconciliation — a
    # payment charged seconds ago does not reliably appear in a 1-hour window, and a 24-hour
    # window can return rows for *other* merchants sharing this public docs mId. So this step
    # only asserts the call itself succeeds, never that it contains the payment just made.
    try:
        from datetime import timedelta

        lst = await provider.list_payments(
            customer_ref=c["ref"], since=datetime.now(UTC) - timedelta(days=1)
        )
        record(
            "PASS",
            p,
            "list_payments",
            f"real /v1/transactions call succeeded, count={len(lst)} (containment not asserted — "
            "see docs/PUBLIC_SANDBOX_VERIFICATION.md and packages/providers/toss/spec/toss.pseudo.md for the confirmed real limitation)",
        )
    except Exception as e:  # noqa: BLE001
        record("FAIL", p, "list_payments", err_detail(e))

    record(
        "SKIP",
        p,
        "webhook",
        "Toss webhooks are unsigned and configured per-merchant in the Toss dashboard (developers.tosspayments.com → 개발자센터 → 웹훅). Add your deployed /api/webhook/paykit URL there, enable PAYMENT_STATUS_CHANGED, and trigger a real test payment from the dashboard to confirm delivery — cannot be scripted without a live endpoint.",
    )


# ── portone ──────────────────────────────────────────────────────────────────────────────────
async def run_portone(
    env: dict[str, str], config: dict[str, Any], dry_run: bool
) -> None:
    p = "portone"
    missing = missing_env("portone", env)
    if missing:
        record(
            "SKIP" if dry_run else "FAIL", p, "all steps", f"no keys in .env (missing: {', '.join(missing)})"
        )
        return
    register_secret(env.get("PORTONE_API_SECRET"))
    register_secret(env.get("PORTONE_WEBHOOK_SECRET"))
    if dry_run:
        record(
            "SKIP",
            p,
            "dry-run",
            "would run create_customer(local) → create_checkout(local url) → get_payment(unknown id, expect real error) → billing-keys(bogus, expect real error) → list_payments → webhook instructions",
        )
        return

    provider = PortoneProvider(
        PortoneProviderConfig(
            api_secret=env["PORTONE_API_SECRET"],
            store_id=env["PORTONE_STORE_ID"],
            webhook_secret=env["PORTONE_WEBHOOK_SECRET"],
        )
    )

    c = await provider.create_customer(
        email=f"paykit-live-{int(time.time())}@example.com"
    )
    record(
        "PASS",
        p,
        "create_customer",
        f"ref={c['ref']} (PortOne V2 has no customer-create API — local synthesized id, not a network call)",
    )

    pp = first_plan_and_price(config)
    if pp:
        try:
            plan = plan_from_dict(pp[0])
            price = PlanPrice(
                currency=pp[1]["currency"], amount_minor=pp[1]["amountMinor"]
            )
            checkout = await provider.create_checkout(
                CreateCheckoutInput(
                    customer_ref=c["ref"],
                    plan=plan,
                    price=price,
                    mode="one_time",
                    success_url="https://example.com/success",
                    cancel_url="https://example.com/cancel",
                    idempotency_key=idem("live_checkout"),
                )
            )
            record(
                "PASS",
                p,
                "create_checkout",
                f"hosted url (local, no network call — PortOne checkout is client-SDK-driven): {checkout.url}",
            )
        except Exception as e:  # noqa: BLE001
            record("FAIL", p, "create_checkout", err_detail(e))
    else:
        record("SKIP", p, "create_checkout", "paykit.config.json has no plans[0]")

    record(
        "SKIP",
        p,
        "confirm_payment",
        "requires a payment_id completed via PortOne browser SDK — not scriptable server-side",
    )

    try:
        await provider.get_payment(f"paykit_live_nonexistent_{int(time.time())}")
        record(
            "FAIL",
            p,
            "get_payment(unknown id)",
            "expected a real PortOne error but the call succeeded",
        )
    except Exception as e:  # noqa: BLE001
        record(
            "PASS" if isinstance(e, ProviderError) and e.failure.provider_code == "PAYMENT_NOT_FOUND" else "FAIL",
            p,
            "get_payment(unknown id)",
            f"expected PAYMENT_NOT_FOUND; received: {err_detail(e)}",
        )

    try:
        await provider.issue_billing_key(customer={"id": c["ref"]}, method={"card": {}})
        record(
            "FAIL",
            p,
            "billing-keys(no real method)",
            "expected a real PortOne error but the call succeeded",
        )
    except Exception as e:  # noqa: BLE001
        record(
            "PASS" if isinstance(e, ProviderError) and e.failure.provider_code == "INVALID_REQUEST" else "FAIL",
            p,
            "billing-keys(no real method)",
            f"expected INVALID_REQUEST; received: {err_detail(e)}",
        )

    try:
        from datetime import timedelta

        lst = await provider.list_payments(
            customer_ref=c["ref"], since=datetime.now(UTC) - timedelta(days=1)
        )
        record(
            "PASS",
            p,
            "list_payments",
            f"real /payments call succeeded, count={len(lst)} (0 expected — no real payment exists for this synthesized customer id)",
        )
    except Exception as e:  # noqa: BLE001
        record("FAIL", p, "list_payments", err_detail(e))

    record(
        "SKIP",
        p,
        "refund",
        "no real payment exists to refund (requires SDK-completed payment)",
    )
    record(
        "SKIP",
        p,
        "webhook",
        "PortOne webhooks are configured per-store in the PortOne console (admin.portone.io → 연동 정보 → Webhook). Add your deployed /api/webhook/paykit URL, then trigger a real test payment from the console to confirm delivery — cannot be scripted without a live endpoint.",
    )


# ── polar ────────────────────────────────────────────────────────────────────────────────────
async def run_polar(env: dict[str, str], config: dict[str, Any], dry_run: bool) -> None:
    p = "polar"
    missing = missing_env("polar", env)
    if missing:
        record(
            "SKIP" if dry_run else "FAIL", p, "all steps", f"no keys in .env (missing: {', '.join(missing)})"
        )
        return
    register_secret(env.get("POLAR_ACCESS_TOKEN"))
    register_secret(env.get("POLAR_WEBHOOK_SECRET"))
    server = "production" if env.get("POLAR_SERVER") == "production" else "sandbox"
    if dry_run:
        record(
            "SKIP",
            p,
            "dry-run",
            f"would run (server={server}) create_customer → create_checkout → get_payment/refund/list_payments/report_usage (skipped: no server-side way to complete a Polar checkout) → webhook instructions",
        )
        return

    provider = PolarProvider(
        access_token=env["POLAR_ACCESS_TOKEN"],
        webhook_secret=env["POLAR_WEBHOOK_SECRET"],
        server=server,
    )

    customer_ref: str | None = None
    try:
        c = await provider.create_customer(
            email=f"paykit-live-{int(time.time())}@example.com", name="paykit live"
        )
        customer_ref = c["ref"]
        record("PASS", p, f"create_customer ({server})", f"ref={c['ref']}")
    except Exception as e:  # noqa: BLE001
        record("FAIL", p, "create_customer", err_detail(e))
        return

    pp = first_plan_and_price(config)
    if pp:
        plan_dict, price_dict = pp
        product_ref = (price_dict.get("providerPriceRefs") or {}).get(
            "polar"
        ) or env.get("POLAR_TEST_PRODUCT_ID")
        if not product_ref:
            record(
                "SKIP",
                p,
                "create_checkout",
                "plans[0].prices[0] has no providerPriceRefs.polar (contract gap — apps/cli PlanPriceConfig has no such field yet) and no POLAR_TEST_PRODUCT_ID env override set",
            )
        else:
            try:
                plan = plan_from_dict(plan_dict)
                price = PlanPrice(
                    currency=price_dict["currency"],
                    amount_minor=price_dict["amountMinor"],
                    provider_price_refs={"polar": product_ref},
                )
                checkout = await provider.create_checkout(
                    CreateCheckoutInput(
                        customer_ref=customer_ref,
                        plan=plan,
                        price=price,
                        mode="subscription"
                        if plan_dict.get("interval")
                        else "one_time",
                        success_url="https://example.com/success",
                        cancel_url="https://example.com/cancel",
                        idempotency_key=idem("live_checkout"),
                    )
                )
                record("PASS", p, "create_checkout", f"hosted url={checkout.url}")
            except Exception as e:  # noqa: BLE001
                record("FAIL", p, "create_checkout", err_detail(e))
    else:
        record("SKIP", p, "create_checkout", "paykit.config.json has no plans[0]")

    record(
        "SKIP",
        p,
        "get_payment/refund/list_payments",
        "Polar has no server-side test-payment API — completing an order requires the Polar-hosted checkout page in a real browser (cannot be scripted here); the created checkout URL above can be opened manually to complete one",
    )

    try:
        await provider.report_usage(
            meter="paykit_live_test",
            customer_ref=customer_ref,
            quantity=1,
            occurred_at=datetime.now(UTC),
            idempotency_key=idem("live_usage"),
        )
        record("PASS", p, "report_usage", "event ingested")
    except Exception as e:  # noqa: BLE001
        detail = err_detail(e)
        if "meter" in detail.lower():
            record(
                "SKIP",
                p,
                "report_usage",
                f'Polar rejected the event — likely no meter named "paykit_live_test" configured for this org: {detail}',
            )
        else:
            record("FAIL", p, "report_usage", detail)

    record(
        "SKIP",
        p,
        "webhook",
        f"Polar webhooks are configured per-org in the Polar dashboard ({'sandbox.polar.sh' if server == 'sandbox' else 'polar.sh'} → Settings → Webhooks). Add your deployed /api/webhook/paykit URL, subscribe to order.paid, then complete a real checkout to confirm delivery — cannot be scripted without a live endpoint.",
    )


# ── orchestration ────────────────────────────────────────────────────────────────────────────
async def main() -> int:
    parser = argparse.ArgumentParser(
        description="paykit live — Python parity real round trip"
    )
    parser.add_argument("--out", default=".", help="project directory (default: cwd)")
    parser.add_argument(
        "--config", default=None, help="paykit.config.json path override"
    )
    parser.add_argument("--env", default=None, help="'.env' path override")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    config_path = (
        Path(args.config).resolve() if args.config else out_dir / "paykit.config.json"
    )
    env_path = Path(args.env).resolve() if args.env else out_dir / ".env"

    if not config_path.exists():
        print(f"paykit.config.json 을 찾을 수 없습니다: {config_path}", file=sys.stderr)
        return 1
    config = json.loads(config_path.read_text(encoding="utf-8"))
    env, found = load_env_file(env_path)

    print("paykit live (python parity)")
    print(f"config: {config_path}")
    print(
        f".env:   {env_path}"
        + ("" if found else " (not found — using process env only)")
    )
    print(f"providers configured: {', '.join(config.get('providers', [])) or '(none)'}")
    if args.dry_run:
        print("--dry-run: no network calls will be made.")
    print()

    providers: list[str] = config.get("providers", [])
    if not providers:
        print(
            "paykit.config.json 에 설정된 provider 가 없습니다. 검증할 것이 없습니다."
        )
        return 0 if args.dry_run else 1

    runners = {
        "stripe": run_stripe,
        "toss": run_toss,
        "portone": run_portone,
        "polar": run_polar,
    }
    for name in providers:
        runner = runners.get(name)
        if runner:
            await runner(env, config, args.dry_run)
            print()
        else:
            record("FAIL", name, "configuration", "unsupported provider")

    passed = sum(1 for r in _RESULTS if r["status"] == "PASS")
    failed = sum(1 for r in _RESULTS if r["status"] == "FAIL")
    skipped = sum(1 for r in _RESULTS if r["status"] == "SKIP")
    print(f"요약: PASS {passed}  FAIL {failed}  SKIP {skipped}")

    return 1 if failed > 0 or (passed == 0 and not args.dry_run) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
