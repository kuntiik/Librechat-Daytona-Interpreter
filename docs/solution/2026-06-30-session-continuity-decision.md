# Decision: Code-Interpreter Session Continuity Model

**Date:** 2026-06-30
**Status:** ACCEPTED
**Scope:** LibreChat `feature/vanilla-librechat` (vanilla `v0.8.7-rc1`) + `Librechat-Daytona-Interpreter` adapter (`feature/jwt-vendor-auth`)
**Related:** `2026-06-25-vanilla-librechat-daytona-design.md`

## Decision

Adopt the **vanilla / "vendor" continuity model**: file-based continuity with
**ephemeral per-run sandboxes**. We explicitly do **NOT** implement sticky
(persistent) per-conversation sandboxes. LibreChat stays 100% vanilla — no
`patch-package`, no `seedConversationExecSession`, no `thread_id` forwarding.

## Context

After resetting LibreChat to vanilla `v0.8.7-rc1`, the open question was whether
to restore the old behavior where a conversation maps to one long-lived sandbox
(the deleted `seedConversationExecSession`, which forced
`exec session_id = conversationId`). The trigger was a multi-turn test where a
file written to `/mnt/data` in one turn was gone in the next.

## How the chosen model actually works (mechanics)

- On the **first** `execute_code` in a conversation with no attached file, the
  adapter **mints** a `session_id` (uuid4), runs in a fresh sandbox, and returns
  the id. LibreChat stores it on any **generated files** as
  `codeEnvRef.storage_session_id`, living only in that conversation's history.
- **Continuity is file-driven.** When the model later references a
  previously-created (or uploaded) **file**, LibreChat re-attaches it with its
  `storage_session_id`; the adapter reloads that file from its storage bucket
  into a fresh sandbox (storage/compute split + copy-in). The *files* persist;
  the *sandbox* does not.
- **Sandboxes are ephemeral** — created per run, torn down after. There is no
  warm, shared, per-conversation sandbox.
- **Isolation** rides on the session id existing only in the originating
  conversation's history (a different thread never has it), reinforced by the
  adapter's owner binding (below). It does **not** rely on thread/conversation
  id reaching the adapter — it never does.
- **Cross-conversation sharing exception:** files pinned to an agent via
  `entity_id` are shared across that agent's conversations (deliberate).

## What we empirically verified (2026-06-30, live stack)

Real LibreChat backend (`:3080`, vanilla) → JWT → adapter (`:8765`) → Daytona:

- **PROVEN — auth + exec + output-file persistence:** agent ran code (`print(6*7)`
  → `42`); the output `answer.txt` was persisted with
  `codeEnvRef.storage_session_id=30a072ff`, `kind:user, id:<userId>`.
- **PROVEN — sandboxes are ephemeral / not sticky:** both turns' `/exec` arrived
  with `session_id=None`; the adapter minted **two different sessions**
  (`30a072ff`, then `50524e53`) and **two different sandboxes**. Turn 2's
  `cat /mnt/data/answer.txt` (a raw path, no file reference) → **not found**.
- **PROVEN — reuse is file-triggered, not conversation-wide:** a bare code run
  that references no prior file always gets a new session/sandbox.
- **REASONED, NOT YET VERIFIED — input-file persistence:** an uploaded input
  file *should* be re-attached and reloaded on every later turn (it is a tracked
  file with a `codeEnvRef`), independent of whether a run produces output files.
  This follows from the mechanics but has not been exercised end-to-end on this
  stack. **TODO: verify** (upload a file; read it in turn 1; read it again in
  turn 2 without re-uploading).

## Operational contract (how to use it correctly)

This is the part that must reach prompt/skill authors and users:

- **Treat code-interpreter outputs as files, not as scratch state.** A file the
  run *produces and surfaces* persists and can be re-opened later. Anything left
  only in `/mnt/data` (uncaptured temp files) is gone next turn.
- **To continue work across turns, reference the file** (by its
  conversation file, not a bare `/mnt/data/...` path). Referencing it triggers
  the reload; poking the raw path does not.
- **Uploaded input files persist** for the conversation and are reloaded each
  turn they are referenced — text-only output does not affect this.
- **Multi-step builds that assume a persistent working directory will break.**
  Either chain via referenced files, or revisit this decision (Option A below).

## Alternatives considered (and why rejected)

- **A — forward `config.configurable.thread_id` as the exec `session_id`**
  (one `patch-package` patch on `@librechat/agents`). Gives true sticky
  per-conversation sandboxes with LibreChat source untouched. **Rejected for
  now** to keep the build fully vanilla (no re-added `patch-package` tooling +
  dep patch). This is the documented escape hatch if persistent `/mnt/data`
  becomes a requirement.
- **B — adapter keys sandboxes on the JWT `sub`.** Zero patches, but only
  per-*user* stickiness: all of a user's conversations share one sandbox and
  filesystem; concurrent threads collide. **Rejected** — loses per-conversation
  isolation.
- **C — re-add `seedConversationExecSession` in `/api` + executor patch.** What
  the vanilla reset removed. **Rejected** — modifies LibreChat's own source;
  superseded by A.

Note: a per-conversation-sticky model with **zero** changes is impossible — the
adapter never receives any conversation identifier (the `/exec` body is
`{lang, code}`; the JWT carries `sub`/`tenant_id`/`jti` but no conversationId).
The conversation id only exists inside LibreChat.

## Security posture

- The adapter binds every session to the JWT `sub` and rejects cross-principal
  reuse/access (403). `sub` is required and non-empty. A leaked `session_id` is
  therefore not usable by another principal. (Proven live: userB reusing userA's
  session → 403.)
- **Open item:** identity-keyed buckets (`entity_id`-pinned files) are
  intentionally shared and are **not** owner-scoped; `_upload_to_bucket` /
  `get_object_info` rely on LibreChat's ACL + key confidentiality by design.
  Sub-scoping them would break the agent-file sharing feature. Revisit before any
  broad multi-tenant exposure.

## Consequences

- LibreChat remains provably vanilla (`git diff v0.8.7-rc1` = config/docs only).
- Continuity works for file-centric workflows; it does not provide a durable
  scratch filesystem across turns.
- If that limitation bites, Option A is the smallest reversible change
  (LibreChat source stays vanilla; adds `patch-package` + one dependency patch).
