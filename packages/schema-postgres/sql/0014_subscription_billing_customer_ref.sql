-- 0014_subscription_billing_customer_ref.sql — EC:A60. Core follow-up (always applied).
-- The provider customer key a billing key was issued under (Toss customerKey). Renewal and upgrade
-- charges send it; Toss refuses a billing-key charge whose customerKey differs from the one the key
-- was issued for. Null when the sign-up gave none: charges then send the customer's provider
-- reference, else the local customer id. 0.2.0 is a fresh install; rows written by 0.1.0 are unsupported.
alter table subscriptions add column if not exists billing_customer_ref text;
