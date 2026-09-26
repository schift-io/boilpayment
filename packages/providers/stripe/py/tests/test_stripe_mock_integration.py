"""[EC:apiBase] Integration test against a REAL `stripe-mock` binary (https://github.com/stripe/stripe-mock),
driven through `StripeProvider(..., api_base=...)`. Unlike the other test files in this directory (which
monkeypatch the SDK's HTTP client), this file makes real HTTP calls to a locally running stripe-mock server
and asserts on the shape it actually returns — this is what caught the "basil" API shape change
(current_period_* moved from Subscription to SubscriptionItem) in the first place: stripe-mock 0.203.0's
canned `GET /v1/subscriptions/:id` response has NO `current_period_start`/`current_period_end` on the
subscription root, only on `items.data[0]`.

Guarded: only runs if the `stripe-mock` binary is present on PATH (`shutil.which`). The module fixture
starts its own stripe-mock child process on an OS-assigned port and stops only that process
afterwards, so `pytest packages` never depends on a daemon the developer has to remember to start.

pytest-asyncio is not installed: async provider methods are driven via asyncio.run(...) inside plain
sync `def test_...():` functions.
"""

from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
import time
from collections.abc import Iterator
from tempfile import TemporaryFile

import httpx
import pytest
from boilpayment_stripe import StripeProvider

HOST = "127.0.0.1"

pytestmark = pytest.mark.skipif(
    shutil.which("stripe-mock") is None,
    reason="stripe-mock binary not found on PATH",
)


def _provider(api_base: str) -> StripeProvider:
    return StripeProvider(
        secret_key="sk_test_123",  # stripe-mock only requires a valid-looking sk_test_ key
        webhook_secret="whsec_unused_in_this_file",
        api_base=api_base,
    )


def _ping(api_base: str) -> bool:
    try:
        httpx.get(
            f"{api_base}/v1/customers/cus_liveness_check",
            headers={"Authorization": "Basic c2tfdGVzdF8xMjM6"},
            timeout=1.0,
        )
        return True
    except httpx.HTTPError:
        return False


@pytest.fixture(scope="module")
def _stripe_mock_process() -> Iterator[str]:
    with TemporaryFile(mode="w+") as output:
        child = subprocess.Popen(
            ["stripe-mock", "-http-port", "0"],
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                output.seek(0)
                startup = output.read()
                match = re.search(r"Listening for HTTP at address: .*:(\d+)", startup)
                if match:
                    api_base = f"http://{HOST}:{match.group(1)}"
                    if _ping(api_base):
                        yield api_base
                        return
                if child.poll() is not None:
                    pytest.fail(f"stripe-mock exited during startup: {startup}")
                time.sleep(0.15)
            pytest.fail("stripe-mock did not start listening within 8s")
        finally:
            child.terminate()
            child.wait(timeout=5)


def test_ec_apibase_create_customer_round_trips_through_real_stripe_mock(
    _stripe_mock_process: str,
):
    provider = _provider(_stripe_mock_process)

    async def run():
        return await provider.create_customer(
            email="mock-integration@example.com", name="Mock Test"
        )

    result = asyncio.run(run())
    assert result["ref"].startswith("cus_")


def test_ec_f_stripe_get_subscription_against_real_stripe_mock_derives_period_from_items(
    _stripe_mock_process: str,
):
    provider = _provider(_stripe_mock_process)

    async def run():
        return await provider.get_subscription("sub_mock_1")

    sub = asyncio.run(run())
    assert sub.id == "sub_mock_1"
    assert sub.provider == "stripe"
    # stripe-mock's canned subscription fixture has no current_period_* on the root object as of
    # 0.203.x — the real invariant under test is that normalize_subscription does NOT raise
    # provider_shape against a live server's actual response shape.
    assert sub.current_period.start.timestamp() > 0
    assert sub.current_period.end.timestamp() > 0


def test_ec_e7_e12_get_payment_pi_prefix_round_trips_through_real_stripe_mock(
    _stripe_mock_process: str,
):
    provider = _provider(_stripe_mock_process)

    async def run():
        return await provider.get_payment("pi_mock_1")

    payment = asyncio.run(run())
    assert payment.id == "pi_mock_1"
    assert payment.provider == "stripe"
    assert isinstance(payment.amount.amount_minor, int)


def test_ec_f_stripe_get_payment_in_prefix_round_trips_through_real_stripe_mock(
    _stripe_mock_process: str,
):
    provider = _provider(_stripe_mock_process)

    async def run():
        return await provider.get_payment("in_mock_1")

    payment = asyncio.run(run())
    assert payment.id == "in_mock_1"
    assert payment.kind == "subscription"
    assert payment.provider == "stripe"


def test_parallel_mock_fixtures_keep_independent_lifetimes():
    owner = _stripe_mock_process.__wrapped__()
    survivor = _stripe_mock_process.__wrapped__()
    try:
        owner_url = next(owner)
        survivor_url = next(survivor)
        assert owner_url != survivor_url
        next(owner, None)
        assert _ping(survivor_url)
    finally:
        owner.close()
        survivor.close()
