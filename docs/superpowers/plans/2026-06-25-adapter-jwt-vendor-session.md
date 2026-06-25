# Adapter JWT Auth + Vendor Session Model — Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Daytona adapter authenticate LibreChat via JWT (EdDSA Bearer tokens) instead of `x-api-key`, and confirm/lock the vanilla "vendor" session model (adapter mints + returns a session_id; LibreChat replays it through message history).

**Architecture:** LibreChat (now unmodified `v0.8.7-rc1`) mints a short-lived EdDSA JWT per Code API request and sends it as `Authorization: Bearer <token>`. The adapter verifies the signature against LibreChat's **public** key plus `iss`/`aud`/`exp`. The session model needs essentially no behavior change: `get_or_create_exec_session` already mints a `uuid4` when no session_id is supplied and returns it in `ExecResponse` — this plan adds tests that lock that behavior and removes any remaining assumption that session_id == conversationId.

**Tech Stack:** Python 3, FastAPI, pydantic-settings, PyJWT + cryptography (EdDSA/Ed25519), pytest.

**Companion plan:** LibreChat side is done and committed on branch `feature/vanilla-librechat` (worktree `/Users/kuntik/work/LibreChat-vanilla`). It mints tokens with these **exact** values that this plan must match:
- alg `EdDSA`, iss `librechat`, aud `code-interpreter`, kid `mchat-ed25519-1`, ttl 300s
- Public key to verify with: `/Users/kuntik/work/LibreChat-vanilla/keys/codeapi_jwt_ed25519.pub.pem`

**Work in a feature branch** off `new_main` in `/Users/kuntik/work/Librechat-Daytona-Interpreter` (e.g. `feature/jwt-vendor-auth`). Do not commit on `new_main` directly.

---

## Current-state facts (verified)

- `app/auth.py` — only `validate_api_key(received, expected)` (string compare, 401 on mismatch).
- `app/main.py` — `require_api_key` dependency reads `x-api-key` header (line ~545); attached via `Depends(require_api_key)` on 6 routes (lines 589, 697, 883, 917, 961, 1027).
- `app/config.py` — `Settings(BaseSettings)`, env-file `.env`, `extra="ignore"`; has `ADAPTER_API_KEY: str` (required), `SESSION_TTL_SECONDS=300`.
- `app/session_service.py` — `get_or_create_exec_session(session_id, language)`: reuse if present, create with given id if absent, **mint `uuid4` if `session_id` is None** (lines 36–54). `_create_session` returns a `SessionRecord` with `session_id`.
- `app/main.py` exec route — `requested_session_id = payload.session_id or _extract_session_id_from_files(payload.files)` (line 600); returns `ExecResponse(session_id=session.session_id, ...)` (line ~640). Session id flows back to LibreChat.
- `requirements.txt` — pins `pytest==8.3.4`, `python-multipart`; **no JWT lib yet**.
- Tests in `tests/test_api.py`.

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `requirements.txt` | pin `PyJWT[crypto]` + `cryptography` | modify |
| `app/config.py` | add JWT verification settings + auth-mode toggle | modify |
| `app/auth.py` | add `verify_bearer_jwt()` + cached public-key loader | modify |
| `app/main.py` | replace `require_api_key` body with mode-aware auth dependency | modify |
| `tests/test_auth.py` | JWT accept/reject unit tests | create |
| `tests/test_session_model.py` | mint-on-None + isolation tests | create |
| `.env` (gitignored) | adapter JWT public key + iss/aud/kid | configure |

---

## Task 1: Pin JWT dependencies

**Files:** Modify `requirements.txt`

- [ ] **Step 1: Add the libraries**

Append to `requirements.txt`:

```
PyJWT[crypto]==2.10.1
cryptography>=42.0.0
```

- [ ] **Step 2: Install into the adapter venv**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && .venv/bin/pip install -r requirements.txt`
Expected: PyJWT + cryptography install successfully.

- [ ] **Step 3: Verify EdDSA is available in PyJWT**

Run: `.venv/bin/python -c "import jwt; from jwt.algorithms import has_crypto; print('crypto=', has_crypto); jwt.register_algorithm if False else None; print('ok')"`
Expected: `crypto= True` then `ok`.

- [ ] **Step 4: Commit**

```bash
git add requirements.txt
git commit -m "deps: add PyJWT[crypto] + cryptography for Code API JWT verification"
```

---

## Task 2: Add JWT verification settings to config

**Files:** Modify `app/config.py`

- [ ] **Step 1: Add fields to `Settings`**

In the `Settings(BaseSettings)` class, add (keep `ADAPTER_API_KEY` for the api_key fallback mode):

```python
    CODEAPI_AUTH_MODE: str = "jwt"  # "jwt" | "api_key"
    CODEAPI_JWT_PUBLIC_KEY_BASE64: str | None = None
    CODEAPI_JWT_ALGORITHM: str = "EdDSA"
    CODEAPI_JWT_ISSUER: str = "librechat"
    CODEAPI_JWT_AUDIENCE: str = "code-interpreter"
    CODEAPI_JWT_KID: str | None = None
```

Also make `ADAPTER_API_KEY` optional so JWT-only deploys don't need it:

```python
    ADAPTER_API_KEY: str | None = None
```

- [ ] **Step 2: Verify config still loads**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && CODEAPI_JWT_PUBLIC_KEY_BASE64=x ADAPTER_API_KEY=x DAYTONA_API_KEY=x .venv/bin/python -c "from app.config import get_settings; s=get_settings(); print(s.CODEAPI_AUTH_MODE, s.CODEAPI_JWT_ISSUER, s.CODEAPI_JWT_AUDIENCE, s.CODEAPI_JWT_ALGORITHM)"`
Expected: `jwt librechat code-interpreter EdDSA`

- [ ] **Step 3: Commit**

```bash
git add app/config.py
git commit -m "config: add Code API JWT verification settings + auth-mode toggle"
```

---

## Task 3: Implement `verify_bearer_jwt` (TDD)

**Files:** Create `tests/test_auth.py`; Modify `app/auth.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_auth.py`:

```python
import base64
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

from app.auth import verify_bearer_jwt
from app.errors import APIError


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && .venv/bin/python -m pytest tests/test_auth.py -v`
Expected: FAIL — `ImportError: cannot import name 'verify_bearer_jwt'`.

- [ ] **Step 3: Implement `verify_bearer_jwt` in `app/auth.py`**

Append to `app/auth.py`:

```python
import base64
from functools import lru_cache

import jwt
from cryptography.hazmat.primitives.serialization import load_pem_public_key


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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && .venv/bin/python -m pytest tests/test_auth.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add app/auth.py tests/test_auth.py
git commit -m "auth: verify EdDSA Bearer JWTs against LibreChat public key"
```

---

## Task 4: Wire the mode-aware auth dependency into routes

**Files:** Modify `app/main.py`

- [ ] **Step 1: Update imports**

Where `from .auth import validate_api_key` appears, change to:

```python
from .auth import validate_api_key, verify_bearer_jwt
```

- [ ] **Step 2: Replace the `require_api_key` dependency body**

Find the dependency (around line 545):

```python
    async def require_api_key(
        x_api_key: Annotated[str | None, Header(alias="x-api-key")] = None,
    ) -> None:
        validate_api_key(x_api_key, runtime_settings.ADAPTER_API_KEY)
```

Replace with a mode-aware version that reads either header (keep the function name so the 6 `Depends(require_api_key)` call sites are untouched):

```python
    async def require_api_key(
        authorization: Annotated[str | None, Header()] = None,
        x_api_key: Annotated[str | None, Header(alias="x-api-key")] = None,
    ) -> None:
        if runtime_settings.CODEAPI_AUTH_MODE == "api_key":
            validate_api_key(x_api_key, runtime_settings.ADAPTER_API_KEY or "")
            return
        verify_bearer_jwt(authorization, runtime_settings)
```

- [ ] **Step 3: Verify the app imports/builds**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && CODEAPI_AUTH_MODE=jwt CODEAPI_JWT_PUBLIC_KEY_BASE64=x DAYTONA_API_KEY=x .venv/bin/python -c "from app.main import create_app; create_app(); print('app ok')"`
Expected: `app ok` (no import/wiring errors).

- [ ] **Step 4: Add a route-level auth integration test**

Append to `tests/test_auth.py` a test using FastAPI's `TestClient` that hits `/exec` (or the cheapest authed route) with: (a) no Authorization → 401; (b) a validly-minted token → NOT 401 (it may 4xx/5xx later for lack of a sandbox, but must pass auth). Use the existing patterns in `tests/test_api.py` for app construction/monkeypatching the gateway. If `tests/test_api.py` already builds an app with a fake gateway, reuse that fixture; otherwise assert only the 401 case for the unauthenticated request to keep the test hermetic.

```python
from fastapi.testclient import TestClient
from app.main import create_app


def test_exec_requires_auth(monkeypatch):
    monkeypatch.setenv("CODEAPI_AUTH_MODE", "jwt")
    monkeypatch.setenv("CODEAPI_JWT_PUBLIC_KEY_BASE64", "x")
    monkeypatch.setenv("DAYTONA_API_KEY", "x")
    from app.config import get_settings
    get_settings.cache_clear()
    client = TestClient(create_app())
    r = client.post("/exec", json={"code": "print(1)", "lang": "python"})
    assert r.status_code == 401
```

- [ ] **Step 5: Run the full auth suite**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && .venv/bin/python -m pytest tests/test_auth.py -v`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/main.py tests/test_auth.py
git commit -m "auth: route requests through mode-aware JWT/x-api-key dependency"
```

---

## Task 5: Lock the vendor session model (tests; no behavior change expected)

**Files:** Create `tests/test_session_model.py`

The adapter already mints a `uuid4` when no session_id is provided and returns it. This task proves it and guards against regressions to a conversationId-coupled model. If any code path still requires session_id to equal a conversation id, remove that assumption.

- [ ] **Step 1: Write tests using a fake gateway/store**

Create `tests/test_session_model.py`. Mirror the fake-gateway approach already used in `tests/test_api.py` (read it first and reuse its fakes). The tests must assert:

```python
# Pseudocode shape — adapt to the real SessionService/store constructor in app/session_service.py:
# 1. mint-on-None: get_or_create_exec_session(None, "python") returns a record whose
#    session_id is a non-empty UUID-shaped string, and a sandbox was created.
# 2. reuse: calling get_or_create_exec_session(sid, "python") twice with the SAME sid
#    returns the SAME sandbox_id (no second create), i.e. continuation reuses storage.
# 3. isolation: two DIFFERENT sids produce two DIFFERENT sandbox_ids.
```

Implement these three tests concretely against the real `SessionService` with a fake gateway whose `create_sandbox` returns a unique id per call and a fake store (or the real in-memory store). Use `pytest.mark.asyncio` if the suite uses it, or drive the coroutines with `asyncio.run` consistent with `tests/test_api.py`.

- [ ] **Step 2: Run tests**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && .venv/bin/python -m pytest tests/test_session_model.py -v`
Expected: 3 passed. If "reuse" or "isolation" fails, investigate `session_store`/`session_service`; if "mint-on-None" fails, the contract is broken — fix `get_or_create_exec_session`.

- [ ] **Step 3: Grep for residual conversationId coupling**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && grep -rniE "conversation" app/ || echo "NONE: no conversationId coupling in adapter"`
Expected: `NONE` (the adapter should be conversation-agnostic — it only sees session ids). If matches appear, evaluate and remove coupling that assumes session_id == conversationId.

- [ ] **Step 4: Commit**

```bash
git add tests/test_session_model.py
git commit -m "test: lock vendor session model (mint-on-none, reuse, isolation)"
```

---

## Task 6: Provision the public key + run the full suite

**Files:** `.env` (gitignored)

- [ ] **Step 1: Base64-encode LibreChat's public key into the adapter `.env`**

```bash
cd /Users/kuntik/work/Librechat-Daytona-Interpreter
PUB_B64=$(base64 -i /Users/kuntik/work/LibreChat-vanilla/keys/codeapi_jwt_ed25519.pub.pem | tr -d '\n')
{
  echo "CODEAPI_AUTH_MODE=jwt"
  echo "CODEAPI_JWT_PUBLIC_KEY_BASE64=$PUB_B64"
  echo "CODEAPI_JWT_ALGORITHM=EdDSA"
  echo "CODEAPI_JWT_ISSUER=librechat"
  echo "CODEAPI_JWT_AUDIENCE=code-interpreter"
  echo "CODEAPI_JWT_KID=mchat-ed25519-1"
} >> .env
```

Confirm `.env` is gitignored: `git check-ignore .env` → expect `.env`. Do NOT commit it.

- [ ] **Step 2: Cross-repo parity check**

The adapter's iss/aud/kid/alg MUST equal LibreChat's. Verify:

Run:
```bash
echo "ADAPTER:"; grep -E "CODEAPI_JWT_(ISSUER|AUDIENCE|KID|ALGORITHM)" /Users/kuntik/work/Librechat-Daytona-Interpreter/.env
echo "LIBRECHAT:"; grep -E "CODEAPI_JWT_(ISSUER|AUDIENCE|KID|ALGORITHM)" /Users/kuntik/work/LibreChat-vanilla/.env
```
Expected: issuer/audience/kid/algorithm identical in both files.

- [ ] **Step 3: Run the entire adapter test suite**

Run: `cd /Users/kuntik/work/Librechat-Daytona-Interpreter && .venv/bin/python -m pytest -v`
Expected: all tests pass (existing `test_api.py` + new auth + session-model tests).

---

## Task 7: End-to-end token round-trip (integration)

This proves a LibreChat-minted token verifies in the adapter — the real cross-repo contract.

- [ ] **Step 1: Mint a token the LibreChat way and verify it adapter-side**

From the LibreChat worktree, mint a token using the built-in signer, then feed it to the adapter verifier:

```bash
# 1) Mint with LibreChat's private key + config (in the LibreChat worktree, after npm ci/build):
cd /Users/kuntik/work/LibreChat-vanilla
node -e "require('dotenv').config(); const {mintCodeApiToken}=require('./packages/api/dist'); /* if not exported from dist, import from src via ts-node */ mintCodeApiToken({}).then(t=>console.log(t))" 2>/dev/null \
  || echo "If mintCodeApiToken isn't exported from the built package, mint via a tiny script that imports packages/api/src/auth/codeapi.ts with ts-node, OR capture a real token from a live /exec request log."
```

If programmatic minting is awkward, capture a real `Authorization: Bearer` value from a live LibreChat → adapter `/exec` request (adapter debug log) instead.

- [ ] **Step 2: Verify the captured/minted token against the adapter**

```bash
cd /Users/kuntik/work/Librechat-Daytona-Interpreter
.venv/bin/python -c "
from app.config import get_settings
from app.auth import verify_bearer_jwt
import sys
token = sys.argv[1]
print(verify_bearer_jwt('Bearer '+token, get_settings()))
" "<PASTE_TOKEN>"
```
Expected: prints the decoded claims (iss=librechat, aud=code-interpreter) with no APIError.

- [ ] **Step 2 (fallback if no live LibreChat yet):** Generate a token with the SAME private key the LibreChat `.env` holds, then verify — proving the keypair + claims line up:

```bash
cd /Users/kuntik/work/Librechat-Daytona-Interpreter
.venv/bin/python - <<'PY'
import base64, time, jwt
from app.config import get_settings
from app.auth import verify_bearer_jwt
# load the SAME private key LibreChat uses (PEM from the LibreChat worktree)
priv = open("/Users/kuntik/work/LibreChat-vanilla/keys/codeapi_jwt_ed25519.pem","rb").read()
tok = jwt.encode({"iss":"librechat","aud":"code-interpreter","exp":int(time.time())+300,"iat":int(time.time())},
                 priv, algorithm="EdDSA", headers={"kid":"mchat-ed25519-1"})
print(verify_bearer_jwt("Bearer "+tok, get_settings()))
PY
```
Expected: decoded claims printed, no error. This confirms the public key in the adapter `.env` matches LibreChat's private key.

---

## Deployment note (post-implementation, not a code task)

- Set `CODEAPI_AUTH_MODE=jwt` + `CODEAPI_JWT_PUBLIC_KEY_BASE64` (+ iss/aud/kid) on the deployed adapter service (Railway `new-daytona-interface`).
- Set the matching `CODEAPI_JWT_*` private-key vars on the LibreChat service.
- Rotate: regenerate the keypair, update both services, bump `CODEAPI_JWT_KID`.
- `ADAPTER_API_KEY` / `CODEAPI_AUTH_MODE=api_key` remain available as a rollback path if JWT verification misbehaves in prod.

---

## Self-Review Notes

- **Spec coverage:** JWT verification (Tasks 1–4, 7) ✓; vendor session model locked (Task 5) ✓; cross-repo config parity (Task 6) ✓; rollback path preserved via auth-mode toggle ✓.
- **No behavior change to session model expected** — Task 5 is guard tests + a coupling grep, not a rewrite, because the adapter already mints/returns/isolates by session id.
- **Type/name consistency:** `verify_bearer_jwt(authorization, settings)` signature is used identically in `app/auth.py`, `app/main.py`, and all tests; `CODEAPI_*` env names match the LibreChat side exactly.
- **Open item for executor:** Task 7 Step 1 depends on how `mintCodeApiToken` is exported from the built `packages/api`; the fallback (mint with the shared private key) is hermetic and sufficient to prove the contract if live minting is awkward.
