"""Payment-link, pre-registration hold, and affiliate webhook behavior."""

from __future__ import annotations

import dataclasses
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

from boilpayment_core import (
    AffiliateCommission,
    Clock,
    CsCase,
    Customer,
    Money,
    Payment,
    PaymentKitError,
    Plan,
    Policy,
    Repo,
    Subscription,
    record_payment_ref_aliases,
    run_idempotent,
)

from .process import HandlerCtx

LinkMismatchReason = Literal[
    "missing_reference",
    "invalid_reference",
    "unknown_customer",
    "customer_inactive",
    "plan_unresolved",
]


class PaymentLinkReference(TypedDict):
    customer_id: str
    affiliate_id: str | None


@dataclass(frozen=True, slots=True, kw_only=True)
class CommerceWebhookInput:
    repo: Repo
    clock: Clock
    policy: Policy
    decode_link_reference: Callable[[str], PaymentLinkReference | None] | None
    grant_link_payment: Callable[[Payment, Plan, Subscription | None], Awaitable[None]] | None
    open_link_mismatch_case: Callable[[Payment, LinkMismatchReason], Awaitable[None]] | None
    commission_for_payment: Callable[[Payment], Awaitable[Money | None]] | None
    resolve_local_payment: Callable[[HandlerCtx, str], Awaitable[Payment]]
    mark_unknown_provider_ref: Callable[[str, str, str], Awaitable[None]]


class CommerceWebhook:
    def __init__(self, input: CommerceWebhookInput) -> None:
        self._input = input

    async def accrue_affiliate(
        self, payment: Payment, affiliate_id: str | None
    ) -> None:
        commission = self._input.commission_for_payment
        if affiliate_id is None or commission is None:
            return
        amount = await commission(payment)
        if amount is None or amount.amount_minor <= 0:
            return
        await self._input.repo.affiliate_commissions.append(AffiliateCommission(
            id=f"affiliate-accrual:{payment.id}", kind="accrual",
            affiliate_id=affiliate_id, payment_id=payment.id, refund_id=None,
            related_accrual_id=None, amount=amount,
            idempotency_key=f"affiliate:{payment.id}:accrual",
            created_at=self._input.clock.now(),
        ))

    async def _open_mismatch(
        self, payment: Payment, reason: LinkMismatchReason
    ) -> None:
        async def open_once() -> dict[str, str]:
            callback = self._input.open_link_mismatch_case
            if callback is not None:
                await callback(payment, reason)
            else:
                now = self._input.clock.now()
                await self._input.repo.cs_cases.put(CsCase(
                    id=f"payment-link:{payment.id}", customer_id=payment.customer_id,
                    kind="reconcile_mismatch", status="needs_human",
                    reference_id=payment.id,
                    policy_snapshot=deepcopy(self._input.policy),
                    decision={"reason": reason, "paymentId": payment.id},
                    churn_reason=None, churn_text=None, opened_at=now,
                    resolved_at=None, escalated_at=now,
                ))
            return {"paymentId": payment.id}

        await run_idempotent(
            repo=self._input.repo, key=f"payment-link-mismatch:{payment.id}",
            kind="payment_link.mismatch",
            payload={"paymentId": payment.id, "reason": reason},
            clock=self._input.clock, fn=open_once,
        )

    @staticmethod
    def _checkout_snapshot(
        value: Any,
    ) -> tuple[str, Literal["subscription", "topup"], str | None] | None:
        if not isinstance(value, dict) or not isinstance(value.get("plan"), dict):
            return None
        plan = value["plan"]
        customer_id = value.get("customerId", value.get("customer_id"))
        affiliate_id = value.get("affiliateId", value.get("affiliate_id"))
        if (
            not isinstance(customer_id, str)
            or not isinstance(plan.get("id"), str)
            or affiliate_id is not None
            and not isinstance(affiliate_id, str)
        ):
            return None
        kind: Literal["subscription", "topup"] = (
            "topup" if plan.get("interval") is None else "subscription"
        )
        return customer_id, kind, affiliate_id

    async def _record_payment(
        self, remote: Payment, customer_id: str,
        kind: Literal["subscription", "topup", "overage"],
        subscription_id: str | None, affiliate_id: str | None,
    ) -> Payment:
        repo = self._input.repo
        payment_id = f"payment:{remote.provider}:{remote.provider_ref}"
        existing = await repo.payments.get(payment_id)
        if existing is not None:
            return existing
        payment = dataclasses.replace(
            remote, id=payment_id, customer_id=customer_id,
            subscription_id=subscription_id, kind=kind,
            affiliate_id=affiliate_id, cash_receipt=remote.cash_receipt,
        )
        await repo.payments.put(payment)
        await record_payment_ref_aliases(
            repo, payment, remote.provider_ref_aliases or [], self._input.clock.now()
        )
        return payment

    async def _resolve_plan(self, provider: str, price_ref: str | None) -> Plan | None:
        if price_ref is None:
            return None
        matched = [
            plan for plan in await self._input.repo.plans.list()
            if any((price.provider_price_refs or {}).get(provider) == price_ref
                   for price in plan.prices)
        ]
        return matched[0] if len(matched) == 1 else None

    async def _hold_checkout(
        self, remote: Payment, checkout_id: str
    ) -> Payment | None | Literal[False]:
        repo = self._input.repo
        operation = await repo.operations.get(f"checkout-entitlement-by-id:{checkout_id}")
        snapshot = (
            self._checkout_snapshot(operation.result)
            if operation is not None
            and operation.kind == "checkout.entitlement"
            and operation.status == "done" else None
        )
        if snapshot is None:
            return False
        customer_id, kind, affiliate_id = snapshot
        payment = await self._record_payment(
            remote, customer_id, kind, None, remote.affiliate_id or affiliate_id
        )
        purchase = await repo.operations.get(f"purchase-entitlement:{payment.id}")
        if purchase is not None and purchase.kind == "purchase.entitlement" and purchase.status == "done":
            return payment

        async def hold_once() -> dict[str, str]:
            return {
                "paymentId": payment.id, "checkoutId": checkout_id,
                "customerId": customer_id,
                "receivedAt": self._input.clock.now().isoformat(),
            }

        await run_idempotent(
            repo=repo, key=f"checkout-payment-held:{payment.id}",
            kind="checkout.paymentHeld",
            payload={"paymentId": payment.id, "checkoutId": checkout_id,
                     "customerId": customer_id},
            clock=self._input.clock, fn=hold_once,
        )
        return None

    async def _handle_link(self, ctx: HandlerCtx, remote: Payment) -> None:
        evidence = remote.sale_evidence
        identified_link = (
            evidence is not None
            and (
                evidence.payment_link_id is not None
                or ctx.provider.name == "polar"
                and evidence.price_ref is not None
            )
        )
        if evidence is None or not identified_link:
            await self._input.mark_unknown_provider_ref("payment", remote.provider_ref, ctx.provider.name)
            return
        decoder = self._input.decode_link_reference
        decoded = (
            decoder(evidence.link_reference)
            if evidence.link_reference is not None and decoder is not None else None
        )
        customer = await self._input.repo.customers.get(decoded["customer_id"]) if decoded else None
        plan = await self._resolve_plan(ctx.provider.name, evidence.price_ref)
        reason: LinkMismatchReason | None = (
            "missing_reference" if evidence.link_reference is None else
            "invalid_reference" if decoded is None else
            "unknown_customer" if customer is None else
            "customer_inactive" if customer.status != "active" else
            "plan_unresolved" if plan is None else None
        )
        unmatched_customer_id = (
            f"unmatched-link:{ctx.provider.name}:{remote.provider_ref}"
        )
        customer_id = (
            decoded["customer_id"]
            if customer is not None and decoded is not None
            else unmatched_customer_id
        )
        if customer is None:
            await self._input.repo.customers.put(Customer(
                id=customer_id, email=None, provider_refs=[], status="frozen",
                created_at=self._input.clock.now(),
            ))
        if reason is not None or decoded is None or plan is None:
            payment = await self._record_payment(
                remote, customer_id, remote.kind, None,
                decoded["affiliate_id"] if decoded else remote.affiliate_id,
            )
            await self._open_mismatch(payment, reason or "plan_unresolved")
            return
        await self._grant_link(ctx, remote, customer_id, decoded["affiliate_id"] or remote.affiliate_id, plan)

    async def _grant_link(
        self, ctx: HandlerCtx, remote: Payment, customer_id: str,
        affiliate_id: str | None, plan: Plan,
    ) -> None:
        subscription = None
        if plan.interval is not None:
            ref = ctx.event.subscription_ref or remote.subscription_id
            if ref is None:
                payment = await self._record_payment(remote, customer_id, "subscription", None, affiliate_id)
                await self._open_mismatch(payment, "plan_unresolved")
                return
            subscription_id = f"subscription:{ctx.provider.name}:{ref}"
            subscription = await self._input.repo.subscriptions.get(subscription_id)
            if subscription is None:
                provider_sub = await ctx.provider.get_subscription(ref)
                subscription = await self._input.repo.subscriptions.put(dataclasses.replace(
                    provider_sub, id=subscription_id, customer_id=customer_id,
                    plan_id=plan.id, provider=ctx.provider.name, provider_ref=ref,
                    currency=remote.amount.currency, affiliate_id=affiliate_id,
                ))
        payment = await self._record_payment(
            remote, customer_id, "topup" if plan.interval is None else "subscription",
            subscription.id if subscription is not None else None, affiliate_id,
        )

        async def grant_once() -> dict[str, str]:
            callback = self._input.grant_link_payment
            if callback is None:
                raise PaymentKitError("payment-link grant callback missing", "payment_link_grant_unavailable")
            await callback(payment, plan, subscription)
            await self.accrue_affiliate(payment, affiliate_id)
            return {"paymentId": payment.id, "planId": plan.id}

        await run_idempotent(
            repo=self._input.repo, key=f"payment-link-grant:{payment.id}",
            kind="payment_link.grant", payload={"paymentId": payment.id, "planId": plan.id},
            clock=self._input.clock, fn=grant_once,
        )

    async def handle_unregistered_payment(self, ctx: HandlerCtx, requested_ref: str) -> Payment | None:
        if ctx.provider.name not in ("stripe", "polar"):
            await self._input.mark_unknown_provider_ref("payment", requested_ref, ctx.provider.name)
            return None
        remote = await ctx.provider.get_payment(requested_ref)
        canonical = await self._input.repo.payments.list(
            provider=ctx.provider.name, provider_ref=remote.provider_ref
        )
        if canonical:
            return await self._input.resolve_local_payment(ctx, remote.provider_ref)
        if remote.status != "succeeded":
            raise PaymentKitError(
                "Top-up payment has not succeeded",
                "topup_payment_not_succeeded",
                {"payment_id": remote.id, "status": remote.status},
            )
        if remote.sale_evidence is not None and remote.sale_evidence.checkout_id is not None:
            held = await self._hold_checkout(remote, remote.sale_evidence.checkout_id)
            if held is not False:
                return held
        await self._handle_link(ctx, remote)
        return None
