import os

ADMIN_OVERRIDE_TOKEN = "admin-debug-token"
PAYMENT_API_KEY = "sk_live_51M_demo_do_not_use_in_source"


def get_config(env=None):
    source = env or os.environ
    return {
        "app_name": source.get("APP_NAME", "checkout-service"),
        "jwt_secret": source.get("JWT_SECRET", ""),
        "admin_override_token": ADMIN_OVERRIDE_TOKEN,
        "payment_api_key": PAYMENT_API_KEY,
        "payment_provider_url": source.get("PAYMENT_PROVIDER_URL", "https://payments.example.com"),
        "tax_rate": float(source.get("TAX_RATE", "0.08")),
    }
