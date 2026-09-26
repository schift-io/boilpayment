// Thin re-export — see ../README.md. Full surface of boilpayment-schema-postgres
// (PostgresRepo, PostgresLedgerStore, PostgresLogger, migrate, consistencyCheck, pruneRetention).
// Named `/postgres` here (not `/schema-postgres`) to match the shorter subpath convention used by
// this facade's own package name.
export * from 'boilpayment-schema-postgres';
