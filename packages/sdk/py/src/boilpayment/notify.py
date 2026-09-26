"""Thin re-export -- see ../README.md. Full surface of boilpayment_notify (resend, smtp, slack, composite, outbox).
"""
from __future__ import annotations

from boilpayment_notify import (
    CompositeNotifier,
    FlushNotifyOutboxResult,
    Locale,
    OutboxNotifier,
    Rendered,
    ResendNotifier,
    SlackNotifier,
    SmtpNotifier,
    composite,
    flush_notify_outbox,
    render,
    render_notification,
    resend,
    slack,
    smtp,
    templates,
    with_outbox,
)

__all__ = [
    "CompositeNotifier",
    "FlushNotifyOutboxResult",
    "Locale",
    "OutboxNotifier",
    "Rendered",
    "ResendNotifier",
    "SlackNotifier",
    "SmtpNotifier",
    "composite",
    "flush_notify_outbox",
    "render",
    "render_notification",
    "resend",
    "slack",
    "smtp",
    "templates",
    "with_outbox",
]
