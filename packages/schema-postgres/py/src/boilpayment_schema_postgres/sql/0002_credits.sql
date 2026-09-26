-- 0002_credits.sql
-- Tables: ledger_entries (append-only), credit_balances (snapshot)
-- Function: paykit_refresh_balance(customer_id)
-- See spec/schema-postgres.pseudo.md for the atomic consume algorithm (EC:B5) that writes these rows.

create table if not exists ledger_entries (
  id text primary key,
  customer_id text not null references customers (id),
  pool text not null check (pool in ('paid', 'promo', 'trial')),
  kind text not null check (kind in ('grant', 'consume', 'revoke', 'expire', 'hold', 'release', 'adjust')),
  amount bigint not null, -- signed: grant + / consume,revoke,expire,hold − / release,adjust ±
  unit_price_minor bigint, -- EC:B8 — needed to price a partial refund of unused credits
  currency text,
  expires_at timestamptz, -- grant rows only; EC:B14 filters expires_at > now() at consume time
  source text not null check (
    source in (
      'subscription', 'topup', 'manual', 'regrant', 'refund', 'downgrade', 'dispute', 'trial', 'promo', 'usage',
      'rollover'
    )
  ),
  -- LedgerReference jsonb: {subscriptionId?, periodStart?(ISO), paymentId?, caseId?, grantId?, refundId?}
  -- consume/revoke/expire rows set reference.grantId to the specific grant bucket they drew down (EC:B8, B15 expiring buckets)
  reference jsonb not null default '{}'::jsonb,
  idempotency_key text not null, -- UNIQUE — EC:B12 duplicate webhook / duplicate consume request
  actor text not null, -- EC:B9 — 'system' | 'app' | admin user id
  reason text,
  created_at timestamptz not null default now()
);
comment on table ledger_entries is
  'EC:B1-B15 H3 — append-only credit ledger, the single source of truth for balances. '
  'amount is signed per kind. reference.grantId links a consume/revoke/expire row back to the grant it drew from.';

create unique index if not exists ledger_entries_idempotency_key_idx on ledger_entries (idempotency_key);
create index if not exists ledger_entries_customer_pool_expires_idx on ledger_entries (customer_id, pool, expires_at);
create index if not exists ledger_entries_customer_created_idx on ledger_entries (customer_id, created_at);
create index if not exists ledger_entries_grant_ref_idx on ledger_entries ((reference ->> 'grantId'))
  where reference ? 'grantId';
create index if not exists ledger_entries_kind_idx on ledger_entries (kind);

-- EC:H3 — ledger is append-only. Corrections are new reversing rows (kind='adjust'/'revoke'), never UPDATE/DELETE.
create or replace function paykit_reject_ledger_mutation() returns trigger as $$
begin
  raise exception 'ledger_entries is append-only (EC:H3): % not allowed on id=%', tg_op, coalesce(old.id, new.id)
    using errcode = 'integrity_constraint_violation';
end;
$$ language plpgsql;

drop trigger if exists ledger_entries_no_update on ledger_entries;
create trigger ledger_entries_no_update
  before update on ledger_entries
  for each row execute function paykit_reject_ledger_mutation();

drop trigger if exists ledger_entries_no_delete on ledger_entries;
create trigger ledger_entries_no_delete
  before delete on ledger_entries
  for each row execute function paykit_reject_ledger_mutation();

create table if not exists credit_balances (
  customer_id text not null references customers (id),
  pool text not null check (pool in ('paid', 'promo', 'trial')),
  available bigint not null default 0,
  held bigint not null default 0,
  expiring jsonb not null default '[]'::jsonb, -- ExpiringBucket[] = {expiresAt, amount}[]
  updated_at timestamptz not null default now(),
  primary key (customer_id, pool)
);
comment on table credit_balances is
  'EC:B15 — app-refreshed snapshot of ledger sums for fast balance() reads. '
  'Source of truth remains ledger_entries; see paykit_refresh_balance() and the daily consistency check (EC:H4).';

-- EC:B15 — recompute the (customer, pool) snapshot from ledger_entries. Call after append()/consume().
-- available = signed sum of every entry (hold/release already net out correctly by sign).
-- held      = outstanding (unreleased) hold amount.
-- expiring  = remaining unexpired amount per grant, grouped by expires_at (requires consume/revoke/expire
--             rows to carry reference.grantId — see spec §consume algorithm).
-- EC:B14 — remaining amount of grants that have already expired at p_now (per pool, or all pools when
-- p_pool is null). available = sum(amount) - this, so an expired-but-not-yet-batched grant never counts
-- (mirrors InMemoryLedger; expire_due() rows are bookkeeping only).
create or replace function paykit_expired_remaining(p_customer_id text, p_pool text, p_now timestamptz)
returns bigint as $$
  select coalesce(sum(r.remaining), 0)
  from (
    select g.amount + coalesce(
      (select sum(le.amount) from ledger_entries le where le.reference ->> 'grantId' = g.id), 0
    ) as remaining
    from ledger_entries g
    where g.customer_id = p_customer_id
      and (p_pool is null or g.pool = p_pool)
      and g.kind = 'grant'
      and g.expires_at is not null
      and g.expires_at <= p_now
  ) r
  where r.remaining > 0;
$$ language sql stable;

-- EC:B14 — live available across all pools (or one pool) at p_now, same definition as the snapshot.
create or replace function paykit_available(p_customer_id text, p_pool text, p_now timestamptz)
returns bigint as $$
  select coalesce((select sum(amount) from ledger_entries
                   where customer_id = p_customer_id and (p_pool is null or pool = p_pool)), 0)
         - paykit_expired_remaining(p_customer_id, p_pool, p_now);
$$ language sql stable;

create or replace function paykit_refresh_balance(p_customer_id text, p_now timestamptz default now()) returns void as $$
begin
  insert into credit_balances (customer_id, pool, available, held, expiring, updated_at)
  select
    p_customer_id,
    pool,
    coalesce(sum(amount), 0) - paykit_expired_remaining(p_customer_id, pool, p_now),
    coalesce(sum(case when kind = 'hold' then -amount when kind = 'release' then -amount else 0 end), 0),
    '[]'::jsonb,
    now()
  from ledger_entries
  where customer_id = p_customer_id
  group by pool
  on conflict (customer_id, pool) do update
  set available = excluded.available,
      held = excluded.held,
      expiring = excluded.expiring, -- reset to '[]' here; the block below fills it back in for
                                     -- pools that still have unexpired remaining grants. Without
                                     -- this, a pool whose last grant bucket hits remaining=0 keeps
                                     -- its previous (stale) expiring value forever, because the
                                     -- UPDATE ... FROM agg below only touches pools present in
                                     -- `agg`, which excludes any pool with no remaining>0 buckets.
      updated_at = excluded.updated_at;

  with grant_remaining as (
    select
      g.pool,
      g.expires_at,
      g.amount + coalesce(
        (select sum(le.amount) from ledger_entries le where le.reference ->> 'grantId' = g.id), 0
      ) as remaining
    from ledger_entries g
    where g.customer_id = p_customer_id
      and g.kind = 'grant'
      and g.expires_at is not null
      and g.expires_at > p_now
  ),
  bucketed as (
    select pool, expires_at, sum(remaining) as amount
    from grant_remaining
    where remaining > 0
    group by pool, expires_at
  ),
  agg as (
    select pool, jsonb_agg(jsonb_build_object('expiresAt', expires_at, 'amount', amount) order by expires_at) as expiring
    from bucketed
    group by pool
  )
  update credit_balances cb
  set expiring = agg.expiring
  from agg
  where cb.customer_id = p_customer_id and cb.pool = agg.pool;
end;
$$ language plpgsql;
comment on function paykit_refresh_balance (text, timestamptz) is
  'EC:B15 B14 — recompute credit_balances snapshot for one customer from ledger_entries as of p_now (expired grants excluded).';
