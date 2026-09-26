"""Validate original billing period and subscription ownership."""

from boilpayment_core import PaymentKitError, Period, Repo, Subscription


async def settlement_period(
    repo: Repo, sub: Subscription, period: Period
) -> str | None:
    subscriptions = await repo.subscriptions.list(customer_id=sub.customer_id)
    if any(candidate.id != sub.id for candidate in subscriptions):
        raise PaymentKitError(
            "Customer usage cannot identify one subscription",
            "ambiguous_usage_subscription",
        )
    payments = [
        payment
        for payment in await repo.payments.list(subscription_id=sub.id)
        if payment.customer_id == sub.customer_id
        and payment.period
        and payment.period.start == period.start
        and (
            payment.kind == "overage"
            or payment.kind == "subscription"
            and payment.status == "succeeded"
        )
    ]
    if any(payment.period and payment.period.end != period.end for payment in payments):
        raise PaymentKitError(
            "Usage period conflicts with its original payment", "invalid_usage_period"
        )
    if period.start == sub.current_period.start:
        if period.end != sub.current_period.end:
            raise PaymentKitError(
                "Usage period end is not canonical", "invalid_usage_period"
            )
    elif not payments:
        raise PaymentKitError(
            "Historical usage requires an original payment period",
            "invalid_usage_period",
        )
    currencies = {payment.amount.currency for payment in payments}
    if len(currencies) > 1:
        raise PaymentKitError(
            "Original usage currency is ambiguous", "billing_currency_required"
        )
    return next(iter(currencies), None)
