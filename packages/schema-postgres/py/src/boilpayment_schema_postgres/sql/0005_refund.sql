-- 0005_refund.sql
-- Tables: refunds, refund_attempts

create table if not exists refunds (
  id text primary key,
  payment_id text not null references payments (id),
  customer_id text not null references customers (id),
  amount_minor bigint not null, -- Money.amountMinor
  currency text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_ref text,
  credits_revoked bigint not null default 0, -- EC:B13 D4
  rule_id text not null, -- EC id that decided, e.g. 'D1'
  reason text,
  failure jsonb, -- PaymentFailure | null — EC:D12
  created_at timestamptz not null default now()
);
comment on table refunds is 'EC:D1-D15 — refund decision + execution record. rule_id = the EDGE_CASES.md id that decided eligibility.';
create index if not exists refunds_payment_id_idx on refunds (payment_id);
create index if not exists refunds_customer_id_idx on refunds (customer_id);

create table if not exists refund_attempts (
  id text primary key,
  refund_id text not null references refunds (id),
  attempted_at timestamptz not null default now(),
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_ref text,
  failure jsonb,
  extra jsonb -- e.g. Toss refundReceiveAccount — EC:D13
);
comment on table refund_attempts is
  'EC:D12 D13 — retry log for provider-side refund calls. Repeated failure escalates to a manual_payout CS case.';
create index if not exists refund_attempts_refund_id_idx on refund_attempts (refund_id);
