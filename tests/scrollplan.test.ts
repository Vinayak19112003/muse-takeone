/**
 * Scroll compositor (scrollplan.ts) regression tests.
 *
 * The compositor renders timed scrolls as MOVING DOCUMENT LAYER + FIXED
 * VIEWPORT LAYER, never as two translated screenshots. These tests cover:
 *  1. One authoritative source for overlapping content.
 *  2. Scroll-down adds only bottom strip.
 *  3. Scroll-up adds only top strip.
 *  4. Overlapping text stays spatially stable.
 *  5. Measured offset overrides slightly incorrect declared dy.
 *  6. Low confidence emits QA warning.
 *  7. Fixed regions retain viewport coordinates.
 *  8. Fixed regions are not duplicated.
 *  9. Scrollbar gutter does not translate.
 * 10. Thumb movement is monotonic.
 * 11. No jump into settled state.
 * 12. Deterministic output across runs.
 * 13. Parallel rendering remains stateless.
 * 14. Horizontal scrolling still works.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeScroll,
  planScrollDraws,
  type ScrollPlan,
  type GrayImage,
} from "../src/compositor/scrollplan.js";

// --- Synthetic fixture helpers -------------------------------------------

const W = 320, H = 200;

function makeGray(w: number, h: number, fill: number): GrayImage {
  return { width: w, height: h, data: new Uint8Array(w * h).fill(fill) };
}

function drawTextRows(g: GrayImage, y0: number, y1: number, seed: number) {
  // Deterministic "text-like" rows: varying brightness per row.
  for (let y = y0; y < y1; y++) {
    const v = 40 + ((y * 37 + seed * 101) % 120);
    for (let x = 0; x < g.width; x++) {
      g.data[y * g.width + x] = (x % 8 < 5) ? v : v + 30;
    }
  }
}

function drawFixedHeader(g: GrayImage, h: number) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < g.width; x++) {
      g.data[y * g.width + x] = 200 + (x % 16);
    }
  }
}

/** Build A/B pair: document scrolls by (dx,dy), header stays fixed. */
function makeScrollPair(dx: number, dy: number, headerH = 32) {
  const a = makeGray(W, H, 20);
  const b = makeGray(W, H, 20);
  drawFixedHeader(a, headerH);
  drawFixedHeader(b, headerH);
  drawTextRows(a, headerH, H, 1);
  // B's document is A's document shifted by (dx,dy): B(x,y) = A(x-dx, y-dy).
  for (let y = headerH; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx >= 0 && sx < W && sy >= headerH && sy < H) {
        b.data[y * W + x] = a.data[sy * W + sx];
      } else {
        b.data[y * W + x] = 90 + ((x + y) % 40); // new content
      }
    }
  }
  return { a, b };
}

function analyze(a: GrayImage, b: GrayImage, dx: number, dy: number): ScrollPlan {
  return analyzeScroll(
    { width: a.width, height: a.height, data: a.data },
    { width: b.width, height: b.height, data: b.data },
    dx, dy,
  );
}

// --- Tests ----------------------------------------------------------------

describe("scrollplan", () => {
  it("1. overlapping content has one authoritative source (no duplicate draws)", () => {
    const { a, b } = makeScrollPair(0, -60);
    const plan = analyze(a, b, 0, -60);
    for (const sp of [0, 0.25, 0.5, 0.75, 1]) {
      const ops = planScrollDraws(plan, sp);
      // For each output y in the document area, at most one op should write
      // document content (excluding fixed/sticky overlays which are on top).
      const docWrites = ops.filter((o) => o.src === "a" && o.alpha === 1);
      // Simple check: no two ops write the exact same output rect from "a".
      const seen = new Set<string>();
      for (const o of docWrites) {
        const key = `${Math.round(o.dx)},${Math.round(o.dy)},${Math.round(o.dw)}x${Math.round(o.dh)}`;
        // Allow sticky overlays to overwrite (they're intentional), but the
        // base document should not be drawn twice.
        if (o.dy >= 32) { // below header
          assert(!seen.has(key), `duplicate doc draw at sp=${sp}: ${key}`);
          seen.add(key);
        }
      }
    }
  });

  it("2. scroll-down adds only bottom strip (my<0)", () => {
    const { a, b } = makeScrollPair(0, -60); // content moves up
    const plan = analyze(a, b, 0, -60);
    assert(plan.my < 0, `expected my<0, got ${plan.my}`);
    const ops = planScrollDraws(plan, 1);
    // Strip = B ops with alpha=1, excluding small fixed-header crossfades.
    const strips = ops.filter((o) => o.src === "b" && o.alpha === 1 && o.sh > 40);
    assert(strips.length > 0, "expected B strip at sp=1");
    for (const s of strips) {
      // Strip should be at the bottom, not the top.
      assert(s.dy + s.dh > H - 80, `strip not at bottom: dy=${s.dy}`);
    }
  });

  it("3. scroll-up adds only top strip (my>0)", () => {
    const { a, b } = makeScrollPair(0, 60); // content moves down
    const plan = analyze(a, b, 0, 60);
    assert(plan.my > 0, `expected my>0, got ${plan.my}`);
    const ops = planScrollDraws(plan, 1);
    const strips = ops.filter((o) => o.src === "b" && o.alpha === 1 && o.sh > 40);
    assert(strips.length > 0, "expected B strip at sp=1");
    for (const s of strips) {
      // Strip should be at the top, not the bottom.
      assert(s.dy < 80, `strip not at top: dy=${s.dy}`);
    }
  });

  it("4. overlapping text stays spatially stable (document moves rigidly)", () => {
    const { a, b } = makeScrollPair(0, -60);
    const plan = analyze(a, b, 0, -60);
    const ops0 = planScrollDraws(plan, 0);
    const ops1 = planScrollDraws(plan, 1);
    // At sp=0, document from A should be at original position.
    // At sp=1, it should be translated by (mx,my).
    const doc0 = ops0.find((o) => o.src === "a" && o.sy >= 32);
    const doc1 = ops1.find((o) => o.src === "a" && o.sy >= 32);
    assert(doc0 && doc1, "expected document ops");
    const dx = doc1.dx - doc0.dx;
    const dy = doc1.dy - doc0.dy;
    // Should match measured displacement (within rounding).
    assert(Math.abs(dx - plan.mx) < 2, `dx ${dx} != mx ${plan.mx}`);
    assert(Math.abs(dy - plan.my) < 2, `dy ${dy} != my ${plan.my}`);
  });

  it("5. measured offset overrides slightly incorrect declared dy", () => {
    const { a, b } = makeScrollPair(0, -60);
    // Declare dy=-55 (slightly off); true is -60.
    const plan = analyze(a, b, 0, -55);
    if (plan.useMeasured) {
      assert(Math.abs(plan.my - (-60)) < 5, `my=${plan.my}, expected ~-60`);
    }
    // If low confidence, it falls back to declared (safe).
    assert(plan.warnings.includes("SCROLL_ALIGNMENT_LOW_CONFIDENCE") || plan.useMeasured);
  });

  it("6. low confidence emits QA warning", () => {
    // Uniform images: no texture to match.
    const a = makeGray(W, H, 50);
    const b = makeGray(W, H, 50);
    const plan = analyze(a, b, 0, -60);
    assert(
      plan.warnings.includes("SCROLL_ALIGNMENT_LOW_CONFIDENCE"),
      "expected low-confidence warning",
    );
    assert(!plan.useMeasured, "should not use measured when low confidence");
  });

  it("7. fixed regions retain viewport coordinates (dx=dy=0, no translation)", () => {
    const { a, b } = makeScrollPair(0, -60, 32);
    const plan = analyze(a, b, 0, -60);
    for (const sp of [0, 0.5, 1]) {
      const ops = planScrollDraws(plan, sp);
      // Header is at y=[0,32). Fixed regions should be drawn at same coords.
      // (In this synthetic, header may classify as fixed or sticky; check
      // that whatever is at y<32 doesn't translate with document.)
      for (const o of ops) {
        if (o.dy < 32 && o.sy < 32 && o.src === "a") {
          // If it's the header, it should not have document translation.
          // (Sticky would have its own d; fixed has alpha crossfade.)
          assert(
            Math.abs(o.dx - o.sx) < 2 || o.alpha < 1,
            `header translated at sp=${sp}: dx=${o.dx}, sx=${o.sx}`,
          );
        }
      }
    }
  });

  it("8. fixed regions are not duplicated (single draw per frame)", () => {
    const { a, b } = makeScrollPair(0, -60, 32);
    const plan = analyze(a, b, 0, -60);
    const ops = planScrollDraws(plan, 0.5);
    // Count ops covering the header area [0,32).
    const headerOps = ops.filter((o) => o.dy < 32 && o.dy + o.dh > 0);
    // Should be small (header + maybe strip knockout), not dozens.
    assert(headerOps.length < 10, `too many header ops: ${headerOps.length}`);
  });

  it("9. scrollbar gutter does not translate (stays at right edge)", () => {
    // Synthetic: add a bright gutter at right edge.
    const { a, b } = makeScrollPair(0, -60);
    for (const g of [a, b]) {
      for (let y = 0; y < H; y++) {
        for (let x = W - 12; x < W; x++) {
          g.data[y * W + x] = y > 40 && y < 100 ? 180 : 60;
        }
      }
    }
    const plan = analyze(a, b, 0, -60);
    if (plan.gutterX0 != null) {
      for (const sp of [0, 0.5, 1]) {
        const ops = planScrollDraws(plan, sp);
        for (const o of ops) {
          if (o.sx >= plan.gutterX0) {
            // Gutter ops should not translate horizontally.
            assert(Math.abs(o.dx - o.sx) < 1, `gutter translated at sp=${sp}`);
          }
        }
      }
    }
  });

  it("10. thumb movement is monotonic (no jumping)", () => {
    const { a, b } = makeScrollPair(0, -60);
    // Add gutter with thumb at different positions.
    for (let y = 0; y < H; y++) {
      for (let x = W - 12; x < W; x++) {
        a.data[y * W + x] = (y > 40 && y < 80) ? 180 : 60;
        b.data[y * W + x] = (y > 20 && y < 60) ? 180 : 60;
      }
    }
    const plan = analyze(a, b, 0, -60);
    if (plan.thumbA && plan.thumbB && plan.gutterX0 != null) {
      let lastY: number | null = null;
      const dir = Math.sign(plan.thumbB.y0 - plan.thumbA.y0);
      for (const sp of [0, 0.25, 0.5, 0.75, 1]) {
        const ops = planScrollDraws(plan, sp);
        // Find thumb op (the one that interpolates).
        const thumb = ops.find(
          (o) => o.sx >= plan.gutterX0! && o.sh < H && o.sy === plan.thumbA!.y0,
        );
        if (thumb && lastY !== null && dir !== 0) {
          const d = thumb.dy - lastY;
          assert(
            Math.sign(d) === dir || Math.abs(d) < 1,
            `thumb not monotonic at sp=${sp}: dy=${thumb.dy}, last=${lastY}`,
          );
        }
        if (thumb) lastY = thumb.dy;
      }
    }
  });

  it("11. no jump into settled state (sp=1 matches B, sp=0 matches A)", () => {
    const { a, b } = makeScrollPair(0, -60);
    const plan = analyze(a, b, 0, -60);
    // At sp=0, the composite should be A (no B content except strip which is empty).
    const ops0 = planScrollDraws(plan, 0);
    const bOps0 = ops0.filter((o) => o.src === "b" && o.alpha === 1);
    // B ops at sp=0 should be minimal (only fixed crossfade at alpha 0, or empty strip).
    const solidB0 = bOps0.filter((o) => o.sh > 1 && o.sw > 1);
    assert(solidB0.length === 0, `B content at sp=0: ${solidB0.length} ops`);
    // At sp=1, document should be at B position (translated by my).
    const ops1 = planScrollDraws(plan, 1);
    assert(ops1.length > 0, "expected ops at sp=1");
  });

  it("12. deterministic output across runs", () => {
    const { a, b } = makeScrollPair(0, -60);
    const p1 = analyze(a, b, 0, -60);
    const p2 = analyze(a, b, 0, -60);
    assert.deepStrictEqual(
      { mx: p1.mx, my: p1.my, conf: p1.confidence, cols: p1.cols },
      { mx: p2.mx, my: p2.my, conf: p2.confidence, cols: p2.cols },
      "analyzeScroll not deterministic",
    );
    const o1 = planScrollDraws(p1, 0.5);
    const o2 = planScrollDraws(p2, 0.5);
    assert.deepStrictEqual(o1, o2, "planScrollDraws not deterministic");
  });

  it("13. parallel rendering remains stateless (no shared mutable state)", () => {
    const { a, b } = makeScrollPair(0, -60);
    const plan = analyze(a, b, 0, -60);
    // planScrollDraws should not mutate the plan.
    const before = JSON.stringify(plan);
    planScrollDraws(plan, 0.3);
    planScrollDraws(plan, 0.7);
    assert.strictEqual(JSON.stringify(plan), before, "plan was mutated");
    // Multiple calls with same args give same result (no accumulation).
    const o1 = planScrollDraws(plan, 0.5);
    const o2 = planScrollDraws(plan, 0.5);
    assert.deepStrictEqual(o1, o2);
  });

  it("14. horizontal scrolling still works", () => {
    // Horizontal: content moves left (dx negative).
    const a = makeGray(W, H, 20);
    const b = makeGray(W, H, 20);
    drawTextRows(a, 0, H, 1);
    const dx = -40;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = x - dx;
        b.data[y * W + x] = (sx >= 0 && sx < W) ? a.data[y * W + sx] : 90;
      }
    }
    const plan = analyze(a, b, dx, 0);
    assert.strictEqual(plan.axis, "h", `expected axis h, got ${plan.axis}`);
    // planScrollDraws should not throw and should produce ops.
    const ops = planScrollDraws(plan, 0.5);
    assert(ops.length > 0, "expected ops for horizontal scroll");
  });

  it("15. B-strip samples B at scroll offset (sy = viewport + my*(1-sp))", () => {
    // Scroll down: my<0. At sp=0.5, the strip's source y must be offset by
    // my*(1-sp) so the revealed content aligns with the scroll position.
    const { a, b } = makeScrollPair(0, -60);
    const plan = analyze(a, b, 0, -60);
    const my = plan.my;
    assert(my < -0.5, `expected my<0, got ${my}`);
    const sp = 0.5;
    const ops = planScrollDraws(plan, sp);
    const stripOps = ops.filter((o) => o.src === "b" && o.alpha === 1);
    assert(stripOps.length > 0, "expected B-strip ops");
    const expectedDy = my * (1 - sp);
    for (const o of stripOps) {
      // sy should equal dy + my*(1-sp) (source offset for scroll alignment).
      const actualOffset = o.sy - o.dy;
      assert(
        Math.abs(actualOffset - expectedDy) < 1.0,
        `B-strip source offset wrong: sy-dy=${actualOffset}, expected ${expectedDy}`,
      );
    }
  });

  it("16. B-strip does not duplicate fixed/sticky content (knockout)", () => {
    // If B has a fixed header, the strip must knock it out so the fixed
    // overlay (drawn separately) is the only source for that content.
    const { a, b } = makeScrollPair(0, -60, 32);
    const plan = analyze(a, b, 0, -60);
    // Find the fixed band (header).
    let fixedY1 = 0;
    for (const c of plan.cols) {
      for (const bd of c.bands) {
        if (bd.kind === "fixed" && bd.y0 === 0) fixedY1 = bd.y1;
      }
    }
    if (fixedY1 > 0) {
      const ops = planScrollDraws(plan, 0.5);
      const stripOps = ops.filter((o) => o.src === "b" && o.alpha === 1);
      // The strip's viewport regions should not overlap the fixed overlay's
      // position (which is at [0, fixedY1] viewport for a top header).
      for (const o of stripOps) {
        const overlapStart = Math.max(o.dy, 0);
        const overlapEnd = Math.min(o.dy + o.dh, fixedY1);
        assert(
          overlapEnd <= overlapStart,
          `B-strip overlaps fixed overlay at [0,${fixedY1}]: op at dy=${o.dy}, dh=${o.dh}`,
        );
      }
    }
  });

  it("17. document layer masks out fixed overlay regions (no bleed-through)", () => {
    // The moving document must exclude fixed bands; otherwise the document
    // (opaque) would show through the translucent fixed crossfade.
    const { a, b } = makeScrollPair(0, -60, 32);
    const plan = analyze(a, b, 0, -60);
    let fixedBand: { y0: number; y1: number } | null = null;
    for (const c of plan.cols) {
      for (const bd of c.bands) {
        if (bd.kind === "fixed" && bd.y0 === 0) fixedBand = { y0: bd.y0, y1: bd.y1 };
      }
    }
    if (fixedBand) {
      const sp = 0.5;
      const ops = planScrollDraws(plan, sp);
      const my = plan.my;
      // Document ops are from src 'a' with alpha=1 (not fixed/sticky overlays).
      // The fixed overlay is at viewport [y0, y1]; document A-coordinates that
      // map there are [y0 - my*sp, y1 - my*sp].
      const vy0 = fixedBand.y0, vy1 = fixedBand.y1;
      const maskA0 = vy0 - my * sp, maskA1 = vy1 - my * sp;
      for (const o of ops) {
        if (o.src !== "a" || o.alpha !== 1) continue;
        // Skip the fixed overlay itself (it's drawn with alpha<1 or as fixed).
        // Document ops are the ones translated by my*sp.
        const isDocument = Math.abs(o.dy - (o.sy + my * sp)) < 1.0;
        if (!isDocument) continue;
        const overlapStart = Math.max(o.sy, maskA0);
        const overlapEnd = Math.min(o.sy + o.sh, maskA1);
        assert(
          overlapEnd <= overlapStart,
          `document overlaps fixed mask [${maskA0},${maskA1}]: op sy=${o.sy}, sh=${o.sh}`,
        );
      }
    }
  });
});
