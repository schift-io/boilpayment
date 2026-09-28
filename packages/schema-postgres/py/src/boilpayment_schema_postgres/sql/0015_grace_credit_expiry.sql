-- 0015_grace_credit_expiry.sql — SB-07 append-only grace-period expiry extensions.

create or replace function paykit_effective_grant_expiry(p_grant_id text, p_original timestamptz)
returns timestamptz as $$
  select case
    when p_original is null then null
    else greatest(
      p_original,
      coalesce((
        select max(le.expires_at)
        from ledger_entries le
        where le.kind = 'adjust'
          and le.amount = 0
          and le.reason = 'SB-07 grace_expiry_extension'
          and le.reference ->> 'grantId' = p_grant_id
      ), p_original)
    )
  end;
$$ language sql stable;

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
      and paykit_effective_grant_expiry(g.id, g.expires_at) is not null
      and paykit_effective_grant_expiry(g.id, g.expires_at) <= p_now
  ) r
  where r.remaining > 0;
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
      expiring = excluded.expiring,
      updated_at = excluded.updated_at;

  with grant_remaining as (
    select
      g.pool,
      paykit_effective_grant_expiry(g.id, g.expires_at) as expires_at,
      g.amount + coalesce(
        (select sum(le.amount) from ledger_entries le where le.reference ->> 'grantId' = g.id), 0
      ) as remaining
    from ledger_entries g
    where g.customer_id = p_customer_id
      and g.kind = 'grant'
      and paykit_effective_grant_expiry(g.id, g.expires_at) is not null
      and paykit_effective_grant_expiry(g.id, g.expires_at) > p_now
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

comment on function paykit_effective_grant_expiry (text, timestamptz) is
  'SB-07 — max original/linked grace expiry; a null original stays unbounded.';
