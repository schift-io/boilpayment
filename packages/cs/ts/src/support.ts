import { runIdempotent, serializeCsCase, deserializeCsCase } from '@schift/payment-kit-core';
import type { Clock, CsCase, IdGen, LedgerStore, Notifier, Payment, PaymentProvider, Policy, ProviderName, Repo } from '@schift/payment-kit-core';
import { escalate, openCase, reject } from './cases.js';
import { getPurchaseSnapshot } from './purchaseSnapshot.js';
import type { LicenseReporter } from './metrics.js';
import type { OnCaseEvent } from './cases.js';

export interface SupportDeps {
  readonly policy: Policy;
  readonly providers: Partial<Record<ProviderName, PaymentProvider>>;
  readonly ledger: LedgerStore;
  readonly repo: Repo;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly notifier?: Notifier | null;
  readonly onCaseEvent?: OnCaseEvent;
  readonly reporter?: LicenseReporter | null;
}
export interface SupportPaymentInput extends SupportDeps {
  readonly customerId: string;
  readonly paymentId: string;
}
export type VerifiedSupportPayment =
  | { readonly ok: true; readonly case: CsCase; readonly payment: Payment; readonly provider: PaymentProvider }
  | { readonly ok: false; readonly case: CsCase };

/** Local ownership is authoritative; live provider facts must corroborate it before mutation. */
export async function verifySupportPayment(input: SupportPaymentInput & { readonly kind: 'refund' | 'regrant'; readonly caseKey?: string }): Promise<VerifiedSupportPayment> {
  const { repo, clock, ids, policy, customerId, paymentId, onCaseEvent } = input;
  const created = await runIdempotent({ repo, clock, key: `support-case:${input.kind}:${customerId}:${paymentId}:${input.caseKey ?? ''}`,
    kind: 'cs.supportCase', payload: { customerId, paymentId, kind: input.kind }, serialize: serializeCsCase, deserialize: deserializeCsCase,
    fn: () => openCase({ customerId, referenceId: paymentId, kind: input.kind, policy, repo, clock, ids, onCaseEvent }) });
  const csCase = await repo.csCases.get(created.result.id) ?? created.result;
  const payment = await repo.payments.get(paymentId);
  const customer = await repo.customers.get(customerId);
  if (!customer || !payment || payment.customerId !== customerId) {
    return { ok: false, case: await reject({ case: csCase, reason: 'customer payment not found', repo, clock, onCaseEvent, reporter: input.reporter }) };
  }
  const provider = input.providers[payment.provider];
  const customerRef = customer.providerRefs.find((ref) => ref.provider === payment.provider)?.ref;
  const hold = async (reason: string): Promise<VerifiedSupportPayment> => ({ ok: false, case: await escalate({ case: csCase, reason, repo, clock, notifier: input.notifier, onCaseEvent }) });
  if (!provider || provider.name !== payment.provider || !customerRef) return hold('payment provider ownership evidence is unavailable');
  try {
    const live = await provider.getPayment(payment.providerRef);
    const ownerMatches = live.customerId === customerId || live.customerId === customerRef;
    const listed = ownerMatches ? true : live.customerId === '' && (await provider.listPayments({ customerRef, since: new Date(payment.occurredAt.getTime() - 1) }))
      .some((candidate) => candidate.providerRef === payment.providerRef && candidate.amount.amountMinor === payment.amount.amountMinor && candidate.amount.currency === payment.amount.currency);
    if (!listed || live.providerRef !== payment.providerRef || live.provider !== payment.provider
      || live.amount.currency !== payment.amount.currency || live.amount.amountMinor !== payment.amount.amountMinor) {
      return hold('local payment and provider evidence disagree');
    }
    if (live.status !== 'succeeded' && live.status !== 'partially_refunded') return hold(`provider payment is ${live.status}`);
    if (payment.status === 'refunded' || payment.status === 'disputed' || payment.status === 'failed') return hold('local payment requires reconciliation');
    const verified = { ...payment, status: live.status };
    await repo.payments.put(verified);
    return { ok: true, case: csCase, payment: verified, provider };
  } catch (error) {
    if (error instanceof Error) return hold('provider payment verification failed; retry after reconciliation');
    throw error;
  }
}

/** Only the immutable snapshot captured when this payment was sold determines credit quantity. */
export async function resolveTopupCredits(input: { readonly payment: Payment; readonly repo: Repo }): Promise<number | null> {
  const { payment, repo } = input;
  const snapshot = await getPurchaseSnapshot({ paymentId: payment.id, repo });
  if (payment.kind !== 'topup' || !snapshot || snapshot.plan.interval !== null || snapshot.customerId !== payment.customerId
    || snapshot.paymentRef !== payment.providerRef || snapshot.provider !== payment.provider
    || snapshot.price.currency !== payment.amount.currency || snapshot.price.amountMinor !== payment.amount.amountMinor) return null;
  return snapshot.plan.creditsPerPeriod > 0 ? snapshot.plan.creditsPerPeriod : null;
}
