"""Phase 6 regression tests -- slack/resend/smtp adapters, with a fake transport injected so no
real network call is ever attempted.

resend() takes an explicit `client` override in its constructor (the DI seam the source already
exposes -- see py/src/schift_payment_kit_notify/resend.py), so that seam is used directly.

slack() and smtp() have NO such seam: slack.py creates a fresh `httpx.AsyncClient()` inside
send(), and smtp.py calls `smtplib.SMTP(host, port)` directly inside its sync worker. Per the
task rules, this file monkeypatches `httpx.AsyncClient` (as referenced from the slack module) and
`smtplib.SMTP` (as referenced from the smtp module) for the duration of each test only, restored
automatically by pytest's `monkeypatch` fixture teardown.

pytest-asyncio is not installed: every async body runs via asyncio.run() inside a sync
`def test_...():` function.
"""

from __future__ import annotations

import asyncio
import importlib
import logging

from schift_payment_kit_core import Notification
from schift_payment_kit_notify import resend, slack, smtp

# `schift_payment_kit_notify/__init__.py` does `from .slack import slack` (and similarly for
# smtp), which rebinds the `slack`/`smtp` *attributes* on the package to the factory functions,
# shadowing the auto-registered submodule attribute. `import schift_payment_kit_notify.slack as x`
# would resolve through that shadowed attribute and hand back the function, not the module — so
# fetch the actual submodule objects straight from sys.modules via importlib instead.
slack_mod = importlib.import_module("schift_payment_kit_notify.slack")
smtp_mod = importlib.import_module("schift_payment_kit_notify.smtp")

NOTIFICATION = Notification(
    type="usage.soft_cap",
    customer_id="cust_1",
    payload={"meter": "api_call", "overage": 2, "included": 5},
)


# ── slack ──────────────────────────────────────────────────────────────────────────────────


class _FakeSlackResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


def _make_fake_httpx_async_client(
    calls: list, *, status_code: int = 200, raise_error: Exception | None = None
):
    class _FakeAsyncClient:
        def __init__(self, *a, **kw) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

        async def post(self, url, json=None, **kwargs):
            if raise_error is not None:
                raise raise_error
            calls.append({"url": url, "json": json})
            return _FakeSlackResponse(status_code)

    return _FakeAsyncClient


def test_notify_slack_adapter_builds_post_to_webhook_url_with_subject_text_body_no_real_network(
    monkeypatch,
):
    calls: list = []
    monkeypatch.setattr(
        slack_mod.httpx, "AsyncClient", _make_fake_httpx_async_client(calls)
    )
    notifier = slack(webhook_url="https://hooks.slack.test/services/abc", locale="en")

    asyncio.run(notifier.send(NOTIFICATION))

    assert len(calls) == 1
    assert calls[0]["url"] == "https://hooks.slack.test/services/abc"
    assert calls[0]["json"] == {
        "text": "*Usage limit reached*\nYou have used 2 units beyond your included 5 for api_call."
    }


def test_notify_slack_adapter_renders_ko_locale_into_webhook_payload(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        slack_mod.httpx, "AsyncClient", _make_fake_httpx_async_client(calls)
    )
    notifier = slack(webhook_url="https://hooks.slack.test/services/abc", locale="ko")

    asyncio.run(notifier.send(NOTIFICATION))

    assert calls[0]["json"] == {
        "text": "*이용량 한도 도달*\napi_call 사용량이 포함 한도 5 을 2 만큼 초과했습니다."
    }


def test_notify_slack_adapter_non_2xx_response_does_not_raise_is_logged_and_swallowed(
    monkeypatch, caplog
):
    calls: list = []
    monkeypatch.setattr(
        slack_mod.httpx,
        "AsyncClient",
        _make_fake_httpx_async_client(calls, status_code=500),
    )

    notifier = slack(webhook_url="https://hooks.slack.test/services/abc")
    with caplog.at_level(logging.ERROR, logger="schift_payment_kit_notify"):
        asyncio.run(notifier.send(NOTIFICATION))  # must not raise

    assert any("notify.slack non-2xx" in r.message for r in caplog.records)


def test_notify_slack_adapter_unreachable_host_does_not_raise_is_logged_and_swallowed(
    monkeypatch, caplog
):
    monkeypatch.setattr(
        slack_mod.httpx,
        "AsyncClient",
        _make_fake_httpx_async_client(
            [], raise_error=ConnectionError("connection refused")
        ),
    )
    notifier = slack(webhook_url="https://hooks.slack.test/services/abc")

    with caplog.at_level(logging.ERROR, logger="schift_payment_kit_notify"):
        asyncio.run(notifier.send(NOTIFICATION))  # must not raise

    assert any("notify.slack failed" in r.message for r in caplog.records)


# ── resend ─────────────────────────────────────────────────────────────────────────────────


class _FakeResendResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _RecordingResendClient:
    def __init__(
        self, *, status_code: int = 200, raise_error: Exception | None = None
    ) -> None:
        self.calls: list = []
        self._status_code = status_code
        self._raise_error = raise_error

    async def post(self, url, headers=None, json=None, **kwargs):
        if self._raise_error is not None:
            raise self._raise_error
        self.calls.append({"url": url, "headers": headers, "json": json})
        return _FakeResendResponse(self._status_code)


def test_notify_resend_adapter_builds_post_to_resend_emails_with_bearer_auth_and_body_no_real_network():
    client = _RecordingResendClient()
    notifier = resend(
        api_key="sk_fake_123",
        from_="billing@example.com",
        to="default@example.com",
        locale="en",
        client=client,
    )

    asyncio.run(notifier.send(NOTIFICATION))

    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["url"] == "https://api.resend.com/emails"
    assert call["headers"]["Authorization"] == "Bearer sk_fake_123"
    assert call["headers"]["Content-Type"] == "application/json"
    assert call["json"] == {
        "from": "billing@example.com",
        "to": "default@example.com",
        "subject": "Usage limit reached",
        "text": "You have used 2 units beyond your included 5 for api_call.",
    }


def test_notify_resend_adapter_payload_email_overrides_configured_default_to():
    client = _RecordingResendClient()
    notifier = resend(
        api_key="sk_fake_123",
        from_="billing@example.com",
        to="default@example.com",
        client=client,
    )
    with_email = Notification(
        type=NOTIFICATION.type,
        customer_id=NOTIFICATION.customer_id,
        payload={**NOTIFICATION.payload, "email": "override@example.com"},
    )

    asyncio.run(notifier.send(with_email))

    assert client.calls[0]["json"]["to"] == "override@example.com"


def test_notify_resend_adapter_non_2xx_response_does_not_raise_is_logged_and_swallowed(
    caplog,
):
    client = _RecordingResendClient(status_code=422)
    notifier = resend(
        api_key="sk_fake_123", from_="a@example.com", to="b@example.com", client=client
    )

    with caplog.at_level(logging.ERROR, logger="schift_payment_kit_notify"):
        asyncio.run(notifier.send(NOTIFICATION))  # must not raise

    assert any("notify.resend non-2xx" in r.message for r in caplog.records)


def test_notify_resend_adapter_network_down_does_not_raise_is_logged_and_swallowed(
    caplog,
):
    client = _RecordingResendClient(raise_error=ConnectionError("network down"))
    notifier = resend(
        api_key="sk_fake_123", from_="a@example.com", to="b@example.com", client=client
    )

    with caplog.at_level(logging.ERROR, logger="schift_payment_kit_notify"):
        asyncio.run(notifier.send(NOTIFICATION))  # must not raise

    assert any("notify.resend failed" in r.message for r in caplog.records)


# ── smtp ───────────────────────────────────────────────────────────────────────────────────


def _make_fake_smtp(calls: list, *, raise_error: Exception | None = None):
    class _Fake:
        def __init__(self, host, port) -> None:
            self.host = host
            self.port = port
            self.starttls_called = False
            self.login_args = None

        def __enter__(self):
            if raise_error is not None:
                raise raise_error
            return self

        def __exit__(self, *exc) -> bool:
            return False

        def starttls(self) -> None:
            self.starttls_called = True

        def login(self, user, password) -> None:
            self.login_args = (user, password)

        def sendmail(self, from_addr, to_addrs, msg) -> None:
            calls.append(
                {
                    "host": self.host,
                    "port": self.port,
                    "starttls": self.starttls_called,
                    "login": self.login_args,
                    "from_addr": from_addr,
                    "to_addrs": to_addrs,
                    "msg": msg,
                }
            )

    return _Fake


def test_notify_smtp_adapter_sends_via_smtplib_with_starttls_login_sendmail_no_real_network(
    monkeypatch,
):
    calls: list = []
    monkeypatch.setattr(smtp_mod.smtplib, "SMTP", _make_fake_smtp(calls))
    notifier = smtp(
        host="smtp.example.com",
        port=587,
        secure=True,
        user="u",
        password="p",
        from_="billing@example.com",
        to="default@example.com",
        locale="en",
    )

    asyncio.run(notifier.send(NOTIFICATION))

    assert len(calls) == 1
    call = calls[0]
    assert call["host"] == "smtp.example.com"
    assert call["port"] == 587
    assert call["starttls"] is True
    assert call["login"] == ("u", "p")
    assert call["from_addr"] == "billing@example.com"
    assert call["to_addrs"] == ["default@example.com"]
    assert "Usage limit reached" in call["msg"]
    assert "You have used 2 units beyond your included 5 for api_call." in call["msg"]


def test_notify_smtp_adapter_payload_email_overrides_configured_default_to(monkeypatch):
    calls: list = []
    monkeypatch.setattr(smtp_mod.smtplib, "SMTP", _make_fake_smtp(calls))
    notifier = smtp(
        host="smtp.example.com",
        port=587,
        from_="billing@example.com",
        to="default@example.com",
    )
    with_email = Notification(
        type=NOTIFICATION.type,
        customer_id=NOTIFICATION.customer_id,
        payload={**NOTIFICATION.payload, "email": "override@example.com"},
    )

    asyncio.run(notifier.send(with_email))

    assert calls[0]["to_addrs"] == ["override@example.com"]


def test_notify_smtp_adapter_unreachable_host_does_not_raise_is_logged_and_swallowed(
    monkeypatch, caplog
):
    monkeypatch.setattr(
        smtp_mod.smtplib,
        "SMTP",
        _make_fake_smtp(
            [], raise_error=ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:1")
        ),
    )
    notifier = smtp(host="127.0.0.1", port=1, from_="a@example.com", to="b@example.com")

    with caplog.at_level(logging.ERROR, logger="schift_payment_kit_notify"):
        asyncio.run(notifier.send(NOTIFICATION))  # must not raise

    assert any("notify.smtp failed" in r.message for r in caplog.records)
