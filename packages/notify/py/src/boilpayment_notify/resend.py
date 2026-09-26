# Resend email adapter. Never throws — see spec/notify.pseudo.md.
from __future__ import annotations

import logging

import httpx
from boilpayment_core import Notification

from .templates import Locale, render_notification

log = logging.getLogger("boilpayment_notify")


class ResendNotifier:
    def __init__(
        self,
        *,
        api_key: str,
        from_: str,
        to: str,
        locale: Locale = "en",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self._from = from_
        self._to = to
        self._locale = locale
        self._client = client  # override for tests — defaults to a fresh httpx.AsyncClient per send

    async def send(self, n: Notification) -> None:
        rendered = render_notification(n, self._locale)
        recipient = (n.payload or {}).get("email", self._to)
        try:
            client = self._client or httpx.AsyncClient()
            try:
                res = await client.post(
                    "https://api.resend.com/emails",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "from": self._from,
                        "to": recipient,
                        "subject": rendered.subject,
                        "text": rendered.text,
                    },
                )
                if res.status_code >= 300:
                    log.error("notify.resend non-2xx: %s", res.status_code)
            finally:
                if self._client is None:
                    await client.aclose()
        except Exception as e:  # noqa: BLE001 — never throw
            log.error("notify.resend failed: %s", e)


def resend(
    *,
    api_key: str,
    from_: str,
    to: str,
    locale: Locale = "en",
    client: httpx.AsyncClient | None = None,
) -> ResendNotifier:
    return ResendNotifier(
        api_key=api_key, from_=from_, to=to, locale=locale, client=client
    )
