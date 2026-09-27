"""spec/cs.pseudo.md — EC:B11 D9 I5"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from boilpayment_core import (
    Clock,
    CsCase,
    IdGen,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    NormalizedEvent,
    Notifier,
    PaymentKitError,
    Policy,
    Repo,
)

from .cases import (
    EscalateInput,
    OnCaseEvent,
    OpenCaseInput,
    ResolveInput,
    escalate,
    open_case,
    resolve,
)

if TYPE_CHECKING:
    from .metrics import LicenseReporter


@dataclass(kw_only=True, slots=True)
class DisputeInput:
    event: NormalizedEvent
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    notifier: Notifier
    clock: Clock
    ids: IdGen
    on_case_event: OnCaseEvent | None = None
    # EC:I5 -- reports the resulting resolved_human transition (dispute.closed) to the license server.
    reporter: LicenseReporter | None = None
    # EC:L5 -- optional delivery-scoped id, merged into reference.correlation_id on every
    # revoke/restore entry this call writes.
    correlation_id: str | None = None


async def _revoke_disputed_grants(
    *,
    ledger: LedgerStore,
    customer_id: str,
    payment_id: str,
    case_id: str,
    correlation_id: str | None = None,
) -> int:
    """EC:B11 D9 -- revoke the credits this payment granted, attributed per grant bucket so the
    ledger, expiry (B14) and a later restore can all see which bucket each unit came from.
    Idempotent: the per-bucket keys make a second call a no-op, so `dispute.opened` and a later
    `lost` close can both call it safely. Returns the amount revoked by this call."""
    all_entries = await ledger.entries(customer_id, pool="paid")
    grants = [
        e
        for e in all_entries
        if e.kind == "grant" and e.reference.payment_id == payment_id
    ]
    total_granted = sum(g.amount for g in grants)
    already_revoked = sum(
        -e.amount
        for e in all_entries
        if e.kind == "revoke"
        and e.source == "dispute"
        and e.reference.case_id == case_id
    )
    left = max(0, total_granted - already_revoked)
    if left <= 0:
        return 0

    revoked = 0
    for g in grants:
        if left <= 0:
            break
        used = sum(
            e.amount
            for e in all_entries
            if e.kind != "grant" and e.reference.grant_id == g.id
        )
        take = min(max(0, g.amount + used), left)
        if take <= 0:
            continue
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="revoke",
                amount=-take,
                source="dispute",
                reference=LedgerReference(
                    payment_id=payment_id,
                    case_id=case_id,
                    grant_id=g.id,
                    correlation_id=correlation_id,
                ),
                idempotency_key=f"revoke:dispute:{case_id}:{g.id}",
                actor="system",
                reason="B11 dispute",
                unit_price_minor=g.unit_price_minor,
                currency=g.currency,
            )
        )
        if not result.duplicated:
            revoked += take
        left -= take
    if left > 0:
        # The customer already spent these credits; the chargeback still takes the money back, so the
        # remainder is revoked unattributed and the balance may go negative (merchant eats the loss).
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="revoke",
                amount=-left,
                source="dispute",
                reference=LedgerReference(
                    payment_id=payment_id,
                    case_id=case_id,
                    correlation_id=correlation_id,
                ),
                idempotency_key=f"revoke:dispute:{case_id}",
                actor="system",
                reason="B11 dispute (spent remainder)",
            )
        )
        if not result.duplicated:
            revoked += left
    return revoked


async def _restore_disputed_grants(
    *,
    ledger: LedgerStore,
    customer_id: str,
    case_id: str,
    correlation_id: str | None = None,
) -> int:
    """EC:D9 -- the merchant WON the dispute: the charge stands, so every credit revoked for this
    case must come back. Restoration is not a policy choice -- keeping the money and the credits
    would be charging the customer twice. Each restored bucket keeps the ORIGINAL grant's expiry, so
    credits that would have lapsed during the dispute stay lapsed. Idempotent by
    `restore:dispute:{case_id}:*`."""
    all_entries = await ledger.entries(customer_id, pool="paid")
    revokes = [
        e
        for e in all_entries
        if e.kind == "revoke"
        and e.source == "dispute"
        and e.reference.case_id == case_id
    ]
    restored = 0
    for r in revokes:
        amount = -r.amount
        if amount <= 0:
            continue
        origin = (
            next((e for e in all_entries if e.id == r.reference.grant_id), None)
            if r.reference.grant_id
            else None
        )
        suffix = r.reference.grant_id or "remainder"
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=amount,
                source="dispute",
                reference=LedgerReference(
                    payment_id=r.reference.payment_id,
                    case_id=case_id,
                    grant_id=r.reference.grant_id,
                    correlation_id=correlation_id,
                ),
                idempotency_key=f"restore:dispute:{case_id}:{suffix}",
                actor="system",
                reason="D9 dispute won -- restoring revoked credits",
                unit_price_minor=(
                    origin.unit_price_minor if origin else r.unit_price_minor
                ),
                currency=(origin.currency if origin else r.currency),
                expires_at=(origin.expires_at if origin else None),
            )
        )
        if not result.duplicated:
            restored += amount
    return restored


async def dispute(input: DisputeInput) -> CsCase:
    """EC:B11 D9 -- cs.dispute({event, policy, ledger, repo, notifier}) -> CsCase"""
    event = input.event

    if event.type == "dispute.opened":
        payments = (
            await input.repo.payments.list(provider_ref=event.payment_ref)
            if event.payment_ref
            else []
        )
        payment = payments[0] if payments else None
        # EC:E24 -- the local customer: the payment's, else the one holding this provider customer ref.
        customer_id = payment.customer_id if payment else await _local_customer_id(input.repo, event)
        if not customer_id:
            raise PaymentKitError("dispute names no local payment or customer", "unmatched_dispute")
        case = await open_case(
            OpenCaseInput(
                customer_id=customer_id,
                kind="dispute",
                reference_id=event.payment_ref or event.id,
                policy=input.policy,
                repo=input.repo,
                clock=input.clock,
                ids=input.ids,
                on_case_event=input.on_case_event,
            )
        )

        on_open = input.policy.dispute.on_open
        if on_open == "freeze_customer":
            customer = await input.repo.customers.get(customer_id)
            if customer is not None:
                customer.status = "frozen"  # B11
                await input.repo.customers.put(customer)
        elif on_open == "revoke_disputed_grant" and payment is not None:
            await _revoke_disputed_grants(
                ledger=input.ledger,
                customer_id=customer_id,
                payment_id=payment.id,
                case_id=case.id,
                correlation_id=input.correlation_id,
            )
        # on_open == "none" -> no side effect

        return await escalate(
            EscalateInput(
                case=case,
                repo=input.repo,
                clock=input.clock,
                notifier=input.notifier,
                reason="dispute opened",
                on_case_event=input.on_case_event,
            )
        )

    if event.type == "dispute.closed":
        reference_id = event.payment_ref or event.id
        existing = await input.repo.cs_cases.list(
            kind="dispute", reference_id=reference_id
        )
        closed_customer = None if existing else await _local_customer_id(input.repo, event)
        if not existing and not closed_customer:
            raise PaymentKitError("dispute names no local payment or customer", "unmatched_dispute")
        case = (
            existing[0]
            if existing
            else await open_case(
                OpenCaseInput(
                    customer_id=closed_customer or "",
                    kind="dispute",
                    reference_id=reference_id,
                    policy=input.policy,
                    repo=input.repo,
                    clock=input.clock,
                    ids=input.ids,
                    on_case_event=input.on_case_event,
                )
            )
        )

        outcome = _dispute_outcome(event)
        customer = await input.repo.customers.get(case.customer_id)

        disputed_payments = (
            await input.repo.payments.list(provider_ref=event.payment_ref)
            if event.payment_ref
            else []
        )
        disputed_payment = disputed_payments[0] if disputed_payments else None

        if outcome == "lost":
            # EC:D9 -- BOTH on_lost values revoke: the card network took the money back, so the
            # credits must go too. Whether it already happened at dispute.opened depends on
            # policy.dispute.on_open, so call the (idempotent) revoke here as well -- otherwise
            # "revoke_only" revokes nothing whenever on_open was "freeze_customer" or "none", which
            # is what its name promises.
            revoked = (
                await _revoke_disputed_grants(
                    ledger=input.ledger,
                    customer_id=case.customer_id,
                    payment_id=disputed_payment.id,
                    case_id=case.id,
                    correlation_id=input.correlation_id,
                )
                if disputed_payment is not None
                else 0
            )
            if (
                input.policy.dispute.on_lost == "revoke_and_ban"
                and customer is not None
            ):
                customer.status = "banned"
                await input.repo.customers.put(customer)
            return await resolve(
                ResolveInput(
                    case=case,
                    by="human",
                    decision={"outcome": "lost", "revoked": revoked},
                    repo=input.repo,
                    clock=input.clock,
                    on_case_event=input.on_case_event,
                    reporter=input.reporter,
                )
            )

        if outcome != "won":
            # EC:D21 -- the provider closed the dispute without saying who won (PortOne, Stripe
            # warning_closed, a caller without the field). Neither restore nor revoke on a guess:
            # the customer stays as dispute.opened left them and a person decides.
            return await escalate(
                EscalateInput(
                    case=case,
                    repo=input.repo,
                    clock=input.clock,
                    notifier=input.notifier,
                    reason="dispute closed without a verdict",
                    on_case_event=input.on_case_event,
                )
            )

        # EC:D9 -- won: the charge stands, so give back every credit this dispute revoked and lift
        # the freeze.
        restored = await _restore_disputed_grants(
            ledger=input.ledger,
            customer_id=case.customer_id,
            case_id=case.id,
            correlation_id=input.correlation_id,
        )
        if customer is not None and customer.status == "frozen":
            customer.status = "active"
            await input.repo.customers.put(customer)
        return await resolve(
            ResolveInput(
                case=case,
                by="human",
                decision={"outcome": outcome, "restored": restored},
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
                reporter=input.reporter,
            )
        )

    raise ValueError(f"cs.dispute: unsupported event type '{event.type}'")


def _dispute_outcome(event: Any) -> str | None:
    """EC:D21 -- the verdict of a closed dispute: the adapter's dispute_outcome, else raw["outcome"]
    (a caller building the event by hand). Anything but won/lost is no verdict."""
    own = getattr(event, "dispute_outcome", None)
    if own in ("won", "lost"):
        return own
    raw = event.raw
    from_raw = raw.get("outcome") if isinstance(raw, dict) else None
    return from_raw if from_raw in ("won", "lost") else None


async def _local_customer_id(repo: Any, event: Any) -> str | None:
    """EC:E24 -- the local customer for a provider event: via the disputed payment, else the provider customer ref."""
    if event.payment_ref:
        found = await repo.payments.list(provider_ref=event.payment_ref)
        if found:
            return found[0].customer_id
    if not event.customer_ref:
        return None
    for c in await repo.customers.list():
        if any(r.provider == event.provider and r.ref == event.customer_ref for r in c.provider_refs):
            return c.id
    # A caller that already holds the local customer id may pass it as customer_ref.
    local = await repo.customers.get(event.customer_ref)
    return local.id if local is not None else None
