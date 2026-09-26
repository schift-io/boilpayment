// EC:J11 — canonical time in keys. Every idempotency / grant / period key built from a date uses
// `isoZ` (UTC, milliseconds, 'Z' — Date.toISOString()), identical in TS and Python and independent
// of the database session time zone. `keyMatchesInstant` also recognises keys written before this
// rule (Python `datetime.isoformat()` forms such as `+09:00` / `+00:00`), so an upgrade never
// grants a second time for a period granted under an old key.

export function isoZ(date: Date): string {
  return date.toISOString();
}

/** True when `key` is `prefix + <timestamp>` and that timestamp is the same instant as `at`. */
export function keyMatchesInstant(key: string, prefix: string, at: Date): boolean {
  if (key === prefix + isoZ(at)) return true;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(rest)) return false;
  const ms = Date.parse(rest);
  return Number.isFinite(ms) && ms === at.getTime();
}
