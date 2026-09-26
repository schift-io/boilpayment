# Slack incoming-webhook adapter. Never throws — see spec/notify.pseudo.md.
from __future__ import annotations

import logging

import httpx
from schift_payment_kit_core import Notification

from .templates import Locale, render_notification

log = logging.getLogger("schift_payment_kit_notify")


class SlackNotifier:
    def __init__(self, *, webhook_url: str, locale: Locale = "en") -> None:
        self._webhook_url = webhook_url
        self._locale = locale

    async def send(self, n: Notification) -> None:
        rendered = render_notification(n, self._locale)
        try:
            async with httpx.AsyncClient() as client:
                res = await client.post(
                    self._webhook_url,
                    json={"text": f"*{rendered.subject}*\n{rendered.text}"},
                )
                if res.status_code >= 300:
                    log.error("notify.slack non-2xx: %s", res.status_code)
        except Exception as e:  # noqa: BLE001 — never throw, e.g. unreachable URL
            log.error("notify.slack failed: %s", e)


def slack(*, webhook_url: str, locale: Locale = "en") -> SlackNotifier:
    return SlackNotifier(webhook_url=webhook_url, locale=locale)
