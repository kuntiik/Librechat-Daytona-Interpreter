# PPTX Skill — session handoff (2026-06-08)

Goal: give the LibreChat code interpreter an **OpenAI-quality PPTX skill** —
pptxgenjs builder + a geometry gate + render/visual QA — driven by a DB skill
body, running in the Daytona sandbox image.

This file is a cold-start brief: a new session should be able to continue the
`:0.5` work below without prior context.

---

## TL;DR status

- **`:0.4` is LIVE and tested end-to-end.** Agent builds a deck → in-memory
  geometry gate (`assertClean`) → render → `review_slides` ×N → delivers. A real
  test deck (`mattoni-1873-investor-overview.pptx`) came out well-designed.
- **One known defect drives the remaining work:** a long title that *wraps* to 3
  lines overflowed into a chart on slide 3, and the gate missed it (it checks
  *declared* pptxgenjs box height, not *rendered/wrapped* height).
- **Remaining `:0.5` task (agreed plan):** bake matching fonts + add a
  **post-render** overlap detector (pdfplumber on the LibreOffice PDF) + give
  `titleClaim` auto-height. Details in "PENDING" below.

---

## Architecture (how the two layers fit)

- **DB skill body** (Mongo `LibreChat.skills`, name `pptx`) = the prompt layer.
  Injected into the model's context; tells it the workflow + how to call the
  baked toolkit. Source of truth lives in `seed/pptx-skill-body.md`, pushed to
  Mongo via `seed/seed_pptx_skill.sh`.
- **Sandbox image** (`kuntik/librechat-skills`, Daytona) = the execution layer.
  Carries the toolkit at `/opt/skill-tools/slides/`.
- `@oai/artifact-tool` (OpenAI's real renderer) is **server-side only** — not on
  npm, not in github.com/openai/skills, not on disk. Unobtainable. So OpenAI's
  own linters (`check_layout_quality.mjs`, `pro_deck_quality_check.js`) are
  **inert here** (they need artifact-tool's render introspection) and are kept
  under `sandbox-image/slides/reference/` for design patterns only.

---

## DONE (live state)

### Sandbox image `kuntik/librechat-skills:0.4` (built + pushed, digest a25c7aa)
`sandbox-image/slides/` (baked to `/opt/skill-tools/slides/`):
- `deck_helpers.js` — **original.** pptxgenjs builder (palettes, type pair,
  `LAYOUT_WIDE` 13.333×7.5) + helpers (`newDeck, slide, kicker, titleClaim,
  card, kpi, kpiRail, pill, bullets, hbars, timeline, footer, divider`) + the
  **in-memory geometry linter** `lint()` / `assertClean()` (overlaps +
  out-of-bounds on `pptx._slides[]._slideObjects`). Verified in-container.
- `render_deck.sh` — soffice→PDF→`pdftoppm` slide PNGs.
- `qa_deck.sh` — render + `make_contact_sheet.py`; tells model to call `review_slides`.
- `make_contact_sheet.py` — vendored (Pillow), works.
- `profiles/*.md`, `templates/*.md` — vendored OpenAI deck-profile guidance (the
  big quality lever).
- `reference/*` — artifact-tool-bound, NOT runnable here (kept for patterns):
  `pro_deck_quality_check.artifact-tool.js`, `check_layout_quality.artifact-tool.mjs`,
  `build_pro_deck_template.reference.js`, `*-SKILL.md`, `cleanup_*.mjs`.
- `PROVENANCE.md` — what runs vs reference, and licensing (OpenAI internal, no
  LICENSE shipped — internal use only).

`Dockerfile`: tag `0.4`; copies `slides/` to `/opt/skill-tools/slides`, chmods
`*.sh`, adds it to PATH. No new system deps (soffice/poppler/pillow/pptxgenjs
already baked). NODE_PATH=`/usr/lib/node_modules` lets
`require("/opt/skill-tools/slides/deck_helpers.js")` resolve pptxgenjs.

### Mongo (LibreChat-086, local `mongodb://127.0.0.1:27017/LibreChat`)
- `pptx` skill **body rewritten** → OpenAI workflow (profile router → claim spine
  → design system → contact-sheet plan → build with `deck_helpers` → `assertClean`
  gate → render → `review_slides` → deliver) + anti-thrash iteration guidance.
  `fileCount` set 0 (old `editing.md`/`pptxgenjs.md` refs 404'd; new body points
  at `/opt/skill-tools/slides/`). Backups: `seed/pptx-skill.backup.*.json`.
- **PPTX builder agent** (`agent_88Pl6jcwNrRIrB6omZpNT`) `recursion_limit = 150`
  (was hitting the ~50 default and 500-ing mid-loop).

### Adapter
- `.env` `DAYTONA_SANDBOX_IMAGE=kuntik/librechat-skills:0.4` (line 13).
- uvicorn restarted (currently PID 74822, `:8765`). Logs `/tmp/daytona-interpreter.log`.

### Git (repo `Librechat-Daytona-Interpreter`, remote `kuntiik`)
- Branch `feature/pptx_skills` (commit `9d835a1`) and `new_develop`
  (fast-forwarded to `9d835a1`) — both pushed to `kuntiik`.
- **Uncommitted:** `seed/pptx-skill-body.md` (the anti-thrash guidance edit;
  already reseeded to Mongo). Commit it when ready.
- `.env`, `*.backup.*.json` are local/gitignored, not committed.

### Test result (via `tools/lc-agent.mjs`)
- 1st run: HTTP 500 "recursion limit 50" — model thrashed hand-patching overlaps.
- After recursion_limit=150 + anti-thrash guidance: **PASS.** Delivered
  `mattoni-1873-investor-overview.pptx`; gate enforced (`Lint: 0 errors`);
  `review_slides` ran 3 cycles. Rendered PNGs were in `/tmp/mattoni-qa/`.
- **Defect:** slide-3 3-line title overflowed its declared 1" box into the chart;
  `lint()` missed it (declared vs rendered height). This is the `:0.5` driver.

---

## PENDING — the `:0.5` work (do this next)

Agreed plan, highest ROI first:

1. **Bake metric-compatible fonts** into the image. `deck_helpers` uses
   Georgia/Calibri/Consolas — **none installed** (image has DejaVu/Liberation/Noto),
   so LibreOffice substitutes them → renders are unfaithful AND measured wrapping
   ≠ what a user sees in PowerPoint. Add `fonts-crosextra-carlito` (Calibri-metric)
   + **Gelasio** (Georgia-metric, fetch the TTFs) to the Dockerfile. Cheap, high value.
2. **Post-render overlap detector** (the real fix for wrapped-title collisions).
   Lean version (recommended, ~½ day): a Python script using `pdfplumber` on the
   PDF that `render_deck.sh` already produces — extract word boxes, cluster to
   line/block bboxes, flag line-line overlaps + edge-margin violations. Wire it
   into `qa_deck.sh` as a **second, render-based gate** after the pre-render
   `assertClean`. (Fuller option: emit the `layout.json` schema and run the
   vendored `reference/check_layout_quality.artifact-tool.mjs` — more work, more
   coverage, needs word→element clustering + chart-zone synthesis.)
   Why this works: LibreOffice does the *real* wrapping; pdfplumber reports *real*
   bboxes — so a wrapped title's true footprint is measured, not guessed. Caveat:
   only as faithful as the fonts (hence step 1 first).
3. **`titleClaim` auto-height** in `deck_helpers.js` — size the title box from
   estimated wrapped lines (chars ÷ chars-per-line × fontSize × ~1.15) so content
   starts below the *real* title bottom. Pre-render mitigation so most titles
   never collide.

Then: rebuild → push **`:0.5`** (NEVER reuse a tag — Daytona caches by tag) →
bump `.env` to `:0.5` → restart adapter → reseed body if changed → re-test.

Assessment from this session (for context): the pdfplumber route gets ~80% of
artifact-tool's *practical* geometric-QA value and is arguably more faithful to
the delivered .pptx (it measures the real file), but loses identity-aware checks
(kicker-pairs, roles). Rebuilding artifact-tool itself = weeks, not worth it.

---

## Key paths

- Daytona repo: `/Users/kuntik/work/Librechat-Daytona-Interpreter`
  - toolkit: `sandbox-image/slides/`  · Dockerfile: `sandbox-image/Dockerfile`
  - skill body + seed: `seed/pptx-skill-body.md`, `seed/seed_pptx_skill.sh`
  - adapter env: `.env` (`DAYTONA_SANDBOX_IMAGE`)
- LibreChat backend: `/Users/kuntik/work/LibreChat-086` (Mongo `LibreChat`)
  - driver: `tools/lc-agent.mjs` (default agent `agent_88Pl6jcwNrRIrB6omZpNT`,
    key in `.agent-api-key`); see `AGENT_API_DRIVER.md`
  - uploads (delivered decks): `uploads/6a182a80822e2a0697c6717b/`
- OpenAI cached skills (vendor/reference source):
  - new `presentations`: `~/.codex/plugins/cache/openai-primary-runtime/presentations/26.601.10930/skills/presentations`
  - legacy `slides`: `~/.codex/.tmp/legacy-primary-runtime-skills/slides-1777043256125-*`
- Mattoni-fork clone (this session's worktree, do NOT disturb): `/Users/kuntik/work/LibreChat`

---

## Commands cheat-sheet

```bash
# Build + push a new image (bump the tag every time)
cd /Users/kuntik/work/Librechat-Daytona-Interpreter
docker build --platform linux/amd64 -t kuntik/librechat-skills:0.5 sandbox-image/
docker push kuntik/librechat-skills:0.5

# Point the adapter at the new tag + restart (no --reload; logs to the file)
sed -i '' 's|librechat-skills:0.4|librechat-skills:0.5|' .env   # or edit line 13
PID=$(pgrep -f "uvicorn app.main"); kill "$PID"; sleep 2
nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8765 >> /tmp/daytona-interpreter.log 2>&1 & disown

# Reseed the pptx skill body into Mongo (backs up first)
./seed/seed_pptx_skill.sh

# Verify which image the sandbox actually used
grep -E "fast-path image=" /tmp/daytona-interpreter.log | tail -1

# Drive an end-to-end test (backend on :3080 must be up)
cd /Users/kuntik/work/LibreChat-086
node tools/lc-agent.mjs send "Create a 4-slide Mattoni 1873 investor overview, graphics only." --agent agent_88Pl6jcwNrRIrB6omZpNT
# then judge by the artifact in uploads/, not the driver output (driver aborts >300s; server finishes)

# Render a delivered deck for visual QA (view PNGs with the Read tool)
docker run --rm --platform linux/amd64 \
  -v /Users/kuntik/work/LibreChat-086/uploads/6a182a80822e2a0697c6717b:/in:ro \
  -v /tmp/qa:/out kuntik/librechat-skills:0.4 bash -lc \
  'cp "/in/<FILE>.pptx" /tmp/workspace/d.pptx; bash /opt/skill-tools/slides/qa_deck.sh /tmp/workspace/d.pptx >/dev/null 2>&1; cp /tmp/workspace/preview/slide*.png /tmp/workspace/qa/contact-sheet.png /out/'

# Local helper smoke (pptxgenjs is installed in /tmp/deck-smoke)
NODE_PATH=/tmp/deck-smoke/node_modules node -e 'const D=require("/Users/kuntik/work/Librechat-Daytona-Interpreter/sandbox-image/slides/deck_helpers.js"); /* build, D.assertClean(deck) */'
```

---

## Gotchas (bit us this session)

- **Never reuse a Docker tag** — Daytona caches by tag on its workers.
- **Adapter restart is manual** (kill PID + nohup relaunch from repo dir; reads
  `.env` at startup). It has no `--reload`.
- **Backend listens on `::1:3080` (IPv6)** — use `curl localhost:3080`, not
  `nc -z 127.0.0.1 3080` (false "down"). Start with `npm run backend` from
  LibreChat-086; a 2nd instance fails with `EADDRINUSE` (harmless).
- **Each `/exec` may get a fresh sandbox** (`getSessionInfo` 404 re-upload) — the
  model must build+render within reasoning that tolerates that; `/tmp/workspace`
  persists per sandbox/session.
- **lc-agent.mjs driver aborts >300s** (undici headersTimeout) while the server
  finishes — judge success by the uploads artifact + log, not driver stdout.
- **Mongo edits are local** — re-run `seed_pptx_skill.sh` if Mongo is wiped;
  re-set the agent `recursion_limit` too.
- **Corporate Wi-Fi** can block `docker push` / Daytona — switch to hotspot.
- **The core lint limitation** (declared box ≠ rendered wrapped height) is exactly
  what `:0.5` step 2 fixes.

---

## If you only do one thing
Bake the fonts (step 1) + the lean pdfplumber post-render gate (step 2), roll
`:0.5`, re-test the Mattoni investor deck, and confirm the slide-3-style title
overflow is now caught.
