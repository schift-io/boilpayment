# Step 1 generated-project verification

This lane generates a new seller project from Wizard question answers, imports its actual
TypeScript/Python entry points, and calls the real PortOne provider adapter over loopback HTTP.
The provider server is a controlled fixture, not PortOne's sandbox or a live provider account.
No AI inference runs: execution follows captured purchase facts and configured seller rules.

```sh
pnpm run build
apps/cli/node_modules/.bin/tsx examples/e2e/step1-run.ts --python
apps/cli/node_modules/.bin/tsx examples/e2e/step1-run.ts --python --postgres
```

The default storage lane uses real in-memory repository/ledger implementations. `--postgres`
creates a unique `paykit_step1_<uuid>` database on **127.0.0.1:5432**, using the current OS user,
applies the package migrations to that new database, and uses the actual Postgres repository
and ledger adapters. It drops only the database it successfully created, including on failure.
It never accepts an existing database URL. The generated project directory and local HTTP
server are also removed/stopped on exit. PostgreSQL CLI tools and local login are prerequisites
for that optional lane; workspace packages and Python dependencies must already be installed.
CI may set `STEP1_POSTGRES_USER` to its local PostgreSQL role; the host and port remain fixed.

| Scenario | Observable assertions in both languages |
| --- | --- |
| Payment registered, grant webhook missing | Generated checkout captures 100-credit entitlement; payment registration persists verified purchase; recovery grants exactly 100 even after current plan changes to 900. |
| Recovery retry, late/duplicate paid webhook | Same purchase leaves exactly one grant and 100 available credits. |
| Rule-approved partial refund | 400 KRW provider refund, one stored successful refund, 40-credit removal and 60 available credits; same support request does not execute twice. |
| Amount above seller's automatic limit | 800 KRW request exceeds 500 KRW rule; original case needs a person and no refund executes. |
| Another customer's payment | Request is rejected with no additional provider refund. |
| Pending refund later succeeds | 40 credits remain held while pending; authoritative cancellation read confirms success, original refund ID survives, original CS case resolves automatically, balance stays 60 after duplicate notifications. |
| Pending refund later fails | Authoritative failed cancellation releases the hold, original refund becomes failed, original CS case remains actionable, balance returns to 100 after duplicate notifications. |
| Usage overage cron retried | 8 units minus 5 included at 10 KRW each creates exactly one 30 KRW provider charge and one local overage payment. |

Each process emits one JSON evidence record with language, storage lane and asserted outcomes.
Any mismatch exits nonzero. `--python-only` is available for debugging the Python lane.

Verified on 2026-09-10: both TypeScript and Python passed all seven emitted scenario groups
with in-memory storage, and both passed the same groups with the isolated Postgres database.
The Postgres run also exercised the nullable self-scheduled subscription reference migration
and persistence of nested refund decisions in idempotency records.

The purchase/recovery scenario is a one-time credit purchase. The metered subscription used for
usage billing is explicitly seeded with a known period and billing key. This does not prove
native subscription checkout, real browser/widget authorization, real provider acceptance,
deployment, process-crash recovery, or concurrent multi-process exactly-once behavior.

PortOne's failed-refund fixture uses a signed `Transaction.CancelPending` notification followed
by an authoritative cancellation lookup returning `FAILED`; it does not invent an undocumented
`Transaction.CancelFailed` webhook. The adapter must corroborate the final cancellation state.
