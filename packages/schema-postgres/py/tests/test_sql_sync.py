"""The package ships a committed copy of the monorepo's sql/ (see scripts/sync-sql.mjs). A copy
rots silently, so assert byte equality with the source of truth on every test run."""

from __future__ import annotations

from pathlib import Path

_PKG_SQL = Path(__file__).resolve().parents[1] / "src" / "boilpayment_schema_postgres" / "sql"
_SOURCE_SQL = Path(__file__).resolve().parents[2] / "sql"  # packages/schema-postgres/sql
_CLI_SQL = Path(__file__).resolve().parents[4] / "apps" / "cli" / "templates" / "sql"


def test_bundled_sql_matches_the_source_of_truth():
    assert _SOURCE_SQL.is_dir(), f"source of truth missing: {_SOURCE_SQL}"
    source = {p.name: p.read_bytes() for p in sorted(_SOURCE_SQL.glob("*.sql"))}
    bundled = {p.name: p.read_bytes() for p in sorted(_PKG_SQL.glob("*.sql"))}
    assert source, "no .sql files found in the source of truth"
    assert bundled.keys() == source.keys(), (
        "bundled sql is out of sync — run `node packages/schema-postgres/scripts/sync-sql.mjs`; "
        f"missing={sorted(source.keys() - bundled.keys())} extra={sorted(bundled.keys() - source.keys())}"
    )
    drifted = [n for n in source if bundled[n] != source[n]]
    assert not drifted, (
        f"bundled sql differs from the source of truth for {drifted} — "
        "run `node packages/schema-postgres/scripts/sync-sql.mjs`"
    )


def test_affiliate_migration_matches_cli_template():
    source = (_SOURCE_SQL / "0016_affiliate_commissions.sql").read_bytes()
    bundled = (_PKG_SQL / "0016_affiliate_commissions.sql").read_bytes()
    cli = (_CLI_SQL / "0016_affiliate_commissions.sql").read_bytes()

    assert source == bundled == cli
