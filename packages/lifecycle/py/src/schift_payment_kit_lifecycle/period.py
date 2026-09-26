"""EC:G1 G2 — re-export core's period/proration arithmetic verbatim. No local reimplementation."""

from schift_payment_kit_core.period import (  # noqa: F401
    days_in_month,
    days_in_period,
    elapsed_ratio,
    next_period,
    period_containing,
    proration_ratio,
)
