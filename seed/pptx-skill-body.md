
# PPTX Skill — high-polish decks

Build editable PowerPoint decks that look like a strong editor, analyst, and
designer made them together. "Serviceable" is a failure. A deck that would still
work after swapping the company name is not specific enough — keep iterating.

## Runtime (LibreChat code interpreter)

The sandbox ships a slides toolkit at `/opt/skill-tools/slides/`:

- `deck_helpers.js` — pptxgenjs builder + **geometry linter** (`lint`/`assertClean`).
- `qa_deck.sh <pptx>` — render every slide to PNG + build a contact sheet.
- `render_deck.sh`, `make_contact_sheet.py` — the pieces `qa_deck.sh` uses.
- `profiles/*.md` — deck-profile playbooks (proof objects + blocking gates).
- `templates/*.md`, `reference/*` — design-system / visual-QA templates and the
  full OpenAI workflows for deeper reference. Read `PROVENANCE.md` first if unsure.

`require("/opt/skill-tools/slides/deck_helpers.js")` resolves `pptxgenjs` via
`NODE_PATH`. Files at `/mnt/data` persist across code_interpreter calls.

## Mandatory workflow

1. **Mode**: `create` | `template-following` (a source/template PPTX supplied) |
   `targeted-edit`.
2. **Pick ONE deck-profile** and `cat /opt/skill-tools/slides/profiles/<profile>.md`,
   then follow its proof-object rules and pass/fail gates:
   `finance-ir`, `product-platform`, `gtm-growth`, `engineering-platform`,
   `consumer-retail`, `appendix-heavy`, `template-and-edit`.
3. **Claim spine** — every non-appendix slide has: a 1–3 word kicker; a **claim
   title that states a conclusion, not a topic**; exactly one dominant proof
   object (chart, table, timeline, diagram, comparison); a short source-backed
   note. Bad: "Revenue and margin trends." Good: "Growth slowed, but the margin
   engine kept expanding." If the title survives a noun-swap, sharpen it.
4. **Design system** — content-informed palette (one color dominates 60–70%, one
   sharp accent), a serif/display + sans pair, ONE repeated motif. Title ≥30pt.
5. **Contact-sheet plan** — for ~10 slides use ≥5 distinct macro-layouts; ≤2
   card-grid slides; never 3 slides in a row sharing a layout; dark title +
   conclusion, light content ("sandwich").
6. **Build** with `deck_helpers.js` on the widescreen canvas (13.333×7.5).
7. **Geometry gate (required)** — call `D.assertClean(deck)`; it throws on any
   text/text collision, text/image overlap, or out-of-bounds element. When it
   reports overlaps, **fix the element coordinates in your ONE build script and
   re-run the whole script** — fix every reported overlap at once. Do NOT
   hand-patch the saved `.pptx`/`.js` with `sed`/`python` heredocs (fragile, and
   it wastes turns). Keep a single canonical build script you re-run until the
   gate passes, **then** `deck.save()`.
8. **Render + render-based gate + visual QA** —
   `bash /opt/skill-tools/slides/qa_deck.sh /mnt/data/<title>.pptx`. After
   rendering it runs a **second geometry gate** (`check_overlaps.py`) that
   measures the *real* wrapped text boxes on the LibreOffice PDF — it catches
   collisions `assertClean` can't (e.g. a title that wraps onto a chart). If it
   exits non-zero, fix the reported coordinates in your build script, re-run it,
   and re-render **before** the visual review. Once it passes, call the
   **`review_slides`** tool on the slide PNGs (fresh eyes that never saw your code).
9. **Iterate (bounded)** — apply review fixes by editing the build script and
   re-running it, then re-render. Do at most **2** review cycles; if issues
   remain after that, deliver the best version and note the residual. Budget your
   tool calls — you have a finite step limit; converge, don't thrash.
10. **Deliver** the `.pptx` with a topic-relevant filename (never `deck.pptx` /
    `output.pptx`). Keep the response short and artifact-focused.

## Build skeleton

```js
const D = require("/opt/skill-tools/slides/deck_helpers.js");
const deck = D.newDeck({ palette: "forest", title: "Q3 Operating Review", author: "Mattoni 1873" });

const s = deck.slide({});                       // light content slide; {dark:true} for title/closing
D.kicker(deck, s, { id: "01", text: "Expansion drivers" });
const t = D.titleClaim(deck, s, "Backlog is compounding faster than revenue.");
// titleClaim auto-sizes its box to the wrapped line count and returns it; flow
// content below t.bottom (+ a ~0.3" gap) so a long, wrapping title never collides.
D.card(deck, s, 0.6, Math.max(1.9, t.bottom + 0.3), 5.2, 3.4);  // optional container
D.hbars(deck, s, [{label:"EMEA",value:42},{label:"APAC",value:31}], { x:0.9, y:2.2, w:4.6 });
D.kpiRail(deck, s, [
  { value:"42%", label:"YoY growth", context:"vs 28% LY" },
  { value:"1.9x", label:"Net retention" },
  { value:"11", label:"New markets" },
], { y: 5.4 });
D.footer(deck, s, { left: "Q3 Operating Review", page: 1 });

D.assertClean(deck);                            // GATE — throws on overlaps / out-of-bounds
deck.save("/mnt/data/q3-operating-review.pptx").then(() => console.log("saved"));
```

(Plain `node script.js` is CommonJS — don't use top-level `await`; use `.then()`
or wrap in an `(async () => { … })()`.)

Helpers: `newDeck, slide, kicker, titleClaim, card, kpi, kpiRail, pill, bullets,
hbars, timeline, footer, divider`. Palettes: `forest, midnight, terracotta,
ocean, charcoal, berry, teal` (or pass your own hex). Kickers are emitted as
named marker/label pairs so alignment is verifiable.

**Diagrams — use the primitives, never hand-roll `addShape`.** For flows,
pipelines, comparison grids, and node diagrams use `box`, `node`, `connector`,
and `flow` — they use only valid ShapeTypes, auto-pick readable text color from
the fill, and return geometry + edge anchors (`midRight`, `midLeft`, …) so
connectors align. A whole "A → B → C" row is one call:
`D.flow(deck, s, [{title,body,fill}, …], { y, h, style:"arrow"|"chevron" })`.
(There is no `circle` ShapeType — `node` uses `ellipse` for you.)

## Blocking anti-patterns — fix before delivery

- Title states a topic instead of a conclusion; title survives a noun-swap.
- A text-only slide (every slide needs a proof object / visual).
- More than one dominant evidence object on a slide.
- **An accent line under the title** (a hallmark of AI slides — use whitespace/color).
- Repeated layout 3 slides in a row; rounded cards as default scaffolding;
  decorative boxes around prose.
- Centered body text (left-align paragraphs/lists; center only titles).
- Low-contrast text/icons; a value lost against its background.
- A chart that displays data but doesn't prove the title; legend where direct
  labels would read better; a "line" faked from rotated rectangles.
- Repeated KPI rail missing a value/label on any item.
- Text overflowing a filled container; boxed prose pinned to an edge.
- Fabricated or approximated official logo/mascot/app icon — use a verified
  asset or solve with color/type/layout instead.
- Thin proof object that can't carry the claim.

## Reading / editing existing decks

- Extract text: `python -m markitdown deck.pptx`. Visual overview: `qa_deck.sh deck.pptx`.
- Leftover placeholders: `python -m markitdown out.pptx | grep -iE "xxxx|lorem|ipsum"`.
- `template-following`: read `/opt/skill-tools/slides/profiles/template-and-edit.md`.
  Preserve the source typography, palette, spacing, and brand chrome; map every
  output slide to a source slide. (OpenAI's artifact-tool clone/edit isn't
  available here — edit with `python-pptx` in place, or rebuild faithfully with
  `deck_helpers.js`. Do not invent a new visual system for a template task.)

## Palette & typography reference

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| Forest & Moss | `2C5F2D` | `97BC62` | `C99745` |
| Midnight Executive | `1E2761` | `4763C4` | `E5B567` |
| Warm Terracotta | `B85042` | `A7BEAE` | `D9A441` |
| Ocean | `065A82` | `1C7293` | `E0A23B` |
| Berry & Cream | `6D2E46` | `A26769` | `CBA15A` |
| Teal Trust | `028090` | `00A896` | `D7A83D` |
| Charcoal Minimal | `36454F` | `7A8B95` | `C9962F` |

| Header font | Body font |  | Element | Size |
|-------------|-----------|--|---------|------|
| Georgia | Calibri |  | Cover / section claim | 56–72pt |
| Cambria | Calibri |  | Slide title (claim) | 30–44pt bold |
| Palatino | Garamond |  | Section header | 20–24pt bold |
| Trebuchet MS | Calibri |  | Body | 14–18pt |
| Consolas | Calibri |  | Caption / source | 9–12pt muted |

Spacing: ≥0.5" slide margins; consistent 0.3–0.5" gaps between blocks; leave
breathing room. Set `margin: 0` on text boxes when aligning shapes to text edges.
