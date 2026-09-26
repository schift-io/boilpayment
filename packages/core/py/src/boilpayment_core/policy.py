"""Policy defaults / merge / validation. Defaults = bold values in docs/EDGE_CASES.md.
Keep in sync with core/ts policy.ts."""
from __future__ import annotations

import dataclasses
import typing
from copy import deepcopy
from typing import Any, get_args, get_origin, get_type_hints

from .types import Policy, PolicyValidationError

DEFAULT_POLICY = Policy()


def _snake(s: str) -> str:
    out = []
    for ch in s:
        if ch.isupper():
            out.append("_" + ch.lower())
        else:
            out.append(ch)
    return "".join(out)


def _camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def policy_to_dict(p: Policy, camel: bool = False) -> dict[str, Any]:
    def conv(obj: Any) -> Any:
        if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
            return {(_camel(f.name) if camel else f.name): conv(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
        return deepcopy(obj)
    return conv(p)


def _build(cls: type, data: dict[str, Any], path: str, errors: list[str]) -> Any:
    hints = get_type_hints(cls)
    kwargs: dict[str, Any] = {}
    known_keys = {key for f in dataclasses.fields(cls) for key in (f.name, _camel(f.name))}
    for key in data.keys() - known_keys:
        errors.append(f"{path + '.' if path else ''}{key}: unknown key")
    for f in dataclasses.fields(cls):
        key = f.name if f.name in data else _camel(f.name)
        here = f"{path}.{f.name}" if path else f.name
        if key not in data:
            if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING:
                errors.append(f"{here}: missing")
            continue  # keep default
        val = data[key]
        hint = hints[f.name]
        origin = get_origin(hint)
        args = get_args(hint)
        # nested dataclass (possibly Optional)
        nested = None
        for cand in ([hint] + list(args)):
            if isinstance(cand, type) and dataclasses.is_dataclass(cand):
                nested = cand
        if nested is not None:
            if val is None and type(None) in args:
                kwargs[f.name] = None
            elif isinstance(val, dict):
                kwargs[f.name] = _build(nested, val, here, errors)
            else:
                errors.append(f"{here}: expected object")
            continue
        # Literal enum
        allowed = None
        if origin is typing.Literal:
            allowed = list(args)
        else:
            for cand in args:
                if get_origin(cand) is typing.Literal:
                    allowed = list(get_args(cand))
        if allowed is not None and val not in allowed:
            errors.append(f"{here}: '{val}' not in {allowed}")
        if hint is bool and type(val) is not bool:
            errors.append(f"{here}: expected boolean")
        if hint is str and not isinstance(val, str):
            errors.append(f"{here}: expected string")
        if hint is int or (origin is not list and int in args):
            if val is None and type(None) in args:
                kwargs[f.name] = None
                continue
            if type(val) is not int or abs(val) > 2**53 - 1:
                errors.append(f"{here}: expected safe integer")
            elif here == "credits.negative_floor":
                if val > 0:
                    errors.append(f"{here}: must be <= 0")
            elif here not in {"credits.bank_cap", "credits.expiry_notice_days"}:
                minimum = (
                    1
                    if here == "cs.fraud.window_days"
                    or here.startswith(("retention.", "credits.expiry_days."))
                    or here == "usage.reservation_ttl_minutes"
                    else 0
                )
                if val < minimum:
                    errors.append(f"{here}: must be >= {minimum}")
        if origin is list and (
            not isinstance(val, list)
            or any(type(item) is not int or not 1 <= item <= 2**53 - 1 for item in val)
        ):
            errors.append(f"{here}: expected positive integer[]")
        kwargs[f.name] = deepcopy(val)
    if errors:
        return None
    return cls(**kwargs)


def policy_from_dict(data: dict[str, Any] | None) -> Policy:
    """Accepts snake_case or camelCase keys (paykit.config.json). Missing keys -> defaults."""
    errors: list[str] = []
    p = _build(Policy, data or {}, "", errors)
    if errors:
        raise PolicyValidationError("invalid policy: " + "; ".join(errors), errors)
    return validate_policy(p)


def resolve_policy(patch: dict[str, Any] | None = None) -> Policy:
    return policy_from_dict(patch)


def validate_policy(p: Policy) -> Policy:
    errors: list[str] = []
    _build(Policy, policy_to_dict(p), "", errors)
    if errors:
        raise PolicyValidationError("invalid policy: " + "; ".join(errors), errors)
    if p.credits.rollover == "banked" and p.credits.bank_cap is None:
        errors.append("credits.bank_cap: required when rollover=banked")
    if p.usage.overage == "bill_overage" and p.usage.overage_unit_price_minor is None:
        errors.append("usage.overage_unit_price_minor: required when overage=bill_overage")
    if p.refund.annual_method == "deny_after_days" and p.refund.annual_deny_after_days is None:
        errors.append("refund.annual_deny_after_days: required when annual_method=deny_after_days")
    if p.dunning.retry_attempts < 0:
        errors.append("dunning.retry_attempts: must be >= 0")
    if p.dunning.retry_attempts > 0 and not p.dunning.retry_interval_hours:
        errors.append("dunning.retry_interval_hours: required when retry_attempts > 0")
    if p.retention.operation_days < 1:
        errors.append("retention.operation_days: must be >= 1")
    if p.dunning.grace_days < 0:
        errors.append("dunning.grace_days: must be >= 0")
    if p.refund.no_questions_days < 0:
        errors.append("refund.no_questions_days: must be >= 0")
    if errors:
        raise PolicyValidationError("invalid policy: " + "; ".join(errors), errors)
    return p
