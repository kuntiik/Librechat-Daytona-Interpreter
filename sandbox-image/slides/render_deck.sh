#!/usr/bin/env bash
# render_deck.sh <deck.pptx> [preview-dir]
# Render every slide to slide-NN.png via LibreOffice + poppler.
set -euo pipefail

PPTX="${1:?usage: render_deck.sh <deck.pptx> [preview-dir]}"
OUT="${2:-$(dirname "$PPTX")/preview}"
mkdir -p "$OUT"

soffice --headless -env:UserInstallation=file:///tmp/lo-profile \
  --convert-to pdf --outdir "$OUT" "$PPTX" >/dev/null 2>&1

base="$(basename "${PPTX%.*}")"
PDF="$OUT/$base.pdf"
[ -f "$PDF" ] || { echo "render failed: $PDF not produced" >&2; exit 1; }

pdftoppm -png -r 150 "$PDF" "$OUT/slide"
ls "$OUT"/slide*.png
