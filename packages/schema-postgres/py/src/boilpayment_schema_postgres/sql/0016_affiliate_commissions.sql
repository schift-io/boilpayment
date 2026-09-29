-- 0016_affiliate_commissions.sql
-- Discount/link evidence and append-only affiliate commission accounting.

alter table payments add column if not exists sale_evidence jsonb;
alter table payments add column if not exists affiliate_id text;
alter table subscriptions add column if not exists affiliate_id text;

create table if not exists affiliate_commissions (
  id text primary key,
  affiliate_id text not null,
  payment_id text not null references payments (id),
  kind text not null check (kind in ('accrual', 'reversal')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null,
  refund_id text,
  related_commission_id text references affiliate_commissions (id),
  idempotency_key text not null unique,
  created_at timestamptz not null
);

comment on table affiliate_commissions is
  'AF-01..04 — append-only affiliate commission accruals and proportional refund reversals';
create index if not exists affiliate_commissions_affiliate_id_created_at_idx
  on affiliate_commissions (affiliate_id, created_at);
create index if not exists affiliate_commissions_payment_id_idx
  on affiliate_commissions (payment_id);
