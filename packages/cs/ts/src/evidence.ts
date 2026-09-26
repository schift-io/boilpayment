// spec/cs.pseudo.md — EC:B18
//
// Chargeback evidence workflow. cs.dispute (dispute.ts, EC:B11 D9) already freezes/revokes/
// restores credits and escalates the case to a human — this module adds the missing piece the
// audit flagged (2026-09-09 edge-case audit #4): collecting what the kit already knows
// about a disputed payment into the checklist a card network expects, tracking the network's
// deadline, and (when the provider supports it) submitting it programmatically.
//
// Honesty over completeness: every item the kit cannot actually back with data comes back
// `available: false` with a `reason`, never a fabricated value.
import {
  Clock, CsCase, LedgerEntry, LedgerStore, Notifier, Payment, Policy, Refund, Repo, Subscription, UsageEvent,
} from '@schift/payment-kit-core';
import { ACTIVE_STATUSES, escalate, OnCaseEvent } from './cases.js';

// ── Public types ─────────────────────────────────────────────────────────────────────────

export type EvidenceItemKey =
  | 'payment_record' | 'proof_of_delivery' | 'proof_of_usage' | 'usage_events'
  | 'customer_acceptance' | 'refund_communication' | 'case_trail';

export interface EvidenceItem {
  key: EvidenceItemKey;
  label: string;
  required: boolean;
  available: boolean;
  value?: unknown;
  /** Set whenever available === false — the honest reason the kit does not have this item. */
  reason?: string;
}

export interface EvidenceRecord {
  items: EvidenceItem[];
  dueAt: string; // ISO — dispute case openedAt + policy.dispute.evidenceDueDays
  collectedAt: string; // ISO
  submittedAt?: string; // ISO — set only once cs.evidence.submit succeeds
  providerRef?: string | null;
}

export interface ChecklistInput {
  case: CsCase;
  payment: Payment | null;
  sub?: Subscription | null;
  repo: Repo;
  ledger: LedgerStore;
  policy: Policy;
  clock: Clock;
}

// ── Deadline ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** EC:B18 — dueAt = the dispute case's own openedAt + its policySnapshot's evidenceDueDays, so a
 *  later policy change never moves a deadline a case was already given (EC:I8 pattern). */
export function evidenceDueAt(csCase: CsCase): Date {
  const days = csCase.policySnapshot.dispute.evidenceDueDays;
  return new Date(csCase.openedAt.getTime() + days * DAY_MS);
}

// ── checklist ────────────────────────────────────────────────────────────────────────────

/**
 * EC:B18 — cs.evidence.checklist({case, payment, sub, repo, ledger, policy, clock}) -> EvidenceItem[]
 * Derives the checklist entirely from what the kit already knows; never invents data.
 */
export async function checklist(input: ChecklistInput): Promise<EvidenceItem[]> {
  const { case: csCase, payment, sub, repo, ledger } = input;
  const items: EvidenceItem[] = [];

  // 1 — the payment record and its provider refs.
  if (payment) {
    items.push({
      key: 'payment_record', label: 'Payment record and provider reference', required: true, available: true,
      value: {
        id: payment.id, provider: payment.provider, providerRef: payment.providerRef,
        amount: payment.amount, status: payment.status, kind: payment.kind, occurredAt: payment.occurredAt,
        subscriptionId: payment.subscriptionId,
      },
    });
  } else {
    items.push({
      key: 'payment_record', label: 'Payment record and provider reference', required: true, available: false,
      reason: 'no local payment record could be matched to this dispute',
    });
  }

  // 2/3 — ledger grant/consume history: for a credits business this is the strongest evidence
  // there is — grant = the goods were delivered, consume = the customer actually used them.
  let grantEntries: LedgerEntry[] = [];
  let consumeEntries: LedgerEntry[] = [];
  if (payment) {
    const all = await ledger.entries(csCase.customerId, { pool: 'paid' });
    grantEntries = all.filter((e) => e.kind === 'grant' && e.reference.paymentId === payment.id);
    const grantIds = new Set(grantEntries.map((g) => g.id));
    consumeEntries = all.filter((e) => e.kind === 'consume' && e.reference.grantId && grantIds.has(e.reference.grantId));
  }
  items.push(grantEntries.length > 0
    ? {
        key: 'proof_of_delivery', label: 'Proof of delivery — credits granted for this payment', required: true, available: true,
        value: grantEntries.map((e) => ({ id: e.id, amount: e.amount, createdAt: e.createdAt, expiresAt: e.expiresAt })),
      }
    : {
        key: 'proof_of_delivery', label: 'Proof of delivery — credits granted for this payment', required: true, available: false,
        reason: payment ? 'no ledger grant entries reference this payment' : 'no payment to look up grants for',
      });
  items.push(consumeEntries.length > 0
    ? {
        key: 'proof_of_usage', label: 'Proof of usage — the customer consumed the granted credits', required: true, available: true,
        value: consumeEntries.map((e) => ({ id: e.id, amount: e.amount, createdAt: e.createdAt })),
      }
    : {
        key: 'proof_of_usage', label: 'Proof of usage — the customer consumed the granted credits', required: true, available: false,
        reason: grantEntries.length > 0
          ? 'credits were granted but no consume entries exist against them yet'
          : 'no granted credits to have been consumed',
      });

  // 4 — usage events, when this is a usage-metered subscription.
  const usageEvents = sub
    ? await repo.usageEvents.list({ customerId: csCase.customerId } as Partial<UsageEvent>)
    : [];
  const scopedUsage = sub ? usageEvents.filter((e) => e.periodStart.getTime() >= sub.currentPeriod.start.getTime()) : [];
  items.push(scopedUsage.length > 0
    ? {
        key: 'usage_events', label: 'Metered usage events for the disputed period', required: false, available: true,
        value: scopedUsage.map((e) => ({ id: e.id, meter: e.meter, quantity: e.quantity, occurredAt: e.occurredAt })),
      }
    : {
        key: 'usage_events', label: 'Metered usage events for the disputed period', required: false, available: false,
        reason: sub ? 'no usage events recorded for the current period' : 'not a usage-metered subscription',
      });

  // 5 — customer's acceptance of terms. The kit has no such table — this is always an honest gap.
  items.push({
    key: 'customer_acceptance', label: 'Customer acceptance of terms of service', required: true, available: false,
    reason: 'not recorded by the kit — attach it from your own signup/terms-acceptance log if you have one',
  });

  // 6 — refund/communication history: attempts to resolve show good faith to the network.
  const refunds = payment ? await repo.refunds.list({ paymentId: payment.id } as Partial<Refund>) : [];
  items.push(refunds.length > 0
    ? {
        key: 'refund_communication', label: 'Refund requests and outcomes for this payment', required: false, available: true,
        value: refunds.map((r) => ({ id: r.id, status: r.status, amount: r.amount, reason: r.reason, createdAt: r.createdAt })),
      }
    : {
        key: 'refund_communication', label: 'Refund requests and outcomes for this payment', required: false, available: false,
        reason: 'no refund requests found for this payment',
      });

  // 7 — the cs_events trail: duck-typed against a `csEvents` table (schema-postgres §0006, not
  // part of the core Repo contract — same degrade pattern as reconcile.checkBalances'
  // `creditBalances`). Falls back to the case's own lifecycle fields, which are ALWAYS available
  // since `case` is a required input — this item is never a hard "no data" gap.
  const csEventsTable = (repo as unknown as { csEvents?: { list(filter: { caseId: string }): Promise<unknown[]> } }).csEvents;
  let trail: unknown[] | null = null;
  if (csEventsTable && typeof csEventsTable.list === 'function') {
    try {
      const rows = await csEventsTable.list({ caseId: csCase.id });
      if (rows.length > 0) trail = rows;
    } catch {
      trail = null;
    }
  }
  items.push({
    key: 'case_trail', label: 'CS case handling trail (internal record)', required: false, available: true,
    value: trail ?? {
      status: csCase.status, openedAt: csCase.openedAt, escalatedAt: csCase.escalatedAt ?? null,
      resolvedAt: csCase.resolvedAt, decision: csCase.decision,
    },
  });

  return items;
}

// ── collect ──────────────────────────────────────────────────────────────────────────────

export interface CollectInput extends ChecklistInput {
  onCaseEvent?: OnCaseEvent;
}

/**
 * EC:B18 — cs.evidence.collect({case, payment, sub, repo, ledger, policy, clock}) -> CsCase
 * Fills the checklist and stores it on `case.decision.evidence`. Idempotent: it is pure re-read +
 * a single `repo.csCases.put`, safe to call repeatedly (each call refreshes the checklist against
 * current data — no duplicate ledger writes, no duplicate escalations).
 */
export async function collect(input: CollectInput): Promise<CsCase> {
  const { case: csCase, repo, clock } = input;
  const items = await checklist(input);
  const record: EvidenceRecord = {
    items, dueAt: evidenceDueAt(csCase).toISOString(), collectedAt: clock.now().toISOString(),
  };
  csCase.decision = { ...(csCase.decision ?? {}), evidence: record };
  await repo.csCases.put(csCase);
  return csCase;
}

// ── due (cron) ───────────────────────────────────────────────────────────────────────────

export interface DueInput {
  repo: Repo;
  clock: Clock;
  notifier?: Notifier | null;
  onCaseEvent?: OnCaseEvent;
}

export interface DueCase {
  case: CsCase;
  dueAt: Date;
  hoursRemaining: number;
  incomplete: boolean;
}

function isIncomplete(csCase: CsCase): boolean {
  const record = (csCase.decision as { evidence?: EvidenceRecord } | null)?.evidence;
  if (!record) return true;
  return record.items.some((i) => i.required && !i.available);
}

/**
 * EC:B18 — cs.evidence.due({repo, clock}) -> DueCase[]. Meant to run off a cron. Scans open
 * dispute cases; when a case is inside 24h of its evidence deadline AND still missing a required
 * item, it (re-)escalates the case (cs.needs_human) so a human sees it before the network's clock
 * runs out, and returns it in the result.
 */
export async function due(input: DueInput): Promise<DueCase[]> {
  const { repo, clock, notifier, onCaseEvent } = input;
  const cases = await repo.csCases.list({ kind: 'dispute' } as Partial<CsCase>);
  const now = clock.now();
  const out: DueCase[] = [];
  for (const csCase of cases) {
    if (!ACTIVE_STATUSES.includes(csCase.status)) continue;
    const dueAt = evidenceDueAt(csCase);
    const hoursRemaining = (dueAt.getTime() - now.getTime()) / (60 * 60 * 1000);
    const incomplete = isIncomplete(csCase);
    if (hoursRemaining <= 24 && incomplete) {
      out.push({ case: csCase, dueAt, hoursRemaining, incomplete });
      await escalate({
        case: csCase, repo, clock, notifier: notifier ?? null,
        reason: `evidence due in ${Math.max(0, Math.round(hoursRemaining))}h, checklist incomplete`,
        onCaseEvent,
      });
    }
  }
  return out;
}

// ── submit ───────────────────────────────────────────────────────────────────────────────

/** EC:B18 — duck-typed against provider adapters that can submit evidence programmatically
 *  (Stripe has one; Toss/PortOne do not) — same pattern as refund.execute's `CashReceiptCanceler`. */
export interface DisputeEvidenceSubmitter {
  submitDisputeEvidence(input: { paymentRef: string; caseId: string; evidence: EvidenceItem[] }): Promise<{ providerRef?: string } | void>;
}

export interface SubmitInput extends ChecklistInput {
  /** Any provider — duck-typed for `submitDisputeEvidence`. */
  provider: unknown;
  notifier?: Notifier | null;
  onCaseEvent?: OnCaseEvent;
}

export interface SubmitResult {
  submitted: boolean;
  reason?: string;
  portalUrl?: string;
  providerRef?: string;
  case: CsCase;
}

/**
 * EC:B18 — cs.evidence.submit({case, payment, sub, provider, repo, ledger, policy, clock}) ->
 * {submitted, reason?, portalUrl?, providerRef?, case}. Never pretends a submission happened: a
 * provider without `submitDisputeEvidence` (or one that throws) always comes back
 * `submitted: false`, and the case is escalated with the checklist attached so a human can paste
 * it into the provider's dashboard.
 */
export async function submit(input: SubmitInput): Promise<SubmitResult> {
  const { case: csCase, payment, provider, repo, clock, notifier, onCaseEvent } = input;

  const existing = (csCase.decision as { evidence?: EvidenceRecord } | null)?.evidence;
  let record = existing;
  if (!record) {
    await collect(input);
    record = (csCase.decision as { evidence: EvidenceRecord }).evidence;
  }

  const submitter = provider as Partial<DisputeEvidenceSubmitter>;
  const portalUrl = typeof (provider as { disputePortalUrl?: unknown } | null)?.disputePortalUrl === 'string'
    ? (provider as { disputePortalUrl: string }).disputePortalUrl
    : undefined;

  if (typeof submitter.submitDisputeEvidence !== 'function') {
    const updated = await escalate({
      case: csCase, repo, clock, notifier: notifier ?? null,
      reason: 'evidence submission not supported by this provider — attach the checklist to the dashboard manually',
      onCaseEvent,
    });
    return { submitted: false, reason: 'provider_unsupported', portalUrl, case: updated };
  }

  if (!payment) {
    const updated = await escalate({
      case: csCase, repo, clock, notifier: notifier ?? null,
      reason: 'no payment record to submit evidence against', onCaseEvent,
    });
    return { submitted: false, reason: 'no_payment', case: updated };
  }

  try {
    const result = await submitter.submitDisputeEvidence({ paymentRef: payment.providerRef, caseId: csCase.id, evidence: record.items });
    const providerRef = (result as { providerRef?: string } | undefined)?.providerRef ?? null;
    csCase.decision = {
      ...(csCase.decision ?? {}),
      evidence: { ...record, submittedAt: clock.now().toISOString(), providerRef },
    };
    await repo.csCases.put(csCase);
    return { submitted: true, providerRef: providerRef ?? undefined, case: csCase };
  } catch (err) {
    const updated = await escalate({
      case: csCase, repo, clock, notifier: notifier ?? null,
      reason: `evidence submission failed: ${(err as Error).message ?? String(err)}`, onCaseEvent,
    });
    return { submitted: false, reason: 'submit_failed', portalUrl, case: updated };
  }
}
