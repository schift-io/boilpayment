# schema-postgres — spec

Source of truth for `PostgresLedgerStore` / `PostgresRepo` (ts) and their py mirror. See
`docs/ARCHITECTURE.md` §3 (core contract), §5 (this module), §7 (idempotency keys) and
`docs/EDGE_CASES.md` for every EC id referenced below.

## Table list

| module file | tables |
|---|---|
| `0001_core.sql` | `customers` `plans` `plan_prices` `subscriptions` `payments` `policy_snapshots` |
| `0002_credits.sql` | `ledger_entries` `credit_balances` (+ `paykit_refresh_balance()`) |
| `0003_usage.sql` | `usage_events` `usage_periods` `usage_outbox` |
| `0004_webhook.sql` | `webhook_events` `outbox` |
| `0005_refund.sql` | `refunds` `refund_attempts` |
| `0006_cs.sql` | `cs_cases` `cs_events` `churn_reasons` `notifications` |

All ids are app-generated strings (`IdGen.newId()`), so every primary key is `text`, not a DB
sequence/identity. `reference`/`meta`/`raw`/`policy`/`headers`/`decision`/`failure`/`provider_refs`/
`expiring` are `jsonb`. All timestamps are `timestamptz`, stored and compared in UTC (EC:G3) —
localization happens at the display layer only.

**Normalization note**: `CsCase.policySnapshot` is an embedded `Policy` object in the TS/py type,
but the SQL schema stores it as `cs_cases.policy_snapshot_id → policy_snapshots.id` (dedup'd,
immutable rows). `PostgresRepo.csCases` resolves/creates the `policy_snapshots` row transparently
on `put()`/`get()` so callers still see a plain `CsCase` with `policySnapshot: Policy` inline —
this is the one table where `PgTable` is not a 1:1 column mirror. This is a proposed contract
deviation; see final report "계약 변경 제안".

**`cs_cases.decision` serialization note**: `CsCase.decision: dict[str, Any] | None` is an opaque
bag whose shape this package doesn't control — `cs.refundAssist`'s `resolve()` stores
`{"decision": RefundDecision(...), "refund": Refund(...)}`, real dataclass instances, and `Refund`
carries `created_at: datetime`. TS's `jsonb()` is safe as-is (`JSON.stringify` calls `Date.toJSON()`
automatically and TS domain objects are plain objects, not class instances with extra machinery),
but py's `jsonb()` (psycopg `Jsonb`) serializes via plain `json.dumps`, which raises `TypeError` on
both a raw dataclass instance and a `datetime` — reproduced against a real DB in
`py/tests/test_cs_cases_decision_serialization.py`. Fixed by `mapping.py`'s `json_safe(value)`
(recursively: dataclass -> dict via `dataclasses.asdict`, `datetime` -> ISO string, dict/list
recursed, everything else passthrough) — `CsCasesTable.put` now calls
`jsonb(json_safe(cs.decision))` instead of `jsonb(cs.decision)`. `InMemoryRepo` is unaffected (no
serialization at all). Any other jsonb column whose py-side type is similarly opaque (not a plain
dict this package assembled itself from primitives) should go through `json_safe` too.

---

## [EC:B5] consume — atomic multi-pool, multi-grant consumption

```pseudo
function consume(input: ConsumeInput) -> ConsumeResult:
  # input: { customerId, poolOrder, amount, idempotencyKey, meta, now, negativeBalance, negativeFloor }
  with db.transaction():
    # 1. Serialize per-customer. No separate lock table — pg_advisory_xact_lock is released
    #    automatically at commit/rollback (supabase lock-advisory.md).
    exec "select pg_advisory_xact_lock(hashtext($1))" [customerId]

    # 2. Idempotency check — same key already applied?
    existing = query "select * from ledger_entries where customer_id = $1 and idempotency_key = $2 limit 1" [customerId, idempotencyKey]   # EC:B20
    if existing:
      entries = query "select * from ledger_entries where customer_id = $1 and idempotency_key = $2" [customerId, idempotencyKey]   # EC:B20
      return { ok: true, entries, shortfall: 0, duplicated: true }

    remaining = amount
    writes = []   # [{ pool, grantId|null, amount (negative), expiresAt|null, unitPriceMinor|null }]

    # 3. Walk pools in caller order (poolOrder encodes EC:B3 consume_order upstream: the credits
    #    module resolves policy.credits.consumeOrder into a poolOrder + per-pool bucket ordering
    #    before calling this; this function just drains pools in the given order).
    for pool in poolOrder:
      if remaining <= 0: break

      # unexpired grant buckets for this pool, each bucket's live remaining computed inline
      # (grant.amount + sum of every prior ledger row whose reference.grantId = grant.id).
      buckets = query """
        select g.id as grant_id, g.expires_at, g.unit_price_minor,
               g.amount + coalesce((
                 select sum(le.amount) from ledger_entries le
                 where le.reference ->> 'grantId' = g.id
               ), 0) as remaining
        from ledger_entries g
        where g.customer_id = $1 and g.pool = $2 and g.kind = 'grant'
          and (g.expires_at is null or g.expires_at > $3)   -- EC:B14
        order by g.expires_at asc nulls last, g.created_at asc
        for update
      """ [customerId, pool, now]

      for bucket in buckets:
        if remaining <= 0: break
        take = min(remaining, bucket.remaining)
        if take <= 0: continue
        writes.append({ pool, grantId: bucket.grant_id, amount: -take,
                         expiresAt: bucket.expires_at, unitPriceMinor: bucket.unit_price_minor })
        remaining -= take

    shortfall = remaining
    if shortfall > 0:
      # 4. Negative-balance policy (EC:B4) — decide before writing anything.
      if negativeBalance == 'block':
        return { ok: false, entries: [], shortfall, duplicated: false }
      if negativeBalance == 'allow_to_floor':
        current_total = query "select coalesce(sum(amount),0) from ledger_entries where customer_id=$1" [customerId]
        allowed = max(0, (current_total - (amount - shortfall)) - negativeFloor)
        # clamp: only draw the pool-order pools further into the floor, tagged pool = last pool in order,
        # grantId = null (floor draws are not attributable to one grant)
        extra = min(shortfall, allowed)
        if extra > 0:
          writes.append({ pool: poolOrder[-1], grantId: null, amount: -extra, expiresAt: null, unitPriceMinor: null })
          shortfall -= extra
        if shortfall > 0: return { ok: false, entries: [], shortfall, duplicated: false }
      # allow_unbounded: draw the remainder from the last pool with grantId = null, no floor check
      if negativeBalance == 'allow_unbounded' and shortfall > 0:
        writes.append({ pool: poolOrder[-1], grantId: null, amount: -shortfall, expiresAt: null, unitPriceMinor: null })
        shortfall = 0

    # 5. Insert one ledger row per bucket drawn from — single INSERT, same transaction as the lock.
    entries = []
    for i, w in enumerate(writes):
      row = insert into ledger_entries
        (id, customer_id, pool, kind='consume', amount=w.amount, unit_price_minor=w.unitPriceMinor,
         expires_at=w.expiresAt, source='usage', reference=jsonb{...meta, grantId: w.grantId},
         idempotency_key = i==0 ? idempotencyKey : idempotencyKey + ':' + i,   # UNIQUE needs one real key + N sub-keys
         actor=meta.actor ?? 'app', reason=meta.reason, created_at=now)
      entries.append(row)

    exec "select paykit_refresh_balance($1)" [customerId]
    return { ok: true, entries, shortfall: 0, duplicated: false }
```

Notes:
- The `for update` on the grant-bucket query plus `pg_advisory_xact_lock` gives two layers: the
  advisory lock serializes all writers for a customer (cheap, no row contention across pools), the
  `for update` protects against a concurrent transaction that holds a *different* advisory lock
  hash bucket colliding with `hashtext()` (extremely unlikely, but free to keep).
- Splitting one logical consume into N ledger rows (one per grant bucket) is what makes EC:B8
  (per-grant unit price for refund calc) and the `expiring` bucket in `credit_balances` possible
  without re-deriving FIFO order from scratch on every refund/report.
- `idempotencyKey` must stay globally unique across the N rows of one logical consume; the store
  suffixes sub-rows (`:1`, `:2`, ...) but the **caller-visible key is the first row's key** — a
  repeat call with the same key is detected by matching that first row.

## [EC:B1 B2] append / grant, and balance refresh

```pseudo
function append(entry: NewLedgerEntry) -> AppendResult:
  with db.transaction():
    exec "select pg_advisory_xact_lock(hashtext($1))" [entry.customerId]
    existing = query "select * from ledger_entries where idempotency_key=$1" [entry.idempotencyKey]
    if existing: return { entry: existing, duplicated: true }
    row = insert into ledger_entries (...)   # single row: grant/revoke/expire/hold/release/adjust
    exec "select paykit_refresh_balance($1)" [entry.customerId]
    return { entry: row, duplicated: false }
```

`balance(customerId, pool?, now?)` reads `credit_balances` (fast path). If a row is missing (never
refreshed) it falls back to `paykit_refresh_balance()` once, then re-reads — this keeps `balance()`
correct even if a caller wrote via raw SQL or a migration seeded rows without going through `append`.

## [EC:H3] ledger immutability — append-only

```pseudo
TRIGGER paykit_ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  RAISE EXCEPTION 'ledger_entries is append-only (EC:H3)'
# 정정은 역분개 행(kind='adjust' 또는 'revoke')으로만 한다. PostgresLedgerStore 는 UPDATE/DELETE 를 발행하지 않는다.
# 구현: sql/0002_credits.sql (트리거) · ts/src/ledger-store.ts · py/.../ledger_store.py (append 만 사용)
```

## [EC:K1] subscriptions — optimistic lock on `put`

`subscriptions.version` (sql/0001_core.sql, `integer not null default 0`) makes a concurrent write
race — an upgrade racing a renewal webhook racing a dunning sweep racing the self-scheduling
Toss/Portone scheduler tick — fail loudly instead of one writer's change silently vanishing under
another's last-write-wins UPDATE. Same contract as `VersionedMemTable` (packages/core — the
InMemory reference implementation): `PostgresRepo.subscriptions` is a hand-written `Table<Subscription>`
(not the generic `PgTable`, which would upsert blindly) — `ts/src/repo.ts` `SubscriptionsTable` /
`py/.../repo.py` `SubscriptionsTable`.

```pseudo
function put(row: Subscription) -> Subscription:
  # 1. Common case: the row already exists — UPDATE guarded by the version the caller read.
  #    A single statement is the atomicity boundary; no explicit transaction/lock needed.
  updated = query """
    update subscriptions set <every column except id, version> = <row's values>,
      version = version + 1
    where id = $row.id and version = $row.version
    returning *
  """
  if updated: row.version = updated.version   # bump the caller's handle in place; return updated

  # 2. 0 rows affected by the UPDATE — either the row doesn't exist yet, or the version is stale.
  #    Re-read to tell the two apart.
  existing = query "select * from subscriptions where id = $row.id"

  if not existing:
    # 3. First put() for this id -> INSERT, version stored as given (normally 0).
    #    on conflict (id) do nothing guards a race where another put() inserted the same id
    #    between step 2's read and this INSERT.
    inserted = query "insert into subscriptions (...) values (...) on conflict (id) do nothing returning *"
    if inserted: row.version = inserted.version; return inserted
    # Lost the insert race — re-read and report as a conflict against whatever the winner wrote.
    raced = query "select * from subscriptions where id = $row.id"
    throw PaymentKitError('subscription_version_conflict', { id: row.id, expected: raced.version, got: row.version })

  # 4. Row exists but the UPDATE's WHERE didn't match -> genuine stale write.
  throw PaymentKitError('subscription_version_conflict', { id: row.id, expected: existing.version, got: row.version })
```

Regression coverage: `ts/test/subscriptions-concurrency.test.ts` · `py/tests/test_subscriptions_concurrency.py`
— two INDEPENDENT reads of the same row racing each other (exactly one write succeeds, the other
throws `subscription_version_conflict` with `details.expected`/`details.got`), and a same-object
read-once-write-twice case (a function that reads once and calls `put` twice on the SAME object
handle must keep working, since `put` bumps `row.version` in place after each successful write).

Call-site note: every lifecycle/webhook function that reads a `Subscription`, does `await` work,
then writes it back can now throw `subscription_version_conflict` where it previously silently
clobbered a concurrent writer. See `packages/lifecycle` final report "call-site audit" for which
call sites re-read-before-write or wrap in `lifecycle.retryOnVersionConflict` as a result, and
`docs/EDGE_CASES.md` row **K1**.

## [EC:H4] daily consistency check

```pseudo
function consistencyCheck(pool) -> Mismatch[]:
  rows = query """
    select le.customer_id, le.pool,
           sum(le.amount) - paykit_expired_remaining(le.customer_id, le.pool, now()) as ledger_sum,  # EC:B14 expired grants excluded
           coalesce(cb.available, 0) as snapshot_available
    from ledger_entries le
    left join credit_balances cb on cb.customer_id = le.customer_id and cb.pool = le.pool
    group by le.customer_id, le.pool, cb.available
    having sum(le.amount) <> coalesce(cb.available, 0)
  """
  return rows.map(r => { customerId: r.customer_id, pool: r.pool,
                          ledgerSum: r.ledger_sum, snapshotAvailable: r.snapshot_available,
                          diff: r.ledger_sum - r.snapshot_available })
```

Run once daily (cron, outside this package). A non-empty result is EC:H4 — open a
`cs_cases` row of `kind='reconcile_mismatch'` (done by the `cs` package, not here).

## Migrations

```pseudo
function migrate({ connectionString | pool, modules?: string[] }):
  ensure table paykit_migrations(name text primary key, applied_at timestamptz default now())
  files = loadMigrations(modules)   # ordered: 0001..0006, filtered to `modules` if given
  with db.transaction():
    exec "select pg_advisory_xact_lock(hashtext('paykit_migrations'))"   # avoid concurrent-migrate race
    for file in files:
      if not exists in paykit_migrations where name = file.name:
        exec file.sql
        insert into paykit_migrations (name) values (file.name)

function loadMigrations(modules?: string[]) -> {name, sql}[]:
  # modules: e.g. ['core','credits'] -> 0001_core.sql, 0002_credits.sql only.
  # Always includes 0001_core.sql (every other module FKs into customers/subscriptions/payments).
  return sql files under packages/schema-postgres/sql/*.sql, sorted by filename,
         filtered to (name starts with '0001_core' or module in modules)
```

`apps/cli` (wizard) uses `loadMigrations` to copy only the chosen modules' `.sql` text into the
generated project's `paykit/migrations/` — it does not depend on a live DB connection.

## [EC:L1 L2 L3 L4 L5] PostgresLogger — audit_log store

`PostgresLogger` (ts `audit-log.ts` / py `audit_log.py`) implements core's `Logger` interface by
extending `BaseLogger` — every `LogEntry` reaching `write()` has already been through
`redact()` (packages/core `logger.ts`/`logger.py`, EC:L2), so this module never has to scrub
anything itself, only shape a row.

```pseudo
class PostgresLogger extends BaseLogger:
  constructor(pool | dsn)   # ts: node-pg Pool object. py: dsn string (matches PostgresLedgerStore).

  async write(entry: {level, event, at, ...fields}):
    customerId, paymentId, subscriptionId, caseId, correlationId =
      fields.customerId, fields.paymentId, fields.subscriptionId, fields.caseId, fields.correlationId
      # promoted to indexed columns for lookups; also LEFT IN `fields` — the jsonb blob stays
      # self-contained even if a caller only has the id, not the column list.
    insert into audit_log
      (id, at, level, event, customer_id, payment_id, subscription_id, case_id, correlation_id, fields)
    values (newId(), at, level, event, customerId, paymentId, subscriptionId, caseId, correlationId,
            jsonb(fields))
```

- **Not part of `Repo`/`PostgresRepo`.** Deliberate — `packages/cs` queries `audit_log` directly for
  the CS timeline rather than through the domain repo, per docs/EDGE_CASES.md §L.
- **EC:L3 tension, resolved at the boundary, not here.** `audit_log.fields` only ever contains
  already-redacted values. The one place raw provider bytes are kept is `webhook_events.raw_body`
  (sql/0001_core.sql, unrelated table) — needed byte-exact for signature re-verification. This
  module never reads or writes `raw_body`.
- **EC:L4 retention — enforced (2026-09-09) by `pruneRetention()` below**, same posture as
  `operations` (EC:J4). Partitioning is still not done (indexes only).
- Smoke-tested 2026-09-09 against a real local Postgres (`paykit_test_*`, dropped after): a
  `provider.request` entry carrying a card PAN and a 주민등록번호 landed in `audit_log.fields`
  already masked/redacted, with `customer_id`/`payment_id`/`correlation_id` correctly promoted to
  columns, in both ts and py.

## [EC:J4 L4] pruneRetention — bounded-batch deletion of operations + audit_log

Deletes rows past their retention window in bounded batches (default 1000 rows/statement) so a
large backlog cannot hold a table lock for minutes. `ledger_entries` is never a target — EC:H2/H3
(전자상거래법 5-year record-keeping) means the ledger is retained indefinitely, forever, by design.

```pseudo
pruneRetention({pool|dsn, policy, clock, dryRun=false, batchSize=1000}) -> {operationsDeleted, auditLogDeleted}:
  now = clock.now()
  operationsCutoff = now - policy.retention.operationDays days
  auditLogCutoff   = now - policy.retention.auditLogDays days

  if dryRun:
    return {
      operationsDeleted: count(operations where status in ('done','failed') and kind not in ('checkout.entitlement','purchase.entitlement','refund.provider') and created_at < operationsCutoff),
      auditLogDeleted:   count(audit_log where at < auditLogCutoff),
    }

  operationsDeleted = deleteInBatches(
    "delete from operations where key in (select key from operations
      where status in ('done','failed') and kind not in ('checkout.entitlement','purchase.entitlement','refund.provider') and created_at < $cutoff
      order by created_at asc limit $batchSize)",
    batchSize,
  )
  auditLogDeleted = deleteInBatches(
    "delete from audit_log where id in (select id from audit_log
      where at < $cutoff order by at asc limit $batchSize)",
    batchSize,
  )
  return {operationsDeleted, auditLogDeleted}

deleteInBatches(deleteSql, batchSize) -> int:
  total = 0
  loop:
    n = execute(deleteSql).rowsAffected
    total += n
    if n < batchSize: break   # fewer than a full batch => nothing left
  return total
```

- **EC:J4 — `status='in_progress'` is never matched by the WHERE clause, regardless of age.** A
  long-running or stuck in-flight operation is never pruned out from under a caller that might
  still be polling it.
- **`dryRun: true`** runs the count queries only — no DELETE — so an operator can preview the
  blast radius before running for real (e.g. from a CLI/cron wrapper).
- Batches are separate statements (not one transaction), matching `PostgresLedgerStore.consume()`'s
  batching philosophy elsewhere in this package: each DELETE commits (autocommit) immediately, so
  a crash mid-run loses at most one batch's progress, not the whole prune.
- **Why the default is 7 days, not 1**: pruning `operations` past the retention window re-opens the
  door to a duplicate replay of a very old retry (EC:J1-J3's idempotency guarantee only covers rows
  that still exist). 7 days gives real-world retry/backoff windows (webhook redelivery, worker
  restarts) comfortable headroom before that protection lapses.
- No automatic schedule is wired up here — the app's cron/batch layer calls `pruneRetention()` on
  whatever cadence it wants (daily is a reasonable default given the 7/90-day windows).
- Proven 2026-09-09 against a real local Postgres (`paykit_test_*`, dropped after): old `done`/
  `failed` operations and old `audit_log` rows are deleted; `in_progress` operations and
  within-window rows of both tables survive; `dryRun` leaves every row in place; a 5-row backlog
  with `batchSize=2` (3 statements) is fully drained — ts (`test/retention.test.ts`) and py
  (`tests/test_retention.py`).


## Atomic operation acquisition

`operations.claim(candidate)` uses `INSERT ... ON CONFLICT (key) DO UPDATE ... WHERE
operations.status='failed' AND operations.payload_hash=excluded.payload_hash RETURNING *`.
The insert starts attempts at one; a retry increments stored attempts and preserves original
creation time and kind. Only the returned-row caller may execute the operation. A conflict with
in-progress/done or a changed payload returns null for the caller to classify or replay.

`checkout.entitlement` and `purchase.entitlement` rows store purchase-time evidence, including
checkout lookup aliases. They are excluded from operation TTL counts and deletion regardless
of age; refund decisions must not lose their evidence when ordinary retry records expire.

`refund.provider` checkpoints are also exempt from operation TTL: a confirmed partial refund
must retain its provider result after the outer operation expires, preventing a second provider
request for the same refund key. Opaque Python operation results use the existing recursive
JSON conversion at persistence, matching JSON serialization of nested date values in TypeScript.

## Forward update 0007 — self-scheduled subscriptions

`0007_subscription_provider_ref_nullable.sql` only drops NOT NULL from
`subscriptions.provider_ref`. Self-scheduled subscriptions use a billing key and legitimately
have no provider subscription ID. Existing 0001 history and payment provider references remain
unchanged. Both loaders always append this core update in filename order; schema verification
reports it pending on older databases. No migration is applied automatically by these changes.

## [EC:B20] Idempotency keys are unique per customer

`ledger_entries` and `usage_events` enforce `unique (customer_id, idempotency_key)` (migrations
0009 and 0010 replace the global indexes from 0002/0003). Every duplicate lookup filters by
customer: a key another customer already used is a new operation for this customer, and the
first customer's rows are never returned. The in-memory stores key their maps the same way.


## [EC:B21] consume 멱등 조회는 정확한 일치

```pseudo
consume(input):
   existing = select * from ledger_entries
              where customer_id = input.customerId and kind = 'consume'
                and (consume_key = input.idempotencyKey
                     or (consume_key is null and idempotency_key = input.idempotencyKey))   # 0013 이전 행
   if existing: return { ok, entries: existing, duplicated: true }
   ... plan writes ...
   for i, w in writes:
      key = i == 0 ? input.idempotencyKey : 'consume-part:' + uuid()   # 호출자 키와 겹칠 수 없는 뒤쪽 행 키
      insert (..., idempotency_key = key, consume_key = input.idempotencyKey)
```

호출자 키를 LIKE 패턴으로 쓰지 않는다. 이전 구현(`idempotency_key like key || ':%'`)은 `topup`,
`%`, `_` 같은 키가 무관한 행에 걸려 차감 없이 중복으로 답했다.
