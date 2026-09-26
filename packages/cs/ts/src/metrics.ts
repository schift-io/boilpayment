// spec/cs.pseudo.md — Metrics (I4/I5 support), CaseMeter (I5), LicenseReporter
import { CsCase, CsCaseKind, CsCaseStatus, Repo } from '@schift/payment-kit-core';
import { BILLABLE_STATUSES, CsMetricEvent } from './cases.js';

export interface MetricsSnapshot {
  countsByKind: Partial<Record<CsCaseKind, number>>;
  countsByStatus: Partial<Record<CsCaseStatus, number>>;
  durationsMsByKind: Partial<Record<CsCaseKind, number[]>>;
  churnReasons: Record<string, number>;
}

/** In-memory `onCaseEvent` collector. Not persisted — a process-local view for dashboards/tests. */
export class Metrics {
  private readonly events: CsMetricEvent[] = [];

  /** Bind as `onCaseEvent` to openCase/escalate/resolve/reject/churn.record. */
  record = (event: CsMetricEvent): void => {
    this.events.push(event);
  };

  snapshot(): MetricsSnapshot {
    const countsByKind: Partial<Record<CsCaseKind, number>> = {};
    const countsByStatus: Partial<Record<CsCaseStatus, number>> = {};
    const durationsMsByKind: Partial<Record<CsCaseKind, number[]>> = {};
    const churnReasons: Record<string, number> = {};

    for (const e of this.events) {
      if (e.type === 'opened') {
        countsByKind[e.case.kind] = (countsByKind[e.case.kind] ?? 0) + 1;
      }
      if (e.type === 'escalated' || e.type === 'resolved') {
        countsByStatus[e.case.status] = (countsByStatus[e.case.status] ?? 0) + 1;
      }
      if (e.type === 'resolved' && e.case.resolvedAt) {
        const ms = e.case.resolvedAt.getTime() - e.case.openedAt.getTime();
        (durationsMsByKind[e.case.kind] ??= []).push(ms);
      }
      if (e.type === 'churn' && e.churnReason) {
        churnReasons[e.churnReason] = (churnReasons[e.churnReason] ?? 0) + 1;
      }
    }
    return { countsByKind, countsByStatus, durationsMsByKind, churnReasons };
  }
}

/** EC:I5 — 1 CsCase row = 1 billable unit once resolved_auto/resolved_human/rejected. */
export class CaseMeter {
  constructor(private readonly repo: Repo) {}

  async countBillable(filter?: Partial<CsCase>): Promise<number> {
    const cases = await this.repo.csCases.list(filter);
    return cases.filter((c) => BILLABLE_STATUSES.includes(c.status)).length;
  }
}

/** EC:I5 — one call per billable case transition (resolved_auto/resolved_human/rejected). */
export interface CaseReportInput {
  caseId: string;
  kind: CsCaseKind;
  status: CsCaseStatus;
  tenantRef?: string | null;
  occurredAt: Date;
}

/** GET {baseUrl}/entitlement response. Pricing/tiers are DB-based on Schift's server
 * (docs/CS_SERVER.md) — the SDK only reports usage and asks entitlement, never computes price. */
export interface Entitlement {
  tier: string;
  includedCasesPerMonth: number;
  usedThisMonth: number;
  overagePriceMinor: number;
  currency: string;
  hardLimit: boolean;
}

/**
 * EC:I5 — reports billable case transitions to Schift's server (API-key auth) and asks
 * entitlement. Implementations MUST be offline-safe: a failed reportCase/entitlement/heartbeat
 * call never throws into the caller's business logic (resolve/reject/regrant/refundAssist/dispute
 * all call this synchronously in their success path).
 */
export interface LicenseReporter {
  reportCase(input: CaseReportInput): Promise<void>;
  entitlement(): Promise<Entitlement | null>;
  heartbeat(): Promise<void>;
}

/** v0 stub — used by tests/smokes and as the default when no apiKey is configured. */
export class NoopLicenseReporter implements LicenseReporter {
  async reportCase(_input: CaseReportInput): Promise<void> {
    // no-op
  }
  async entitlement(): Promise<Entitlement | null> {
    return null;
  }
  async heartbeat(): Promise<void> {
    // no-op
  }
}

const DEFAULT_BASE_URL = 'https://api.schift.io/paykit/v1'; // placeholder — owner must confirm (docs/CS_SERVER.md)

export interface HttpLicenseReporterOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch (Node 18+). */
  fetch?: typeof fetch;
  /** When given, a reportCase that fails after retries is also queued to repo.outbox
   * (kind 'cs.license') so an app-level outbox sweeper can retry it independently of this
   * process's lifetime. */
  repo?: Repo | null;
}

/**
 * EC:I5 — real HTTP client for the CS SDK license server (docs/CS_SERVER.md). Offline-safe:
 * network/HTTP failures in reportCase/entitlement/heartbeat are caught and never thrown. A failed
 * reportCase is queued in-memory; call flush() to retry (e.g. from a cron/outbox sweeper).
 */
export class HttpLicenseReporter implements LicenseReporter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly repo: Repo | null;
  private readonly buffer: CaseReportInput[] = [];

  constructor(opts: HttpLicenseReporterOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.repo = opts.repo ?? null;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  private serialize(input: CaseReportInput): Record<string, unknown> {
    return {
      caseId: input.caseId, kind: input.kind, status: input.status,
      tenantRef: input.tenantRef ?? null, occurredAt: input.occurredAt.toISOString(),
    };
  }

  /** POST {baseUrl}/cases — idempotent by caseId on the server. Never throws. */
  async reportCase(input: CaseReportInput): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/cases`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(this.serialize(input)),
      });
      if (!res.ok) throw new Error(`cs license reportCase failed: HTTP ${res.status}`);
    } catch {
      await this.enqueue(input);
    }
  }

  private async enqueue(input: CaseReportInput): Promise<void> {
    this.buffer.push(input);
    if (this.repo) {
      await this.repo.outbox.put({
        id: `cs.license:${input.caseId}`,
        kind: 'cs.license',
        payload: this.serialize(input),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: input.occurredAt,
        createdAt: input.occurredAt,
      });
    }
  }

  /** Retries every queued reportCase. Items that still fail stay queued for the next flush(). */
  async flush(): Promise<{ sent: number; remaining: number }> {
    const pending = this.buffer.splice(0, this.buffer.length);
    let sent = 0;
    for (const item of pending) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/cases`, {
          method: 'POST', headers: this.headers(), body: JSON.stringify(this.serialize(item)),
        });
        if (!res.ok) throw new Error(`cs license reportCase failed: HTTP ${res.status}`);
        sent++;
        if (this.repo) {
          const row = await this.repo.outbox.get(`cs.license:${item.caseId}`);
          if (row) await this.repo.outbox.put({ ...row, status: 'sent' });
        }
      } catch {
        this.buffer.push(item);
      }
    }
    return { sent, remaining: this.buffer.length };
  }

  /** GET {baseUrl}/entitlement. Returns null on any failure (offline-safe). */
  async entitlement(): Promise<Entitlement | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/entitlement`, { headers: this.headers() });
      if (!res.ok) return null;
      return (await res.json()) as Entitlement;
    } catch {
      return null;
    }
  }

  /** POST {baseUrl}/heartbeat. Best-effort, never throws, no queueing (heartbeats are point-in-time). */
  async heartbeat(): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/heartbeat`, { method: 'POST', headers: this.headers() });
    } catch {
      // offline-safe — dropped silently
    }
  }
}
