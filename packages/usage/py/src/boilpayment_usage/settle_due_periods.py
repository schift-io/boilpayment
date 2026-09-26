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
    for sub in subscriptions:
        events = await repo.usage_events.list(customer_id=sub.customer_id)
        payments = [
            payment
            for payment in await repo.payments.list(subscription_id=sub.id)
            if payment.kind == "overage"
            or payment.kind == "subscription"
            and payment.status == "succeeded"
        ]
        if not events and not payments:
            continue
        if (
            events
            and sum(
                candidate.customer_id == sub.customer_id for candidate in subscriptions
            )
            > 1
        ):
            raise PaymentKitError(
                "Customer usage cannot identify one subscription",
                "ambiguous_usage_subscription",
            )
        periods: dict[datetime, Period] = {
            payment.period.start: payment.period
            for payment in payments
            if payment.period
        }
        for event in events:
            start = event.period_start
            if start in periods:
                continue
            if start == sub.current_period.start:
                periods[start] = sub.current_period
            else:
                raise PaymentKitError(
                    "Historical usage requires an original payment period",
                    "invalid_usage_period",
                )

        for period in sorted(periods.values(), key=lambda period: period.start):
            if period.end > clock.now():
                continue
            provider = providers.get(sub.provider)
            if provider is None:
                raise PaymentKitError(
                    "Usage billing provider is not configured",
                    "unsupported_usage_billing",
                )
            result = await settle_period(
                sub=sub,
                period=period,
                policy=policy,
                repo=repo,
                ledger=ledger,
                provider=provider,
                clock=clock,
            )
            results.append(
                DuePeriodSettlement(
                    subscription_id=sub.id, period=period, result=result
                )
            )
    return results
