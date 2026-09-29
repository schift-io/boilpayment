import pytest
from boilpayment_core import PaymentKitError
from boilpayment_cs import build_payment_link_url, decode_payment_link_reference


@pytest.mark.parametrize(
    ("provider", "parameter"),
    [("stripe", "client_reference_id"), ("polar", "reference_id")],
)
def test_pl_01_round_trips_customer_and_affiliate(provider, parameter):
    # Given
    from urllib.parse import parse_qs, urlparse

    # When
    built = build_payment_link_url(
        provider=provider,
        link_url="https://pay.example/link?locale=ko",
        customer_id="customer-1",
        affiliate_id="partner-1",
    )

    # Then
    query = parse_qs(urlparse(built).query)
    reference = query[parameter][0]
    assert query["locale"] == ["ko"]
    assert decode_payment_link_reference(reference) == {
        "customer_id": "customer-1",
        "affiliate_id": "partner-1",
    }


def test_pl_01_rejects_stripe_reference_that_would_be_silently_dropped():
    # Given
    customer_id = "x" * 300

    # When / Then
    with pytest.raises(PaymentKitError):
        build_payment_link_url(
            provider="stripe",
            link_url="https://buy.stripe.com/x",
            customer_id=customer_id,
        )


def test_pl_03_malformed_reference_decodes_to_none():
    # Given / When / Then
    assert decode_payment_link_reference("not-a-kit-reference") is None
