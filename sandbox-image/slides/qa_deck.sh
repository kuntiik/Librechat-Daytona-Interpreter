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
# This script is the render + contact-sheet (fresh-eyes) step that follows.
set -euo pipefail

PPTX="${1:?usage: qa_deck.sh <deck.pptx>}"
DIR="$(cd "$(dirname "$PPTX")" && pwd)"
PREVIEW="$DIR/preview"
QA="$DIR/qa"
mkdir -p "$PREVIEW" "$QA"

bash /opt/skill-tools/slides/render_deck.sh "$PPTX" "$PREVIEW" >/dev/null
python3 /opt/skill-tools/slides/make_contact_sheet.py "$PREVIEW"/slide*.png \
  --output "$QA/contact-sheet.png" --cols 3

echo "Slides:        $PREVIEW/slide*.png"
echo "Contact sheet: $QA/contact-sheet.png"
echo "Next: call the review_slides tool on the slide PNGs (fresh-eyes QA), fix, re-render."
