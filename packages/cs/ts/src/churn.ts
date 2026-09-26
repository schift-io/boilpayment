// spec/cs.pseudo.md — EC:I4
import { Clock, CsCase, Repo } from 'boilpayment-core';
import { OnCaseEvent } from './cases.js';

export type ChurnReason =
  | 'too_expensive' | 'not_using' | 'missing_feature' | 'bugs' | 'switched_competitor' | 'temporary' | 'other';

export interface ChurnRecordInput {
  customerId: string;
  reason: ChurnReason;
  text?: string | null;
  /** CsCase already carries churnReason/churnText (core types.ts) — recorded onto it when given. */
  case?: CsCase | null;
  repo?: Repo | null;
  clock?: Clock | null;
  onCaseEvent?: OnCaseEvent;
}

export interface ChurnRecord { customerId: string; reason: ChurnReason; text: string | null; recordedAt: Date | null }

/**
 * EC:I4 — cs.churn.record({customerId, reason, text}). A bare customerId-only call (no `case`) has
 * nowhere to persist under the current Repo contract (no churn_reasons table) — see spec's contract-gap
 * note. When `case` is given, this writes onto CsCase.churnReason/churnText (always collected; surfacing
 * it to the merchant is a paid feature, per EC:I4 — this function only records, it never gates access).
 */
export async function record(input: ChurnRecordInput): Promise<ChurnRecord> {
  const { customerId, reason, text = null, case: csCase, repo, clock, onCaseEvent } = input;
  const now = clock?.now() ?? null;
  if (csCase) {
    csCase.churnReason = reason;
    csCase.churnText = text;
    if (repo) await repo.csCases.put(csCase);
    onCaseEvent?.({ type: 'churn', case: csCase, at: now ?? new Date(), churnReason: reason });
  }
  return { customerId, reason, text, recordedAt: now };
}
