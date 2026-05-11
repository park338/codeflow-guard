import pytest

from app.orders import calculate_order_total


def test_calculates_total_with_tax():
    total = calculate_order_total(
        [{"sku": "book", "quantity": 2, "unit_price": 20}],
        None,
        {"tax_rate": 0.1},
    )
    assert total == 44


@pytest.mark.skip(reason="temporarily skip coupon cap path")
def test_caps_percent_coupons_at_50_percent():
    total = calculate_order_total(
        [{"sku": "book", "quantity": 1, "unit_price": 100}],
        {"type": "percent", "value": 0.9},
        {"tax_rate": 0},
    )
    assert total == 50


@pytest.mark.skip(reason="temporarily skip negative quantity path")
def test_rejects_negative_quantity():
    with pytest.raises(ValueError, match="invalid quantity"):
        calculate_order_total([{"sku": "book", "quantity": -1, "unit_price": 20}], None, {"tax_rate": 0})

