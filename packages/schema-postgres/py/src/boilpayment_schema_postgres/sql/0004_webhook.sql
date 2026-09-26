-- 0004_webhook.sql
-- Tables: webhook_events (PK = provider event id), outbox

create table if not exists webhook_events (
  id text primary key, -- provider event id — EC:B12 E2 E14 (re-delivery is a no-op)
  provider text not null check (provider in ('stripe', 'polar', 'toss', 'portone')),
  type text not null,
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  raw_body text not null,
  headers jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  attempts integer not null default 0,
  -- EC:I9 finding (2026-09-09, cs.timeline) — the LOCAL row this event is about, resolved by
  -- webhook.receive/process via (provider, provider_ref) lookup (EC:E3: never the provider
  -- adapter's own ref fields). null when unresolved. No FK constraint on purpose — a webhook for
  -- a checkout that was abandoned before any local row exists must still be storable.
  customer_id text,
  payment_id text,
  subscription_id text,
  -- EC:L5 — minted by webhook.receive as `corr_{id}` (deterministic across redeliveries),
  -- threaded by webhook.process into every handler invocation for this delivery. Nullable: rows
  -- written before this column existed have none.
  correlation_id text
);
comment on table webhook_events is
  'EC:E3-E5 E13 I9 L5 — durable webhook receipt log. Receive stores + returns 200 immediately; '
  'processing (handler dispatch, provider re-fetch — E3) happens async, tracked by status. '
  'customer_id/payment_id/subscription_id let a customer-scoped CS timeline query this table '
  'directly instead of a full table scan. correlation_id lets a delivery be traced end to end '
  '(ledger_entries.reference, audit_log.correlation_id).';
create index if not exists webhook_events_correlation_id_idx on webhook_events (correlation_id) where correlation_id is not null;
create index if not exists webhook_events_status_idx on webhook_events (status) where status in ('received', 'processing', 'failed');
create index if not exists webhook_events_provider_idx on webhook_events (provider);
create index if not exists webhook_events_customer_id_received_at_idx on webhook_events (customer_id, received_at) where customer_id is not null;
create index if not exists webhook_events_payment_id_idx on webhook_events (payment_id) where payment_id is not null;

create table if not exists outbox (
  id text primary key,
  kind text not null, -- 'webhook.process' | 'notify' | ...
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
comment on table outbox is 'EC:E5 — generic async outbox for webhook.process retries and other deferred work.';
create index if not exists outbox_due_idx on outbox (next_attempt_at) where status = 'pending';
