-- 0014_subscription_billing_customer_ref.sql — EC:A60. Core follow-up (always applied).
-- The provider customer key a billing key was issued under (Toss customerKey). Renewal and upgrade
-- charges send it; Toss refuses a billing-key charge whose customerKey differs from the one the key
-- was issued for. Null on rows written before it existed (they keep sending the local customer id).
alter table subscriptions add column if not exists billing_customer_ref text;
