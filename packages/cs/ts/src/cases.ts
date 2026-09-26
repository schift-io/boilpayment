// spec/cs.pseudo.md — EC:I3 I7 I8 I5
import { Clock, CsCase, CsCaseKind, CsCaseStatus, IdGen, Notification, Notifier, Policy, Repo } from '@schift/payment-kit-core';
import { LicenseReporter } from './metrics.js';

export const ACTIVE_STATUSES: readonly CsCaseStatus[] = ['open', 'needs_human'];
export const BILLABLE_STATUSES: readonly CsCaseStatus[] = ['resolved_auto', 'resolved_human', 'rejected'];

export interface CsMetricEvent {
  type: 'opened' | 'escalated' | 'resolved' | 'churn';
  case: CsCase;
  at: Date;
  churnReason?: string | null;
}
export type OnCaseEvent = (event: CsMetricEvent) => void;

export interface OpenCaseInput {
  customerId: string;
  kind: CsCaseKind;
  referenceId: string;
  policy: Policy;
  repo: Repo;
  clock: Clock;
  ids: IdGen;
  onCaseEvent?: OnCaseEvent;
}

/** EC:I7 I8 — cs.openCase({customerId, kind, referenceId, policy, repo, clock, ids}) -> CsCase */
export async function openCase(input: OpenCaseInput): Promise<CsCase> {
  const { customerId, kind, referenceId, policy, repo, clock, ids, onCaseEvent } = input;
  const existing = await repo.csCases.list({ customerId, kind, referenceId });
  const active = existing.find((c) => ACTIVE_STATUSES.includes(c.status));
  if (active) return active; // I7 dedupe

  const now = clock.now();
  const csCase: CsCase = {
    id: ids.newId(), customerId, kind, status: 'open', referenceId,
    policySnapshot: structuredClone(policy), // I8
    decision: null, churnReason: null, churnText: null, openedAt: now, resolvedAt: null,
  };
  await repo.csCases.put(csCase);
  onCaseEvent?.({ type: 'opened', case: csCase, at: now });
  return csCase;
}

export interface EscalateInput {
  case: CsCase;
  repo: Repo;
  clock: Clock;
  reason: string;
  notifier?: Notifier | null;
  onCaseEvent?: OnCaseEvent;
}

/** EC:I3 — cs.escalate(case, notifier, reason) -> needs_human + notifier 'cs.needs_human' */
export async function escalate(input: EscalateInput): Promise<CsCase> {
  const { case: csCase, repo, clock, reason, notifier, onCaseEvent } = input;
  csCase.status = 'needs_human';
  csCase.escalatedAt = clock.now(); // EC:I3 I9 — resolve() overwrites `decision`, so the moment needs its own field
  csCase.decision = { ...(csCase.decision ?? {}), escalateReason: reason };
  await repo.csCases.put(csCase);
  if (notifier) {
    const n: Notification = { type: 'cs.needs_human', customerId: csCase.customerId, payload: { caseId: csCase.id, kind: csCase.kind, reason } };
    await notifier.send(n);
  }
  onCaseEvent?.({ type: 'escalated', case: csCase, at: clock.now() });
  return csCase;
}

export interface ResolveInput {
  case: CsCase;
  by: 'auto' | 'human';
  decision: Record<string, unknown>;
  repo: Repo;
  clock: Clock;
  onCaseEvent?: OnCaseEvent;
  /** EC:I5 — reports this billable transition (resolved_auto/resolved_human) to the license server. */
  reporter?: LicenseReporter | null;
}

/** EC:resolve I5 — cs.resolve(case, by, decision) */
export async function resolve(input: ResolveInput): Promise<CsCase> {
  const { case: csCase, by, decision, repo, clock, onCaseEvent, reporter } = input;
  csCase.status = by === 'auto' ? 'resolved_auto' : 'resolved_human';
  csCase.decision = decision;
  csCase.resolvedAt = clock.now();
  await repo.csCases.put(csCase);
  onCaseEvent?.({ type: 'resolved', case: csCase, at: csCase.resolvedAt });
  if (reporter) {
    await reporter.reportCase({ caseId: csCase.id, kind: csCase.kind, status: csCase.status, tenantRef: csCase.customerId, occurredAt: csCase.resolvedAt });
  }
  return csCase;
}

export interface RejectInput {
  case: CsCase;
  reason: string;
  repo: Repo;
  clock: Clock;
  onCaseEvent?: OnCaseEvent;
  /** EC:I5 — reports this billable transition (rejected) to the license server. */
  reporter?: LicenseReporter | null;
}

/** cs.reject I5 — local extension (not a separate EC id) used by regrant/refundAssist for terminal denials. */
export async function reject(input: RejectInput): Promise<CsCase> {
  const { case: csCase, reason, repo, clock, onCaseEvent, reporter } = input;
  csCase.status = 'rejected';
  csCase.decision = { reason };
  csCase.resolvedAt = clock.now();
  await repo.csCases.put(csCase);
  onCaseEvent?.({ type: 'resolved', case: csCase, at: csCase.resolvedAt });
  if (reporter) {
    await reporter.reportCase({ caseId: csCase.id, kind: csCase.kind, status: csCase.status, tenantRef: csCase.customerId, occurredAt: csCase.resolvedAt });
  }
  return csCase;
}
