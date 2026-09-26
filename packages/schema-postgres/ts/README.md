# @schift/payment-kit-schema-postgres

Postgres implementation of `@schift/payment-kit-core`'s `Ledger`/`Repo` DI interfaces, migration
runner for the module SQL files (ships them inside the package, see `dist/sql/`), a consistency
checker (ledger vs. running balance), and a retention pruner for old operations/webhook rows.

## Install

```
npm install @schift/payment-kit-schema-postgres @schift/payment-kit-core pg
```

## Usage

```ts
import { migrate, createPostgresRepo, PostgresLedgerStore } from '@schift/payment-kit-schema-postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Applies this package's bundled SQL migrations (idempotent, advisory-locked).
await migrate({ pool, modules: ['core', 'credits', 'usage'] });

const repo = createPostgresRepo(pool);
const ledger = new PostgresLedgerStore(pool);
```

Full module contract: [docs/ARCHITECTURE.md §5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
