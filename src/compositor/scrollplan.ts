// src/compositor/scrollplan.ts
//
// Deterministic scroll-compositing analysis.
//
// A timed scroll is rendered as MOVING DOCUMENT LAYER + FIXED VIEWPORT LAYER,
// never as two translated screenshots. This module:
//   - measures the true document displacement between the pre-scroll (A) and
//     post-scroll (B) screenshots with deterministic coarse-to-fine normalized
//     cross-correlation (no randomness, no learned models),
//   - partitions the frame into document / fixed / sticky regions,
//   - detects a scrollbar gutter touching the right edge and its thumb,
//   - plans the exact draw operations for any eased scroll progress,
//   - reports declared-vs-measured offsets and QA warnings.
//
// Everything here is pure and deterministic (no DOM, no I/O), so it is
// unit-testable in Node and safe to run in parallel render workers.
//
// Coordinate conventions:
//   - All plan coordinates are in screenshot pixels.
//   - (mx, my) is the measured document displacement A -> B, defined by
//     B(x, y) = A(x - mx, y - my). For a scroll down (content moves up),
//     my is negative; for a scroll up (content moves down), my is positive.
//   - For horizontal scrolls the images are transposed before analysis and
//     the plan is kept in transposed space (axis "h"); planScrollDraws
//     converts back, so callers never handle this directly.

export type ScrollAxis = "v" | "h";
export type ScrollRegionKind = "document" | "fixed" | "sticky";

export interface ScrollBand {
  /** [y0, y1) in A coordinates, screenshot px. */
  y0: number;
  y1: number;
  kind: ScrollRegionKind;
  /** Measured displacement of this band's content A -> B along the scroll axis. */
  d: number;
}

export interface ScrollCol {
  /** [x0, x1) vertical strip, screenshot px. */
  x0: number;
  x1: number;
  kind: ScrollRegionKind;
  d: number;
  /** Bands subdividing this column; empty unless kind === "document". */
  bands: ScrollBand[];
}

export interface ScrollPlan {
  axis: ScrollAxis;
  /** Measured document displacement A -> B, screenshot px. */
  mx: number;
  my: number;
  /** Declared displacement, screenshot px. */
  dx: number;
  dy: number;
  /** NCC confidence of the global displacement measurement, 0..1. */
  confidence: number;
  /** False when confidence is low: the renderer falls back to declared offsets. */
  useMeasured: boolean;
  /** Partition of [0, w) into vertical strips (transposed space when axis "h"). */
  cols: ScrollCol[];
  /** Screenshot width/height the plan coordinates refer to. */
  w: number;
  h: number;
  /** Right-edge scrollbar gutter start x, screenshot px. Null when absent. */
  gutterX0: number | null;
  thumbA: { y0: number; y1: number } | null;
  thumbB: { y0: number; y1: number } | null;
  warnings: string[];
  /** Scrollbar gutter width, screenshot px (0 when gutterX0 is null). */
  gutterW: number;
}

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ScrollDrawOp {
  src: "a" | "b";
  /** Source rect, screenshot px. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rect, screenshot px (caller scales to device px). */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  alpha: number;
}

// ---------------------------------------------------------------------------
// Grayscale helpers
// ---------------------------------------------------------------------------

interface Gray {
  w: number;
  h: number;
  d: Float32Array;
}

function toGray(data: Uint8ClampedArray, w: number, h: number): Gray {
  const d = new Float32Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    d[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { w, h, d };
}

function transposeGray(g: Gray): Gray {
  const d = new Float32Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) {
    const ro = y * g.w;
    for (let x = 0; x < g.w; x++) d[x * g.h + y] = g.d[ro + x];
  }
  return { w: g.h, h: g.w, d };
}

// ---------------------------------------------------------------------------
// Normalized cross-correlation and SAD at an integer offset.
//
// nccAt(a, b, dx, dy) compares a(x, y) against b(x + dx, y + dy) over their
// overlap. The displacement (mx, my) with B(x,y) = A(x-mx, y-my) is the
// (dx, dy) maximizing nccAt, since b(x+mx, y+my) = a(x, y).
// ---------------------------------------------------------------------------

function overlap(
  a: Gray, b: Gray, dx: number, dy: number,
  x0: number, x1: number, y0: number, y1: number,
): [number, number, number, number] {
  const ax0 = Math.max(x0, -dx);
  const ax1 = Math.min(x1, b.w - dx);
  const ay0 = Math.max(y0, -dy);
  const ay1 = Math.min(y1, b.h - dy);
  return [ax0, ax1, ay0, ay1];
}

function nccAt(
  a: Gray, b: Gray, dx: number, dy: number,
  x0 = 0, x1 = a.w, y0 = 0, y1 = a.h,
  skipRows?: Uint8Array,
): number {
  const [ax0, ax1, ay0, ay1] = overlap(a, b, dx, dy, x0, x1, y0, y1);
  if (ax1 - ax0 < 8 || ay1 - ay0 < 8) return -2;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = ay0; y < ay1; y++) {
    if (skipRows && skipRows[y]) continue;
    const ao = y * a.w;
    const bo = (y + dy) * b.w + dx;
    for (let x = ax0; x < ax1; x++) {
      const va = a.d[ao + x];
      const vb = b.d[bo + x];
      n++;
      sa += va; sb += vb;
      saa += va * va; sbb += vb * vb;
      sab += va * vb;
    }
  }
  if (n < 64) return -2;
  const num = n * sab - sa * sb;
  const den = Math.sqrt(Math.max(0, (n * saa - sa * sa) * (n * sbb - sb * sb)));
  return den < 1e-9 ? -2 : num / den;
}

function sadAt(
  a: Gray, b: Gray, dx: number, dy: number,
  x0 = 0, x1 = a.w, y0 = 0, y1 = a.h,
  skipRows?: Uint8Array,
): number {
  const [ax0, ax1, ay0, ay1] = overlap(a, b, dx, dy, x0, x1, y0, y1);
  if (ax1 - ax0 < 16 || ay1 - ay0 < 16) return Infinity;
  let s = 0, n = 0;
  for (let y = ay0; y < ay1; y++) {
    if (skipRows && skipRows[y]) continue;
    const ao = y * a.w;
    const bo = (y + dy) * b.w + dx;
    for (let x = ax0; x < ax1; x++) {
      s += Math.abs(a.d[ao + x] - b.d[bo + x]);
      n++;
    }
  }
  return n < 256 ? Infinity : s / n;
}

// ---------------------------------------------------------------------------
// Scrollbar gutter + thumb detection.
//
// The gutter is a narrow fixed strip at the right edge. We find it by scanning
// from the edge for columns brighter than the (usually dark) page background.
// The thumb is the lighter band within the gutter; its position is read from
// the vertical brightness profile.
// ---------------------------------------------------------------------------

function detectGutter(a: Gray, b: Gray): number | null {
  const w = a.w, h = a.h;
  const means: number[] = [];
  for (let x = w - 32; x < w; x++) {
    let s = 0, n = 0;
    for (let y = 0; y < h; y += 4) { s += a.d[y * w + x]; n++; }
    means.push(s / n);
  }
  let x0 = w;
  for (let i = means.length - 1; i >= 0; i--) {
    if (means[i] > 25) x0 = w - 32 + i;
    else break;
  }
  const gw = w - x0;
  // A scrollbar gutter is narrow. Wider fixed strips are sidebars, handled by
  // the column classifier instead.
  if (gw < 8 || gw > 28) return null;
  return x0;
}

function detectThumb(g: Gray, x0: number): { y0: number; y1: number } | null {
  const w = g.w, h = g.h;
  const gw = w - x0;
  if (gw <= 0) return null;
  const p = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const o = y * w + x0;
    for (let x = 0; x < gw; x++) s += g.d[o + x];
    p[y] = s / gw;
  }
  const sorted = Float32Array.from(p).sort();
  const track = sorted[Math.floor(h / 2)];
  const thresh = track + 25;
  let best: { y0: number; y1: number } | null = null;
  let y = 0;
  while (y < h) {
    if (p[y] > thresh) {
      const y0 = y;
      while (y < h && p[y] > thresh) y++;
      if (!best || y - y0 > best.y1 - best.y0) best = { y0, y1: y };
    } else y++;
  }
  if (!best || best.y1 - best.y0 < 24 || best.y1 - best.y0 > h * 0.7) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Region classification.
// ---------------------------------------------------------------------------

const BAND_H = 32;
const COL_W = 32;

/** Per-column texture: skip uniform columns when matching a band. */
function texturedColumns(g: Gray, y0: number, y1: number, x0: number, x1: number): Uint8Array {
  const mask = new Uint8Array(x1 - x0);
  for (let x = x0; x < x1; x++) {
    let mean = 0;
    for (let y = y0; y < y1; y++) mean += g.d[y * g.w + x];
    mean /= y1 - y0;
    let v = 0;
    for (let y = y0; y < y1; y++) {
      const d = g.d[y * g.w + x] - mean;
      v += d * d;
    }
    mask[x - x0] = v / (y1 - y0) > 16 ? 1 : 0;
  }
  return mask;
}

function nccAtMaskedCols(
  a: Gray, b: Gray, dx: number, dy: number,
  x0: number, x1: number, y0: number, y1: number,
  colMask: Uint8Array,
): number {
  const [ax0, ax1, ay0, ay1] = overlap(a, b, dx, dy, x0, x1, y0, y1);
  if (ay1 - ay0 < 8) return -2;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = ay0; y < ay1; y++) {
    const ao = y * a.w;
    const bo = (y + dy) * b.w + dx;
    for (let x = ax0; x < ax1; x++) {
      if (!colMask[x - x0]) continue;
      const va = a.d[ao + x];
      const vb = b.d[bo + x];
      n++;
      sa += va; sb += vb;
      saa += va * va; sbb += vb * vb;
      sab += va * vb;
    }
  }
  if (n < 64) return -2;
  const num = n * sab - sa * sb;
  const den = Math.sqrt(Math.max(0, (n * saa - sa * sa) * (n * sbb - sb * sb)));
  return den < 1e-9 ? -2 : num / den;
}

interface RegionMeasurement { d: number; conf: number; }

/**
 * Measure a horizontal band's vertical displacement. The declared offset is
 * the prior: when it matches well we take it (with local refinement),
 * otherwise we search wider. Texture-masked so a sticky bar on a uniform
 * background is not outvoted by the background.
 */
function measureBand(
  a: Gray, b: Gray, y0: number, y1: number,
  x0: number, x1: number, dx: number, dy: number,
): RegionMeasurement {
  const mask = texturedColumns(a, y0, y1, x0, x1);
  let textured = 0;
  for (let i = 0; i < mask.length; i++) textured += mask[i];
  if (textured < 24) return { d: dy, conf: 0 }; // uniform: motion is invisible
  const dxr = Math.round(dx);
  const dyr = Math.round(dy);
  const nccDecl = nccAtMaskedCols(a, b, dxr, dyr, x0, x1, y0, y1, mask);
  if (nccDecl >= 0.7) {
    let bd = dyr, bc = nccDecl;
    for (let d = dyr - 6; d <= dyr + 6; d++) {
      if (d === dyr) continue;
      const c = nccAtMaskedCols(a, b, dxr, d, x0, x1, y0, y1, mask);
      if (c > bc) { bc = c; bd = d; }
    }
    return { d: bd, conf: bc };
  }
  // Declared matches poorly: full search over the plausible range.
  const lo = Math.min(0, dyr) - 64;
  const hi = Math.max(0, dyr) + 64;
  let bestD = dyr, bestS = Infinity;
  for (let d = lo; d <= hi; d += 4) {
    const s = sadAt(a, b, dxr, d, x0, x1, y0, y1);
    if (s < bestS) { bestS = s; bestD = d; }
  }
  let bd = bestD, bc = -2;
  for (let d = bestD - 5; d <= bestD + 5; d++) {
    const c = nccAtMaskedCols(a, b, dxr, d, x0, x1, y0, y1, mask);
    if (c > bc) { bc = c; bd = d; }
  }
  return { d: bd, conf: bc };
}

function classify(d: number, conf: number, my: number): ScrollRegionKind {
  if (conf < 0.55) return "document"; // ambiguous: safest is document motion
  if (Math.abs(d) <= 10) return "fixed";
  if (Math.abs(d - my) <= 14) return "document";
  return "sticky";
}

/** Measure a full-height vertical strip's vertical displacement (cheap check). */
function measureCol(
  a: Gray, b: Gray, x0: number, x1: number, mx: number, my: number,
): RegionMeasurement {
  const mxr = Math.round(mx);
  const myr = Math.round(my);
  const nccFix = nccAt(a, b, 0, 0, x0, x1, 0, a.h);
  const nccDoc = nccAt(a, b, mxr, myr, x0, x1, 0, a.h);
  if (nccFix >= 0.75 && nccFix > nccDoc) return { d: 0, conf: nccFix };
  if (nccDoc >= 0.75) return { d: myr, conf: nccDoc };
  return { d: myr, conf: Math.max(0, nccDoc) };
}

function mergeBands(bands: ScrollBand[]): ScrollBand[] {
  const out: ScrollBand[] = [];
  for (const b of bands) {
    const p = out[out.length - 1];
    if (
      p && p.kind === b.kind && p.y1 === b.y0 &&
      (b.kind !== "sticky" || Math.abs(p.d - b.d) <= 12)
    ) {
      p.y1 = b.y1;
      if (b.kind === "sticky") p.d = (p.d + b.d) / 2;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main analysis (vertical orientation).
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = 0.5;

function analyzeVertical(gA: Gray, gB: Gray, dx: number, dy: number): ScrollPlan {
  const w = gA.w, h = gA.h;
  const warnings: string[] = [];

  const gutterX0 = detectGutter(gA, gB);
  const gutterW = gutterX0 == null ? 0 : w - gutterX0;
  const x1 = gutterX0 ?? w;

  // Per-band displacement, using the declared offset as the prior. The global
  // document displacement is the median of the confident bands, which is
  // robust against fixed/sticky regions polluting a whole-image match.
  interface BandM { y0: number; y1: number; d: number; conf: number }
  const bandMs: BandM[] = [];
  for (let y0 = 0; y0 < h; y0 += BAND_H) {
    const y1 = Math.min(h, y0 + BAND_H);
    const m = measureBand(gA, gB, y0, y1, 0, x1, dx, dy);
    bandMs.push({ y0, y1, d: m.d, conf: m.conf });
  }
  const confident = bandMs.filter((b) => b.conf >= 0.55);
  const ds = confident.map((b) => b.d).sort((p, q) => p - q);
  const agree = (v: number) => ds.filter((d) => Math.abs(d - v) <= 14).length;
  let my = dy;
  let conf = 0;
  if (ds.length >= 3) {
    const median = ds[Math.floor(ds.length / 2)];
    // Prefer the median, but keep the declared offset when it explains the
    // bands at least as well (it is the trace's ground truth).
    my = agree(dy) >= agree(median) ? dy : median;
    conf = agree(my) / ds.length;
  }

  const mx = dx;

  // Column strips (catches full-height fixed sidebars).
  const cols: ScrollCol[] = [];
  for (let x0 = 0; x0 < x1; x0 += COL_W) {
    const cx1 = Math.min(x1, x0 + COL_W);
    const m = measureCol(gA, gB, x0, cx1, mx, my);
    const kind = classify(m.d, m.conf, my);
    cols.push({ x0, x1: cx1, kind, d: m.d, bands: [] });
  }
  const mergedCols: ScrollCol[] = [];
  for (const c of cols) {
    const p = mergedCols[mergedCols.length - 1];
    if (
      p && p.kind === c.kind && p.x1 === c.x0 &&
      (c.kind !== "sticky" || Math.abs(p.d - c.d) <= 12)
    ) {
      p.x1 = c.x1;
      if (c.kind === "sticky") p.d = (p.d + c.d) / 2;
    } else mergedCols.push({ ...c, bands: [] });
  }

  // Bands inside document columns (catches horizontal fixed/sticky bars).
  for (const c of mergedCols) {
    if (c.kind !== "document") continue;
    c.bands = mergeBands(bandMs.map((b) => ({
      y0: b.y0, y1: b.y1,
      kind: classify(b.d, b.conf, my),
      d: b.d,
    })));
  }

  let useMeasured = true;
  if (conf < CONFIDENCE_THRESHOLD) {
    warnings.push("SCROLL_ALIGNMENT_LOW_CONFIDENCE");
    useMeasured = false;
    my = dy;
  }

  const thumbA = gutterX0 == null ? null : detectThumb(gA, gutterX0);
  const thumbB = gutterX0 == null ? null : detectThumb(gB, gutterX0);

  return {
    axis: "v",
    mx, my, dx, dy,
    confidence: conf,
    useMeasured,
    cols: mergedCols,
    w, h,
    gutterX0,
    gutterW,
    thumbA,
    thumbB,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function analyzeScroll(a: ImageDataLike, b: ImageDataLike, dx: number, dy: number): ScrollPlan {
  const gA = toGray(a.data, a.width, a.height);
  const gB = toGray(b.data, b.width, b.height);
  const axis: ScrollAxis = Math.abs(dy) >= Math.abs(dx) ? "v" : "h";
  if (axis === "v") return analyzeVertical(gA, gB, dx, dy);
  const plan = analyzeVertical(transposeGray(gA), transposeGray(gB), dy, dx);
  plan.axis = "h";
  return plan;
}

// ---------------------------------------------------------------------------
// Draw-op planning: pure function of (plan, eased progress).
// ---------------------------------------------------------------------------

/** Subtract sorted, non-overlapping [s0,s1) intervals from [r0,r1). */
function subtractIntervals(r0: number, r1: number, subs: [number, number][]): [number, number][] {
  const segs = subs
    .map(([s0, s1]) => [Math.max(s0, r0), Math.min(s1, r1)] as [number, number])
    .filter(([s0, s1]) => s1 > s0)
    .sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cur = r0;
  for (const [s0, s1] of segs) {
    if (s0 > cur) out.push([cur, Math.min(s0, r1)]);
    cur = Math.max(cur, s1);
    if (cur >= r1) break;
  }
  if (cur < r1) out.push([cur, r1]);
  return out;
}

/**
 * Plan the draw operations compositing one scroll frame.
 *
 * Layers (back to front): moving document (A) -> newly revealed strip (B) ->
 * sticky regions (A, own displacement) -> fixed regions (A/B crossfade in
 * place) -> scrollbar gutter (fixed, interpolated thumb).
 *
 * sp is the EASED progress in [0, 1]. At sp=0 the composite equals A; at
 * sp=1 it equals B (up to measurement error).
 */
export function planScrollDraws(plan: ScrollPlan, sp: number, W?: number, H?: number): ScrollDrawOp[] {
  const ops: ScrollDrawOp[] = [];
  const w = W ?? plan.w;
  const h = H ?? plan.h;
  const { mx, my } = plan;
  const x1 = plan.gutterX0 ?? w;

  // Document top/bottom: bounding box of document bands (for full coverage).
  let docTop = h;
  let docBotY1 = 0;
  for (const c of plan.cols) {
    const bands = c.kind === "document" ? c.bands : [];
    for (const b of bands) {
      if (b.kind === "document") {
        if (b.y0 < docTop) docTop = b.y0;
        if (b.y1 > docBotY1) docBotY1 = b.y1;
      }
    }
    if (c.kind === "document" && c.bands.length === 0) {
      docTop = 0;
      docBotY1 = h;
    }
  }
  if (docTop === h) docTop = 0;
  if (docBotY1 === 0) docBotY1 = h;
  const docBottom = h - docBotY1;

  const pushDoc = (x0: number, x1b: number, y0: number, y1: number) => {
    if (x1b <= x0 || y1 <= y0) return;
    ops.push({
      src: "a", sx: x0, sy: y0, sw: x1b - x0, sh: y1 - y0,
      dx: x0 + mx * sp, dy: y0 + my * sp, dw: x1b - x0, dh: y1 - y0, alpha: 1,
    });
  };
  const pushSticky = (x0: number, x1b: number, y0: number, y1: number, d: number) => {
    if (x1b <= x0 || y1 <= y0) return;
    ops.push({
      src: "a", sx: x0, sy: y0, sw: x1b - x0, sh: y1 - y0,
      dx: x0 + mx * sp, dy: y0 + d * sp, dw: x1b - x0, dh: y1 - y0, alpha: 1,
    });
  };
  const pushFixed = (x0: number, x1b: number, y0: number, y1: number) => {
    if (x1b <= x0 || y1 <= y0) return;
    ops.push({
      src: "a", sx: x0, sy: y0, sw: x1b - x0, sh: y1 - y0,
      dx: x0, dy: y0, dw: x1b - x0, dh: y1 - y0, alpha: 1 - sp,
    });
    ops.push({
      src: "b", sx: x0, sy: y0, sw: x1b - x0, sh: y1 - y0,
      dx: x0, dy: y0, dw: x1b - x0, dh: y1 - y0, alpha: sp,
    });
  };

  // 1. Moving document from A (full coverage, no gaps), then fixed/sticky
  //    overlays. The document layer is A[docTop:h-docBottom] translated by
  //    (mx*sp, my*sp). Fixed/sticky bands are drawn on top.
  for (const c of plan.cols) {
    if (c.kind === "fixed") {
      pushFixed(c.x0, c.x1, 0, h);
    } else if (c.kind === "sticky") {
      pushSticky(c.x0, c.x1, 0, h, c.d);
    } else {
      // Full document coverage for this column.
      pushDoc(c.x0, c.x1, docTop, h - docBottom);
      // Overlays for non-document bands. Sticky is only drawn near the top or
      // bottom (headers/footers); mid-document "sticky" hits are usually
      // spurious matches on repetitive text — the full document layer already
      // covers them correctly.
      for (const b of c.bands) {
        if (b.kind === "sticky") {
          const nearTop = b.y0 < docTop + 128;
          const nearBottom = b.y1 > h - docBottom - 128;
          if (nearTop || nearBottom) pushSticky(c.x0, c.x1, b.y0, b.y1, b.d);
        } else if (b.kind === "fixed") {
          pushFixed(c.x0, c.x1, b.y0, b.y1);
        }
        // document bands: already covered by pushDoc above.
      }
    }
  }

  // 2. Newly revealed strip from B, with B-side fixed/sticky regions knocked out
  //    (they are drawn by their own layers). The strip reveals statically: at
  //    progress sp, the top (docTop+my)*sp pixels of new content are visible
  //    (scroll up). Starts at 0 to cover the header area (B has new content
  //    there); the sticky/fixed overlays draw on top.
  if (my > 0.5) {
    // Strip fills [0, docTop + my*sp]: aligns with the moving document's top edge.
    const r1 = docTop + my * sp;
    if (r1 > 0.5) {
      for (const c of plan.cols) {
        if (c.kind === "fixed") continue;
        if (c.kind === "sticky") continue;
        const knockouts: [number, number][] = [];
        for (const b of c.bands) {
          if (b.kind === "fixed") knockouts.push([b.y0, b.y1]);
          else if (b.kind === "sticky") knockouts.push([b.y0 + b.d * sp, b.y1 + b.d * sp]);
        }
        for (const [s0, s1] of subtractIntervals(0, r1, knockouts)) {
          if (s1 - s0 < 0.5) continue;
          ops.push({
            src: "b", sx: c.x0, sy: s0, sw: c.x1 - c.x0, sh: s1 - s0,
            dx: c.x0, dy: s0, dw: c.x1 - c.x0, dh: s1 - s0, alpha: 1,
          });
        }
      }
    }
  } else if (my < -0.5) {
    // Strip fills [h + my*sp - docBottom, h]: aligns with document's bottom edge.
    const r0 = h - docBottom + my * sp;
    if (h - r0 > 0.5) {
      for (const c of plan.cols) {
        if (c.kind === "fixed") continue;
        if (c.kind === "sticky") continue;
        const knockouts: [number, number][] = [];
        for (const b of c.bands) {
          if (b.kind === "fixed") knockouts.push([b.y0, b.y1]);
          else if (b.kind === "sticky") knockouts.push([b.y0 + b.d * sp, b.y1 + b.d * sp]);
        }
        for (const [s0, s1] of subtractIntervals(r0, h, knockouts)) {
          if (s1 - s0 < 0.5) continue;
          ops.push({
            src: "b", sx: c.x0, sy: s0, sw: c.x1 - c.x0, sh: s1 - s0,
            dx: c.x0, dy: s0, dw: c.x1 - c.x0, dh: s1 - s0, alpha: 1,
          });
        }
      }
    }
  }

  // 3. Scrollbar gutter: fixed track, interpolated thumb.
  if (plan.gutterX0 != null) {
    const gx = plan.gutterX0, gw = w - gx;
    if (plan.thumbA && plan.thumbB && gw > 0) {
      const tA = plan.thumbA, tB = plan.thumbB;
      const iy0 = tA.y0 + (tB.y0 - tA.y0) * sp;
      const iy1 = tA.y1 + (tB.y1 - tA.y1) * sp;
      if (tA.y0 > 0.5) {
        ops.push({ src: "a", sx: gx, sy: 0, sw: gw, sh: tA.y0, dx: gx, dy: 0, dw: gw, dh: tA.y0, alpha: 1 });
      }
      if (tA.y1 < h - 0.5) {
        ops.push({
          src: "a", sx: gx, sy: tA.y1, sw: gw, sh: h - tA.y1,
          dx: gx, dy: tA.y1, dw: gw, dh: h - tA.y1, alpha: 1,
        });
      }
      if (iy1 - iy0 > 0.5) {
        ops.push({
          src: "a", sx: gx, sy: tA.y0, sw: gw, sh: tA.y1 - tA.y0,
          dx: gx, dy: iy0, dw: gw, dh: iy1 - iy0, alpha: 1,
        });
      }
    } else if (gw > 0) {
      ops.push({ src: "a", sx: gx, sy: 0, sw: gw, sh: h, dx: gx, dy: 0, dw: gw, dh: h, alpha: 1 });
    }
  }

  // Horizontal scrolls: the plan is in transposed space; swap axes back.
  if (plan.axis === "h") {
    for (const op of ops) {
      const { sx, sy, sw, sh, dx, dy, dw, dh } = op;
      op.sx = sy; op.sy = sx; op.sw = sh; op.sh = sw;
      op.dx = dy; op.dy = dx; op.dw = dh; op.dh = dw;
    }
  }
  return ops;
}
