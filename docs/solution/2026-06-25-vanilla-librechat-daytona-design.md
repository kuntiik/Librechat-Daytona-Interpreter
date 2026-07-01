# Vanilla LibreChat + Daytona — Design

**Date:** 2026-06-25
**Branch (target):** `feature/vanilla-librechat`
**Base:** upstream tag `v0.8.7-rc1` (clean slate)

## Decision (locked)

**LibreChat carries ZERO code changes.** The branch is unmodified `v0.8.7-rc1`
plus configuration only. All integration logic lives on the Daytona side (the
`Librechat-Daytona-Interpreter` adapter and the `kuntik/librechat-skills`
sandbox image), which are not part of this repo.

- **Auth: Option B — JWT mode.** Enable vanilla LibreChat's built-in Code API
  JWT auth (`isCodeApiJwtAuthEnabled` / `mintCodeApiToken` already ship in
  `v0.8.7-rc1`) via config. The **adapter** verifies the signed EdDSA/RS256
  token against LibreChat's public key. This replaces the old `x-api-key` shim
  and aligns with upstream's stated direction (JWT mandatory). No patch.
- **Session model: vendor/vanilla.** No conversationId forcing, no
  `seedConversationExecSession`. The session_id is minted by the Code
  Interpreter on first exec and replayed through conversation message history.

## Goal

Reset LibreChat to a provably vanilla `v0.8.7-rc1` baseline carrying **only**
deployment configuration. Drop every customization that accumulated on
`new_main`. The valuable, feature-rich assets live on the Daytona side (sandbox
image + adapter) and survive untouched.

## Non-goals / explicitly dropped

Revert to vanilla; do **not** carry forward:

- `seedConversationExecSession()` and its call sites (`client.js`,
  `responses.js`) — the conversationId-forcing routing
- `patches/@librechat+agents+3.1.97.patch` — the `session_id`-forwarding
  executor patch (only existed to support the seed)
- `x-api-key` auth shim in `codeapi.ts` — replaced by JWT mode (B)
- `review_slides` / fresh-eyes QA stack (`reviewImages.js`, handlers, prompts)
- Custom Skills seeding into Mongo — `v0.8.7-rc1` ships **native Skills**;
  re-seed office skills via the public `/api/skills` API (`frontmatter: {}`)
- `collapse-images` UI feature
- agent-file-handoff
- Custom S3/MinIO storage routing **code** — configure storage the vanilla way
- Any other divergence in `client/src`, `api/server`, `packages/*`

## Architecture

```
LibreChat (this repo) — UNMODIFIED v0.8.7-rc1 + config
      │  POST /exec, /upload, /download
      │  Authorization: Bearer <JWT signed by LibreChat>
      ▼
Daytona adapter   (Librechat-Daytona-Interpreter)
      │  • verifies the JWT (EdDSA/RS256) against LibreChat's public key
      │  • implements vanilla session semantics (below)
      ▼
Daytona Cloud — kuntik/librechat-skills:<tag> image
      office tooling, deck helpers, native-skill scripts, storage/compute split
```

### Session model — vendor/vanilla (no conversationId forcing)

- **First `execute_code` in a conversation** carries no session_id. The adapter
  **mints** one, runs in a fresh isolated sandbox, and **returns** the assigned
  session_id in the result.
- LibreChat (vanilla) stores that session_id **on the generated files**
  (`callbacks.js` stamps `session_id: file.storage_session_id`); it lives only
  in **that conversation's message history**.
- **Continuation:** when the model wants a previously created file it passes the
  session_id back (it's in its context); `seedCodeFilesIntoSessions` (vanilla)
  replays it into the exec call. A different thread never has that id, so it
  always gets a fresh, isolated session.
- **Isolation rides on history scope**, not on thread/conversation ID: the
  identifier exists only in the originating conversation's messages.
- **Sandboxes are ephemeral** — created per run, torn down after; files
  rehydrated from storage by session each run, removed after.
- **Cross-conversation sharing exception:** files pinned to the agent via
  `entity_id` are available across that agent's conversations.

### Auth — JWT (Option B)

- Vanilla mints a per-request JWT when JWT mode is enabled
  (`isCodeApiJwtAuthEnabled` → `mintCodeApiToken`, both in `v0.8.7-rc1`).
- Enabled via configuration (env / `librechat.yaml`); LibreChat code untouched.
- The **adapter** verifies the token signature against LibreChat's public key
  and rejects unsigned/invalid requests. This is the only new adapter auth work
  and replaces the prior `x-api-key` string compare.

## Adapter-side work (Librechat-Daytona-Interpreter — not this repo)

1. **JWT verification** — verify EdDSA/RS256 `Authorization: Bearer` against
   LibreChat's public key; remove the `x-api-key` path.
2. **Vanilla session semantics** — mint-and-return session_id on first exec;
   reuse storage by session_id on continuation; ephemeral sandbox per run;
   honor `entity_id`-pinned files across an agent's conversations. (Move away
   from the conversationId-keyed persistent-sandbox model.)

## Build method (clean slate)

1. Branch `feature/vanilla-librechat` off the `v0.8.7-rc1` tag (no glue ports).
2. Apply configuration only:
   - **Env:** Code API base URL → adapter (`:8765`), JWT mode enabled + key
     material, storage env (S3/MinIO creds + bucket), Mongo URI.
   - **`librechat.yaml`:** enable Code Interpreter for agents; endpoints/models;
     storage strategy.
   - **Deploy:** Helm/Railway values mirroring the env.
3. `npm ci && npm run build`; run vanilla per-workspace tests (should pass
   unchanged — no code touched).
4. Re-seed the four office skills via `/api/skills` (native, `frontmatter: {}`).

## Testing & verification

- **Vanilla-ness check (primary):** `git diff v0.8.7-rc1 HEAD` shows **only**
  config / deploy / docs / `tools/` — zero `client/src`, `api/server`,
  `packages/*` source divergence.
- **Auth contract:** adapter rejects a request with no/invalid JWT; accepts a
  LibreChat-minted token.
- **Session E2E:** in conversation A, turn 1 creates a file; turn 2 references
  it → adapter rehydrates by the minted session_id. A second conversation gets a
  distinct session. An `entity_id`-pinned file is visible across the agent's
  conversations.
- **Native suites:** vanilla code-interpreter unit tests run unchanged.

## Kept dev tooling (no app impact)

- `tools/lc-agent.mjs` + `tools/lc-send-notimeout.mjs` — headless agent driver
  over the Open Responses API. Lives in `tools/`, never loaded by the app.

## Risks

- **JWT key distribution.** The adapter needs LibreChat's public key (or JWKS
  endpoint); key rotation must be handled. Verify the token algorithm/claims the
  vanilla minter emits before implementing the verifier.
- **Adapter session-model rewrite.** Moving from conversationId-keyed persistent
  sandboxes to vanilla mint/return/ephemeral changes adapter behavior and any
  multi-turn flows that implicitly relied on a sticky sandbox; validate
  multi-turn file reuse end-to-end.
- **Storage config parity.** Vanilla storage config must reproduce what the old
  routing code did; verify upload/download round-trips.

## Follow-up decision (2026-06-30): session continuity

The session model was validated live and a decision recorded separately:
**ephemeral per-run sandboxes with file-based continuity — NOT sticky
per-conversation sandboxes.** LibreChat stays fully vanilla (no `patch-package`,
no `thread_id` forwarding). `/mnt/data` does not persist across turns; continuity
is via referenced/uploaded files reloaded from storage. The "Session E2E" bullet
above (turn 2 rehydrating by a replayed minted session) holds **only when the
model references the file** — a bare `/mnt/data` path does not. See
`2026-06-30-session-continuity-decision.md` for mechanics, empirical evidence,
the operational contract, and the Option-A escape hatch if sticky sandboxes are
later required.
