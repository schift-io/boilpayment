"""The provider calls StripeClient(...).v1.*, which exists from stripe 12.5.0; the declared range must say so."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

MINIMUM_WITH_V1 = (12, 5)


def test_declared_stripe_lower_bound_has_the_v1_client_namespace() -> None:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    dependencies = tomllib.loads(pyproject.read_text())["project"]["dependencies"]
    specs = [d for d in dependencies if re.match(r"stripe\b", d)]
    assert len(specs) == 1, dependencies
    lower = re.search(r">=\s*(\d+)(?:\.(\d+))?", specs[0])
    assert lower is not None, specs[0]
    assert (int(lower.group(1)), int(lower.group(2) or 0)) >= MINIMUM_WITH_V1


def test_installed_stripe_client_exposes_v1() -> None:
    import stripe

    assert hasattr(stripe.StripeClient("sk_test_x"), "v1")
