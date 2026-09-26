"""Thin re-export -- see ../README.md. Full surface of schift_payment_kit_schema_postgres (PostgresRepo, PostgresLedgerStore,
PostgresLogger, migrate, consistency_check, prune_retention). Named `postgres` here (not
`schema_postgres`) to match the shorter submodule convention used by this facade's own
package name.
"""
from __future__ import annotations

from schift_payment_kit_schema_postgres import (
    MODULE_FILES,
    BalanceMismatch,
    MigrationFile,
    PgTable,
    PostgresLedgerStore,
    PostgresLogger,
    PostgresRepo,
    PruneRetentionResult,
    SchemaStatus,
    atomic,
    camel_to_snake,
    connection,
    consistency_check,
    current_tx,
    jsonb,
    load_migrations,
    migrate,
    prune_retention,
    schema_status,
    snake_to_camel,
    verify_schema,
    with_customer_transaction,
)

__all__ = [
    "MODULE_FILES",
    "BalanceMismatch",
    "MigrationFile",
    "PgTable",
    "PostgresLedgerStore",
    "PostgresLogger",
    "PostgresRepo",
    "PruneRetentionResult",
    "SchemaStatus",
    "atomic",
    "camel_to_snake",
    "connection",
    "consistency_check",
    "current_tx",
    "jsonb",
    "load_migrations",
    "migrate",
    "prune_retention",
    "schema_status",
    "snake_to_camel",
    "verify_schema",
    "with_customer_transaction",
]
