-- 0011_subscription_status_paused_incomplete.sql — EC:A27. Core follow-up (always applied).
-- Widens 0001's subscriptions.status check (kept immutable) for the two non-entitled states:
-- `paused` (trial ended without a payment method) and `incomplete` (first payment not made).
alter table subscriptions drop constraint if exists subscriptions_status_check;
alter table subscriptions add constraint subscriptions_status_check
  check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired', 'paused', 'incomplete'));
