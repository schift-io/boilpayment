# Optional CS usage reporting

`packages/cs` ships two license reporters:

- `NoopLicenseReporter` — the default. Reports nothing, never throws.
- `HttpLicenseReporter` — used by a generated project only when `cs.enabled` is on **and**
  `PAYKIT_API_KEY` is set. It reports resolved CS cases to a hosted Schift service.

Refunds, recovery, pending completion, overage settlement and CS case storage all run the same way
with either reporter. The kit's ledger, cases and decisions stay in your database.

## What the HTTP reporter sends

One request per case that reaches `resolved_auto`, `resolved_human` or `rejected` (EC:I5):

```http
POST {baseUrl}/cases
Authorization: Bearer <PAYKIT_API_KEY>
Content-Type: application/json

{
  "caseId": "id_5",
  "kind": "refund",
  "status": "resolved_auto",
  "tenantRef": "cust_2",
  "occurredAt": "2026-02-01T00:00:00.000Z"
}
```

| field | meaning |
|---|---|
| `caseId` | `CsCase.id`, the idempotency key. Re-sending the same id is safe. |
| `kind` | `CsCase.kind` (`regrant`, `refund`, `dispute`, `double_charge`, `refund_failed`, `reconcile_mismatch`) |
| `status` | the state the case just moved to |
| `tenantRef` | your customer id (`CsCase.customerId`), or `null` |
| `occurredAt` | `CsCase.resolvedAt` |

No payment amounts, card data or ledger rows leave your process.

## Failure behaviour

The reporter never throws into your request path. Network errors and non-2xx responses go to an
in-memory retry queue; pass `repo.outbox` to make the queue survive restarts.

## Configuration

| env | default |
|---|---|
| `PAYKIT_API_KEY` | unset (reporter falls back to `NoopLicenseReporter`) |
| `PAYKIT_API_BASE_URL` | the `HttpLicenseReporter` default `baseUrl` |
