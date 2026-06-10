# Plan: storage/compute split for the Daytona code-interpreter adapter

**Goal:** make agent/user Code-Environment files reliably available to a run, with
**per-session + per-user isolation**, by giving the adapter the two-layer model real
codeapi has (persistent identity-keyed *buckets* + ephemeral per-session *sandboxes*
that copy the bucket files in).

**Why:** today the adapter conflates storage and compute into one object
(`session_id → sandbox`, where a sandbox is both where files live and where code
runs). With no stable key on `/upload`, each uploaded file lands in its own
throwaway sandbox, so multi-file agents (e.g. the "Promo dohoda MOL/JIP" agent with
`_TEMPLATE_promo_dohoda.xlsx` + `product-master.xlsx`) see only one file per run.
Keying by agent identity would co-locate them but leak across users/sessions
(shared agents → shared sandbox). Neither single key works — the fix is to split
the two layers.

---

## Current state (already done — do NOT redo)

LibreChat side (repo `/Users/kuntik/work/LibreChat`, branch `new_dev`):
- `packages/api/src/agents/codeFilesSession.ts` — `seedConversationExecSession()`
  seeds `Graph.sessions[EXECUTE_CODE].session_id = conversationId` when no file/skill
  seed exists. Wired in `api/server/controllers/agents/client.js` (~line 874, chat
  path) and `api/server/controllers/agents/responses.js` (~line 543, Open Responses
  API). `packages/api` built; 24/24 unit tests pass.
- `patches/@librechat+agents+3.1.97.patch` (+ `postinstall: patch-package`) — the
  `BashExecutor`/`CodeExecutor` now send `session_id` in the `/exec` POST body when
  present (they previously discarded it). Re-applies on every `npm install`.
- Net effect: **file-less execs already route to one sandbox per conversation,
  keyed by `conversationId`** (verified: two-turn probe, `/mnt/data` persists across
  turns, one sandbox). This is the compute-key foundation the plan builds on.
- Also done, unrelated to this plan but in the tree: `ensureAssets`/`assertAssets`
  in `sandbox-image/slides/deck_helpers.js`, `unzip` + tag `1.1` in the Dockerfile,
  `pptx` skill body updated in Mongo. (Image rebuild still pending on a network-clean
  machine — NodeSource fetch was blocked.)

Adapter side (repo `/Users/kuntik/work/Librechat-Daytona-Interpreter`, branch
`new_develop`) — **unchanged so far; this is where the work happens.**

---

## Key facts established (grounding)

- `app/main.py`
  - `/exec` handler ~line 488. Routes via
    `requested_session_id = payload.session_id or _extract_session_id_from_files(payload.files)`
    then `service.get_or_create_exec_session(requested_session_id, lang)`.
  - `_extract_session_id_from_files` (~219) reads `storage_session_id` first, then
    `session_id`/`sessionId`.
  - `/upload` handler ~line 595. Reads session id from form keys
    `("session_id","sessionId","entity_id","entityId")` — **does NOT read `kind`/`id`**
    (the bucket identity LibreChat sends via `appendCodeEnvFileIdentity`). With no
    session id it calls `get_or_create_upload_session(None,…)` → mints a NEW sandbox
    per upload. Then `gateway.upload_file(sandbox_id, path, bytes)` writes the file
    into that sandbox; response `storage_session_id = session.session_id`.
- `app/session_service.py` — `get_or_create_exec_session` / `get_or_create_upload_session`
  / `_create_session` (calls `gateway.create_sandbox(language)`), `touch`, `delete_session`.
- `app/session_store.py` — `SessionRecord{session_id, sandbox_id, language, last_access}`,
  `SessionStore` (memory/redis).
- `app/cleanup.py` — reaps sandboxes idle > `SESSION_TTL_SECONDS`; sweep every
  `CLEANUP_INTERVAL_SECONDS`.
- `app/config.py` — `SESSION_TTL_SECONDS` default 300; **`.env` overrides to 1800**
  (30 min). `CLEANUP_INTERVAL_SECONDS=60`.
- `app/daytona_gateway.py` — `create_sandbox(language)`, `upload_file(sandbox_id, path, bytes)`,
  `download_file`, `run_code(sandbox_id, lang, code)`, `delete_sandbox(sandbox_id)`,
  `list_files`.
- LibreChat `appendCodeEnvFileIdentity` (`packages/api/src/files/code/identity.ts`)
  appends `kind` (`agent`/`user`/`skill`) + `id` (+`version` for skill) to every
  upload form. Buckets: `<tenant>:agent:<id>`, `<tenant>:user:<userId>`,
  `<tenant>:skill:<id>:v:<n>`.
- LibreChat `primeCodeFiles` (`api/server/services/Files/Code/process.js` ~763-960):
  per run, for each code-env file, reuse if its `storage_session_id` is alive else
  **re-upload** (`uploadCodeEnvFile`, single file). `no-codeEnvRef → skip` at ~819.
  Re-upload updates `metadata.codeEnvRef` with the fresh `storage_session_id` (~918).
- Exec file refs (`_injected_files`) carry `{ kind, id, storage_session_id, file_id, name }`.

---

## Target architecture

```
STORAGE (new)                         COMPUTE (changed)
persistent, identity-keyed            ephemeral, per-conversation
  BUCKET_ROOT/<tenant:kind:id>/         sandbox keyed by conversationId
    _TEMPLATE_promo_dohoda.xlsx           (per-user, since convo is user-owned)
    product-master.xlsx
        │                                      ▲
        └────── copy referenced files ─────────┘
                in on the session's first exec
```

- **Bucket** = a directory on the adapter host (`BUCKET_ROOT/<bucketKey>/<filename>`),
  written on `/upload`. Survives sandbox reaping and adapter restarts. No container.
- **Sandbox** = compute, keyed by `conversationId` (the exec `session_id` LibreChat
  already sends via the seed). One per conversation → isolated per session AND per
  user (conversations are user-scoped).
- **Copy-in** = on a session's exec, for each `_injected_files` ref, copy
  `BUCKET_ROOT/<ref bucket>/<ref name>` into the sandbox `/mnt/data` (idempotent).

This preserves LibreChat's contract: the upload returns a **stable** `storage_session_id`
(= the bucket key), so `codeEnvRef` stops going stale and the per-turn re-upload
churn ends (optional follow-up: implement freshness/`getSessionInfo` so LibreChat
skips re-upload entirely).

---

## Build steps (adapter unless noted)

### Phase 0 — verify assumptions first (do before coding)
1. Capture a real `/upload` request and confirm the form actually carries `kind`
   and `id` (LibreChat sends them; confirm they arrive at the adapter). Add a debug
   log of `form_data.multi_items()` keys if unsure.
2. Confirm `/exec` receives `session_id = conversationId` for a file-bound run
   (after the LibreChat seed change in Phase 3) — i.e. that the compute key is the
   conversation, not a per-file storage id.
3. Decide `BUCKET_ROOT` location + whether it needs to outlive container restarts
   (a mounted volume vs ephemeral disk). Add `BUCKET_ROOT` to `app/config.py` + `.env`.

### Phase 1 — bucket storage layer (`app/buckets.py`, new)
- `bucket_key(kind, id, version=None) -> str` → `f"{kind}:{id}"` (+`:v:{version}` for
  skill). Sanitize for filesystem safety.
- `write(bucket_key, filename, data: bytes)` → writes `BUCKET_ROOT/<bucket_key>/<safe filename>`;
  returns the stored path. Overwrite-safe (idempotent re-upload).
- `path(bucket_key, filename) -> Path | None`; `exists(...)`.
- `read(bucket_key, filename) -> bytes`.
- Filename sanitization (reuse `sanitize_upload_filename` already imported in main.py).
- (v1: no GC. Note follow-up: a retention/cleanup policy for buckets — they're small
  xlsx but unbounded over time.)

### Phase 2 — rewrite `/upload` (`app/main.py`)
- Read `kind` + `id` (+`version`) from the form in addition to the existing session keys.
- If `kind`+`id` present → `bucket = bucket_key(...)`; for each uploaded file:
  `buckets.write(bucket, filename, bytes)`. **Do not create a sandbox.**
- Response: `storage_session_id = bucket`; `files = [UploadFileDescriptor(...)]` built
  from the written files (not from a sandbox listing).
- Fallback: if no `kind`/`id` (legacy/chat path that only sends a session id), keep
  today's behavior so nothing regresses while migrating.

### Phase 3 — compute key = conversationId (LibreChat, small)
- Make the seeded representative exec `session_id` **always** the `conversationId`,
  even when file/skill seeds exist (today `seedConversationExecSession` skips when a
  file seed is present, and `seedCodeFilesIntoSessions` sets the representative to
  `files[0].storage_session_id`). Add/adjust a helper so:
  `Graph.sessions[EXECUTE_CODE] = { session_id: conversationId, files: [<bucket refs>] }`.
  The per-file `storage_session_id`s (bucket keys) stay on `files`; only the
  representative changes. The executor patch already forwards `session_id`, so the
  adapter receives `session_id=conversationId` (compute) AND `files=[bucket refs]`
  (what to copy). Update `codeFilesSession.spec.ts`.

### Phase 4 — copy-in on `/exec` (`app/main.py` + gateway)
- Compute key: prefer `payload.session_id` (= conversationId). Keep
  `_extract_session_id_from_files` only as a legacy fallback.
- `session = get_or_create_exec_session(conversationId, lang)` → the per-conversation
  sandbox.
- Before running code: for each ref in `payload.files`, resolve
  `bucket = ref.storage_session_id`, `name = ref.name`; if
  `buckets.exists(bucket, name)` and the file isn't already in the sandbox, push it:
  `gateway.upload_file(session.sandbox_id, f"{WORKSPACE_ROOT}/{name}", buckets.read(bucket, name))`.
  Make it idempotent (track copied `(sandbox_id, bucket, name)` in the session record
  or check existence) so repeated execs don't re-copy every call.
- Then run code as today.
- Apply the same copy-in to the `read_file` path if it bypasses `/exec`
  (`readSandboxFile` in LibreChat hits `/exec` with `cat`, so it should flow through
  the same logic — verify).

### Phase 5 — (optional) stop the per-turn re-upload
- With stable bucket ids, implement a freshness endpoint so LibreChat's
  `primeCodeFiles` sees the file as alive and skips re-upload (today `getSessionInfo`
  404s → re-upload every turn). Optional; the re-upload is idempotent against the
  bucket, so v1 works without it (just wasteful).

### Phase 6 — (optional) skip the config-time sandbox
- Config-time upload already flows through the new `/upload` → writes to the bucket,
  no sandbox. So Phase 2 implicitly fixes "don't create a sandbox at agent-file
  upload." Nothing extra needed beyond confirming the config-time upload carries
  `kind=agent,id=<agentId>` (it does, via `process.js` ~661-699 → `uploadCodeEnvFile`).

---

## Verification

1. **2-file promo agent (the original failure):** in the UI, the "Promo dohoda MOL/JIP"
   agent with both xlsx attached, ask it to build the promo file. Confirm in
   `/tmp/daytona-interpreter.log`: both files written to one bucket on upload; one
   sandbox keyed by conversationId; both files present in it; the run completes and
   returns the filled `.xlsx`.
2. **Per-user / per-session isolation:** same shared agent, two different
   conversations (ideally two users) → two different sandboxes; neither can see the
   other's `/mnt/data`. Verify distinct `sandbox_id`s and no cross-file visibility.
3. **Reaping:** idle a conversation > 30 min, send another turn → sandbox recreated,
   files re-copied from the bucket (bucket survived).
4. **Regression:** a plain code run with no attachments still works (file-less seed
   path); a single-file chat upload still works.

---

## Gotchas / risks

- **Filename collisions** across buckets copied into one sandbox (rare; distinct
  names here). Namespace under `/mnt/data/<bucket>/…` if it ever matters — but
  LibreChat/model expect flat `/mnt/data/<name>`, so keep flat and accept
  last-writer-wins, or de-dupe by (bucket,name).
- **Bucket GC** — unbounded growth; add retention later.
- **Concurrency** — two execs of the same conversation hitting one sandbox is fine
  (intended); ensure copy-in is idempotent and not racy.
- **Corporate Wi-Fi** — Daytona API / Docker Hub calls can drop on the Mattoni
  network; switch to hotspot for sandbox ops and image work.
- **Don't break the legacy path** while migrating — keep `/upload` and `/exec`
  fallbacks until LibreChat is confirmed sending `kind/id` (upload) and
  `conversationId` (exec) consistently.
- **TTL note:** CLAUDE.md says `SESSION_TTL_SECONDS=300`; the live `.env` is `1800`.
  Update CLAUDE.md when touching this.

---

## Repos / branches
- Adapter: `/Users/kuntik/work/Librechat-Daytona-Interpreter` (branch `new_develop`).
  Restart after changes: `uvicorn` (its config is cached at startup). Log:
  `/tmp/daytona-interpreter.log`.
- LibreChat: `/Users/kuntik/work/LibreChat` (branch `new_dev`). Backend runs under
  `nodemon` (`backend:dev`) on `:3080`; touch a watched file to restart. Driver:
  `node tools/lc-run.mjs "<prompt>" [--continue <convoId>]` (key in `.agent-api-key`)
  — note the driver uses the Open Responses API path and can't attach files, so the
  2-file test must be done in the UI.
- Nothing is committed yet; commit only when Lukáš asks.
