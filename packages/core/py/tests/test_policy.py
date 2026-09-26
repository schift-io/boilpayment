"""policy validation errors -- packages/core/py/src/schift_payment_kit_core/policy.py"""

from __future__ import annotations

import pytest
from schift_payment_kit_core import PolicyValidationError, resolve_policy


def test_resolve_policy_defaults():
    policy = resolve_policy()
    assert policy.credits.rollover == "none"
    assert policy.upgrade.mode == "immediate_prorate_reset_anchor"
    assert policy.dunning.grace_days == 7


def test_rollover_banked_without_bank_cap_raises():
    with pytest.raises(PolicyValidationError):
        resolve_policy({"credits": {"rollover": "banked"}})


def test_rollover_banked_with_bank_cap_is_valid():
    policy = resolve_policy({"credits": {"rollover": "banked", "bankCap": 50}})
    assert policy.credits.bank_cap == 50


def test_overage_bill_overage_without_unit_price_raises():
    with pytest.raises(PolicyValidationError):
        resolve_policy({"usage": {"overage": "bill_overage"}})


def test_grace_days_negative_raises():
    with pytest.raises(PolicyValidationError):
        resolve_policy({"dunning": {"graceDays": -1}})


def test_no_questions_days_negative_raises():
    with pytest.raises(PolicyValidationError):
        resolve_policy({"refund": {"noQuestionsDays": -1}})


def test_invalid_enum_value_raises_and_names_path():
    with pytest.raises(PolicyValidationError) as exc_info:
        resolve_policy({"upgrade": {"mode": "not_a_real_mode"}})
    assert "mode" in str(exc_info.value)


@pytest.mark.parametrize("patch", [
    {"cs": {"autoApprove": {"maxAmountMinor": value}}}
    for value in [-1, 0.5, None, float("nan"), float("inf"), 2**53]
] + [
    {"cs": {"autoApprove": {"maxCredits": True}}},
    {"cs": {"fraud": {"windowDays": 0}}},
    {"cs": {"fraud": {"refundVelocity": -1}}},
    {"cashReceipt": {"cancelOnRefund": "false"}},
    {"dunning": {"retryIntervalHours": [0]}},
    {"credits": {"topupExpiryDays": -1}},
    {"usage": {"creditConversion": {"unit": "token", "creditsPerUnit": -1}}},
    {"retention": {"auditLogDays": 0}},
    {"cs": {"autoApprove": None}},
    {"usage": {"creditConversion": {"unit": "token"}}},
])
def test_rejects_invalid_authority_configuration(patch):
    with pytest.raises(PolicyValidationError):
        resolve_policy(patch)


def test_retry_arrays_are_independent_of_input_and_serialized_output():
    from schift_payment_kit_core.policy import policy_to_dict

    retries = [12]
    policy = resolve_policy({"dunning": {"retryIntervalHours": retries}})
    retries.append(24)
    assert policy.dunning.retry_interval_hours == [12]
    serialized = policy_to_dict(policy)
    serialized["dunning"]["retry_interval_hours"].append(48)
    assert policy.dunning.retry_interval_hours == [12]


def test_zero_authority_limits_and_positive_window_are_valid():
    policy = resolve_policy({"cs": {"autoApprove": {"maxAmountMinor": 0, "maxCredits": 0}, "fraud": {"windowDays": 1}}})
    assert policy.cs.auto_approve.max_amount_minor == 0


def test_validate_policy_checks_direct_dataclass_values():
    from dataclasses import replace

    from schift_payment_kit_core.policy import validate_policy

    policy = resolve_policy()
    invalid = replace(policy, cs=replace(policy.cs, fraud=replace(policy.cs.fraud, window_days=-1)))
    with pytest.raises(PolicyValidationError):
        validate_policy(invalid)


@pytest.mark.parametrize("patch", [
    {"refnud": {}},
    {"refund": {"annualDaysThreshold": 10}},
    {"cs": {"autoApprove": {"maxAmuntMinor": 100}}},
    {"usage": {"creditConversion": {"unit": "token", "creditsPerUnit": 1, "typo": True}}},
])
def test_unknown_configuration_keys_are_rejected(patch):
    with pytest.raises(PolicyValidationError):
        resolve_policy(patch)


def test_annual_refund_rule_requires_threshold():
    with pytest.raises(PolicyValidationError):
        resolve_policy({"refund": {"annualMethod": "deny_after_days"}})
    assert resolve_policy({"refund": {"annualMethod": "deny_after_days", "annualDenyAfterDays": 0}}).refund.annual_deny_after_days == 0
