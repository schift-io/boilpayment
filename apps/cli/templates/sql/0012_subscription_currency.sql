-- 0012_subscription_currency.sql — EC:A28. Core follow-up (always applied).
-- The currency a subscription was bought in; renewals, dunning retries and upgrade proration charge
-- the plan price in it. Null on rows written before it existed (they keep the plan's first price).
alter table subscriptions add column if not exists currency text;
