# EC:E3 — duck-typed handler wiring. lifecycle/credits/refund/cs are built
# concurrently and are NOT imported here. See spec/webhook.pseudo.md.
#
# EC:E3 identity rule (2026-09-09, per team-lead): provider.get_payment /
# get_subscription re-fetches are re-verification only — they confirm live
# status/period/amount, but their id/customer_id/plan_id/subscription_id
# fields are provider-adapter best-effort (restored from checkout metadata)
# and are NOT trustworthy local identity. The entity passed to
# lifecycle/credits is always the local repo row (found by provider_ref),
# with only the verified live fields overlaid on top. If no local row
# matches provider_ref (e.g. a subscription created directly in the provider
# dashboard), we do not process the event: the webhook record is left
# 'failed' with error 'unknown_provider_ref' and a 'reconcile.mismatch'
# notification is sent — see _mark_unknown_provider_ref() below.
from __future__ import annotations

import dataclasses
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any, Protocol

from boilpayment_core import (
    INACTIVE_SUBSCRIPTION_STATUSES,
    CashReceiptRef,
    Clock,
    CsCase,
    IdGen,
    LedgerStore,
    Notification,
    Notifier,
    Payment,
    PaymentKitError,
    PaymentProvider,
    Policy,
    Repo,
    Subscription,
    record_payment_ref_aliases,
    run_idempotent,
)

from .attempt_row import complete_attempt_row
from .correlation import with_correlation_id
from .payment_ref import localize_payment_event
from .process import Handler, HandlerCtx, HandlerMap
from .refund import authoritative_refund_event


# EC:K1 call-site helper -- deliberately duplicated from
# packages/lifecycle/py/src/boilpayment_lifecycle/retry.py rather than imported: this
# package intentionally does NOT depend on boilpayment_lifecycle (see the EC:E3 duck-typing
# note above), and adding that edge just for this small helper would break that boundary. Retries
# `fn` when it raises PaymentKitError('subscription_version_conflict') (raised by
# Repo.subscriptions.put -- see EC:K1), up to `attempts` times; `fn` re-reads whatever Subscription
# it needs on every attempt.
async def _retry_on_version_conflict(fn, attempts: int = 3):
    last_err: BaseException | None = None
    for _ in range(attempts):
        try:
            return await fn()
        except PaymentKitError as err:
            if err.code == "subscription_version_conflict":
                last_err = err
                continue
            raise
    assert last_err is not None
    raise last_err


def _record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _field(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)


def _stripe_checkout_session_id(raw: Any) -> str | None:
    data = _field(raw, "data")
    session = _field(data, "object")
    session_id = _field(session, "id")
    if (
        _field(raw, "type") == "checkout.session.completed"
        and session is not None
        and _field(session, "mode") == "subscription"
        and isinstance(session_id, str)
    ):
        return session_id
    return None


def _checkout_subscription_identity(value: Any) -> tuple[str, str, str, str] | None:
    snapshot = _record(value)
    plan = _record(snapshot.get("plan")) if snapshot is not None else None
    price = _record(snapshot.get("price")) if snapshot is not None else None
    customer_id = (
        snapshot.get("customerId", snapshot.get("customer_id"))
        if snapshot is not None
        else None
    )
    plan_id = plan.get("id") if plan is not None else None
    provider = snapshot.get("provider") if snapshot is not None else None
    currency = price.get("currency") if price is not None else None
    if (
        isinstance(customer_id, str)
        and isinstance(plan_id, str)
        and provider == "stripe"
        and isinstance(currency, str)
    ):
        return customer_id, plan_id, provider, currency
    return None


class LifecycleDunningDeps(Protocol):
    async def on_payment_failed(
        self,
        *,
        sub: Subscription,
        policy: Policy,
        ledger: LedgerStore,
        repo: Repo,
        notifier: Notifier,
        clock: Clock,
    ) -> object: ...


class LifecycleDeps(Protocol):
    dunning: LifecycleDunningDeps

    async def on_renewal_paid(
        self,
        *,
        sub: Subscription,
        payment: Payment,
        policy: Policy,
        ledger: LedgerStore,
        repo: Repo,
        clock: Clock,
    ) -> object: ...


class CreditsDeps(Protocol):
    # EC:B10 J1-J5 -- `repo` is threaded through so the real credits.topup() can wrap the grant in
    # run_idempotent (boilpayment_core) the same way every other webhook-triggered mutation
    # is: otherwise a redelivered payment.succeeded for a one-time payment only gets ledger-level
    # idempotency_key dedup (B12), not the operation-level in-progress/replay guarantees (J1-J3).
    async def topup(
        self,
        *,
        customer_id: str,
        payment: Payment,
        credits: int,
        policy: Policy,
        ledger: LedgerStore,
        clock: Clock,
        repo: Repo,
    ) -> object: ...


class CsDeps(Protocol):
    async def dispute(
        self,
        *,
        event: object,
        policy: Policy,
        ledger: LedgerStore,
        repo: Repo,
        notifier: Notifier,
        provider: PaymentProvider | None = None,
    ) -> object: ...


class RefundDeps(Protocol):
    async def on_external_refund(
        self, *, event: object, ledger: LedgerStore, repo: Repo, cs: CsDeps | None
    ) -> object: ...


class UnknownProviderRefError(Exception):
    def __init__(self) -> None:
        super().__init__("unknown_provider_ref")


def default_handlers(
    *,
    policy: Policy,
    ledger: LedgerStore,
    repo: Repo,
    notifier: Notifier,
    clock: Clock,
    ids: IdGen,
    lifecycle: LifecycleDeps | None = None,
    credits: CreditsDeps | None = None,
    refund: RefundDeps | None = None,
    cs: CsDeps | None = None,
    resolve_topup_credits: Callable[[Payment], Awaitable[int | None]] | None = None,
    # EC:K2 -- KR 현금영수증 auto-issue. The kit cannot invent a 휴대폰번호/사업자등록번호, so the app
    # supplies it per payment; returning None skips issuance. Only consulted when
    # policy.cash_receipt.mode == "auto".
    resolve_cash_receipt_identity: Callable[[Payment], Awaitable[dict[str, Any] | None]]
    | None = None,
    on_cash_receipt_error: Callable[[Payment, BaseException], Awaitable[None]]
    | None = None,
) -> HandlerMap:
    async def mark_unknown_provider_ref(
        kind: str, provider_ref: str, provider_name: str
    ) -> None:
        await notifier.send(
            Notification(
                type="reconcile.mismatch",
                customer_id=None,
                payload={
                    "kind": kind,
                    "providerRef": provider_ref,
                    "provider": provider_name,
                },
            )
        )
        raise UnknownProviderRefError()

    async def resolve_local_subscription(
        ctx: HandlerCtx, provider_ref: str, preserve_current_period: bool = False
    ) -> Subscription:
        subs = await repo.subscriptions.list(provider_ref=provider_ref)
        if not subs:
            await mark_unknown_provider_ref(
                "subscription", provider_ref, ctx.provider.name
            )
        sub = subs[0]
        # EC:F — Toss/PortOne have no native provider-side subscription (self-scheduled by us);
        # get_subscription() raises PaymentKitError('unsupported') there, so only re-fetch when supported.
        if ctx.provider.capabilities().native_subscriptions:
            provider_sub = await ctx.provider.get_subscription(
                provider_ref
            )  # re-fetch for verification (EC:E3)
            sub = dataclasses.replace(
                sub,
                status=provider_sub.status,
                current_period=(
                    sub.current_period
                    if preserve_current_period
                    else provider_sub.current_period
                ),
                cancel_at_period_end=provider_sub.cancel_at_period_end,
                grace_until=provider_sub.grace_until,
            )
        return sub

    async def resolve_local_payment(ctx: HandlerCtx, provider_ref: str) -> Payment:
        payments = await repo.payments.list(provider_ref=provider_ref)
        if not payments:
            await mark_unknown_provider_ref("payment", provider_ref, ctx.provider.name)
        provider_payment = await ctx.provider.get_payment(provider_ref)  # re-fetch for verification (EC:E3)
        await record_payment_ref_aliases(repo, payments[0], provider_payment.provider_ref_aliases or [], clock.now())  # EC:E24
        return dataclasses.replace(
            payments[0],
            status=provider_payment.status,
            amount=provider_payment.amount,
            period=provider_payment.period,
            occurred_at=provider_payment.occurred_at,
            failure=provider_payment.failure,
        )

    async def resolve_renewal_payment(
        ctx: HandlerCtx, payment_ref: str, subscription_ref: str
    ) -> Payment:
        """EC:E16 -- a native provider (Stripe/Polar) renews on its own schedule, so the renewal
        invoice reaches us first as a webhook: no local Payment row exists for it yet. When the
        event names a subscription we already have, re-fetch the payment from the provider
        (EC:E3), check that the provider ties it to that same subscription, and record it before
        renewing. Anything else keeps the unknown_provider_ref path."""
        if await repo.payments.list(provider_ref=payment_ref):
            return await resolve_local_payment(ctx, payment_ref)
        subs = await repo.subscriptions.list(
            provider=ctx.provider.name, provider_ref=subscription_ref
        )
        if not subs or not ctx.provider.capabilities().native_subscriptions:
            return await resolve_local_payment(ctx, payment_ref)
        sub = subs[0]
        remote = await ctx.provider.get_payment(payment_ref)
        if remote.kind != "subscription" or remote.subscription_id != subscription_ref:
            await mark_unknown_provider_ref("payment", payment_ref, ctx.provider.name)
        # A concurrent delivery of the same invoice may have recorded it since the first lookup.
        raced = await repo.payments.list(provider_ref=payment_ref)
        if raced:
            return raced[0]
        recorded = await repo.payments.put(Payment(
            id=ids.new_id(), customer_id=sub.customer_id, provider=ctx.provider.name, provider_ref=payment_ref,
            subscription_id=sub.id, amount=remote.amount, status=remote.status, kind="subscription",
            period=remote.period, occurred_at=remote.occurred_at, failure=remote.failure,
            cash_receipt=None, raw=remote.raw,
        ))
        await record_payment_ref_aliases(repo, recorded, remote.provider_ref_aliases or [], clock.now())  # EC:E24
        return recorded

    async def park_late_renewal(sub: Subscription, payment: Payment) -> None:
        # SB-10 -- money arriving after local expiry/cancellation is evidence to reconcile, never a
        # reason to revive access or grant credits. Operation claiming makes both the case and notice
        # exactly-once across distinct provider event IDs for the same payment.
        async def park_once() -> dict[str, str]:
            existing = await repo.cs_cases.list(
                customer_id=sub.customer_id,
                kind="reconcile_mismatch",
                reference_id=payment.id,
            )
            active = next(
                (case for case in existing if case.status in ("open", "needs_human")),
                None,
            )
            if active is not None:
                return {"caseId": active.id}

            now = clock.now()
            case = CsCase(
                id=f"late-renewal:{payment.id}",
                customer_id=sub.customer_id,
                kind="reconcile_mismatch",
                status="needs_human",
                reference_id=payment.id,
                policy_snapshot=deepcopy(policy),
                decision={
                    "reason": "late renewal payment for closed subscription",
                    "paymentId": payment.id,
                },
                churn_reason=None,
                churn_text=None,
                opened_at=now,
                resolved_at=None,
                escalated_at=now,
            )
            await repo.cs_cases.put(case)
            await notifier.send(Notification(
                type="cs.needs_human",
                customer_id=sub.customer_id,
                payload={
                    "caseId": case.id,
                    "kind": case.kind,
                    "reason": "late renewal payment for closed subscription",
                    "paymentId": payment.id,
                },
            ))
            return {"caseId": case.id}

        await run_idempotent(
            repo=repo,
            key=f"webhook.late-renewal:{payment.id}",
            kind="webhook.late_renewal",
            payload={"paymentId": payment.id, "subscriptionId": sub.id},
            clock=clock,
            fn=park_once,
        )

    async def maybe_issue_cash_receipt(payment: Payment, provider: Any) -> None:
        """EC:K2 K4 K6 K7 -- auto-issue a cash receipt. Never rolls back a payment that succeeded.

        The provider adapters raise PaymentKitError('cash_receipt_unsupported_for_payment_method')
        for card payments (EC:K4) before touching the provider API; that failure is EXPECTED for
        every card payment once auto mode is on, so it's swallowed quietly -- anything else is a
        genuine failure and gets recorded/notified.
        """
        if policy.cash_receipt.mode != "auto":
            return
        if payment.cash_receipt is not None:
            return  # EC:K7 -- already issued; a webhook redelivery must not double-issue
        if resolve_cash_receipt_identity is None:
            return
        issue = getattr(provider, "issue_cash_receipt", None)
        if not callable(issue):
            return  # provider has no cash-receipt support (duck-type)

        try:
            identity = await resolve_cash_receipt_identity(payment)
            if not identity:
                return  # app opted this payment out (non-KR customer, declined, etc.)
            receipt_type = identity.get("type") or policy.cash_receipt.default_type
            receipt = await issue(
                payment_ref=payment.provider_ref,
                type=receipt_type,
                customer_identity_number=identity["customer_identity_number"],
            )
            # EC:K7 -- re-fetch immediately before writing so this doesn't clobber any other field
            # a concurrent write to the same Payment row changed since `payment` was resolved.
            fresh = await repo.payments.get(payment.id) or payment
            fresh.cash_receipt = CashReceiptRef(
                receipt_key=receipt.receipt_key,
                issued_at=clock.now(),
                type=getattr(receipt, "type", None) or receipt_type,
            )
            await repo.payments.put(fresh)
        except PaymentKitError as err:
            if err.code == "cash_receipt_unsupported_for_payment_method":
                return  # EC:K4 -- expected, not an incident
            await notifier.send(
                Notification(
                    type="cs.needs_human",
                    customer_id=payment.customer_id,
                    payload={
                        "kind": "cash_receipt_issue_failed",
                        "paymentId": payment.id,
                        "error": str(err),
                    },
                )
            )
            if on_cash_receipt_error is not None:
                await on_cash_receipt_error(payment, err)
        except Exception as err:  # noqa: BLE001 -- EC:K6, any other issuance failure never fails the payment
            await notifier.send(
                Notification(
                    type="cs.needs_human",
                    customer_id=payment.customer_id,
                    payload={
                        "kind": "cash_receipt_issue_failed",
                        "paymentId": payment.id,
                        "error": str(err),
                    },
                )
            )
            if on_cash_receipt_error is not None:
                await on_cash_receipt_error(payment, err)

    async def on_payment_succeeded(ctx: HandlerCtx) -> None:
        # EC:L5 -- every ledger append lifecycle/credits make while handling THIS delivery gets
        # ctx.correlation_id merged into its reference, without lifecycle/credits knowing
        # correlation_id exists (see correlation.py module docstring).
        scoped_ledger = with_correlation_id(ledger, ctx.correlation_id)
        payment = (
            await resolve_renewal_payment(
                ctx, ctx.event.payment_ref, ctx.event.subscription_ref
            )
            if ctx.event.subscription_ref
            else await resolve_local_payment(ctx, ctx.event.payment_ref)
        )
        if ctx.event.subscription_ref:
            # SB-10 -- inspect stored status before resolve_local_subscription overlays provider
            # state. Provider-side active must not resurrect a locally expired/canceled subscription.
            stored_subs = await repo.subscriptions.list(
                provider=ctx.provider.name,
                provider_ref=ctx.event.subscription_ref,
            )
            stored_sub = stored_subs[0] if stored_subs else None
            if stored_sub is not None and stored_sub.status in ("expired", "canceled"):
                await park_late_renewal(stored_sub, payment)
                return
            raw = payment.raw if isinstance(payment.raw, dict) else {}
            plan = (
                await repo.plans.get(stored_sub.plan_id)
                if stored_sub is not None
                else None
            )
            if (
                payment.provider == "stripe"
                and payment.kind == "subscription"
                and payment.status == "succeeded"
                and payment.amount.amount_minor == 0
                and raw.get("billing_reason") == "subscription_create"
                and stored_sub is not None
                and stored_sub.status == "trialing"
                and plan is not None
                and plan.trial_days > 0
            ):
                # SB-03 -- Stripe reports a trial's opening invoice as paid even though no money
                # moved. Keep the payment for idempotency/audit, but never start a paid period.
                payment = dataclasses.replace(
                    payment,
                    raw={**raw, "boilpaymentTrialOpeningInvoice": True},
                )
                await repo.payments.put(payment)
                return
            if lifecycle is not None:
                # EC:K1 call-site audit -- resolve_local_subscription reads the row, then
                # lifecycle.on_renewal_paid does real work (rollover, grant_for_period, ledger
                # appends) before its own repo.subscriptions.put; a concurrent writer (another
                # webhook delivery, a scheduler tick, a manual cancel) can win that race. Re-resolve
                # the subscription on every retry attempt. on_renewal_paid's own EC:A7 idempotency
                # check (period_key already granted -> duplicated=True, no re-grant) makes
                # replaying the whole call safe.
                async def _attempt(
                    subscription_ref: str = ctx.event.subscription_ref,
                ) -> None:
                    sub = await resolve_local_subscription(ctx, subscription_ref)
                    await lifecycle.on_renewal_paid(
                        sub=sub,
                        payment=payment,
                        policy=policy,
                        ledger=scoped_ledger,
                        repo=repo,
                        clock=clock,
                    )

                await _retry_on_version_conflict(_attempt)
        elif payment.kind == "subscription" and payment.subscription_id:
            # EC:A45 -- a self-scheduled renewal's own payment (PortOne Transaction.Paid for the charge our
            # scheduler made; the event names no subscription). It completes that renewal, never a top-up.
            if payment.status != "succeeded":
                raise PaymentKitError(
                    "Renewal payment has not succeeded", "renewal_payment_not_succeeded",
                    {"payment_id": payment.id, "status": payment.status},
                )
            stored = await repo.payments.get(payment.id)
            if not await complete_attempt_row(repo, notifier, stored, payment):
                return  # EC:A50 (A6-6) -- held for a person
            # EC:A51 (A5-4) -- the renewal this pays for is the stored attempt's period (see handlers.ts).
            paid_period = stored.period if stored is not None else None
            if lifecycle is not None and paid_period is not None:
                async def _renew(sub_id: str = payment.subscription_id) -> None:
                    sub = await repo.subscriptions.get(sub_id)
                    if sub is None:
                        await mark_unknown_provider_ref("subscription", sub_id, ctx.provider.name)
                        return
                    await lifecycle.on_renewal_paid(
                        sub=sub, payment=dataclasses.replace(payment, period=paid_period), policy=policy,
                        ledger=scoped_ledger, repo=repo, clock=clock,
                    )

                await _retry_on_version_conflict(_renew)
        elif credits is not None:
            # EC:E19 -- only money that arrived buys credits: the status re-fetched from the provider
            # must be 'succeeded' (a forged or early notification, a pending virtual account, or a
            # payment refunded before this retry is refused; a later delivery/retry re-checks).
            if payment.status != "succeeded":
                raise PaymentKitError(
                    "Top-up payment has not succeeded", "topup_payment_not_succeeded",
                    {"payment_id": payment.id, "status": payment.status},
                )
            # EC:B10 -- the kit cannot know how many credits a one-time payment buys; the app resolves it.
            n = await resolve_topup_credits(payment) if resolve_topup_credits else None
            if n is None:
                raise RuntimeError("topup_credits_unresolved")
            await credits.topup(
                customer_id=payment.customer_id,
                payment=payment,
                credits=n,
                policy=policy,
                ledger=scoped_ledger,
                clock=clock,
                repo=repo,
            )
        # EC:K2 -- after the goods are granted; applies to both subscription renewals and top-ups
        await maybe_issue_cash_receipt(payment, ctx.provider)

    async def on_subscription_payment_failed(ctx: HandlerCtx) -> None:
        if not ctx.event.subscription_ref:
            return
        if lifecycle is None:
            return

        # EC:K1 call-site audit -- same reasoning as on_payment_succeeded above.
        scoped_ledger = with_correlation_id(ledger, ctx.correlation_id)
        async def _attempt(subscription_ref: str = ctx.event.subscription_ref) -> None:
            # SB-07 -- provider state may already name the new unpaid period. Dunning must extend
            # the stored previous paid period while still verifying provider status/identity.
            sub = await resolve_local_subscription(
                ctx, subscription_ref, preserve_current_period=True
            )
            await lifecycle.dunning.on_payment_failed(
                # SB-07 -- dunning extends the previous grant to grace using this scoped ledger.
                sub=sub, policy=policy, ledger=scoped_ledger,
                repo=repo, notifier=notifier, clock=clock
            )

        await _retry_on_version_conflict(_attempt)

    async def on_subscription_created(ctx: HandlerCtx) -> None:
        if ctx.provider.name != "stripe" or not ctx.event.subscription_ref:
            return
        checkout_id = _stripe_checkout_session_id(ctx.event.raw)
        if checkout_id is None:
            return
        operation = await repo.operations.get(
            f"checkout-entitlement-by-id:{checkout_id}"
        )
        identity = (
            _checkout_subscription_identity(operation.result)
            if operation is not None
            and operation.kind == "checkout.entitlement"
            and operation.status == "done"
            else None
        )
        # SB-03 -- only a locally captured checkout snapshot may establish provider identity. A
        # direct dashboard subscription.created remains a no-op instead of inventing customer/plan.
        if identity is None:
            return
        customer_id, plan_id, provider_name, currency = identity
        if provider_name != ctx.provider.name:
            return
        subscription_id = f"subscription:{provider_name}:{ctx.event.subscription_ref}"
        if await repo.subscriptions.get(subscription_id) is not None:
            return
        remote = await ctx.provider.get_subscription(ctx.event.subscription_ref)
        await repo.subscriptions.put(dataclasses.replace(
            remote,
            id=subscription_id,
            customer_id=customer_id,
            plan_id=plan_id,
            provider=provider_name,
            provider_ref=ctx.event.subscription_ref,
            currency=currency,
        ))

    async def on_subscription_canceled(ctx: HandlerCtx) -> None:
        if not ctx.event.subscription_ref:
            return
        subs = await repo.subscriptions.list(provider_ref=ctx.event.subscription_ref)
        for sub in subs:
            # EC:K1 call-site audit -- re-read immediately before the write so a retry (after a
            # conflict with another writer touching this row between list() and put()) sees the
            # latest version.
            async def _attempt(sub: Subscription = sub) -> None:
                fresh = await repo.subscriptions.get(sub.id) or sub
                await repo.subscriptions.put(
                    dataclasses.replace(fresh, status="canceled")
                )

            await _retry_on_version_conflict(_attempt)

    # EC:A27 -- keep the local subscription in step with the provider for the non-entitled states:
    # entering paused / incomplete, and leaving them (resume, first payment landed). Other
    # transitions belong to dunning, renewal and cancel. Unknown subscription: no-op.
    async def on_subscription_updated(ctx: HandlerCtx) -> None:
        if not ctx.event.subscription_ref or not ctx.provider.capabilities().native_subscriptions:
            return
        found = await repo.subscriptions.list(provider_ref=ctx.event.subscription_ref)
        if not found:
            return
        local = found[0]
        remote = await ctx.provider.get_subscription(ctx.event.subscription_ref)  # EC:E3 re-fetch
        entering = remote.status in INACTIVE_SUBSCRIPTION_STATUSES and remote.status != local.status
        leaving = local.status in INACTIVE_SUBSCRIPTION_STATUSES and remote.status in ("active", "trialing")
        if not entering and not leaving:
            return

        async def _attempt() -> None:
            fresh = await repo.subscriptions.get(local.id) or local
            await repo.subscriptions.put(
                dataclasses.replace(
                    fresh,
                    status=remote.status,
                    current_period=remote.current_period,
                    cancel_at_period_end=remote.cancel_at_period_end,
                )
            )

        await _retry_on_version_conflict(_attempt)

    async def on_refund_created(ctx: HandlerCtx) -> None:
        # EC:L5 -- see on_payment_succeeded above.
        if refund is not None:
            event = await localize_payment_event(ctx, await authoritative_refund_event(ctx, notifier), "refund", repo, clock, notifier)
            await refund.on_external_refund(
                event=event,
                ledger=with_correlation_id(ledger, ctx.correlation_id),
                repo=repo,
                cs=cs,
            )  # EC:D8

    async def on_dispute(ctx: HandlerCtx) -> None:
        # EC:L5 -- see on_payment_succeeded above.
        if cs is not None:
            await cs.dispute(
                event=await localize_payment_event(ctx, ctx.event, "dispute", repo, clock, notifier),
                policy=policy,
                ledger=with_correlation_id(ledger, ctx.correlation_id),
                repo=repo,
                notifier=notifier,
                provider=ctx.provider,
            )  # EC:B11 D9 A66

    async def on_unknown(ctx: HandlerCtx) -> None:
        pass  # ignored, no-op

    handlers: dict[str, Handler] = {
        "payment.succeeded": on_payment_succeeded,
        "subscription.created": on_subscription_created,
        "subscription.payment_failed": on_subscription_payment_failed,
        "subscription.canceled": on_subscription_canceled,
        "subscription.updated": on_subscription_updated,
        "refund.created": on_refund_created,
        "refund.failed": on_refund_created,
        "refund.pending": on_refund_created,
        "dispute.opened": on_dispute,
        "dispute.closed": on_dispute,
        "unknown": on_unknown,
    }
    return handlers
