-- 0010_usage_idempotency_per_customer.sql — EC:B20. Module `usage` follow-up.
-- usage_events dedupe is per customer, like the ledger (0009).
alter table usage_events drop constraint if exists usage_events_idempotency_key_key;
alter table usage_events add constraint usage_events_customer_idempotency_key_key
  unique (customer_id, idempotency_key);
