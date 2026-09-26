-- 0003_usage.sql
-- Tables: usage_events, usage_periods, usage_outbox

create table if not exists usage_events (
  id text primary key,
  customer_id text not null references customers (id),
  meter text not null,
  quantity bigint not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  period_start timestamptz not null, -- EC:C2 — late-arrival attribution
  idempotency_key text not null,
  meta jsonb, -- EC:C7 — request_id / ip / user_agent for usage disputes
  constraint usage_events_idempotency_key_key unique (idempotency_key)
);
comment on table usage_events is
  'EC:C1-C9 — raw usage events; the local source of truth (EC:C4 — provider meter reporting is best-effort via usage_outbox).';
create index if not exists usage_events_customer_meter_period_idx on usage_events (customer_id, meter, period_start);

create table if not exists usage_periods (
  id text primary key,
  customer_id text not null references customers (id),
  subscription_id text not null references subscriptions (id),
  meter text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  included_quantity bigint not null default 0, -- EC:C5
  used_quantity bigint not null default 0,
  overage_quantity bigint not null default 0, -- EC:C1
  closed boolean not null default false,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint usage_periods_sub_meter_period_key unique (subscription_id, meter, period_start)
);
comment on table usage_periods is 'EC:C2 C5 C9 — per-period usage rollup backing usage.check / usage.close_period.';
create index if not exists usage_periods_customer_idx on usage_periods (customer_id);

create table if not exists usage_outbox (
  id text primary key,
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
comment on table usage_outbox is 'EC:C4 — retry queue for provider usage reporting (Stripe Billing Meter Events / Polar meters).';
create index if not exists usage_outbox_due_idx on usage_outbox (next_attempt_at) where status = 'pending';
