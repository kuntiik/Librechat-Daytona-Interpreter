#!/usr/bin/env bash
# Live auth + session-ownership E2E for the Daytona adapter (JWT mode).
#
# Starts the adapter on a test port, mints EdDSA tokens with LibreChat's private
# key, and asserts the auth contract end-to-end against the running service:
#   - no Authorization            -> 401
#   - token without `sub`         -> 401
#   - token signed by wrong key   -> 401
#   - valid userA token           -> 200 (runs code in a real Daytona sandbox)
#   - userB reusing userA session -> 403 (cross-principal steal blocked)
#   - userA reusing own session   -> 200
#
# Requires: the adapter .env configured for JWT mode (CODEAPI_JWT_PUBLIC_KEY_BASE64
# matching the private key below) and reachable Daytona creds. Runs real sandboxes.
#
# Usage:
#   tests/e2e_auth.sh
#   PRIV_KEY=/path/to/codeapi_jwt_ed25519.pem PORT=8799 tests/e2e_auth.sh
set -euo pipefail

ADAPTER_DIR="${ADAPTER_DIR:-/Users/kuntik/work/Librechat-Daytona-Interpreter}"
PRIV_KEY="${PRIV_KEY:-/Users/kuntik/work/LibreChat-vanilla/keys/codeapi_jwt_ed25519.pem}"
PORT="${PORT:-8765}"
KID="${KID:-mchat-ed25519-1}"
PY="$ADAPTER_DIR/.venv/bin/python"
BASE="http://127.0.0.1:$PORT"

[ -f "$PRIV_KEY" ] || { echo "FAIL: private key not found at $PRIV_KEY"; exit 1; }

mint() { # $1 = sub ("" => omit sub); $2 = wrong-key flag (any value => random key)
  "$PY" - "$1" "${2:-}" "$PRIV_KEY" "$KID" <<'PY'
import sys, time, jwt
sub, wrong, priv_path, kid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
if wrong:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    key = Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption())
else:
    key = open(priv_path, "rb").read()
claims = {"iss": "librechat", "aud": "code-interpreter",
          "exp": int(time.time()) + 300, "iat": int(time.time())}
if sub:
    claims["sub"] = sub
print(jwt.encode(claims, key, algorithm="EdDSA", headers={"kid": kid}))
PY
}

code() { # $1=token $2=session_id $3=python-code  -> prints HTTP status
  curl -s -o /tmp/e2e_auth.body -w "%{http_code}" -X POST "$BASE/exec" \
    -H 'content-type: application/json' -H "Authorization: Bearer $1" \
    -d "{\"session_id\":\"$2\",\"code\":\"$3\",\"lang\":\"python\"}"
}
expect() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then echo "  PASS  $1 (HTTP $3)"; else echo "  FAIL  $1: expected $2, got $3"; FAILED=1; fi
}

echo "Starting adapter on :$PORT ..."
( cd "$ADAPTER_DIR" && "$PY" -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port "$PORT" ) >/tmp/e2e_auth_adapter.log 2>&1 &
UVPID=$!
trap 'kill $UVPID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break; perl -e 'select(undef,undef,undef,1)'; done
curl -fsS "$BASE/healthz" >/dev/null 2>&1 || { echo "FAIL: adapter did not come up"; cat /tmp/e2e_auth_adapter.log; exit 1; }
echo "Adapter up."

FAILED=0
SID="e2e-$(date +%s)"
TOKA=$(mint userA); TOKB=$(mint userB)
TOK_NOSUB=$(mint "" ""); TOK_WRONG=$(mint userA wrong)

echo "Auth contract:"
expect "no auth -> 401"        401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/exec" -H 'content-type: application/json' -d '{"session_id":"x","code":"print(1)","lang":"python"}')"
expect "no sub -> 401"         401 "$(code "$TOK_NOSUB" "$SID" 'print(1)')"
expect "wrong key -> 401"      401 "$(code "$TOK_WRONG" "$SID" 'print(1)')"

echo "Session ownership:"
expect "userA create -> 200"   200 "$(code "$TOKA" "$SID" "open('/mnt/data/secret.txt','w').write('userA-private'); print('ok')")"
expect "userB steal -> 403"    403 "$(code "$TOKB" "$SID" "print(open('/mnt/data/secret.txt').read())")"
expect "userA reuse -> 200"    200 "$(code "$TOKA" "$SID" "print(open('/mnt/data/secret.txt').read())")"

echo ""
[ "$FAILED" = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
echo "(reminder: this created a real Daytona sandbox for session '$SID' — reap idle sandboxes per CLAUDE.md quota snippet)"
