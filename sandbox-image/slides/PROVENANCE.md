# Slides toolkit — provenance & what actually runs here

This directory equips the LibreChat code interpreter to build high-polish PPTX
decks with pptxgenjs and gate them on geometry + visual QA. It mixes original
code with material vendored from OpenAI's Codex presentation skills.

## Source material

Vendored from a local Codex install (no LICENSE shipped with these skills —
they are OpenAI's internal Codex runtime skills, not the public
`github.com/openai/skills` catalog). Treat as internal use only; do not
redistribute.

- New `presentations` skill (v26.601.10930):
  `~/.codex/plugins/cache/openai-primary-runtime/presentations/.../skills/presentations`
- Legacy `slides` skill:
  `~/.codex/.tmp/legacy-primary-runtime-skills/slides-*`

## What runs in this sandbox (Daytona / LibreChat)

| File | Origin | Status |
|------|--------|--------|
| `deck_helpers.js` | original | **WORKS** — pptxgenjs builder + in-memory geometry linter (`lint`/`assertClean`). The geometry gate. |
| `render_deck.sh` | original | **WORKS** — LibreOffice + poppler render to slide PNGs. |
| `qa_deck.sh` | original | **WORKS** — render + contact sheet + render-based gate, then hands off to `review_slides`. |
| `check_overlaps.py` | original | **WORKS** — pdfplumber post-render gate; measures real wrapped text boxes to catch collisions `assertClean` can't (declared vs rendered height). |
| `make_contact_sheet.py` | vendored (presentations) | **WORKS** — pure Pillow, no runtime deps. |
| `profiles/*.md`, `templates/*.md` | vendored (presentations) | **GUIDANCE** — deck-profile playbooks, design-system + visual-QA templates. The main quality lever. |

## reference/ — NOT executable here

Everything under `reference/` is bound to OpenAI's proprietary, server-side
`@oai/artifact-tool` runtime (not on npm, not downloadable) or its render-time
introspection outputs (`inspect.ndjson`, art-plate reference dirs,
`render_verify_loops.ndjson`). It cannot run on a raw pptxgenjs deck and is kept
only for its design patterns and QA heuristics:

- `presentations-SKILL.md`, `slides-SKILL.md` — full OpenAI workflows.
- `build_pro_deck_template.reference.js` — artifact-tool deck builder (design system, palettes, layouts worth borrowing).
- `pro_deck_quality_check.artifact-tool.js`, `check_layout_quality.artifact-tool.mjs` — linters that consume artifact-tool layout JSON / ndjson. Their geometry heuristics informed `deck_helpers.lint()`.
- `cleanup_presentation_workspace.mjs` — workspace cleanup helper.
