# schift-payment-kit-schema-postgres

Postgres implementation of `schift-payment-kit-core`'s `Ledger`/`Repo` DI interfaces, migration
runner for the module SQL files (ships them inside the wheel — `schift_payment_kit_schema_postgres/sql/`),
a consistency checker (ledger vs. running balance), and a retention pruner for old operations/webhook rows.

## Install

```
pip install schift-payment-kit-schema-postgres
```

## Usage

```python
from schift_payment_kit_schema_postgres import migrate, PostgresRepo, PostgresLedgerStore

# Applies this package's bundled SQL migrations (idempotent, advisory-locked).
await migrate(conninfo=os.environ["DATABASE_URL"], modules=["core", "credits", "usage"])

repo = PostgresRepo(os.environ["DATABASE_URL"])
ledger = PostgresLedgerStore(os.environ["DATABASE_URL"])
```

Full module contract: [docs/ARCHITECTURE.md §5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
