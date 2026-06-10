#!/usr/bin/env bash
# qa_deck.sh <deck.pptx>
# Render every slide and build a contact sheet for visual QA.
#
# NOTE: the deterministic geometry gate (overlaps / out-of-bounds) runs INSIDE
# your build script, before export:
#
#   const D = require("/opt/skill-tools/slides/deck_helpers.js");
#   D.assertClean(deck);            // throws on any collision/out-of-bounds
#   await deck.save("/mnt/data/<title>.pptx");
#
# This script is the render + contact-sheet (fresh-eyes) step that follows, plus
# a render-based geometry gate (check_overlaps.py) — pdfplumber measures the REAL
# wrapped text boxes, catching collisions assertClean misses (a wrapped title
# spilling into content). A non-zero exit means fix coordinates and re-render.
set -euo pipefail

PPTX="${1:?usage: qa_deck.sh <deck.pptx>}"
DIR="$(cd "$(dirname "$PPTX")" && pwd)"
# Slides render into $DIR itself (NOT a subdir): LibreChat only persists files
# at the workspace root, and review_slides can only see persisted files.
PREVIEW="$DIR"
QA="$DIR/qa"
mkdir -p "$QA"

bash /opt/skill-tools/slides/render_deck.sh "$PPTX" "$PREVIEW" >/dev/null
python3 /opt/skill-tools/slides/make_contact_sheet.py "$PREVIEW"/slide*.png \
  --output "$QA/contact-sheet.png" --cols 3

echo "Slides:        $PREVIEW/slide*.png"
echo "Contact sheet: $QA/contact-sheet.png"

PDF="$PREVIEW/$(basename "${PPTX%.*}").pdf"
set +e
python3 /opt/skill-tools/slides/check_overlaps.py "$PDF"
RC=$?
set -e

if [ "$RC" -ne 0 ]; then
  echo "Geometry gate failed — fix the reported collisions in your build script, re-run it, then re-render before the visual review." >&2
  exit "$RC"
fi

echo "Next: call the review_slides tool on the slide PNGs (fresh-eyes QA), fix, re-render."
