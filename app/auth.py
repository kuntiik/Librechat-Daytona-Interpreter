from __future__ import annotations

import base64
from functools import lru_cache

import jwt
from cryptography.hazmat.primitives.serialization import load_pem_public_key

from .errors import APIError

_ALLOWED_JWT_ALGORITHMS = frozenset({"EdDSA"})


def validate_api_key(received_key: str | None, expected_key: str) -> None:
    if not received_key or received_key != expected_key:
        raise APIError(
            status_code=401,
            code="unauthorized",
            message="Invalid or missing x-api-key header.",
        )


@lru_cache(maxsize=8)
def _load_public_key(pub_b64: str):
    pem = base64.b64decode(pub_b64)
    return load_pem_public_key(pem)


def verify_bearer_jwt(authorization: str | None, settings) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise APIError(
            status_code=401,
            code="unauthorized",
            message="Missing or malformed Authorization header.",
        )
    token = authorization[len("Bearer ") :].strip()
    if not settings.CODEAPI_JWT_PUBLIC_KEY_BASE64:
        raise APIError(
            status_code=401,
            code="unauthorized",
            message="Code API JWT public key is not configured.",
        )
    if settings.CODEAPI_JWT_ALGORITHM not in _ALLOWED_JWT_ALGORITHMS:
        raise APIError(
            status_code=401,
            code="unauthorized",
            message="JWT algorithm not permitted.",
        )
    if not settings.CODEAPI_JWT_ISSUER or not settings.CODEAPI_JWT_AUDIENCE:
        raise APIError(
            status_code=401,
            code="unauthorized",
            message="JWT issuer/audience not configured.",
        )
    public_key = _load_public_key(settings.CODEAPI_JWT_PUBLIC_KEY_BASE64)
    if settings.CODEAPI_JWT_KID:
        header = jwt.get_unverified_header(token)
        if header.get("kid") != settings.CODEAPI_JWT_KID:
            raise APIError(
                status_code=401, code="unauthorized", message="Unexpected token kid."
            )
    try:
        return jwt.decode(
            token,
            public_key,
            algorithms=[settings.CODEAPI_JWT_ALGORITHM],
            audience=settings.CODEAPI_JWT_AUDIENCE,
            issuer=settings.CODEAPI_JWT_ISSUER,
            options={"require": ["exp", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise APIError(
            status_code=401,
            code="unauthorized",
            message=f"JWT verification failed: {exc}",
        )

