import base64
import tempfile
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from app.auth import verify_bearer_jwt
from app.config import Settings
from app.errors import APIError
from app.main import create_app
from app.session_store import MemorySessionStore

from tests.test_api import FakeDaytonaGateway


class _Cfg:
    CODEAPI_JWT_ALGORITHM = "EdDSA"
    CODEAPI_JWT_ISSUER = "librechat"
    CODEAPI_JWT_AUDIENCE = "code-interpreter"
    CODEAPI_JWT_KID = None

    def __init__(self, pub_b64):
        self.CODEAPI_JWT_PUBLIC_KEY_BASE64 = pub_b64


def _keypair():
    priv = Ed25519PrivateKey.generate()
    priv_pem = priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return priv_pem, base64.b64encode(pub_pem).decode()


def _mint(priv_pem, **overrides):
    claims = {
        "iss": "librechat",
        "aud": "code-interpreter",
        "exp": int(time.time()) + 300,
        "iat": int(time.time()),
    }
    claims.update(overrides)
    return jwt.encode(claims, priv_pem, algorithm="EdDSA")


def test_valid_token_accepted():
    priv, pub_b64 = _keypair()
    token = _mint(priv)
    claims = verify_bearer_jwt(f"Bearer {token}", _Cfg(pub_b64))
    assert claims["iss"] == "librechat"


def test_missing_header_rejected():
    _, pub_b64 = _keypair()
    with pytest.raises(APIError) as e:
        verify_bearer_jwt(None, _Cfg(pub_b64))
    assert e.value.status_code == 401


def test_wrong_audience_rejected():
    priv, pub_b64 = _keypair()
    token = _mint(priv, aud="someone-else")
    with pytest.raises(APIError) as e:
        verify_bearer_jwt(f"Bearer {token}", _Cfg(pub_b64))
    assert e.value.status_code == 401


def test_expired_token_rejected():
    priv, pub_b64 = _keypair()
    token = _mint(priv, exp=int(time.time()) - 10)
    with pytest.raises(APIError) as e:
        verify_bearer_jwt(f"Bearer {token}", _Cfg(pub_b64))
    assert e.value.status_code == 401


def test_tampered_signature_rejected():
    priv, pub_b64 = _keypair()
    other_priv, _ = _keypair()
    token = _mint(other_priv)  # signed by a different key
    with pytest.raises(APIError) as e:
        verify_bearer_jwt(f"Bearer {token}", _Cfg(pub_b64))
    assert e.value.status_code == 401


def test_none_algorithm_rejected():
    priv, pub_b64 = _keypair()
    # token with alg=none, no signature
    token = jwt.encode(
        {"iss": "librechat", "aud": "code-interpreter",
         "exp": int(time.time()) + 300, "iat": int(time.time())},
        key=None, algorithm="none",
    )
    with pytest.raises(APIError) as e:
        verify_bearer_jwt(f"Bearer {token}", _Cfg(pub_b64))
    assert e.value.status_code == 401


def test_missing_exp_rejected():
    priv, pub_b64 = _keypair()
    token = jwt.encode(
        {"iss": "librechat", "aud": "code-interpreter", "iat": int(time.time())},
        priv, algorithm="EdDSA",
    )
    with pytest.raises(APIError) as e:
        verify_bearer_jwt(f"Bearer {token}", _Cfg(pub_b64))
    assert e.value.status_code == 401


def test_non_eddsa_config_algorithm_rejected():
    priv, pub_b64 = _keypair()
    token = _mint(priv)
    cfg = _Cfg(pub_b64)
    cfg.CODEAPI_JWT_ALGORITHM = "HS256"  # operator misconfig -> must be refused
    with pytest.raises(APIError) as e:
        verify_bearer_jwt(f"Bearer {token}", cfg)
    assert e.value.status_code == 401


def _jwt_client(pub_b64):
    settings = Settings(
        CODEAPI_AUTH_MODE="jwt",
        CODEAPI_JWT_PUBLIC_KEY_BASE64=pub_b64,
        DAYTONA_API_KEY="test-daytona-key",
        BUCKET_ROOT=tempfile.mkdtemp(prefix="lc-buckets-"),
    )
    app = create_app(
        settings=settings,
        store=MemorySessionStore(),
        gateway=FakeDaytonaGateway(),
        enable_cleanup=False,
    )
    return TestClient(app)


def test_protected_route_requires_auth():
    _, pub_b64 = _keypair()
    client = _jwt_client(pub_b64)
    r = client.post("/exec", json={"code": "print(1)", "lang": "python"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_protected_route_accepts_valid_token():
    priv, pub_b64 = _keypair()
    client = _jwt_client(pub_b64)
    token = _mint(priv)
    r = client.post(
        "/exec",
        headers={"Authorization": f"Bearer {token}"},
        json={"code": "print(1)", "lang": "python"},
    )
    # A validly-minted token clears the auth dependency; the request may then
    # succeed (fake gateway) or fail downstream, but it must NOT be a 401.
    assert r.status_code != 401
