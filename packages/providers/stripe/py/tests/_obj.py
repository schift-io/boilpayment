"""Test helper — minimal attr/dict-accessor wrapper so fixtures built as plain dicts satisfy the
`getattr(x, "field")` / dict-style access call sites used throughout the provider's normalize_*
functions, recursively. Real Stripe SDK objects (StripeObject) behave the same way. Modeled on the
private `_Obj` helper in packages/providers/stripe/py/examples/smoke.py (duplicated here rather than
imported, so the test suite doesn't depend on the examples/ script's module path).
"""

from __future__ import annotations

from typing import Any


def _wrap(value: Any) -> Any:
    if isinstance(value, dict):
        return _Obj(value)
    if isinstance(value, list):
        return [_wrap(v) for v in value]
    return value


class _Obj:
    def __init__(self, data: dict):
        self._data = data

    def __getattr__(self, name: str) -> Any:
        if name in self._data:
            return _wrap(self._data[name])
        raise AttributeError(name)

    # Real StripeObject also exposes dict-style access and to_dict().
    def to_dict(self) -> dict:
        return dict(self._data)

    def get(self, key: str, default: Any = None) -> Any:
        return _wrap(self._data.get(key, default))

    def __contains__(self, key: str) -> bool:
        return key in self._data

    def __getitem__(self, key: str) -> Any:
        return _wrap(self._data[key])

    def keys(self):
        return self._data.keys()
