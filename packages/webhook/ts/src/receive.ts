// EC:E4 EC:E5 L5 — see spec/webhook.pseudo.md
import type { Clock, Logger, PaymentProvider, Repo, WebhookEventRecord } from 'boilpayment-core';
import { WebhookSignatureError } from 'boilpayment-core';
import { resolveWebhookIdentity } from './identity.js';
import { mintCorrelationId } from './correlation.js';

export interface ReceiveInput {
  provider: PaymentProvider;
  headers: Record<string, string>;
  rawBody: string;
  repo: Repo;
  clock: Clock;
  /** EC:L1 L5 — optional; when given, logs a `webhook.received` event carrying the minted
   * correlationId. Omit and nothing is logged (backward compatible with every existing caller). */
  logger?: Logger;
  /** EC:E18 — the peer address from the app's socket (for IP-allowlisted providers such as Toss). */
  remoteAddress?: string;
}

export interface ReceiveResult {
  status: 200 | 400;
  eventId: string | null;
  duplicated: boolean | null;
}

export async function receive(input: ReceiveInput): Promise<ReceiveResult> {
  const { provider, headers, rawBody, repo, clock, logger, remoteAddress } = input;

  let event;
  try {
    event = await provider.verifyWebhook({ headers, rawBody, ...(remoteAddress ? { remoteAddress } : {}) }); // EC:E4 E18
  } catch (e) {
    if (e instanceof WebhookSignatureError) {
      return { status: 400, eventId: null, duplicated: null }; // nothing stored
    }
    throw e;
  }

  const existing = await repo.webhookEvents.get(event.id);
  if (existing) {
    return { status: 200, eventId: event.id, duplicated: true }; // EC:E5 dedupe
  }

  // EC:I9 — best-effort at first sighting; process() re-resolves later once more local rows exist.
  const identity = await resolveWebhookIdentity(repo, provider, event);
  // EC:L5 — minted here, deterministic from the provider event id (`corr_{id}`) so a redelivery of
  // the same event mints the same correlationId, no state needed. Threaded by process() into every
  // handler invocation, ledger append, and provider call for this delivery.
  const correlationId = mintCorrelationId(event.id);
  const record: WebhookEventRecord = {
    id: event.id,
    provider: provider.name,
    type: event.type,
    status: 'received',
    rawBody,
    headers,
    receivedAt: clock.now(),
    processedAt: null,
    error: null,
    attempts: 0,
    customerId: identity.customerId,
    paymentId: identity.paymentId,
    subscriptionId: identity.subscriptionId,
    correlationId,
  };
  await repo.webhookEvents.put(record);
  if (logger) {
    await logger.log({ level: 'info', event: 'webhook.received', at: clock.now(), correlationId, provider: provider.name, eventId: event.id, eventType: event.type });
  }

  return { status: 200, eventId: event.id, duplicated: false }; // EC:E5 — 200 immediately, process() runs async
}
