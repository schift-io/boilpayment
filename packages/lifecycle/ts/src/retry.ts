// EC:K1 call-site helper. Not tied to one spec section — used wherever a handler holds a
// Subscription across an `await` that another writer (a webhook, a scheduler tick, a dunning
// sweep) could touch before the final `repo.subscriptions.put`.
import { PaymentKitError } from '@schift/payment-kit-core';

/**
 * Retries `fn` when it throws `PaymentKitError('subscription_version_conflict')` (thrown by
 * `PostgresRepo.subscriptions.put` / `VersionedMemTable.put` — see EC:K1), up to `attempts` times.
 * Any other error, or a conflict still present on the last attempt, propagates to the caller.
 *
 * `fn` owns re-reading whatever it needs BEFORE writing on each attempt (typically
 * `repo.subscriptions.get(id)`) — retrying with the same stale object just fails again with the
 * same conflict. This is deliberately generic (not "reread a Subscription and re-run X") because
 * every call site's "re-run" step differs (re-derive a grant amount, re-check a status transition,
 * etc.) — see the call sites in scheduler.ts and packages/webhook/ts/src/handlers.ts for the
 * re-read-then-retry pattern in practice.
 */
export async function retryOnVersionConflict<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PaymentKitError && err.code === 'subscription_version_conflict') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
