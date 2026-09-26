"""Migration runner + SQL-file loader. Mirrors ts/src/migrate.py. See
spec/schema-postgres.pseudo.md "Migrations".
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

MODULE_FILES: dict[str, str] = {
    "core": "0001_core.sql",
    "credits": "0002_credits.sql",
    "usage": "0003_usage.sql",
    "webhook": "0004_webhook.sql",
    "refund": "0005_refund.sql",
    "cs": "0006_cs.sql",
    "iap": "0008_iap.sql",  # EC:N1 -- only for projects with an in-app purchase store
}

_PKG_DIR = Path(__file__).resolve().parent
# Two candidate locations, tried in order:
#  1. <pkg>/sql — where a real wheel has the files (pyproject.toml `force-include`), or where a
#     local build/copy step placed them.
#  2. packages/schema-postgres/sql — the monorepo source of truth, used directly in an editable
#     install (`uv sync` / workspace member) where force-include never runs.
_CANDIDATES = [_PKG_DIR / "sql", _PKG_DIR.parents[2] / "sql"]


def _sql_dir() -> Path:
    for c in _CANDIDATES:
        if c.is_dir():
            return c
    raise FileNotFoundError(
        "schema-postgres sql/ directory not found; tried: "
        + ", ".join(str(c) for c in _CANDIDATES)
    )


class MigrationFile:
    def __init__(self, name: str, sql: str) -> None:
        self.name = name
        self.sql = sql


# Follow-up migrations of a module, applied with it (EC:B20: per-customer idempotency keys).
MODULE_UPDATES: dict[str, tuple[str, ...]] = {
    "credits": ("0009_ledger_idempotency_per_customer.sql",),
    "usage": ("0010_usage_idempotency_per_customer.sql",),
}

# Modules applied only when asked for by name (EC:N1): a default migrate() keeps its schema.
OPT_IN_MODULES: tuple[str, ...] = ("iap",)


def load_migrations(modules: list[str] | None = None) -> list[MigrationFile]:
    """Loads the .sql text for the requested modules (default: all), always including
    0001_core.sql since every other module's tables FK into customers/subscriptions/payments."""
    wanted = set(modules) if modules else {m for m in MODULE_FILES if m not in OPT_IN_MODULES}
    wanted.add("core")
    wanted_files = {file for mod, file in MODULE_FILES.items() if mod in wanted}
    wanted_files.add("0007_subscription_provider_ref_nullable.sql")
    for mod, updates in MODULE_UPDATES.items():
        if mod in wanted:
            wanted_files.update(updates)
    sql_dir = _sql_dir()
    files = sorted(p.name for p in sql_dir.glob("*.sql"))
    return [
        MigrationFile(name, (sql_dir / name).read_text())
        for name in files
        if name in wanted_files
    ]


async def migrate(
    *,
    conninfo: str | None = None,
    conn: psycopg.AsyncConnection | None = None,
    modules: list[str] | None = None,
) -> dict[str, list[str]]:
    """Applies the selected modules' migrations, tracked in paykit_migrations so re-running is a
    no-op. Wrapped in an advisory lock so two concurrent migrate() calls don't race."""
    owns_conn = conn is None
    connection = conn or await psycopg.AsyncConnection.connect(
        conninfo, autocommit=False, row_factory=dict_row
    )
    applied: list[str] = []
    try:
        async with connection.cursor() as cur:
            await cur.execute(
                "select pg_advisory_xact_lock(hashtext('paykit_migrations'))"
            )
            await cur.execute(
                "create table if not exists paykit_migrations (name text primary key, applied_at timestamptz not null default now())"
            )
            await cur.execute("select name from paykit_migrations")
            done = {r["name"] for r in await cur.fetchall()}
            for file in load_migrations(modules):
                if file.name in done:
                    continue
                await cur.execute(file.sql)
                await cur.execute(
                    "insert into paykit_migrations (name) values (%s)", (file.name,)
                )
                applied.append(file.name)
        if owns_conn:
            await connection.commit()
    except Exception:
        if owns_conn:
            await connection.rollback()
        raise
    finally:
        if owns_conn:
            await connection.close()
    return {"applied": applied}


@dataclass(kw_only=True, slots=True)
class SchemaStatus:
    expected: list[str]
    applied: list[str]
    pending: list[str]
    unknown: list[str]
    ok: bool


async def schema_status(
    *,
    conninfo: str | None = None,
    conn: psycopg.AsyncConnection | None = None,
    modules: list[str] | None = None,
) -> SchemaStatus:
    """What this build of the SDK expects vs what the database actually has.

    The failure this exists to prevent: upgrade the package, forget to migrate, and the first query
    that touches a new column dies in production with `column "..." does not exist`. Call it once at
    boot and refuse to start instead -- a startup failure with a fix in the message beats a 3am
    incident. Reading `paykit_migrations` is also how we detect a DB that is AHEAD of the code,
    which a plain "run the pending ones" check would miss entirely.
    """
    expected = [f.name for f in load_migrations(modules)]
    applied: list[str] = []

    async def _read(cursor: psycopg.AsyncCursor) -> None:
        try:
            await cursor.execute("select name from paykit_migrations order by name")
        except Exception as err:
            if getattr(err, "sqlstate", None) == "42P01" or "paykit_migrations" in str(err):
                return
            raise
        for row in await cursor.fetchall():
            applied.append(row["name"])

    if conn is not None:
        async with conn.cursor() as cur:
            await _read(cur)
    else:
        connection = await psycopg.AsyncConnection.connect(
            conninfo, autocommit=True, row_factory=dict_row
        )
        try:
            async with connection.cursor() as cur:
                await _read(cur)
        finally:
            await connection.close()

    applied_set, expected_set = set(applied), set(expected)
    pending = [n for n in expected if n not in applied_set]
    unknown = [n for n in applied if n not in expected_set]
    return SchemaStatus(
        expected=expected,
        applied=applied,
        pending=pending,
        unknown=unknown,
        ok=not pending and not unknown,
    )


async def verify_schema(
    *,
    conninfo: str | None = None,
    conn: psycopg.AsyncConnection | None = None,
    modules: list[str] | None = None,
) -> SchemaStatus:
    """Raises unless the database matches this build. Call it at boot, before serving traffic."""
    status = await schema_status(conninfo=conninfo, conn=conn, modules=modules)
    if status.pending:
        raise RuntimeError(
            f"paykit: database is behind this build -- {len(status.pending)} migration(s) not "
            f"applied ({', '.join(status.pending)}). Run `npx boilpayment migrate` before starting."
        )
    if status.unknown:
        raise RuntimeError(
            "paykit: database is AHEAD of this build -- it has migration(s) this version does not "
            f"ship ({', '.join(status.unknown)}). You likely downgraded the package; install a "
            "version at least as new as the one that migrated this database."
        )
    return status
