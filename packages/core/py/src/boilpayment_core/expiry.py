"""Append-only grant-expiry derivation."""

from __future__ import annotations

from datetime import datetime

from .types import LedgerEntry

GRACE_EXPIRY_EXTENSION_REASON = "SB-07 grace_expiry_extension"
GRACE_EXPIRY_RESTORE_REASON = "SB-07 grace_expiry_restore"
PAID_PERIOD_PRESERVED_REASON = "SB-07 paid_period_preserved"
GRACE_EXPIRY_END_REASON = "SB-08 grace_expiry_end"


def effective_grant_expiry(
    grant: LedgerEntry, entries: list[LedgerEntry]
) -> datetime | None:
    """Return the extended expiry capped by the first linked grace-end marker."""
    if grant.expires_at is None:
        return None
    extended_expiry = grant.expires_at
    first_grace_end: datetime | None = None
    for entry in entries:
        if (
            entry.kind == "adjust"
            and entry.amount == 0
            and entry.reference.grant_id == grant.id
            and entry.expires_at is not None
        ):
            if (
                entry.reason == GRACE_EXPIRY_EXTENSION_REASON
                and entry.expires_at > extended_expiry
            ):
                extended_expiry = entry.expires_at
            if entry.reason == GRACE_EXPIRY_END_REASON and (
                first_grace_end is None or entry.expires_at < first_grace_end
            ):
                first_grace_end = entry.expires_at
    if first_grace_end is None:
        return extended_expiry
    capped_end = max(grant.expires_at, first_grace_end)
    return min(extended_expiry, capped_end)
