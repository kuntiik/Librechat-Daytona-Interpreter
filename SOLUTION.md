# Vanilla LibreChat + Daytona Code Interpreter — Solution Overview

Snapshot of the whole solution, for versioning/reference. Detailed docs linked below.

## Goal

Run **unmodified upstream LibreChat** (`v0.8.7-rc1`) and get its Code Interpreter
by pointing it at a **middleware adapter** (this repo) that executes code in
**Daytona** sandboxes. LibreChat carries **no source changes** — integration is
configuration only. All integration logic lives in this adapter.

## Architecture

```
LibreChat (vanilla v0.8.7-rc1, config only)
      │  POST /exec, /upload, GET /download …   Authorization: Bearer <EdDSA JWT>
      ▼
Daytona adapter (this repo — FastAPI)
      │  • verifies the JWT against LibreChat's public key
      │  • binds each code session to the JWT subject (per-user isolation)
      │  • storage = host buckets;  compute = ephemeral Daytona sandboxes
      ▼
Daytona Cloud  → sandbox image  kuntik/librechat-skills:<tag>
```

## Key design decisions

1. **Auth = EdDSA JWT (not x-api-key).** LibreChat mints a short-lived Bearer
   token per code-API request (built-in `CODEAPI_JWT_ENABLED`); the adapter
   verifies it with the matching public key. Vanilla LibreChat source untouched.
   `sub` (user id) is required; the adapter binds sessions to it and rejects
   cross-principal reuse (403).
2. **Session continuity = vendor/vanilla model.** Ephemeral per-run sandboxes +
   file-based continuity (files persist in storage buckets, reloaded when
   referenced). **Not** sticky per-conversation sandboxes — `/mnt/data` scratch
   does not survive across turns. Per-conversation stickiness is impossible
   without a LibreChat change because the adapter never receives a conversation
   id (documented, with an escape hatch).
3. **Everything valuable lives adapter/image-side**, so LibreChat stays a clean
   vanilla baseline (`git diff v0.8.7-rc1` = config/docs only).

## Repos

- **LibreChat** — vanilla `v0.8.7-rc1` + config, branch `feature/vanilla-librechat`
  (also deployed as Railway `dev-librechat`, branch `dev`).
- **This adapter** — JWT verification + vendor session model, branch
  `feature/jwt-vendor-auth` / `new_main` (deployed as Railway `new-daytona-interface`).

## Deployment (Railway, project vivacious-intuition)

- **dev**: `dev-librechat` (vanilla, JWT enabled) → `new-daytona-interface`
  (adapter, `CODEAPI_AUTH_MODE=jwt`, image `kuntik/librechat-skills:1.4`).
  Verified live: no-auth→401, JWT→200 running real Daytona code; per-user
  session ownership enforced.
- Office skills (`docx/pdf/pptx/xlsx`) seeded into the dev DB; `pptx` cleaned of
  the removed `review_slides` tool to match vanilla.

## Detailed docs

- `DAYTONA_INTEGRATION.md` — architecture, JWT auth config (both sides), session
  isolation boundaries, adapter API, **how to build/roll a new sandbox image**.
- `docs/superpowers/plans/2026-06-25-adapter-jwt-vendor-session.md` — adapter
  implementation plan.
- `docs/solution/2026-06-25-vanilla-librechat-daytona-design.md` — LibreChat-side
  design spec.
- `docs/solution/2026-06-30-session-continuity-decision.md` — the ephemeral-vs-
  sticky session decision (mechanics, evidence, alternatives).

## Secrets

No secrets are committed. Runtime config (`.env`, JWT keypair, Daytona/API keys)
lives only in environment variables / Railway service config, never in git.
`.env.example` documents the required variables with placeholders.
