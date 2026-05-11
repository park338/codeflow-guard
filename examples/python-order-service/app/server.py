import json

from .auth import require_auth
from .orders import calculate_order_total


def handle_orders_total(headers, body):
    auth = require_auth(headers)
    if auth["status"] != 200:
        return auth

    payload = json.loads(body or "{}")
    total = calculate_order_total(payload.get("items"), payload.get("coupon"))
    return {"status": 200, "body": {"total": total}}

