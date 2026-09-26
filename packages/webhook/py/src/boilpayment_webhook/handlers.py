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
from typing import Any, Protocol

from boilpayment_core import (
    INACTIVE_SUBSCRIPTION_STATUSES,
    CashReceiptRef,
    Clock,
    IdGen,
    LedgerStore,
    Notification,
    Notifier,
    Payment,
    PaymentKitError,
    Policy,
    Repo,
    Subscription,
)

from .correlation import with_correlation_id
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


class LifecycleDunningDeps(Protocol):
    async def on_payment_failed(
        self,
        *,
        sub: Subscription,
        policy: Policy,
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
        ctx: HandlerCtx, provider_ref: str
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
                current_period=provider_sub.current_period,
                cancel_at_period_end=provider_sub.cancel_at_period_end,
                grace_until=provider_sub.grace_until,
            )
        return sub

    async def resolve_local_payment(ctx: HandlerCtx, provider_ref: str) -> Payment:
        payments = await repo.payments.list(provider_ref=provider_ref)
        if not payments:
            await mark_unknown_provider_ref("payment", provider_ref, ctx.provider.name)
        provider_payment = await ctx.provider.get_payment(
            provider_ref
        )  # re-fetch for verification (EC:E3)
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
        return await repo.payments.put(
            Payment(
                id=ids.new_id(),
                customer_id=sub.customer_id,
                provider=ctx.provider.name,
                provider_ref=payment_ref,
                subscription_id=sub.id,
                amount=remote.amount,
                status=remote.status,
                kind="subscription",
                period=remote.period,
                occurred_at=remote.occurred_at,
                failure=remote.failure,
                cash_receipt=None,
            )
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
        async def _attempt(subscription_ref: str = ctx.event.subscription_ref) -> None:
            sub = await resolve_local_subscription(ctx, subscription_ref)
            await lifecycle.dunning.on_payment_failed(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )

        await _retry_on_version_conflict(_attempt)

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
            await refund.on_external_refund(
                event=await authoritative_refund_event(ctx, notifier),
                ledger=with_correlation_id(ledger, ctx.correlation_id),
                repo=repo,
                cs=cs,
            )  # EC:D8

    async def on_dispute(ctx: HandlerCtx) -> None:
        # EC:L5 -- see on_payment_succeeded above.
        if cs is not None:
            await cs.dispute(
                event=ctx.event,
                policy=policy,
                ledger=with_correlation_id(ledger, ctx.correlation_id),
                repo=repo,
                notifier=notifier,
            )  # EC:B11 D9

    async def on_unknown(ctx: HandlerCtx) -> None:
        pass  # ignored, no-op

    handlers: dict[str, Handler] = {
        "payment.succeeded": on_payment_succeeded,
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
