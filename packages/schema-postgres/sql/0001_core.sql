-- 0001_core.sql
-- Tables: customers, plans, plan_prices, subscriptions, payments, policy_snapshots
-- Mirrors packages/core/ts/src/types.ts §Domain entities (docs/ARCHITECTURE.md §3.3).
-- Ids are app-generated strings (IdGen), not DB-generated — primary keys are `text`.

create table if not exists customers (
  id text primary key,
  email text,
  provider_refs jsonb not null default '[]'::jsonb, -- ProviderRef[] = {provider, ref}[] — EC:E15
  status text not null default 'active' check (status in ('active', 'frozen', 'banned')),
  created_at timestamptz not null default now()
);
comment on table customers is 'EC:H1 H2 E15 — canonical customer record. provider_refs jsonb = ProviderRef[]';
create index if not exists customers_email_idx on customers (email) where email is not null;

create table if not exists plans (
  id text primary key,
  name text not null,
  interval text check (interval in ('month', 'year')), -- null = one-time (top-up) — EC:A8
  credits_per_period bigint not null default 0,
  usage_included bigint not null default 0,
  trial_days integer not null default 0
);
comment on table plans is 'EC:A8 A21 — plan catalog. interval null = one-time (top-up) plan';

create table if not exists plan_prices (
  plan_id text not null references plans (id) on delete cascade,
  currency text not null, -- ISO 4217 upper-case
  amount_minor bigint not null,
  provider_price_refs jsonb, -- Partial<Record<ProviderName, string>>
  primary key (plan_id, currency)
);
comment on table plan_prices is 'EC:E10 — per-currency price list for a plan; checkout rejects on currency mismatch';
create index if not exists plan_prices_plan_id_idx on plan_prices (plan_id);

create table if not exists subscriptions (
  id text primary key,
  customer_id text not null references customers (id),
  plan_id text not null references plans (id),
  provider text not null check (provider in ('stripe', 'polar', 'toss', 'portone')),
  provider_ref text not null,
  status text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  period_start timestamptz not null, -- Subscription.currentPeriod.start
  period_end timestamptz not null, -- Subscription.currentPeriod.end (exclusive)
  anchor_day integer not null, -- 1..31 original day-of-month — EC:G1
  cancel_at_period_end boolean not null default false,
  grace_until timestamptz, -- EC:A13-A17
  billing_key text, -- Toss/Portone self-scheduling
  scheduled_plan_id text references plans (id), -- pending downgrade / next_period change
  version integer not null default 0, -- EC:K1 optimistic lock (see PostgresRepo.subscriptions.put)
  created_at timestamptz not null default now()
);
comment on table subscriptions is 'EC:A1-A19 G1 — subscription state machine. period_start/period_end = currentPeriod';
create index if not exists subscriptions_customer_id_idx on subscriptions (customer_id);
create index if not exists subscriptions_plan_id_idx on subscriptions (plan_id);
create index if not exists subscriptions_status_idx on subscriptions (status);
create unique index if not exists subscriptions_provider_ref_idx on subscriptions (provider, provider_ref);

create table if not exists payments (
  id text primary key,
  customer_id text not null references customers (id),
  provider text not null check (provider in ('stripe', 'polar', 'toss', 'portone')),
  provider_ref text not null,
  subscription_id text references subscriptions (id),
  amount_minor bigint not null, -- Money.amountMinor
  currency text not null, -- Money.currency
  status text not null check (
    status in ('pending', 'requires_action', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'disputed')
  ),
  kind text not null check (kind in ('subscription', 'topup', 'overage')),
  period_start timestamptz, -- Payment.period (nullable)
  period_end timestamptz,
  occurred_at timestamptz not null,
  failure jsonb, -- PaymentFailure | null — EC:E9
  cash_receipt jsonb, -- CashReceiptRef | null — EC:K2-K7 (KR 현금영수증)
  raw jsonb -- provider payload, debugging only
);
comment on table payments is 'EC:E1-E15 D* — payment record. failure = PaymentFailure jsonb (normalized code — EC:E9)';
create index if not exists payments_customer_id_idx on payments (customer_id);
create index if not exists payments_subscription_id_idx on payments (subscription_id) where subscription_id is not null;
create unique index if not exists payments_provider_ref_idx on payments (provider, provider_ref);
create index if not exists payments_occurred_at_idx on payments (occurred_at);

create table if not exists policy_snapshots (
  id text primary key,
  policy jsonb not null,
  created_at timestamptz not null default now()
);
comment on table policy_snapshots is
  'EC:I8 — immutable Policy snapshot. cs_cases.policy_snapshot_id (0006) pins the policy in effect '
  'when a case opened, so later policy edits cannot change a pending decision. Normalizes CsCase.policySnapshot '
  '(embedded Policy in the TS/py type) into a shared, dedup-able row.';

create table if not exists operations (
  key text primary key, -- caller-provided or EC:J5-derived idempotency key; Operation.id == key
  kind text not null, -- e.g. 'lifecycle.upgrade' | 'refund.execute' | 'credits.topup' | 'cs.regrant'
  payload_hash text not null, -- sha256(stable-JSON(payload)) — EC:J2 same-key-different-payload guard
  status text not null default 'in_progress' check (status in ('in_progress', 'done', 'failed')),
  result jsonb, -- serialized result — only set when status = 'done'
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- EC:I9 finding (2026-09-09, cs.timeline) — number of times run_idempotent was invoked for this
  -- key (1 on first execution, +1 per replay of 'done' or re-run after 'failed'). Without this a
  -- 5x-retried (all replays) operation and a once-executed one look identical in storage.
  attempts integer not null default 1
);
comment on table operations is
  'EC:J1-J5 I9 — operation-level idempotency (mutating public operations retried after a network blip / '
  'worker restart replay their first result instead of re-executing). See packages/core/spec/core.pseudo.md '
  '[EC:J1 J2 J3 J4 J5] and docs/EDGE_CASES.md §J. EC:J4 — rows past policy.retention.operationDays (status '
  'done/failed only, never in_progress) are pruned by schema-postgres pruneRetention(); no automatic '
  'schedule, the app cron/batch owner calls it.';
create index if not exists operations_status_idx on operations (status);
create index if not exists operations_created_at_idx on operations (created_at);

-- EC:L1-L5 (docs/EDGE_CASES.md §L) — durable audit trail. `PostgresLogger` (ts/py, this package)
-- implements core's `Logger` interface and writes one row per log() call. `fields` only ever holds
-- ALREADY-REDACTED values (packages/core Logger.log() -> redact() runs before write() is called —
-- see packages/core/{ts,py}/src/logger.py `BaseLogger`), so this table is safe to query/export for
-- CS without a second redaction pass. Deliberately NOT part of the `Repo` interface (EC:H*
-- tables) — exposed as its own store so the CS timeline module can query it independently of the
-- domain repo. EC:L4 — rows past policy.retention.auditLogDays are pruned by schema-postgres
-- pruneRetention() (same batched-delete pattern as `operations` above); no automatic schedule.
-- Partitioning is still a v1 task.
create table if not exists audit_log (
  id text primary key,
  at timestamptz not null,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  event text not null, -- e.g. 'provider.request' | 'webhook.received' | 'ledger.append'
  customer_id text,
  payment_id text,
  subscription_id text,
  case_id text,
  correlation_id text,
  fields jsonb not null default '{}'::jsonb -- already-redacted extra fields (EC:L2)
);
comment on table audit_log is
  'EC:L1-L5 — audit/observability log. fields is pre-redacted (EC:L2) by the Logger implementation '
  'before this row is ever written. No FK constraints on customer_id/payment_id/subscription_id/'
  'case_id on purpose: a log line for a provider call that never resolved to a local row (e.g. a '
  'checkout that was abandoned before webhook delivery) must still be writable.';
create index if not exists audit_log_customer_id_at_idx on audit_log (customer_id, at);
create index if not exists audit_log_payment_id_idx on audit_log (payment_id) where payment_id is not null;
