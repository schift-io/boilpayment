-- 0013_ledger_consume_key.sql — EC:B21. Module `credits` follow-up.
-- consume() found its earlier rows with `idempotency_key = k or idempotency_key like k || ':%'`, so a
-- caller key that was a prefix of another key ('topup' vs 'topup:pay_1') or held LIKE wildcards
-- ('%', '_') matched unrelated rows and the consume was answered as a duplicate without a debit.
-- Every row a consume writes now carries the caller's key in consume_key, and the lookup is an exact
-- equality on it. Rows written before this migration have consume_key null; a retry of such a
-- consume still matches its first row by exact idempotency_key.
alter table ledger_entries add column if not exists consume_key text;
create index if not exists ledger_entries_customer_consume_key_idx
  on ledger_entries (customer_id, consume_key) where consume_key is not null;
