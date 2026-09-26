# SMTP email adapter via smtplib. Never throws — see spec/notify.pseudo.md.
from __future__ import annotations

import asyncio
import logging
import smtplib
from email.mime.text import MIMEText

from schift_payment_kit_core import Notification

from .templates import Locale, render_notification

log = logging.getLogger("schift_payment_kit_notify")


class SmtpNotifier:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        secure: bool = False,
        user: str | None = None,
        password: str | None = None,
        from_: str,
        to: str,
        locale: Locale = "en",
    ) -> None:
        self._host = host
        self._port = port
        self._secure = secure
        self._user = user
        self._password = password
        self._from = from_
        self._to = to
        self._locale = locale

    def _send_sync(self, recipient: str, subject: str, text: str) -> None:
        msg = MIMEText(text)
        msg["Subject"] = subject
        msg["From"] = self._from
        msg["To"] = recipient
        with smtplib.SMTP(self._host, self._port) as server:
            if self._secure:
                server.starttls()
            if self._user and self._password:
                server.login(self._user, self._password)
            server.sendmail(self._from, [recipient], msg.as_string())

    async def send(self, n: Notification) -> None:
        rendered = render_notification(n, self._locale)
        recipient = (n.payload or {}).get("email", self._to)
        try:
            await asyncio.to_thread(
                self._send_sync, recipient, rendered.subject, rendered.text
            )
        except Exception as e:  # noqa: BLE001 — never throw
            log.error("notify.smtp failed: %s", e)


def smtp(
    *,
    host: str,
    port: int,
    secure: bool = False,
    user: str | None = None,
    password: str | None = None,
    from_: str,
    to: str,
    locale: Locale = "en",
) -> SmtpNotifier:
    return SmtpNotifier(
        host=host,
        port=port,
        secure=secure,
        user=user,
        password=password,
        from_=from_,
        to=to,
        locale=locale,
    )
