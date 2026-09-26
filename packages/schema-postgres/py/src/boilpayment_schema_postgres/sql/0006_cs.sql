-- 0006_cs.sql
-- Tables: cs_cases, cs_events, churn_reasons, notifications

create table if not exists cs_cases (
  id text primary key,
  customer_id text not null references customers (id),
  kind text not null check (kind in ('regrant', 'refund', 'dispute', 'double_charge', 'refund_failed', 'reconcile_mismatch')),
  status text not null check (status in ('open', 'needs_human', 'resolved_auto', 'resolved_human', 'rejected')),
  reference_id text not null,
  -- Normalizes CsCase.policySnapshot (embedded Policy in TS/py) into a shared row — see 0001_core.sql policy_snapshots.
  policy_snapshot_id text not null references policy_snapshots (id),
  decision jsonb,
  churn_reason text,
  churn_text text,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- EC:I9 finding (2026-09-09) — when escalate() moved this case to needs_human, distinct from
  -- resolved_at (which resolve() sets). Nullable, filled by packages/cs.
  escalated_at timestamptz
);
comment on table cs_cases is
  'EC:A18 E1 E2 E14 I1-I8 I9 — CS case queue. policy_snapshot_id pins the policy in effect when the case opened (EC:I8).';
-- EC:I7 — only one open/needs_human case per (customer, kind, reference_id)
create unique index if not exists cs_cases_open_unique_idx on cs_cases (customer_id, kind, reference_id)
  where status in ('open', 'needs_human');
create index if not exists cs_cases_customer_idx on cs_cases (customer_id);
create index if not exists cs_cases_status_idx on cs_cases (status);

create table if not exists cs_events (
  id text primary key,
  case_id text not null references cs_cases (id),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  actor text not null,
  created_at timestamptz not null default now()
);
comment on table cs_events is 'EC:I5 — audit trail of state transitions/notes on a cs_case (billing unit is still 1 row in cs_cases).';
create index if not exists cs_events_case_id_idx on cs_events (case_id);

create table if not exists churn_reasons (
  id text primary key,
  customer_id text not null references customers (id),
  subscription_id text references subscriptions (id),
  reason text not null,
  text text,
  created_at timestamptz not null default now()
);
comment on table churn_reasons is 'EC:I4 — always collected on cancel/refund; exposed to the merchant only on the paid CS tier.';
create index if not exists churn_reasons_customer_idx on churn_reasons (customer_id);

create table if not exists notifications (
  id text primary key,
  type text not null check (
    type in (
      'payment.failed', 'grace.started', 'grace.ending', 'subscription.canceled', 'refund.executed',
      'cs.needs_human', 'reconcile.mismatch', 'card.expiring', 'usage.soft_cap'
    )
  ),
  customer_id text references customers (id),
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);
comment on table notifications is 'EC:A13-A17 D8 H4 I3 — sent-notification audit log (Notifier.send).';
create index if not exists notifications_customer_idx on notifications (customer_id) where customer_id is not null;
