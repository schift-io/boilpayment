"""The facade re-exports a fixed list per submodule. A fixed list rots: add an export to an internal
package and it silently never reaches users (that is exactly how `verify_schema` went missing).
Assert the two surfaces are identical, and name the regeneration command in the failure."""

from __future__ import annotations

import importlib
import inspect

import pytest

SUBMODULES = {
    "core": "core", "credits": "credits", "lifecycle": "lifecycle", "refund": "refund",
    "usage": "usage", "webhook": "webhook", "notify": "notify", "cs": "cs",
    "postgres": "schema_postgres", "stripe": "stripe", "toss": "toss",
    "portone": "portone", "polar": "polar", "apple": "apple", "google_play": "google_play",
}


def _public_surface(module, internal: str) -> list[str]:
    """The same rule the facade is generated with: an explicit __all__ when the package declares
    one, otherwise every public name the package itself defines (not what it happens to import)."""
    declared = getattr(module, "__all__", None)
    if declared:
        return sorted(declared)
    prefix = f"boilpayment_{internal}"
    out = []
    for n in dir(module):
        if n.startswith("_"):
            continue
        value = getattr(module, n)
        # a re-exported SUBMODULE (lifecycle.dunning) has no __module__ — match on its own name
        if inspect.ismodule(value):
            if getattr(value, "__name__", "").startswith(prefix):
                out.append(n)
        elif getattr(value, "__module__", "").startswith(prefix):
            out.append(n)
    return sorted(out)


@pytest.mark.parametrize(("sub", "internal"), sorted(SUBMODULES.items()))
def test_facade_surface_matches_the_internal_package(sub: str, internal: str):
    facade = importlib.import_module(f"boilpayment.{sub}")
    real = importlib.import_module(f"boilpayment_{internal}")
    expected = set(_public_surface(real, internal))
    assert expected, f"boilpayment_{internal} exposes nothing to mirror"
    actual = set(getattr(facade, "__all__", ()) or ())
    missing, extra = sorted(expected - actual), sorted(actual - expected)
    assert not missing and not extra, (
        f"boilpayment.{sub} is out of sync with boilpayment_{internal} — "
        f"missing={missing} extra={extra}. Regenerate the facade submodule surfaces."
    )
    for name in sorted(expected):
        assert hasattr(facade, name), f"{sub}.{name} is listed in __all__ but does not resolve"
