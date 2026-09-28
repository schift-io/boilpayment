"""Append-only grant-expiry derivation."""

from __future__ import annotations

from datetime import datetime

from .types import LedgerEntry

GRACE_EXPIRY_EXTENSION_REASON = "SB-07 grace_expiry_extension"
GRACE_EXPIRY_RESTORE_REASON = "SB-07 grace_expiry_restore"
PAID_PERIOD_PRESERVED_REASON = "SB-07 paid_period_preserved"


def effective_grant_expiry(
    grant: LedgerEntry, entries: list[LedgerEntry]
) -> datetime | None:
    """Return the latest linked SB-07 expiry; a null original expiry stays null."""
    if grant.expires_at is None:
        return None
    expiry = grant.expires_at
    for entry in entries:
        if (
            entry.kind == "adjust"
            and entry.amount == 0
            and entry.reason == GRACE_EXPIRY_EXTENSION_REASON
            and entry.reference.grant_id == grant.id
            and entry.expires_at is not None
            and entry.expires_at > expiry
        ):
            expiry = entry.expires_at
    return expiry
