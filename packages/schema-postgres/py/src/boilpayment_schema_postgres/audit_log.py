"""EC:L1-L5 (docs/EDGE_CASES.md §L) -- durable audit trail. `PostgresLogger` implements core's
`Logger` (via `BaseLogger`, so every entry is already redacted -- EC:L2 -- before `write()` ever
sees it) and writes one row per `log()` call to `audit_log` (sql/0001_core.sql). Deliberately NOT
part of `Repo`/`PostgresRepo` -- its own store, so the CS timeline module (packages/cs) can query
it independently of the domain repo. Mirrors
packages/schema-postgres/ts/src/audit-log.ts exactly.
"""

from __future__ import annotations

import uuid
from typing import Any

from boilpayment_core import BaseLogger

from .mapping import jsonb
from .tx import connection


class PostgresLogger(BaseLogger):
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def write(self, entry: dict[str, Any]) -> None:
        fields = dict(entry)
        level = fields.pop("level")
        event = fields.pop("event")
        at = fields.pop("at")
        # customer_id/payment_id/subscription_id/case_id/correlation_id are promoted to real
        # columns for indexed lookups (EC:L1-L5); read via .get() (not popped) so they also stay
        # in `fields`, keeping the jsonb blob self-contained (matches the ts adapter).
        customer_id = fields.get("customerId")
        payment_id = fields.get("paymentId")
        subscription_id = fields.get("subscriptionId")
        case_id = fields.get("caseId")
        correlation_id = fields.get("correlationId")
        async with (
            connection(self._dsn, customer_id) as conn,
            conn.cursor() as cur,
        ):
            await cur.execute(
                """
                insert into audit_log
                  (id, at, level, event, customer_id, payment_id, subscription_id, case_id, correlation_id, fields)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    str(uuid.uuid4()),
                    at,
                    level,
                    event,
                    customer_id,
                    payment_id,
                    subscription_id,
                    case_id,
                    correlation_id,
                    jsonb(fields),
                ),
            )
