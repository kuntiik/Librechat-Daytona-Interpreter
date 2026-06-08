#!/usr/bin/env python3
"""check_overlaps.py <deck.pdf> [more.pdf ...]

Post-render geometry gate. LibreOffice does the REAL text wrapping and
pdfplumber reports the REAL word bounding boxes, so a wrapped title's true
footprint is measured rather than guessed. This catches collisions the
pre-render in-memory lint (deck_helpers.assertClean) cannot see, because that
one only knows the *declared* pptxgenjs box height, not the rendered/wrapped
height.

Per page it flags:
  - text/text collisions: two text lines (distinct baselines) whose bounding
    boxes overlap in both axes — a wrapped title spilling onto a chart label,
    stacked captions, etc.
  - off-page elements: a word crossing the physical page edge (ERROR).
  - tight margins: a word inside the safe margin band (WARNING only).

Exits non-zero if any ERROR is found so qa_deck.sh can gate on it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pdfplumber

PT_PER_IN = 72.0

# Words whose baselines (bottom edge) are within this many points belong to the
# same rendered line. Kept tight so two genuinely colliding text runs (which sit
# on different baselines) stay separate and get flagged.
BASELINE_TOL = 2.5

# Two distinct lines must overlap by more than this in BOTH axes to count as a
# collision — guards against descender/ascender grazes and kerning noise.
OVERLAP_X_TOL = 4.0
OVERLAP_Y_TOL = 3.0

# Words on the same baseline separated by more than this horizontal gap belong to
# different blocks (e.g. separate columns/cards), not one line — so a row of card
# titles isn't merged into one wide line that appears to straddle every card.
LINE_GAP_TOL = 36.0

# Off-page slack and the safe-margin band (inches → points). The band is kept
# tight so standard footer / page-number chrome (which sits ~0.16" from the
# bottom edge by design) doesn't generate noise — only text basically touching
# an edge warns.
OFFPAGE_SLACK = 1.0
MARGIN_IN = 0.15

# A "panel" is a large filled rectangle/rounded-rect (a card). LibreOffice
# renders a pptxgenjs roundRect as a curve, so we scan both rects and curves.
# Foreign text spilling onto a card is flagged when a text line overlaps a panel
# but is NOT fully contained within it (it crosses the panel boundary). Native
# in-card text is fully contained, so it never trips this.
PANEL_MIN_W_IN = 2.0
PANEL_MIN_H_IN = 0.9
PANEL_FULLBLEED = 0.97
CONTAIN_TOL = 4.0


class Line:
    __slots__ = ("x0", "x1", "top", "bottom", "text")

    def __init__(self, word):
        self.x0 = word["x0"]
        self.x1 = word["x1"]
        self.top = word["top"]
        self.bottom = word["bottom"]
        self.text = word["text"]

    def add(self, word):
        self.x0 = min(self.x0, word["x0"])
        self.x1 = max(self.x1, word["x1"])
        self.top = min(self.top, word["top"])
        self.bottom = max(self.bottom, word["bottom"])
        self.text = f"{self.text} {word['text']}"


def cluster_lines(words):
    lines: list[Line] = []
    for word in sorted(words, key=lambda w: (round(w["bottom"], 1), w["x0"])):
        target = next(
            (
                ln
                for ln in lines
                if abs(word["bottom"] - ln.bottom) <= BASELINE_TOL
                and max(word["x0"] - ln.x1, ln.x0 - word["x1"]) <= LINE_GAP_TOL
            ),
            None,
        )
        if target is None:
            lines.append(Line(word))
        else:
            target.add(word)
    return lines


def overlap(a: Line, b: Line):
    ox = min(a.x1, b.x1) - max(a.x0, b.x0)
    oy = min(a.bottom, b.bottom) - max(a.top, b.top)
    if ox > OVERLAP_X_TOL and oy > OVERLAP_Y_TOL:
        return ox, oy
    return None


def extract_panels(page):
    """Deduped large filled rect/curve boxes (cards), excluding full-bleed backgrounds."""
    min_w = PANEL_MIN_W_IN * PT_PER_IN
    min_h = PANEL_MIN_H_IN * PT_PER_IN
    seen = set()
    panels = []
    for o in list(page.rects) + list(page.curves):
        w = o["x1"] - o["x0"]
        h = o["bottom"] - o["top"]
        if w < min_w or h < min_h:
            continue
        if w >= page.width * PANEL_FULLBLEED and h >= page.height * PANEL_FULLBLEED:
            continue
        key = (round(o["x0"]), round(o["top"]), round(o["x1"]), round(o["bottom"]))
        if key in seen:
            continue
        seen.add(key)
        panels.append((o["x0"], o["top"], o["x1"], o["bottom"]))
    return panels


def line_intrudes(line: Line, panel):
    px0, ptop, px1, pbot = panel
    ox = min(line.x1, px1) - max(line.x0, px0)
    oy = min(line.bottom, pbot) - max(line.top, ptop)
    if ox <= OVERLAP_X_TOL or oy <= OVERLAP_Y_TOL:
        return None
    contained = (
        line.x0 >= px0 - CONTAIN_TOL
        and line.x1 <= px1 + CONTAIN_TOL
        and line.top >= ptop - CONTAIN_TOL
        and line.bottom <= pbot + CONTAIN_TOL
    )
    if contained:
        return None
    return ox, oy


def snippet(text, limit=40):
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def check_page(page, page_no):
    errors: list[str] = []
    warnings: list[str] = []
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    margin = MARGIN_IN * PT_PER_IN

    for word in words:
        off = []
        if word["x0"] < -OFFPAGE_SLACK:
            off.append("left")
        if word["top"] < -OFFPAGE_SLACK:
            off.append("top")
        if word["x1"] > page.width + OFFPAGE_SLACK:
            off.append("right")
        if word["bottom"] > page.height + OFFPAGE_SLACK:
            off.append("bottom")
        if off:
            errors.append(
                f"Slide {page_no}: \"{snippet(word['text'])}\" runs off the {'/'.join(off)} edge."
            )
            continue
        if (
            word["x0"] < margin
            or word["top"] < margin
            or word["x1"] > page.width - margin
            or word["bottom"] > page.height - margin
        ):
            warnings.append(
                f"Slide {page_no}: \"{snippet(word['text'])}\" sits inside the {MARGIN_IN}\" safe margin."
            )

    lines = cluster_lines(words)
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            ov = overlap(lines[i], lines[j])
            if ov is None:
                continue
            ox, oy = ov
            errors.append(
                f"Slide {page_no}: text \"{snippet(lines[i].text, 28)}\" and "
                f"\"{snippet(lines[j].text, 28)}\" collide "
                f"({ox / PT_PER_IN:.2f}\"x{oy / PT_PER_IN:.2f}\"). "
                "Give the title more room or move content down."
            )

    panels = extract_panels(page)
    for line in lines:
        for panel in panels:
            ov = line_intrudes(line, panel)
            if ov is None:
                continue
            ox, oy = ov
            errors.append(
                f"Slide {page_no}: text \"{snippet(line.text, 32)}\" spills into a card "
                f"({ox / PT_PER_IN:.2f}\"x{oy / PT_PER_IN:.2f}\" over the edge). "
                "Keep text fully inside the card or move the card clear of it."
            )
    return errors, warnings


def check_pdf(path: Path):
    errors: list[str] = []
    warnings: list[str] = []
    with pdfplumber.open(path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            e, w = check_page(page, page_no)
            errors.extend(e)
            warnings.extend(w)
    return errors, warnings


def main(argv):
    pdfs = [Path(p) for p in argv]
    if not pdfs:
        print("usage: check_overlaps.py <deck.pdf> [more.pdf ...]", file=sys.stderr)
        return 2

    total_errors = 0
    for path in pdfs:
        if not path.exists():
            print(f"ERROR {path}: not found", file=sys.stderr)
            total_errors += 1
            continue
        errors, warnings = check_pdf(path)
        for w in warnings:
            print(f"WARN  {w}")
        for e in errors:
            print(f"ERROR {e}")
        total_errors += len(errors)
        print(f"{path.name}: {len(errors)} error(s), {len(warnings)} warning(s).")

    if total_errors:
        print(
            f"Render gate FAILED with {total_errors} error(s) — fix coordinates in your "
            "build script, re-run it, then re-render.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
