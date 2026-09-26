-- 0009_ledger_idempotency_per_customer.sql — EC:B20. Module `credits` follow-up.
-- Idempotency keys are scoped to the customer: another customer reusing a caller-chosen key is a
-- different operation, never a duplicate of the first customer's row. Replaces 0002's global
-- unique index; existing rows already satisfy the narrower constraint.
drop index if exists ledger_entries_idempotency_key_idx;
create unique index if not exists ledger_entries_customer_idempotency_key_idx
  on ledger_entries (customer_id, idempotency_key);
