"""Find original closed usage periods and persisted unresolved charge attempts."""

from dataclasses import dataclass
from datetime import datetime

from boilpayment_core import (
    Clock,
    LedgerStore,
    PaymentKitError,
    PaymentProvider,
    Period,
    Policy,
    ProviderName,
    Repo,
)

from .settle_period import SettlePeriodResult, settle_period


@dataclass(frozen=True, slots=True)
class DuePeriodSettlement:
    subscription_id: str
    period: Period
    result: SettlePeriodResult


async def settle_due_periods(
    *,
    policy: Policy,
    repo: Repo,
    ledger: LedgerStore,
    providers: dict[ProviderName, PaymentProvider],
    clock: Clock,
) -> list[DuePeriodSettlement]:
    subscriptions = await repo.subscriptions.list()
    results: list[DuePeriodSettlement] = []
    errors: list[dict[str, str]] = []
    for sub in subscriptions:
        # EC:A75 -- one subscription's failure (a refused charge, a bad row) is reported after every other
        # subscription has been settled; it never stops the rest of this run.
        try:
            results.extend(await _settle_subscription(sub, subscriptions, policy=policy, repo=repo, ledger=ledger,
                                                      providers=providers, clock=clock))
        except Exception as err:  # noqa: BLE001 -- collected and raised after the loop
            errors.append({"subscription_id": sub.id, "code": err.code if isinstance(err, PaymentKitError) else "usage_settlement_error",
                           "message": str(err)})
    # EC:A83 -- a charge the provider has not settled (or refused) stays in the error list on every run, so a
    # cron alert keeps firing until someone resolves it.
    for r in results:
        if r.result.status in ("pending", "failed"):
            errors.append({"subscription_id": r.subscription_id, "code": f"overage_charge_{r.result.status}",
                           "message": f"overage charge for {r.period.start.isoformat()} is {r.result.status}"})
    if errors:
        raise PaymentKitError("some usage periods could not be settled", "usage_settlement_errors", {"errors": errors, "results": results})
    return results


async def _owns_usage(repo: Repo, candidate) -> bool:  # type: ignore[no-untyped-def]
    """EC:A72 -- a sign-up whose first charge never succeeded (closed incomplete/expired) never owned usage."""
    if candidate.status not in ("incomplete", "expired"):
        return True
    return any(p.status == "succeeded" for p in await repo.payments.list(subscription_id=candidate.id))


async def _settle_subscription(sub, subscriptions, *, policy: Policy, repo: Repo, ledger: LedgerStore,  # type: ignore[no-untyped-def]
                               providers: dict[ProviderName, PaymentProvider], clock: Clock) -> list[DuePeriodSettlement]:
    out: list[DuePeriodSettlement] = []
    events = await repo.usage_events.list(customer_id=sub.customer_id)
    payments = [
        payment
        for payment in await repo.payments.list(subscription_id=sub.id)
        if payment.kind == "overage" or (payment.kind == "subscription" and payment.status == "succeeded")
    ]
    if not events and not payments:
        return out
    owners = [c for c in subscriptions if c.customer_id == sub.customer_id and await _owns_usage(repo, c)]
    if events and not any(o.id == sub.id for o in owners):
        return out
    if events and len(owners) > 1:
        raise PaymentKitError("Customer usage cannot identify one subscription", "ambiguous_usage_subscription")
    periods: dict[datetime, Period] = {payment.period.start: payment.period for payment in payments if payment.period}
    for event in events:
        start = event.period_start
        if start in periods:
            continue
        if start == sub.current_period.start:
            periods[start] = sub.current_period
        else:
            raise PaymentKitError("Historical usage requires an original payment period", "invalid_usage_period")
    for period in sorted(periods.values(), key=lambda period: period.start):
        if period.end > clock.now():
            continue
        provider = providers.get(sub.provider)
        if provider is None:
            raise PaymentKitError("Usage billing provider is not configured", "unsupported_usage_billing")
        result = await settle_period(sub=sub, period=period, policy=policy, repo=repo, ledger=ledger, provider=provider, clock=clock)
        out.append(DuePeriodSettlement(subscription_id=sub.id, period=period, result=result))
    return out
