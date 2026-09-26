// spec/cs.pseudo.md — EC:A18 E1 E2 E14 J1-J5
import { Clock, CsCase, IdGen, LedgerStore, Policy, Pool, Repo, deserializeCsCase, runIdempotent, serializeCsCase } from '@schift/payment-kit-core';
import { escalate, OnCaseEvent, reject, resolve } from './cases.js';
import { LicenseReporter } from './metrics.js';

export interface RegrantPlan {
  customerId?: string;
  pool: Pool;
  amount: number;
  unitPriceMinor?: number | null;
  currency?: string | null;
  expiresAt?: Date | null;
  idempotencyKey?: string;
  reason?: string;
}

export interface RegrantInput {
  case: CsCase;
  ledger: LedgerStore;
  repo: Repo;
  policy: Policy;
  clock: Clock;
  ids: IdGen;
  plan: RegrantPlan;
  approvedBy?: string | null;
  onCaseEvent?: OnCaseEvent;
  /** EC:I5 — reports the resulting resolved_auto/rejected transition to the license server. */
  reporter?: LicenseReporter | null;
  /** EC:L5 — optional delivery-scoped id, merged into `reference.correlationId` on the grant
   *  entry this call writes when it resolves in 'auto' mode. */
  correlationId?: string;
}

/**
 * EC:A18 E1 E2 E14 — cs.regrant({case, ledger, repo, clock, plan}) -> CsCase
 * EC:J1-J5 — wrapped in runIdempotent so a retried regrant call replays the first CsCase instead
 * of re-resolving the case a second time. Default key reuses E1/E14's existing convention
 * (`plan.idempotencyKey ?? case.referenceId`) — regrant was already ledger-append-safe; this adds
 * Operation-level J2 (key reused with a genuinely different grant) / J3 (in-flight duplicate)
 * protection. The J2 payload deliberately only covers `{customerId, pool, amount}` — the fields
 * that actually change what lands in the ledger — not incidental fields like `reason` or
 * `unitPriceMinor`/`currency` presentation: EC:E14's "a late-arriving duplicate must always no-op"
 * contract must hold even if the retry's caller doesn't reproduce every optional field byte-for-byte.
 */
export async function regrant(input: RegrantInput): Promise<CsCase> {
  const { case: csCase, repo, clock, plan } = input;
  if (csCase.kind !== 'regrant' || (plan.customerId && plan.customerId !== csCase.customerId)
    || !Number.isSafeInteger(plan.amount) || plan.amount <= 0) {
    return reject({ case: csCase, reason: 'invalid regrant case, customer or amount', repo, clock, onCaseEvent: input.onCaseEvent, reporter: input.reporter });
  }
  const idemKey = plan.idempotencyKey ?? csCase.referenceId; // E1/E14 — original key; late webhook = no-op
  const previous = await repo.operations.get(idemKey);
  if (previous?.status !== 'done' && csCase.policySnapshot.cs.regrant.mode === 'manual_approve' && !input.approvedBy?.trim()) {
    return escalate({ case: csCase, repo, clock, reason: 'cs.regrant.mode=manual_approve, awaiting approval', onCaseEvent: input.onCaseEvent });
  }
  const key = idemKey; // EC:J5 — same key drives both the ledger append and the Operation record.

  const { result } = await runIdempotent<CsCase>({
    repo,
    clock,
    key,
    kind: 'cs.regrant',
    payload: {
      caseId: csCase.id,
      customerId: plan.customerId ?? csCase.customerId,
      pool: plan.pool,
      amount: plan.amount,
    },
    serialize: serializeCsCase,
    deserialize: deserializeCsCase,
    fn: () => doRegrant(input, idemKey),
  });
  return result;
}

async function doRegrant(input: RegrantInput, idemKey: string): Promise<CsCase> {
  const { case: csCase, ledger, repo, clock, plan, approvedBy, onCaseEvent, reporter, correlationId } = input;
  const mode = csCase.policySnapshot.cs.regrant.mode;

  if (mode === 'off') {
    return reject({ case: csCase, reason: 'cs.regrant.mode=off', repo, clock, onCaseEvent, reporter });
  }

  // mode == 'auto', or manual_approve with approvedBy set
  const result = await ledger.append({
    customerId: plan.customerId ?? csCase.customerId, pool: plan.pool, kind: 'grant', amount: plan.amount,
    unitPriceMinor: plan.unitPriceMinor ?? null, currency: plan.currency ?? null, expiresAt: plan.expiresAt ?? null,
    source: 'regrant', reference: { caseId: csCase.id, ...(correlationId ? { correlationId } : {}) }, idempotencyKey: idemKey, actor: 'cs',
    reason: plan.reason ?? `regrant: case ${csCase.id}`,
  });
  const decision = { granted: !result.duplicated, entryId: result.entry.id, idempotencyKey: idemKey, approvedBy: approvedBy ?? null };
  return resolve({ case: csCase, by: 'auto', decision, repo, clock, onCaseEvent, reporter }); // E2 — duplicated append still resolves
}
