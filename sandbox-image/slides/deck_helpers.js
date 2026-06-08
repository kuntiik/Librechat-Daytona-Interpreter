"use strict";

/**
 * deck_helpers.js — pptxgenjs helper library for the LibreChat code interpreter.
 *
 * Portable replacement for OpenAI's artifact-tool builder (which cannot run
 * here). Encodes the same design system — opinionated palettes, a serif/sans
 * type pair, a strict 16:9 widescreen canvas, and reusable proof-object
 * builders (KPI rails, kickers, cards, bar proofs, timelines).
 *
 * Every element that the QA linters key off of (kicker marker/label pairs,
 * boxed prose) is given an explicit objectName so pro_deck_quality_check.js /
 * check_layout_quality.mjs can verify alignment instead of guessing.
 *
 * Usage inside a sandbox script:
 *
 *   const D = require("/opt/skill-tools/slides/deck_helpers.js");
 *   const deck = D.newDeck({ palette: "forest", title: "Q3 Review" });
 *   const s = deck.slide({ dark: false });
 *   D.kicker(deck, s, { id: "01", text: "EXPANSION DRIVERS", x: 0.6, y: 0.55 });
 *   D.titleClaim(deck, s, "Backlog is compounding faster than revenue.", { y: 0.95 });
 *   D.kpiRail(deck, s, [{ value: "42%", label: "YoY growth" }], { y: 5.4 });
 *   deck.save("/mnt/data/q3-review.pptx");
 */

const pptxgen = require("pptxgenjs");

const EMU_W = 13.333;
const EMU_H = 7.5;

/** Content-informed palettes. One color dominates; one sharp accent. */
const PALETTES = {
  forest: { ink: "1A2B22", base: "F4F1E8", surface: "FFFFFF", muted: "5E6B61", accent: "2C5F2D", accent2: "97BC62", gold: "C99745" },
  midnight: { ink: "0B1437", base: "F5F7FE", surface: "FFFFFF", muted: "5A6488", accent: "1E2761", accent2: "4763C4", gold: "E5B567" },
  terracotta: { ink: "3A2218", base: "F6EFE6", surface: "FFFFFF", muted: "7A6256", accent: "B85042", accent2: "A7BEAE", gold: "D9A441" },
  ocean: { ink: "0A1E2C", base: "EEF4F7", surface: "FFFFFF", muted: "55707E", accent: "065A82", accent2: "1C7293", gold: "E0A23B" },
  charcoal: { ink: "1A1F22", base: "F2F2F2", surface: "FFFFFF", muted: "5C6770", accent: "36454F", accent2: "7A8B95", gold: "C9962F" },
  berry: { ink: "2E141F", base: "F3EADF", surface: "FFFFFF", muted: "7B5963", accent: "6D2E46", accent2: "A26769", gold: "CBA15A" },
  teal: { ink: "06262B", base: "ECF5F4", surface: "FFFFFF", muted: "4E7B79", accent: "028090", accent2: "00A896", gold: "D7A83D" },
};

/** Serif display + utilitarian sans. Faces baked into the sandbox image. */
const TYPE = {
  head: "Georgia",
  body: "Calibri",
  mono: "Consolas",
};

function palette(name) {
  return PALETTES[name] || PALETTES.forest;
}

/**
 * Create a deck with the widescreen canvas and theme locked in.
 * @returns {{pptx: object, C: object, T: object, slide: Function, save: Function}}
 */
function newDeck(opts = {}) {
  const C = palette(opts.palette);
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "WIDE", width: EMU_W, height: EMU_H });
  pptx.layout = "WIDE";
  pptx.theme = { headFontFace: opts.headFont || TYPE.head, bodyFontFace: opts.bodyFont || TYPE.body };
  if (opts.title) pptx.title = opts.title;
  if (opts.author) pptx.author = opts.author;

  const deck = {
    pptx,
    C,
    T: { head: opts.headFont || TYPE.head, body: opts.bodyFont || TYPE.body, mono: TYPE.mono },
    slide,
    save: (file) => pptx.writeFile({ fileName: file }),
  };

  function slide({ dark = false } = {}) {
    const s = pptx.addSlide();
    s.background = { color: dark ? C.ink : C.base };
    s._deckDark = dark;
    return s;
  }

  return deck;
}

function shadow() {
  return { type: "outer", color: "000000", blur: 4, offset: 1, angle: 90, opacity: 0.14 };
}

function fg(deck, s) {
  return s._deckDark ? deck.C.base : deck.C.ink;
}

/**
 * Kicker = small caps eyebrow with a leading marker dot. Marker + label share
 * a vertical centerline and are named as a pair so QA can verify alignment.
 */
function kicker(deck, s, { id = "01", text, x = 0.6, y = 0.55, color }) {
  const c = color || deck.C.accent;
  const dot = 0.12;
  const labelH = 0.22;
  const cy = y + labelH / 2;
  s.addShape(deck.pptx.ShapeType.ellipse, {
    x, y: cy - dot / 2, w: dot, h: dot,
    fill: { color: c }, line: { color: c },
    objectName: `kicker-${id}-marker`,
  });
  s.addText(String(text).toUpperCase(), {
    x: x + dot + 0.12, y, w: 5.0, h: labelH,
    fontFace: deck.T.body, fontSize: 11, bold: true, color: c,
    charSpacing: 2.5, align: "left", valign: "middle", margin: 0,
    objectName: `kicker-${id}-label`,
  });
}

/** The slide's claim (a conclusion, not a topic). */
function titleClaim(deck, s, text, { x = 0.6, y = 0.95, w = 8.6, size = 30 } = {}) {
  s.addText(text, {
    x, y, w, h: 1.0,
    fontFace: deck.T.head, fontSize: size, bold: true, color: fg(deck, s),
    align: "left", valign: "top", margin: 0,
  });
}

/** A neutral container card with soft shadow. */
function card(deck, s, x, y, w, h, { fill, line } = {}) {
  const f = fill || deck.C.surface;
  s.addShape(deck.pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06,
    fill: { color: f }, line: { color: line || f, width: 1 },
    shadow: shadow(),
  });
}

/** Big-number stat with label beneath. value + label always both render. */
function kpi(deck, s, x, y, w, { value, label, context, accent }) {
  const c = accent || deck.C.accent;
  s.addText(String(value), {
    x, y, w, h: 0.62,
    fontFace: deck.T.head, fontSize: 40, bold: true, color: c,
    align: "left", valign: "bottom", margin: 0, fit: "shrink",
  });
  s.addText(String(label), {
    x, y: y + 0.66, w, h: 0.26,
    fontFace: deck.T.body, fontSize: 12, bold: true, color: fg(deck, s),
    align: "left", margin: 0,
  });
  if (context) {
    s.addText(String(context), {
      x, y: y + 0.94, w, h: 0.24,
      fontFace: deck.T.body, fontSize: 9.5, color: deck.C.muted,
      align: "left", margin: 0, fit: "shrink",
    });
  }
}

/** Evenly distribute a KPI rail across a width; preserves value+label+context per item. */
function kpiRail(deck, s, items, { x = 0.6, y = 5.3, w = 12.13, gap = 0.4 } = {}) {
  const n = items.length;
  const cw = (w - gap * (n - 1)) / n;
  items.forEach((it, i) => kpi(deck, s, x + i * (cw + gap), y, cw, it));
}

/** Small pill / tag. */
function pill(deck, s, x, y, text, { fill, color } = {}) {
  const f = fill || deck.C.accent2;
  const c = color || deck.C.ink;
  const w = Math.max(1.0, 0.22 + String(text).length * 0.085);
  s.addShape(deck.pptx.ShapeType.roundRect, {
    x, y, w, h: 0.34, rectRadius: 0.17, fill: { color: f }, line: { color: f },
  });
  s.addText(String(text), {
    x, y, w, h: 0.34, fontFace: deck.T.body, fontSize: 9.5, bold: true,
    color: c, align: "center", valign: "middle", margin: 0,
  });
  return w;
}

/** Left-aligned bullets with comfortable spacing (never centered). */
function bullets(deck, s, items, { x = 0.6, y = 1.9, w = 5.6, h = 3.0, size = 14 } = {}) {
  s.addText(
    items.map((t, i) => ({ text: t, options: { bullet: { code: "2022" }, breakLine: i < items.length - 1 } })),
    { x, y, w, h, fontFace: deck.T.body, fontSize: size, color: fg(deck, s),
      align: "left", valign: "top", paraSpaceAfter: 8, margin: 0, lineSpacingMultiple: 1.1 },
  );
}

/**
 * Horizontal bar proof with direct end-labels (no legend). Values 0..max.
 * data: [{ label, value }]
 */
function hbars(deck, s, data, { x = 0.6, y = 1.9, w = 6.2, rowH = 0.5, max, accent } = {}) {
  const top = max || Math.max(...data.map((d) => d.value));
  const c = accent || deck.C.accent;
  const labelW = 2.2;
  const trackX = x + labelW;
  const trackW = w - labelW - 0.9;
  data.forEach((d, i) => {
    const ry = y + i * (rowH + 0.18);
    s.addText(d.label, { x, y: ry, w: labelW - 0.15, h: rowH, fontFace: deck.T.body, fontSize: 12, bold: true, color: fg(deck, s), align: "left", valign: "middle", margin: 0, fit: "shrink" });
    s.addShape(deck.pptx.ShapeType.rect, { x: trackX, y: ry + rowH / 2 - 0.07, w: trackW, h: 0.14, fill: { color: deck.C.muted, transparency: 80 }, line: { color: deck.C.muted, transparency: 80 } });
    const bw = Math.max(0.04, trackW * (d.value / top));
    s.addShape(deck.pptx.ShapeType.rect, { x: trackX, y: ry + rowH / 2 - 0.07, w: bw, h: 0.14, fill: { color: c }, line: { color: c } });
    s.addText(String(d.display != null ? d.display : d.value), { x: trackX + bw + 0.1, y: ry, w: 0.8, h: rowH, fontFace: deck.T.body, fontSize: 11, bold: true, color: fg(deck, s), align: "left", valign: "middle", margin: 0 });
  });
}

/**
 * Horizontal timeline with numbered nodes and captions. steps: [{year, text}]
 * Captions are clamped to stay within slide margins, so end nodes never spill.
 */
function timeline(deck, s, steps, { x = 1.4, y = 3.5, w = 10.5 } = {}) {
  const c = deck.C.accent;
  const edge = 0.3;
  const capW = 2.0;
  const clampX = (cx, boxW) => Math.max(edge, Math.min(cx - boxW / 2, EMU_W - edge - boxW));
  s.addShape(deck.pptx.ShapeType.line, { x, y, w, h: 0, line: { color: c, width: 2 } });
  const n = steps.length;
  const step = w / (n - 1 || 1);
  steps.forEach((st, i) => {
    const cx = x + i * step;
    const d = 0.26;
    s.addShape(deck.pptx.ShapeType.ellipse, { x: cx - d / 2, y: y - d / 2, w: d, h: d, fill: { color: i === 0 ? deck.C.gold : c }, line: { color: deck.C.surface, width: 1.5 } });
    s.addText(String(st.year), { x: clampX(cx, 1.6), y: y - 0.72, w: 1.6, h: 0.3, fontFace: deck.T.head, fontSize: 15, bold: true, color: fg(deck, s), align: "center", margin: 0 });
    s.addText(String(st.text), { x: clampX(cx, capW), y: y + 0.22, w: capW, h: 0.7, fontFace: deck.T.body, fontSize: 9.5, color: deck.C.muted, align: "center", margin: 0, valign: "top", fit: "shrink" });
  });
}

/** Quiet footer + page marker. Consistent grammar across the deck. */
function footer(deck, s, { left, page } = {}) {
  if (left) s.addText(String(left), { x: 0.6, y: 7.12, w: 8.0, h: 0.22, fontFace: deck.T.body, fontSize: 8, color: deck.C.muted, align: "left", margin: 0 });
  if (page != null) s.addText(String(page).padStart(2, "0"), { x: 12.5, y: 7.08, w: 0.3, h: 0.24, fontFace: deck.T.body, fontSize: 9, bold: true, color: deck.C.accent, align: "right", margin: 0 });
}

/** Full-bleed section divider on the ink background. */
function divider(deck, s, title, { kickerText, page } = {}) {
  s.addShape(deck.pptx.ShapeType.rect, { x: 0, y: 0, w: EMU_W, h: EMU_H, fill: { color: deck.C.ink }, line: { color: deck.C.ink } });
  s._deckDark = true;
  if (kickerText) kicker(deck, s, { id: "div", text: kickerText, x: 0.7, y: 2.9, color: deck.C.gold });
  s.addText(title, { x: 0.7, y: 3.25, w: 11.5, h: 1.4, fontFace: deck.T.head, fontSize: 46, bold: true, color: deck.C.base, align: "left", valign: "top", margin: 0 });
  if (page != null) footer(deck, s, { page });
}

/* ------------------------------------------------------------------ *
 * In-memory geometry linter.
 *
 * The vendored OpenAI linters (pro_deck_quality_check.js,
 * check_layout_quality.mjs) detect overlaps from artifact-tool's render-time
 * `inspect.ndjson` / `layout.json`, which pptxgenjs never produces — so they
 * are inert on a raw pptxgenjs deck. This linter works directly on the
 * pptxgenjs object model (`pptx._slides[]._slideObjects`) before export, the
 * same approach the original pptxgenjs slides skill used. No render needed.
 * ------------------------------------------------------------------ */

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function hasRealText(t) {
  if (typeof t === "string") return t.trim() !== "";
  if (Array.isArray(t)) return t.some((r) => r && typeof r.text === "string" && r.text.trim() !== "");
  return false;
}

/**
 * pptxgenjs stores shapes as `_type:'text'` objects carrying a `shape` field
 * and (usually empty) `text`. Classify by actual text content + `shape`, not
 * by `_type`, so empty container shapes are not mistaken for text boxes.
 */
function extractElements(slide) {
  const objs = Array.isArray(slide._slideObjects) ? slide._slideObjects : [];
  const out = [];
  objs.forEach((obj, index) => {
    const o = obj.options || obj.data || {};
    const x = num(o.x), y = num(o.y), w = num(o.w), h = num(o.h);
    if (x === null || y === null || w === null || h === null) return;
    const shapeKind = obj.shape || null;
    const isImage = obj._type === "image" || !!obj.image || !!o.path;
    const isLine = shapeKind === "line" || obj._type === "line";
    const isText = !isImage && hasRealText(obj.text);
    const type = isText ? "text" : isImage ? "image" : shapeKind || obj._type || "shape";
    out.push({ index, type, isText, isImage, isLine, x, y, w, h, x2: x + w, y2: y + h });
  });
  return out;
}

function isFullBleed(e) {
  return e.w >= EMU_W * 0.97 && e.h >= EMU_H * 0.97;
}

function overlapArea(a, b) {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x, b.x);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h, area: w * h } : null;
}

/**
 * Lint every slide for out-of-bounds elements and severe text collisions.
 * @returns {{errors: string[], warnings: string[]}}
 */
function lint(deck, opts = {}) {
  const tol = opts.boundsTolerance ?? 0.02;
  const errors = [];
  const warnings = [];
  const slides = (deck.pptx && deck.pptx._slides) || [];

  slides.forEach((slide, si) => {
    const label = `Slide ${si + 1}`;
    const els = extractElements(slide);

    for (const e of els) {
      if (e.isLine) continue;
      const over = [];
      if (e.x < -tol) over.push("left");
      if (e.y < -tol) over.push("top");
      if (e.x2 > EMU_W + tol) over.push("right");
      if (e.y2 > EMU_H + tol) over.push("bottom");
      if (over.length) {
        errors.push(`${label}: ${e.type} #${e.index} extends past ${over.join("/")} edge (x=${e.x.toFixed(2)},y=${e.y.toFixed(2)},w=${e.w.toFixed(2)},h=${e.h.toFixed(2)}).`);
      }
    }

    for (let i = 0; i < els.length; i += 1) {
      for (let j = i + 1; j < els.length; j += 1) {
        const a = els[i], b = els[j];
        if (a.isLine || b.isLine) continue;
        if (isFullBleed(a) || isFullBleed(b)) continue;
        const ov = overlapArea(a, b);
        if (!ov) continue;
        const minArea = Math.min(a.w * a.h, b.w * b.h);
        const ratio = minArea > 0 ? ov.area / minArea : 0;
        const contained = ratio > 0.95;

        if (a.isText && b.isText) {
          if (ov.w > 0.08 && ov.h > 0.05) {
            errors.push(`${label}: text #${a.index} and text #${b.index} overlap (${ov.w.toFixed(2)}"x${ov.h.toFixed(2)}"). Reposition so text never stacks.`);
          }
        } else if ((a.isText && b.isImage) || (a.isImage && b.isText)) {
          if (!contained && ov.area > 0.05) {
            errors.push(`${label}: text and image #${a.index}/#${b.index} overlap by ${ov.area.toFixed(2)} sq". Text must sit on a clear area.`);
          }
        } else if ((a.isText || b.isText) && !contained) {
          if (ratio > 0.35 && ov.w > 0.1 && ov.h > 0.08) {
            warnings.push(`${label}: text #${(a.isText ? a : b).index} partially overlaps shape #${(a.isText ? b : a).index} (${(ratio * 100).toFixed(0)}%). Verify it reads as inside a container, not a collision.`);
          }
        }
      }
    }
  });

  return { errors, warnings };
}

/** Print the lint report; throw if any error remains. Use in the build loop. */
function assertClean(deck, opts = {}) {
  const { errors, warnings } = lint(deck, opts);
  warnings.forEach((w) => console.error(`WARN  ${w}`));
  errors.forEach((e) => console.error(`ERROR ${e}`));
  console.error(`Lint: ${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length) throw new Error(`Deck geometry lint failed with ${errors.length} error(s) — fix and re-run before exporting.`);
  return { errors, warnings };
}

module.exports = {
  PALETTES, TYPE, EMU_W, EMU_H,
  palette, newDeck,
  kicker, titleClaim, card, kpi, kpiRail, pill, bullets, hbars, timeline, footer, divider,
  lint, assertClean,
};
