# Daytona Code-Interpreter Integration

Authoritative reference for how LibreChat's Code Interpreter is wired to Daytona
through this adapter: architecture, authentication, session isolation, the
adapter API, and how to build/roll a new sandbox base image.

- **LibreChat side:** vanilla `v0.8.7-rc1` (branch `feature/vanilla-librechat`),
  no source changes — integration is config only. Session-continuity decision:
  `LibreChat/docs/superpowers/specs/2026-06-30-session-continuity-decision.md`.
- **Adapter side:** this repo (`feature/jwt-vendor-auth`). Plan:
  `docs/superpowers/plans/2026-06-25-adapter-jwt-vendor-session.md`.

---

## 1. Topology

```
LibreChat backend            (:3080, vanilla v0.8.7-rc1)
      │  POST /exec, /upload, GET /download …   Authorization: Bearer <JWT>
      ▼
Daytona adapter (this repo)  (:8765, FastAPI)
      │  • verifies the EdDSA JWT against LibreChat's public key
      │  • binds each session to the JWT subject (owner)
      │  • storage = host buckets;  compute = ephemeral Daytona sandboxes
      ▼
Daytona Cloud   app.daytona.io
      runs sandboxes from image  kuntik/librechat-skills:<tag>
```

The adapter is the only component that talks to Daytona. LibreChat never sees
Daytona; it only knows the code-API contract (`LIBRECHAT_CODE_BASEURL`).

---

## 2. Authentication — EdDSA JWT (Option B)

LibreChat mints a short-lived EdDSA Bearer token per code-API request
(`isCodeApiJwtAuthEnabled` / `mintCodeApiToken`, both vanilla). The adapter
verifies it. No `x-api-key`.

**Token claims** (vanilla `buildClaims`): `iss`, `aud`, `sub` (LibreChat user
id), `tenant_id`, `exp`, `iat`, `jti`, `role`, … There is **no conversation id**
in the token or the request body.

**Keypair:** one ed25519 keypair. LibreChat holds the **private** key; the
adapter verifies with the **public** key.

```bash
openssl genpkey -algorithm ed25519 -out codeapi_jwt_ed25519.pem
openssl pkey -in codeapi_jwt_ed25519.pem -pubout -out codeapi_jwt_ed25519.pub.pem
```

**Config — both sides must agree on iss / aud / kid / alg:**

| Param | Value |
|---|---|
| algorithm | `EdDSA` |
| issuer | `librechat` |
| audience | `code-interpreter` |
| kid | `mchat-ed25519-1` |
| ttl | 300s |

LibreChat `.env` (private key):
```dotenv
CODEAPI_JWT_ENABLED=true
CODEAPI_JWT_ALGORITHM=EdDSA
CODEAPI_JWT_PRIVATE_KEY_BASE64=<base64 of codeapi_jwt_ed25519.pem>
CODEAPI_JWT_ISSUER=librechat
CODEAPI_JWT_AUDIENCE=code-interpreter
CODEAPI_JWT_KID=mchat-ed25519-1
CODEAPI_JWT_TTL_SECONDS=300
LIBRECHAT_CODE_BASEURL=http://127.0.0.1:8765
```

Adapter `.env` (public key):
```dotenv
CODEAPI_AUTH_MODE=jwt
CODEAPI_JWT_PUBLIC_KEY_BASE64=<base64 of codeapi_jwt_ed25519.pub.pem>
CODEAPI_JWT_ALGORITHM=EdDSA
CODEAPI_JWT_ISSUER=librechat
CODEAPI_JWT_AUDIENCE=code-interpreter
CODEAPI_JWT_KID=mchat-ed25519-1
```

Adapter verification (`app/auth.py` `verify_bearer_jwt`): rejects missing/malformed
header, non-allowlisted alg (only `EdDSA`), wrong `iss`/`aud`, expired, missing or
empty `sub`, bad signature, mismatched `kid`. `CODEAPI_AUTH_MODE=api_key` is a
legacy/rollback path that uses `ADAPTER_API_KEY` instead.

**Rotation:** regenerate the keypair, update both `.env`s, bump `CODEAPI_JWT_KID`.
Both sides restart (config is cached).

---

## 3. Session model & isolation — **when isolation is a thing**

Decision (2026-06-30): **ephemeral per-run sandboxes + file-based continuity**,
NOT sticky per-conversation sandboxes. Full rationale + live evidence in the
LibreChat decision doc referenced above.

### How a session id comes to exist
- First `execute_code` in a conversation arrives with **no** session id (the
  `/exec` body is just `{lang, code}`). The adapter **mints** a `uuid4`
  `session_id`, runs in a fresh sandbox, returns the id.
- LibreChat stores that id on generated files as `codeEnvRef.storage_session_id`,
  living **only in that conversation's message history**.
- Continuation is **file-driven**: when the model references a previously
  created/uploaded **file**, LibreChat re-sends it with its `storage_session_id`;
  the adapter reloads it from its storage bucket into a fresh sandbox.

### Isolation boundaries (the important part)

| Boundary | Isolated? | Why |
|---|---|---|
| **Different conversation, same user** | ✅ yes | The session id lives only in the originating conversation's history. A different conversation never sends it, so it always mints a new, separate session/sandbox. Isolation rides on history scope, **not** on a thread id (none reaches the adapter). |
| **Different user** | ✅ yes (defense-in-depth) | (1) session ids are unguessable `uuid4` and only in the owner's history; (2) the adapter **binds each session to the JWT `sub`** and returns **403** if another principal presents it. A leaked id is useless to others. |
| **Across turns within one conversation** | ⚠️ partial | Each exec is an **ephemeral** sandbox; `/mnt/data` scratch does **not** persist. Continuity holds only for **referenced files** (reloaded from storage). A bare `cat /mnt/data/x` next turn → fresh sandbox → not found. |
| **`entity_id`-pinned agent files** | ❌ shared (by design) | Files pinned to an agent are available across that agent's conversations. These identity-keyed **buckets are NOT owner-scoped** — they rely on LibreChat's ACL + key confidentiality. Open item before broad multi-tenant exposure. |

### Operational contract (tell prompt/skill authors)
- Treat code outputs as **files** (which persist in storage), not as a durable
  scratch dir. To continue work, **reference the file**, don't poke a raw path.
- Uploaded **input** files persist for the conversation and reload each turn they
  are referenced.
- Multi-step builds assuming a persistent working dir need either file-chaining
  or the sticky-sandbox escape hatch (Option A in the decision doc).

---

## 4. Adapter API & storage/compute split

All routes require auth (`Depends(require_api_key)` → JWT or api_key mode).

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness |
| POST | `/exec` | run code; mints/reuses session; copies in referenced bucket files |
| POST | `/upload` | store a file (identity-keyed → bucket; else legacy sandbox) |
| GET | `/files/{session_id}` | list files (owner-checked) |
| GET | `/sessions/{session_id}/objects/{file_id}` | bucket-object freshness probe (metadata) |
| GET | `/download/{session_id}/{file_id}` | download a file (owner-checked) |
| DELETE | `/files/{session_id}/{file_id}` | delete a file (owner-checked) |

**Storage/compute split:** uploads carrying a `kind`+`id` identity write to a
persistent host bucket `BUCKET_ROOT/<kind:id[:v:N]>/` and return a stable
`storage_session_id` — **no sandbox created**. On `/exec`, referenced bucket
files are copied into the ephemeral sandbox (idempotent by basename). Sandboxes
are reaped after `SESSION_TTL_SECONDS` idle.

**Key `.env` (adapter):**
```dotenv
DAYTONA_API_KEY=<...>
DAYTONA_API_URL=<...>                 # optional (region/self-host)
DAYTONA_SANDBOX_IMAGE=kuntik/librechat-skills:1.3
DAYTONA_SANDBOX_DISK=3                 # GiB; MUST be ≥3 (image ~1.5 GB)
SESSION_TTL_SECONDS=1800              # idle sandbox reap
BUCKET_ROOT=./buckets                 # persistent identity-keyed storage
# auth: see §2
```

When `DAYTONA_SANDBOX_IMAGE` is set, the adapter skips per-session pip priming
(everything is baked into the image).

---

## 5. Sandbox base image — what it is & how to build a new one

The image (`kuntik/librechat-skills:<tag>`, Docker Hub, public) is what every
Daytona sandbox boots from. Source: `sandbox-image/Dockerfile`.

### Contents (current)
- `python:3.12-slim`
- **LibreOffice** (calc/writer/impress) + **pandoc** + **poppler** + **qpdf** +
  **tesseract** (recalc, PDF conversion, OCR for the office skills)
- **Node 20** + npm globals `pptxgenjs`, `docx` (with `NODE_PATH=/usr/lib/node_modules`
  so scripts anywhere can `require()` them)
- pip: `openpyxl python-docx python-pptx pandas matplotlib pillow tabulate pypdf
  pdfplumber reportlab pytesseract pdf2image markitdown[pptx]`
- Metric-compatible fonts: **Carlito** (≈Calibri) + **Gelasio** (≈Georgia) with a
  fontconfig alias so LibreOffice renders the deck type pair faithfully
- Anthropic **skills** cloned to `/opt/anthropic-skills` (each `scripts/` dir on
  `PYTHONPATH`); pin/update via the `SKILLS_REF` build arg
- `/opt/skill-tools/sanitize_xlsx.py` (on PATH + PYTHONPATH) — strips openpyxl's
  x14 conditional-formatting extension that makes Excel demand "Repair"
- `/opt/skill-tools/slides/` — pptxgenjs builder + geometry linter
  (`deck_helpers.js`), render/contact-sheet helpers, overlap gate, design guidance
- `unzip`

### Build & roll a new image

> **Rule #1: never reuse a tag, never use `:latest`.** Daytona caches images by
> tag on each worker — a re-pushed tag is NOT picked up. Always bump.
> **Rule #2: build `--platform linux/amd64`** (Daytona workers are amd64; a
> default arm64 build on Apple Silicon will fail to run).
> **Rule #3: don't pipe `docker build/push` through `tail`** — it masks the exit
> code. Watch the full output (corporate Wi-Fi can silently drop layers; switch
> to hotspot if a `curl|bash` layer no-ops).

```bash
cd /Users/kuntik/work/Librechat-Daytona-Interpreter

# 1. (optional) edit sandbox-image/Dockerfile — add a tooling line, bump SKILLS_REF, etc.
#    Add a one-line changelog comment at the top documenting the new tag.

# 2. build for amd64 with the NEXT tag (current live is :1.3 → use :1.4)
docker build --platform linux/amd64 -t kuntik/librechat-skills:1.4 sandbox-image/

# 3. push
docker push kuntik/librechat-skills:1.4

# 4. point the adapter at the new tag
#    edit .env:  DAYTONA_SANDBOX_IMAGE=kuntik/librechat-skills:1.4

# 5. restart the adapter (uvicorn) so it reads the new .env

# To update only the bundled Anthropic skills, bump the pinned ref:
#   docker build --platform linux/amd64 --build-arg SKILLS_REF=<git-sha> \
#       -t kuntik/librechat-skills:1.4 sandbox-image/
```

Verify the live image in use:
```bash
grep -E "fast-path image=" /tmp/daytona-interpreter.log | tail -3
```

---

## 6. Running & testing

**Adapter:**
```bash
cd /Users/kuntik/work/Librechat-Daytona-Interpreter
.venv/bin/uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8765
```

**Unit tests:** `.venv/bin/python -m pytest -q`

**Live auth + ownership E2E (self-contained — starts adapter, mints tokens,
asserts no-auth/no-sub/wrong-key → 401, userA → 200, userB steal → 403):**
```bash
tests/e2e_auth.sh        # override PRIV_KEY / PORT / KID via env
```

**Full stack with LibreChat:** start Mongo (`docker start librechat-086-mongo`),
the adapter (above), and `npm run backend` from the LibreChat worktree. Drive an
agent over the API with `LibreChat/tools/lc-agent.mjs` (reads `.agent-api-key`),
or use the UI at `http://localhost:3080`. Watch JWT auth + session ids in
`/tmp/<adapter>.log`.

---

## 7. Gotchas

1. **Daytona disk quota.** Org cap is 30 GiB; each sandbox claims
   `DAYTONA_SANDBOX_DISK` GiB. STOPPED sandboxes still count. Reap idle/leaked
   sandboxes via the Daytona SDK (`Daytona().list()` → `sb.delete()`); do this
   deliberately — it deletes shared-org workloads.
2. **Image tags are cached per worker.** Bump the tag for every change (§5).
3. **`NODE_PATH`** must be `/usr/lib/node_modules` or `require('pptxgenjs')` fails
   from `/mnt/data` scripts. Baked in.
4. **Corporate Wi-Fi** can drop Docker Hub pushes / Daytona API calls mid-stream.
   Switch to hotspot and retry.
5. **`/exec` carries no conversation id** — only the JWT (`sub`, `tenant_id`,
   `jti`). Per-conversation stickiness is therefore impossible adapter-side; see
   the decision doc's Option A.
6. **`entity_id` buckets aren't owner-scoped** (§3) — deliberate sharing; revisit
   before broad multi-tenant exposure.
