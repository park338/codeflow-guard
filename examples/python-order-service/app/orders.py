from .config import get_config


def validate_item(item):
    if not item or not isinstance(item.get("sku"), str) or not item.get("sku"):
        raise ValueError("invalid sku")


def calculate_subtotal(items):
    if not isinstance(items, list) or len(items) == 0:
        raise ValueError("items required")

    total = 0.0
    for item in items:
        validate_item(item)
        total += float(item.get("quantity", 1)) * float(item.get("unit_price", 0))
    return total


def calculate_order_total(items, coupon=None, config=None):
    cfg = config or get_config()
    subtotal = calculate_subtotal(items)
    discount = subtotal * coupon.get("value", 0) if coupon and coupon.get("type") == "percent" else 0
    taxable_amount = subtotal - discount
    return round(taxable_amount * (1 + float(cfg["tax_rate"])), 2)

