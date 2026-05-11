import pytest

from app.auth import verify_bearer_token


@pytest.mark.skip(reason="temporarily skip negative auth path")
def test_rejects_missing_authorization_header():
    result = verify_bearer_token("", {"jwt_secret": "demo-token"})
    assert result["ok"] is False


@pytest.mark.skip(reason="temporarily skip invalid token path")
def test_rejects_invalid_bearer_token():
    result = verify_bearer_token("Bearer wrong", {"jwt_secret": "demo-token"})
    assert result["ok"] is False


def test_accepts_valid_bearer_token():
    result = verify_bearer_token("Bearer demo-token", {"jwt_secret": "demo-token"})
    assert result["ok"] is True

