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

/** Methods models reach for on `deck` that live elsewhere — fail with the fix. */
const DECK_MISUSE = {
  addSlide: 'use deck.slide({ dark }) — it returns the slide object',
  writeFile: 'use deck.save("/mnt/data/<name>.pptx")',
  write: 'use deck.save("/mnt/data/<name>.pptx")',
  addText: 'call it on a slide: const s = deck.slide({}); s.addText(...)',
  addTable: 'call it on a slide: s.addTable(rows, opts)',
  addChart: 'use D.chart(deck, s, "bar"|"line", data, opts)',
  addImage: 'use D.image(deck, s, { path, x, y, w, h })',
  addShape: 'use D.box/node/connector/flow, or s.addShape(...) on a slide',
};

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
    guardImages(s);
    return s;
  }

  for (const [name, hint] of Object.entries(DECK_MISUSE)) {
    Object.defineProperty(deck, name, {
      get() {
        throw new TypeError(`deck.${name} does not exist — ${hint}.`);
      },
    });
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

/**
 * Estimate how many lines `text` wraps to in a box of width `w` at `size` pt.
 * Slightly conservative (~0.55em average advance) so we over- rather than
 * under-estimate height — content placed below the title never collides.
 */
function estimateWrappedLines(text, w, size) {
  const charWIn = (size * 0.55) / 72;
  const charsPerLine = Math.max(1, Math.floor(w / charWIn));
  return String(text)
    .split("\n")
    .reduce((sum, seg) => sum + Math.max(1, Math.ceil(seg.length / charsPerLine)), 0);
}

/**
 * The slide's claim (a conclusion, not a topic). The box height is sized from
 * the estimated wrapped line count so the *declared* box matches the rendered
 * footprint — the in-memory lint then catches a long title spilling into
 * content. Returns the box geometry so callers can flow content below `bottom`.
 */
function titleClaim(deck, s, text, { x = 0.6, y = 0.95, w = 8.6, size = 30, h } = {}) {
  const lineH = (size * 1.15) / 72;
  const boxH = h != null ? h : Math.max(lineH, estimateWrappedLines(text, w, size) * lineH + 0.08);
  s.addText(text, {
    x, y, w, h: boxH,
    fontFace: deck.T.head, fontSize: size, bold: true, color: fg(deck, s),
    align: "left", valign: "top", margin: 0,
  });
  return { x, y, w, h: boxH, bottom: y + boxH };
}

/** A neutral container card with soft shadow. Accepts positional or {x,y,w,h}. */
function card(deck, s, x, y, w, h, opts = {}) {
  if (x !== null && typeof x === "object") {
    opts = x;
    ({ x, y, w, h } = opts);
  }
  const f = opts.fill || deck.C.surface;
  s.addShape(deck.pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: opts.radius ?? 0.06,
    fill: { color: f }, line: { color: opts.line || f, width: 1 },
    shadow: opts.shadow === false ? undefined : shadow(),
  });
  return geom(x, y, w, h);
}

/** Big-number stat with label beneath. Accepts positional or {x,y,w,value,…}. */
function kpi(deck, s, x, y, w, opts = {}) {
  if (x !== null && typeof x === "object") {
    opts = x;
    ({ x, y, w } = opts);
  }
  const { value, label, context, accent } = opts;
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

/** Small pill / tag. Accepts positional or {x,y,text,fill,color,w,h}. */
function pill(deck, s, x, y, text, opts = {}) {
  if (x !== null && typeof x === "object") {
    opts = x;
    x = opts.x;
    y = opts.y;
    text = opts.text ?? opts.label;
  }
  const f = opts.fill || deck.C.accent2;
  const c = opts.color || deck.C.ink;
  const h = opts.h ?? 0.34;
  const w = opts.w ?? Math.max(1.0, 0.22 + String(text).length * 0.085);
  s.addShape(deck.pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: Math.min(0.17, h / 2), fill: { color: f }, line: { color: f },
  });
  s.addText(String(text), {
    x, y, w, h, fontFace: deck.T.body, fontSize: opts.size ?? 9.5, bold: true,
    color: c, align: "center", valign: "middle", margin: 0, fit: "shrink",
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
 * Native editable chart (the proof object for data slides). type: "bar" | "line".
 * data: [{ name, labels: [...], values: [...] }] — one entry per series.
 * Wraps s.addChart with palette colors, theme fonts, and readable axis text.
 */
function chart(deck, s, type, data, opts = {}) {
  if (type !== "bar" && type !== "line") {
    throw new TypeError(`chart type "${type}" is not supported — use "bar" or "line".`);
  }
  const text = fg(deck, s);
  const colors = (opts.colors || [deck.C.accent, deck.C.gold, deck.C.accent2, deck.C.muted])
    .slice(0, Math.max(1, data.length));
  s.addChart(deck.pptx.ChartType[type], data, {
    x: opts.x ?? 0.9, y: opts.y ?? 2.1, w: opts.w ?? 6.2, h: opts.h ?? 4.2,
    chartColors: colors,
    barDir: "col",
    showLegend: opts.showLegend ?? data.length > 1,
    legendPos: "b", legendColor: text, legendFontFace: deck.T.body, legendFontSize: 11,
    showValue: opts.showValue ?? true,
    dataLabelColor: text, dataLabelFontFace: deck.T.body, dataLabelFontSize: 10,
    catAxisLabelColor: text, catAxisLabelFontFace: deck.T.body, catAxisLabelFontSize: 11,
    valAxisLabelColor: deck.C.muted, valAxisLabelFontFace: deck.T.body, valAxisLabelFontSize: 10,
    lineSize: type === "line" ? 2.5 : undefined,
    ...opts.chartOpts,
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

/**
 * Source / citation line. Reserved slot just above the footer band, stopping
 * short of the page-number marker — so it never collides with footer({left,page}).
 * Use this instead of a hand-rolled addText; a freehand bottom line lands in the
 * footer's band (y~7.1) and trips the geometry gate.
 */
function source(deck, s, text) {
  const str = typeof text === "string" ? text : text && text.text;
  if (!str) return;
  s.addText(String(str), { x: 0.6, y: 6.84, w: 11.55, h: 0.2, fontFace: deck.T.body, fontSize: 8.5, italic: true, color: deck.C.muted, align: "left", valign: "top", margin: 0, fit: "shrink" });
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
 * Media — aspect-safe image placement + content-aware selection.
 *
 * pptxgenjs stretches a bitmap to fill `w`x`h` when both are given and no
 * `sizing` is set (anamorphic `<a:stretch><a:fillRect/>`). That distorts every
 * non-matching ratio — a wide logo squeezed into a tall box, a square can
 * stretched to 16:9. `guardImages` wraps a slide's `addImage` so a frame can
 * NEVER distort: it injects `sizing` (default `contain` = whole image fits,
 * preserving ratio; pass `fit:"cover"` for full-bleed backgrounds that may crop).
 * ------------------------------------------------------------------ */

/** Wrap `slide.addImage` so every placement is aspect-safe by default. */
function guardImages(s) {
  if (s._imagesGuarded) return s;
  s._imagesGuarded = true;
  const orig = s.addImage.bind(s);
  s.addImage = (opts = {}) => {
    const o = { ...opts };
    const hasFrame = typeof o.w === "number" && typeof o.h === "number";
    const fit = o.fit === "cover" || o.fit === "contain" ? o.fit : null;
    delete o.fit;
    if (hasFrame && !o.sizing && !o.srcRect) {
      o.sizing = { type: fit || "contain", w: o.w, h: o.h };
    }
    return orig(o);
  };
  return s;
}

/**
 * Aspect-safe image. `fit:"contain"` (default) fits the whole image inside the
 * frame, preserving ratio; `fit:"cover"` fills the frame and may crop. Use
 * `contain` for product cutouts and logos, `cover` for full-bleed photos.
 */
function image(deck, s, { path, data, x, y, w, h, fit = "contain", ...rest }) {
  s.addImage({ path, data, x, y, w, h, sizing: { type: fit, w, h }, ...rest });
  return geom(x, y, w, h);
}

const IMG_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

/** Recursively list image files under `dir`, sorted by path. */
function listImages(dir) {
  const fs = require("fs");
  const path = require("path");
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d); } catch (e) { return; }
    for (const f of entries) {
      const p = path.join(d, f);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) walk(p);
      else if (IMG_RE.test(f)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function tokens(p) {
  const path = require("path");
  return path.basename(p).toLowerCase().replace(IMG_RE, "").split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Score a filename against include/exclude keyword lists. A single `exclude`
 * hit disqualifies the image (returns -1) — this is how off-brand or
 * wrong-product assets (e.g. a mocktail can in an Imuno deck) get filtered out.
 * Otherwise the score is the count of matched `include` keywords.
 */
function scoreName(p, { include = [], exclude = [] } = {}) {
  const tks = tokens(p);
  const hit = (kw) => tks.some((t) => t.includes(kw) || kw.includes(t));
  if (exclude.some(hit)) return -1;
  return include.reduce((n, kw) => n + (hit(kw) ? 1 : 0), 0);
}

/**
 * Choose the single best image for a role by CONTENT, never by array index.
 * `images` is a list of paths (from `listImages`). Returns the highest-scoring
 * path, or null if every candidate is excluded / none match when
 * `requireMatch` is set.
 * @example pickImage(imgs, { include: ["imuno","can"], exclude: ["mocktail","logo"] })
 */
function pickImage(images, spec = {}) {
  const ranked = images
    .map((p) => ({ p, score: scoreName(p, spec) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (spec.requireMatch && ranked[0].score === 0) return null;
  return ranked[0].p;
}

/**
 * Resolve a whole set of roles to images in one call. `plan` maps role name →
 * include/exclude spec; returns role → path (or null). Distinct assets are
 * preferred — once a path is taken by one role it is not reused unless no other
 * candidate matches.
 * @example planImages(dir, { hero:{include:["imuno"],exclude:["mocktail"]}, logo:{include:["logo","eagle"]} })
 */
function planImages(dir, plan = {}) {
  const images = Array.isArray(dir) ? dir : listImages(dir);
  const out = {};
  const used = new Set();
  for (const [role, spec] of Object.entries(plan)) {
    const fresh = pickImage(images.filter((p) => !used.has(p)), spec);
    const pick = fresh || pickImage(images, spec);
    out[role] = pick || null;
    if (pick) used.add(pick);
  }
  return out;
}

/**
 * Materialize image assets INTO THE CURRENT SANDBOX, in the same code execution
 * that builds the deck.
 *
 * Every code-interpreter `run_code` call is an isolated, EPHEMERAL sandbox:
 * files you `git clone` / download / unzip in one call are GONE by the time a
 * later call runs the build. The "files persisted in /mnt/data" banner only
 * covers files LibreChat tracks (uploads + prior outputs) — not assets you
 * fetched yourself. So the build script must (re)fetch its own external assets
 * at the top, every run. This call is idempotent: it no-ops when `dir` already
 * holds images, and THROWS when a fetch yields none — so a deck never silently
 * ships with blank holes where product images belong.
 *
 * @param {object} opts
 * @param {string}  opts.dir    destination dir (e.g. "/mnt/data/assets")
 * @param {string} [opts.repo]  git URL to shallow-clone into `dir`
 * @param {string} [opts.ref]   branch/tag for the clone
 * @param {string} [opts.zip]   path to a .zip to extract into `dir`
 * @returns {string} `dir`
 * @example const dir = D.ensureAssets({ dir:"/mnt/data/assets", repo:"https://github.com/acme/brand.git" });
 */
function ensureAssets({ dir, repo, ref, zip } = {}) {
  const fs = require("fs");
  const { execFileSync } = require("child_process");
  if (!dir) throw new Error("ensureAssets: `dir` is required");
  if (listImages(dir).length) return dir;
  if (repo) {
    const args = ["clone", "--depth", "1"];
    if (ref) args.push("--branch", ref);
    args.push(repo, dir);
    execFileSync("git", args, { stdio: "pipe" });
  } else if (zip) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("unzip", ["-o", "-q", zip, "-d", dir], { stdio: "pipe" });
  } else {
    throw new Error("ensureAssets: pass `repo` (git URL) or `zip` (path)");
  }
  const found = listImages(dir);
  console.error(`ensureAssets: ${found.length} image(s) under ${dir}`);
  if (!found.length) {
    throw new Error(
      `ensureAssets: no images materialized under ${dir} (repo=${repo || ""} zip=${zip || ""}). ` +
        `Fetch failed in THIS exec — refusing to build an image-less deck.`,
    );
  }
  return dir;
}

/**
 * Hard-fail if any REQUIRED role resolved to null in a planImages() result.
 * Use this instead of `if (img) addImage(...)` guards: those silently ship a
 * deck with blank holes where the product images should be (the exact failure
 * a reserved-but-empty image region is). Call it right after planImages().
 * @example const A = D.planImages(dir, plan); D.assertAssets(A, ["hero","logo"]);
 */
function assertAssets(plan, required = []) {
  const missing = required.filter((r) => !plan[r]);
  if (missing.length) {
    throw new Error(
      `assertAssets: required image role(s) unresolved: ${missing.join(", ")}. ` +
        `Check include/exclude keywords and that ensureAssets() fetched assets in THIS exec.`,
    );
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * Diagram primitives — box / node / connector / flow.
 *
 * These exist so a deck never has to hand-roll raw `addShape` for flow
 * diagrams, comparison grids, or pipelines. They use only valid pptxgenjs
 * ShapeTypes (roundRect, ellipse, chevron, rightArrow, line), auto-pick a
 * readable text color from the fill luminance, and return geometry + edge
 * anchors so connectors and downstream content can align without guesswork.
 * ------------------------------------------------------------------ */

/** Pick ink or base text so it stays readable on a given fill color. */
function readableOn(deck, hex) {
  const c = String(hex || "").replace("#", "");
  if (c.length < 6) return deck.C.ink;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? deck.C.ink : deck.C.base;
}

function geom(x, y, w, h) {
  return {
    x, y, w, h, right: x + w, bottom: y + h, cx: x + w / 2, cy: y + h / 2,
    midLeft: { x, y: y + h / 2 }, midRight: { x: x + w, y: y + h / 2 },
    midTop: { x: x + w / 2, y }, midBottom: { x: x + w / 2, y: y + h },
  };
}

/**
 * A titled content box (rounded rect + optional bold title + body). Text is
 * fit-shrunk to stay inside, and the color auto-contrasts with `fill`. Returns
 * its geometry + edge anchors (`midRight`, `midLeft`, …) for connectors.
 */
function box(deck, s, x, y, w, h, opts = {}) {
  // Accept both box(deck,s,x,y,w,h,opts) and the options-object form
  // box(deck,s,{x,y,w,h,title,body|text,fill,...}) — the latter is what callers
  // naturally reach for (like kicker/titleClaim/flow).
  if (x !== null && typeof x === "object") {
    opts = x;
    ({ x, y, w, h } = opts);
  }
  opts = opts || {};
  const fill = opts.fill || deck.C.surface;
  const txt = opts.color || readableOn(deck, fill);
  const pad = opts.pad ?? 0.18;
  const align = opts.align || "left";
  const title = opts.title;
  const body = opts.body ?? opts.text; // `text` is a common alias
  const titleSize = opts.titleSize ?? opts.size ?? 15;
  const bodySize = opts.bodySize ?? opts.size ?? 12;
  s.addShape(deck.pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: opts.radius ?? 0.06,
    fill: { color: fill }, line: { color: opts.line || fill, width: 1 },
    shadow: opts.shadow === false ? undefined : shadow(),
  });
  let ty = y + pad;
  if (title) {
    s.addText(String(title), {
      x: x + pad, y: ty, w: w - 2 * pad, h: 0.42,
      fontFace: deck.T.head, fontSize: titleSize, bold: true,
      color: opts.titleColor || txt, align, valign: "top", margin: 0, fit: "shrink",
    });
    ty += 0.52;
  }
  if (body) {
    s.addText(String(body), {
      x: x + pad, y: ty, w: w - 2 * pad, h: y + h - ty - pad,
      fontFace: deck.T.body, fontSize: bodySize, color: txt,
      align, valign: title ? "top" : "middle", margin: 0, fit: "shrink",
      lineSpacingMultiple: 1.05,
    });
  }
  return geom(x, y, w, h);
}

/** A labeled circular node (uses ellipse — there is no `circle` ShapeType). */
function node(deck, s, cx, cy, d, opts = {}) {
  // Accept node(deck,s,{cx|x, cy|y, d|w, label|text, ...}) too.
  if (cx !== null && typeof cx === "object") {
    opts = cx;
    cx = opts.cx ?? opts.x;
    cy = opts.cy ?? opts.y;
    d = opts.d ?? opts.w;
  }
  opts = opts || {};
  if (opts.label == null && opts.text != null) opts = { ...opts, label: opts.text };
  const fill = opts.fill || deck.C.accent;
  s.addShape(deck.pptx.ShapeType.ellipse, {
    x: cx - d / 2, y: cy - d / 2, w: d, h: d,
    fill: { color: fill }, line: { color: opts.line || deck.C.surface, width: opts.lineWidth ?? 1.5 },
  });
  if (opts.label != null) {
    s.addText(String(opts.label), {
      x: cx - d / 2, y: cy - d / 2, w: d, h: d,
      fontFace: deck.T.head, fontSize: opts.size ?? 14, bold: true,
      color: opts.color || readableOn(deck, fill), align: "center", valign: "middle",
      margin: 0, fit: "shrink",
    });
  }
  return geom(cx - d / 2, cy - d / 2, d, d);
}

/**
 * Connector between two anchors (box geometry or a {x,y} point). Defaults to a
 * right-arrow sitting in the gap between `from.midRight` and `to.midLeft`.
 * style: "arrow" | "chevron" | "line".
 */
function connector(deck, s, from, to, opts = {}) {
  const color = opts.color || deck.C.accent;
  const a = from.midRight || from;
  const b = to.midLeft || to;
  const style = opts.style || "arrow";
  if (style === "line") {
    s.addShape(deck.pptx.ShapeType.line, {
      x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y,
      line: { color, width: opts.width ?? 2, endArrowType: opts.arrow === false ? undefined : "triangle" },
    });
    return;
  }
  const th = opts.size ?? (style === "chevron" ? 0.34 : 0.22);
  const shape = style === "chevron" ? deck.pptx.ShapeType.chevron : deck.pptx.ShapeType.rightArrow;
  s.addShape(shape, {
    x: a.x + 0.04, y: (a.y + b.y) / 2 - th / 2,
    w: Math.max(0.4, b.x - a.x - 0.08), h: th,
    fill: { color }, line: { color },
  });
}

/**
 * Lay N steps out as a row of boxes with connectors between them — the common
 * "A → B → C" flow / pipeline. steps: [{ title, body, fill, line, align }].
 * Returns the box geometries (so you can attach more connectors or labels).
 */
function flow(deck, s, steps, opts = {}) {
  const x = opts.x ?? 0.6;
  const y = opts.y ?? 2.6;
  const h = opts.h ?? 1.6;
  const w = opts.w ?? EMU_W - 2 * x;
  const gap = opts.gap ?? 0.7;
  const n = steps.length;
  const bw = (w - gap * (n - 1)) / n;
  const geoms = steps.map((st, i) =>
    box(deck, s, x + i * (bw + gap), y, bw, h, {
      title: st.title, body: st.body, fill: st.fill, line: st.line, align: st.align || "left",
    }),
  );
  for (let i = 0; i < n - 1; i += 1) {
    connector(deck, s, geoms[i], geoms[i + 1], { style: opts.style, color: opts.connectorColor });
  }
  return geoms;
}

function noteColumn(deck, s, note, x, y, w, h, opts = {}) {
  const title = note.title ?? note.heading;
  const items = Array.isArray(note.items) ? note.items : [];
  const body = note.body ?? note.text;
  const color = note.color || fg(deck, s);
  const muted = note.muted || deck.C.muted;
  const titleH = title ? 0.25 : 0;
  const itemGap = opts.itemGap ?? 0.38;
  const bullet = opts.bulletSize ?? 0.07;
  const bulletColor = note.bulletColor || opts.bulletColor || deck.C.gold;
  let cursor = y;

  if (title) {
    s.addText(String(title), {
      x, y: cursor, w, h: titleH,
      fontFace: deck.T.body, fontSize: note.titleSize ?? opts.titleSize ?? 14,
      bold: true, color: note.titleColor || color, margin: 0,
      align: "left", valign: "top", fit: "shrink",
    });
    cursor += titleH + 0.16;
  }

  if (body) {
    const bodyH = Math.max(0.28, h - (cursor - y) - (items.length ? items.length * itemGap : 0));
    s.addText(String(body), {
      x, y: cursor, w, h: bodyH,
      fontFace: deck.T.body, fontSize: note.bodySize ?? opts.bodySize ?? 12.5,
      color: note.bodyColor || muted, margin: 0,
      align: "left", valign: "top", fit: "shrink",
      lineSpacingMultiple: 1.05,
    });
    cursor += bodyH + 0.1;
  }

  items.forEach((item, i) => {
    const iy = cursor + i * itemGap;
    s.addShape(deck.pptx.ShapeType.ellipse, {
      x, y: iy + 0.08, w: bullet, h: bullet,
      fill: { color: bulletColor }, line: { color: bulletColor },
    });
    s.addText(String(item), {
      x: x + bullet + 0.11, y: iy, w: w - bullet - 0.11, h: itemGap,
      fontFace: deck.T.body, fontSize: note.itemSize ?? opts.itemSize ?? 12.5,
      color, margin: 0, align: "left", valign: "top", fit: "shrink",
    });
  });

  return geom(x, y, w, h);
}

/**
 * Safe pattern for the common "flow row + explanatory notes" slide. It
 * guarantees the notes start below the flow by at least `minGap` (0.45in by
 * default), which prevents headings from colliding with flow boxes/arrows when
 * labels wrap after render. Use this instead of hand-placing text below
 * `D.flow`.
 *
 * @example
 * const t = D.titleClaim(deck, s, "Artifacts fail in the visible last mile.");
 * D.safeFlowWithNotes(deck, s, [
 *   { title: "Generate", body: "Create code and artifacts." },
 *   { title: "Render", body: "Export files." },
 *   { title: "Judge", body: "Users infer quality." },
 * ], {
 *   y: Math.max(2.0, t.bottom + 0.25),
 *   h: 0.85,
 *   notes: [
 *     { title: "What goes wrong", items: ["Correct code can still look broken."] },
 *     { title: "Why it matters", items: ["Artifacts are product surfaces."] },
 *   ],
 * });
 */
function safeFlowWithNotes(deck, s, steps, opts = {}) {
  const x = opts.x ?? 0.7;
  const y = opts.y ?? 2.2;
  const w = opts.w ?? EMU_W - 2 * x;
  const h = opts.h ?? 0.95;
  const minGap = opts.minGap ?? 0.45;
  const bottomMargin = opts.bottomMargin ?? 0.62;
  const noteY = Math.max(opts.noteY ?? 0, y + h + minGap);
  const noteH = opts.noteH ?? Math.max(0.9, EMU_H - bottomMargin - noteY);
  const notes = opts.notes ?? [
    ...(opts.left ? [opts.left] : []),
    ...(opts.right ? [opts.right] : []),
  ];

  if (noteY + noteH > EMU_H - bottomMargin + 0.01) {
    throw new Error(
      `safeFlowWithNotes: not enough vertical room for notes (flow bottom ${(
        y + h
      ).toFixed(2)}, noteY ${noteY.toFixed(2)}, noteH ${noteH.toFixed(2)}). Move the flow up or shorten notes.`,
    );
  }

  const flowGeoms = flow(deck, s, steps, {
    x, y, w, h,
    gap: opts.gap,
    style: opts.style,
    connectorColor: opts.connectorColor,
  });

  const noteGeoms = [];
  if (notes.length > 0) {
    const columnGap = opts.noteGap ?? 0.65;
    const columnW = (w - columnGap * (notes.length - 1)) / notes.length;
    notes.forEach((note, i) => {
      noteGeoms.push(noteColumn(
        deck,
        s,
        note,
        x + i * (columnW + columnGap),
        noteY,
        columnW,
        note.h ?? noteH,
        opts,
      ));
    });
  }

  return {
    flow: flowGeoms,
    notes: noteGeoms,
    noteY,
    bottom: notes.length ? Math.max(...noteGeoms.map((g) => g.bottom)) : y + h,
  };
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

const EMU_PER_IN = 914400;

/** pptxgenjs stores TABLE geometry pre-converted to EMU; everything else stays in inches. */
function emuToIn(v) {
  return Math.abs(v) > 100 ? v / EMU_PER_IN : v;
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
    let x = num(o.x), y = num(o.y), w = num(o.w), h = num(o.h);
    if (x === null || y === null || w === null || h === null) return;
    [x, y, w, h] = [x, y, w, h].map(emuToIn);
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
          if (ov.w > 0.4 && ov.h > 0.4) {
            errors.push(`${label}: text #${a.index} and text #${b.index} overlap (${ov.w.toFixed(2)}"x${ov.h.toFixed(2)}"). Reposition so text never stacks.`);
          } else if (ov.w > 0.08 && ov.h > 0.05) {
            warnings.push(`${label}: text #${a.index} and text #${b.index} graze (${ov.w.toFixed(2)}"x${ov.h.toFixed(2)}"). Declared boxes clip — pptxgenjs boxes over-state height; the render gate (qa_deck.sh) measures real text. Verify the rendered slide, do not loop on this.`);
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
  palette, newDeck, readableOn,
  kicker, titleClaim, estimateWrappedLines, card, kpi, kpiRail, pill, bullets, hbars, chart, timeline, footer, source, divider,
  image, listImages, scoreName, pickImage, planImages, ensureAssets, assertAssets,
  box, node, connector, flow, safeFlowWithNotes,
  lint, assertClean,
};
