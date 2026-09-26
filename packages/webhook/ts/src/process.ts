// EC:E3 EC:E13 L5 — see spec/webhook.pseudo.md
import type { Clock, Logger, NormalizedEvent, NormalizedEventType, PaymentProvider, ProviderName, Repo } from '@schift/payment-kit-core';
import { resolveWebhookIdentity } from './identity.js';
import { mintCorrelationId } from './correlation.js';

export interface HandlerCtx {
  event: NormalizedEvent;
  provider: PaymentProvider;
  repo: Repo;
  clock: Clock;
  /** EC:L5 — this delivery's correlationId, minted by receive() (or here, defensively, for a
   * record written before this column existed). Threaded so every ledger append, provider call,
   * and log line for this delivery can be tied back to the webhook that produced it. */
  correlationId: string;
}
export type Handler = (ctx: HandlerCtx) => Promise<void>;
export type HandlerMap = Partial<Record<NormalizedEventType, Handler>>;

export interface ProcessInput {
  eventId: string;
  providers: Partial<Record<ProviderName, PaymentProvider>>;
  handlers: HandlerMap;
  repo: Repo;
  clock: Clock;
  /** EC:L1 L5 — optional; when given, logs `webhook.processing`/`webhook.processed`/
   * `webhook.failed` events carrying this delivery's correlationId. Omit and nothing is logged
   * (backward compatible with every existing caller). */
  logger?: Logger;
}

export async function process(input: ProcessInput): Promise<void> {
  const { eventId, providers, handlers, repo, clock, logger } = input;
  const record = await repo.webhookEvents.get(eventId);
  if (!record) return;

  // EC:L5 — defensive fallback for a record written before the correlationId column existed.
  const correlationId = record.correlationId ?? mintCorrelationId(record.id);

  record.status = 'processing';
  record.attempts += 1;
  await repo.webhookEvents.put(record);
  if (logger) {
    await logger.log({ level: 'info', event: 'webhook.processing', at: clock.now(), correlationId, provider: record.provider, eventId: record.id, attempts: record.attempts });
  }

  try {
    const rawProvider = providers[record.provider];
    if (!rawProvider) throw new Error(`no provider configured for ${record.provider}`);
    // EC:L5 — scope every provider call this handler invocation makes to this delivery's
    // correlationId. `withCorrelationId` is duck-typed (not part of the `PaymentProvider`
    // interface — see spec/webhook.pseudo.md [EC:L5]); providers that don't implement it are used
    // as-is, unchanged from before.
    const provider = typeof (rawProvider as { withCorrelationId?: unknown }).withCorrelationId === 'function'
      ? (rawProvider as PaymentProvider & { withCorrelationId(id: string): PaymentProvider }).withCorrelationId(correlationId)
      : rawProvider;
    // EC:E3 — re-verify/re-parse from the stored raw body, never trust cached payloads.
    const event = await provider.verifyWebhook({ headers: record.headers, rawBody: record.rawBody });
    // EC:I9 — re-resolve identity even on a re-process: a local row that didn't exist at receive()
    // time (e.g. checkout hadn't landed yet) may exist by now.
    const identity = await resolveWebhookIdentity(repo, provider, event);
    record.customerId = identity.customerId ?? record.customerId;
    record.paymentId = identity.paymentId ?? record.paymentId;
    record.subscriptionId = identity.subscriptionId ?? record.subscriptionId;
    const handler = handlers[event.type] ?? handlers['unknown'];
    if (handler) {
      await handler({ event, provider, repo, clock, correlationId });
    }
    record.status = 'processed';
    record.processedAt = clock.now();
    record.error = null;
    if (logger) {
      await logger.log({ level: 'info', event: 'webhook.processed', at: clock.now(), correlationId, provider: record.provider, eventId: record.id });
    }
  } catch (e) {
    record.status = 'failed';
    record.error = e instanceof Error ? e.message : String(e);
    if (logger) {
      await logger.log({ level: 'error', event: 'webhook.failed', at: clock.now(), correlationId, provider: record.provider, eventId: record.id, error: record.error });
    }
  }
  await repo.webhookEvents.put(record);
}

export interface ProcessPendingInput {
  repo: Repo;
  providers: Partial<Record<ProviderName, PaymentProvider>>;
  handlers: HandlerMap;
  clock: Clock;
  maxAttempts?: number;
  logger?: Logger;
}
export interface ProcessPendingResult {
  processed: number;
  failed: number;
}

export async function processPending(input: ProcessPendingInput): Promise<ProcessPendingResult> {
  const { repo, providers, handlers, clock, maxAttempts = 8, logger } = input;
  const received = await repo.webhookEvents.list({ status: 'received' });
  const failedRetryable = (await repo.webhookEvents.list({ status: 'failed' })).filter((r) => r.attempts < maxAttempts);
  const candidates = [...received, ...failedRetryable];

  let processed = 0;
  let failed = 0;
  for (const record of candidates) {
    await process({ eventId: record.id, providers, handlers, repo, clock, logger });
    const after = await repo.webhookEvents.get(record.id);
    if (after?.status === 'processed') processed += 1;
    else if (after?.status === 'failed') failed += 1;
  }
  return { processed, failed };
}
