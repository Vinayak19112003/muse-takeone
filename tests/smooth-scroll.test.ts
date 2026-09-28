/**
 * Smooth scroll reconstruction: the visual scroll must play over the scroll
 * action's own durationMs with both screenshots translating, not as a short
 * crossfade-slide.
 *
 * Build level: durationMs and full deltas are preserved into the auto slide.
 * Instruction level: the transition spans ~durationMs of output time, mix
 * progresses 0 -> 1 without single-frame jumps, directions are correct.
 * QA level: SCROLL_VISUAL_TOO_SHORT / SCROLL_DISCONTINUITY /
 * SCROLL_LARGE_FRAME_JUMP fire on measurable problems only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../src/config.js";
import {
  buildReconstructionManifest,
  type ReconstructionInput,
} from "../src/reconstruct/build.js";
import { qaReconstruction } from "../src/reconstruct/qa.js";
import {
  buildTimeline,
  cameraBusyWindows,
  extractCursor,
  planKeyToasts,
  type KeptRange,
} from "../src/compositor/plan.js";
import { planFrameInstructions } from "../src/compositor/instructions.js";
import { makeCamAtOut, planCameraKeys } from "../src/compositor/render.js";
import type { RecordingManifest, ScenarioConfig } from "../src/types.js";

const VW = 1280, VH = 800, FPS = 60;
const cfg: ScenarioConfig = resolveConfig(RECONSTRUCTION_DEFAULTS);

function baseInput(frames: ReconstructionInput["frames"]): ReconstructionInput {
  return { version: 1, viewport: { width: VW, height: VH }, screenshotsDir: "frames", frames };
}

function buildManifest(input: ReconstructionInput): RecordingManifest {
  return buildReconstructionManifest(input, cfg);
}

function planInstructions(m: RecordingManifest) {
  const { keys } = planCameraKeys(m, cfg);
  const { ranges, outDuration } = buildTimeline(m, cfg, cameraBusyWindows(keys));
  const totalFrames = Math.max(1, Math.ceil((outDuration / 1000) * FPS));
  const camAtOut = makeCamAtOut(m, cfg, ranges, keys);
  const { samples, downs } = extractCursor(m.events);
  return planFrameInstructions({
    frames: m.frames,
    fps: FPS,
    ranges,
    totalFrames,
    camAtOut,
    samples,
    downs,
    keyToasts: planKeyToasts(m.events, cfg),
    captions: m.captions,
    content: { x: 0, y: 0, w: VW, h: VH },
    vw: VW,
    W: VW,
    H: VH,
    cfg,
    transitionMs: cfg.transition.duration,
  });
}

const scrollInput = (dx: number | undefined, dy: number | undefined, durationMs: number) =>
  baseInput([
    { file: "a.png", actions: [{ kind: "scroll", dx, dy, durationMs }] },
    { file: "b.png", holdMs: 3000 },
  ]);

describe("smooth scroll: build preserves duration and distance", () => {
  it("dy 600 / 600ms becomes a timed slide with full deltas", () => {
    const m = buildManifest(scrollInput(undefined, 600, 600));
    const ti = m.frames[1].transitionIn;
    assert.ok(ti && typeof ti === "object" && ti.kind === "slide", `got ${JSON.stringify(ti)}`);
    assert.equal(ti.dy, -600); // content moves opposite the gesture
    assert.ok(ti.dx === 0, `expected dx 0, got ${ti.dx}`);
    assert.equal(ti.durationMs, 600);
  });

  it("scroll down pushes the old screenshot up (negative slide dy)", () => {
    const m = buildManifest(scrollInput(undefined, 700, 700));
    const ti = m.frames[1].transitionIn as { dy: number };
    assert.ok(ti.dy < 0, `expected negative dy, got ${ti.dy}`);
    assert.equal(ti.dy, -700); // full distance, not the old 0.35 nudge
  });

  it("scroll up pulls the old screenshot down (positive slide dy)", () => {
    const m = buildManifest(scrollInput(undefined, -450, 500));
    const ti = m.frames[1].transitionIn as { dy: number; durationMs: number };
    assert.equal(ti.dy, 450);
    assert.equal(ti.durationMs, 500);
  });

  it("horizontal scrolls keep their sign too", () => {
    const right = buildManifest(scrollInput(300, 0, 400));
    const tiR = right.frames[1].transitionIn as { dx: number };
    assert.equal(tiR.dx, -300);
    const left = buildManifest(scrollInput(-300, 0, 400));
    const tiL = left.frames[1].transitionIn as { dx: number };
    assert.equal(tiL.dx, 300);
  });

  it("an explicit transitionIn still wins over the auto scroll", () => {
    const m = buildManifest(
      baseInput([
        { file: "a.png", actions: [{ kind: "scroll", dy: 700, durationMs: 700 }] },
        { file: "b.png", transitionIn: "cut", holdMs: 3000 },
      ]),
    );
    assert.equal(m.frames[1].transitionIn, "cut");
  });

  it("backwards compat: an explicit slide without durationMs is untouched", () => {
    const m = buildManifest(
      baseInput([
        { file: "a.png", actions: [{ kind: "scroll", dy: 700, durationMs: 700 }] },
        { file: "b.png", transitionIn: { kind: "slide", dx: 0, dy: -100 }, holdMs: 3000 },
      ]),
    );
    const ti = m.frames[1].transitionIn as { dy: number; durationMs?: number };
    assert.equal(ti.dy, -100);
    assert.equal(ti.durationMs, undefined);
  });
});

describe("smooth scroll: instructions play the scroll in real time", () => {
  it("a 600ms scroll spans ~36 frames at 60fps (not the generic transition)", () => {
    const ins = planInstructions(buildManifest(scrollInput(undefined, 600, 600)));
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    // 600ms at 60fps = 36 frames; allow off-by-one at the window edges.
    assert.ok(scrolled.length >= 34 && scrolled.length <= 38,
      `expected ~36 scroll frames, got ${scrolled.length}`);
    // The generic 140ms transition would only span ~9 frames.
    assert.ok(scrolled.length > 20, "must be far longer than the old 140ms crossfade");
  });

  it("mix progresses 0 -> 1 with no single-frame jump of the full distance", () => {
    const ins = planInstructions(buildManifest(scrollInput(undefined, 600, 600)));
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    assert.ok(scrolled.length > 1);
    assert.ok(scrolled[0].mix! < 0.1, `starts at pre-scroll state, got mix=${scrolled[0].mix}`);
    assert.ok(scrolled[scrolled.length - 1].mix! > 0.9, `ends at post-scroll state, got mix=${scrolled[scrolled.length - 1].mix}`);
    for (let i = 1; i < scrolled.length; i++) {
      const d = scrolled[i].mix! - scrolled[i - 1].mix!;
      assert.ok(d >= 0, `mix must not go backwards (frame ${i})`);
      assert.ok(d < 0.5, `no single frame may perform the whole scroll (delta ${d} at frame ${i})`);
    }
    // Intermediate frames actually change progressively.
    const mids = scrolled.filter((x) => x.mix! > 0.2 && x.mix! < 0.8);
    assert.ok(mids.length > 10, `expected many intermediate frames, got ${mids.length}`);
  });

  it("every scroll frame names both screenshots for stateless workers", () => {
    const ins = planInstructions(buildManifest(scrollInput(undefined, 600, 600)));
    for (const x of ins.filter((x) => x.isScroll)) {
      assert.equal(x.file, "b.png");
      assert.equal(x.previousFile, "a.png");
      assert.ok(x.slide, "slide vector present for the renderer");
    }
  });

  it("isScroll is only set inside the scroll transition window", () => {
    const ins = planInstructions(buildManifest(scrollInput(undefined, 600, 600)));
    for (const x of ins) {
      if (x.mix === null) assert.equal(x.isScroll, undefined, "no scroll flag outside a transition");
    }
    assert.ok(ins.some((x) => x.isScroll), "at least one scroll frame exists");
  });

  it("a legacy slide without durationMs keeps the generic transition duration", () => {
    const m = buildManifest(
      baseInput([
        { file: "a.png", actions: [{ kind: "scroll", dy: 700, durationMs: 700 }] },
        { file: "b.png", transitionIn: { kind: "slide", dx: 0, dy: -100 }, holdMs: 3000 },
      ]),
    );
    const ins = planInstructions(m);
    const blended = ins.filter((x) => x.mix !== null);
    // Generic 140ms transition at 60fps ≈ 8-9 frames — far shorter than a real scroll.
    assert.ok(blended.length >= 7 && blended.length <= 11, `got ${blended.length}`);
    assert.ok(!blended.some((x) => x.isScroll), "legacy slides are not scroll transitions");
  });

  it("planning is deterministic across runs", () => {
    const input = scrollInput(undefined, 600, 600);
    const a = planInstructions(buildManifest(input));
    const b = planInstructions(buildManifest(input));
    assert.deepEqual(a, b);
  });
});

describe("smooth scroll: QA reports measurable scroll problems", () => {
  it("a timed scroll matching its declaration raises no scroll warnings", () => {
    const input = scrollInput(undefined, 600, 600);
    const qa = qaReconstruction(input, buildManifest(input));
    assert.ok(!qa.warnings.some((w) => w.includes("SCROLL_")), JSON.stringify(qa.warnings));
  });

  it("SCROLL_VISUAL_TOO_SHORT fires when the visual is shorter than declared", () => {
    const input = baseInput([
      { file: "a.png", actions: [{ kind: "scroll", dy: 600, durationMs: 600 }] },
      // Legacy explicit slide: no durationMs, so it plays over the generic 240ms.
      { file: "b.png", transitionIn: { kind: "slide", dx: 0, dy: -600 }, holdMs: 3000 },
    ]);
    const qa = qaReconstruction(input, buildManifest(input));
    assert.ok(qa.warnings.some((w) => w.includes("SCROLL_VISUAL_TOO_SHORT")),
      JSON.stringify(qa.warnings));
  });

  it("SCROLL_LARGE_FRAME_JUMP fires when one frame would move the whole distance", () => {
    const input = baseInput([
      { file: "a.png", actions: [{ kind: "scroll", dy: 2000, durationMs: 2000 }] },
      // Absurdly short visual for a huge distance: 2000px in 100ms = 333px/frame.
      { file: "b.png", transitionIn: { kind: "slide", dx: 0, dy: -2000, durationMs: 100 }, holdMs: 3000 },
    ]);
    const qa = qaReconstruction(input, buildManifest(input));
    assert.ok(qa.warnings.some((w) => w.includes("SCROLL_LARGE_FRAME_JUMP")),
      JSON.stringify(qa.warnings));
  });

  it("SCROLL_DISCONTINUITY fires when the transition is under two frames", () => {
    const input = baseInput([
      { file: "a.png", actions: [{ kind: "scroll", dy: 600, durationMs: 600 }] },
      { file: "b.png", transitionIn: { kind: "slide", dx: 0, dy: -600, durationMs: 10 }, holdMs: 3000 },
    ]);
    const qa = qaReconstruction(input, buildManifest(input));
    assert.ok(qa.warnings.some((w) => w.includes("SCROLL_DISCONTINUITY")),
      JSON.stringify(qa.warnings));
  });
});

describe("smooth scroll: pre-cut timing model (no double-paid duration)", () => {
  // A 1300ms scroll must occupy ~1300ms of visual time, rendered in
  // [nextFrameStart - 1300, nextFrameStart], not [nextFrameStart, nextFrameStart + 1300].
  const D = 1300;
  const manifest1300 = () => buildManifest(scrollInput(undefined, 600, D));
  const nextStateTime = () => manifest1300().frames[1].t;

  it("1. a 1300ms scroll consumes ~1300ms of visual time, not ~2600ms", () => {
    const ins = planInstructions(manifest1300());
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    // 1300ms at 60fps = 78 frames; allow edge tolerance.
    assert.ok(scrolled.length >= 74 && scrolled.length <= 82,
      `expected ~78 scroll frames (1300ms), got ${scrolled.length}`);
    // The old double-paid model would span ~156 frames (2600ms).
    assert.ok(scrolled.length < 100, `must not be ~2600ms (double-paid), got ${scrolled.length} frames`);
  });

  it("2. the visual transition begins at nextStateTime - durationMs", () => {
    const tNext = nextStateTime();
    const ins = planInstructions(manifest1300());
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    assert.ok(scrolled.length > 0);
    // First scroll frame is at output time i*1000/60. Find its output time.
    const firstIdx = ins.indexOf(scrolled[0]);
    const tFirst = (firstIdx * 1000) / FPS;
    const expectedStart = tNext - D;
    // Within ~2 frames of the expected pre-cut start.
    assert.ok(Math.abs(tFirst - expectedStart) < 40,
      `expected start ~${expectedStart}ms (tNext - ${D}), got ${tFirst}ms`);
  });

  it("3. the visual transition ends at nextStateTime", () => {
    const tNext = nextStateTime();
    const ins = planInstructions(manifest1300());
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    const lastIdx = ins.indexOf(scrolled[scrolled.length - 1]);
    const tLast = (lastIdx * 1000) / FPS;
    // Last scroll frame is just before tNext (window is [tNext - D, tNext)).
    assert.ok(tLast < tNext && tNext - tLast < 40,
      `expected end ~${tNext}ms, last scroll frame at ${tLast}ms`);
  });

  it("4. at transition start: progress ~0 and pre-scroll screenshot fully visible", () => {
    const ins = planInstructions(manifest1300());
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    const first = scrolled[0];
    assert.ok(first.mix! < 0.1, `progress should start near 0, got ${first.mix}`);
    assert.equal(first.previousFile, "a.png", "pre-scroll screenshot must be the outgoing image");
    assert.equal(first.file, "b.png", "post-scroll screenshot must be the incoming image");
  });

  it("5. halfway: both screenshots aligned at ~50% scroll progress", () => {
    const ins = planInstructions(manifest1300());
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    const mid = scrolled[Math.floor(scrolled.length / 2)];
    assert.ok(mid.mix! > 0.4 && mid.mix! < 0.6, `midpoint progress ~0.5, got ${mid.mix}`);
    assert.equal(mid.file, "b.png");
    assert.equal(mid.previousFile, "a.png");
    assert.ok(mid.slide, "slide vector present for aligned rendering");
  });

  it("6. at nextStateTime: progress = 1 and post-scroll screenshot settled", () => {
    const tNext = nextStateTime();
    const ins = planInstructions(manifest1300());
    // First frame at or after tNext: the cut has landed, scroll is done.
    const idx = ins.findIndex((_, i) => (i * 1000) / FPS >= tNext);
    assert.ok(idx >= 0);
    const settled = ins[idx];
    assert.equal(settled.file, "b.png");
    assert.equal(settled.mix, null, "no transition active at the settled timestamp");
    assert.equal(settled.isScroll, undefined, "scroll flag cleared at settled timestamp");
    assert.equal(settled.previousFile, undefined);
  });

  it("7. there is NO second scroll transition after nextStateTime", () => {
    const tNext = nextStateTime();
    const ins = planInstructions(manifest1300());
    const after = ins.filter((_, i) => (i * 1000) / FPS >= tNext);
    assert.ok(after.length > 0);
    assert.ok(!after.some((x) => x.isScroll), "no scroll frames on or after the settled timestamp");
    assert.ok(!after.some((x) => x.mix !== null && x.previousFile !== undefined && x.slide !== undefined),
      "no post-cut slide transition either");
  });

  it("8. post-scroll frame actions do not occur before the scroll completes", () => {
    const tNext = nextStateTime();
    const m = buildManifest(baseInput([
      { file: "a.png", actions: [{ kind: "scroll", dy: 600, durationMs: D }] },
      {
        file: "b.png",
        actions: [{ kind: "click", x: 100, y: 100 }],
        holdMs: 3000,
      },
    ]));
    // The scroll event itself is the only non-cursor action event in the pre-cut window.
    // Frame B's click must be synthesized at or after the settled timestamp.
    const preSettled = m.events.filter((e) => e.t < tNext && e.t >= tNext - D);
    for (const e of preSettled) {
      if (e.type === "scroll") continue;
      if (e.type === "mouse") continue; // cursor samples are fine
      assert.fail(`non-scroll action event before settled time: ${JSON.stringify(e)}`);
    }
    // Frame B starts at tNext; its actions begin after CUT_BREATHE, i.e. after tNext.
    const frameBStart = m.frames[1].t;
    assert.equal(frameBStart, tNext);
  });

  it("9. narration/state timing semantics are unchanged", () => {
    const m = buildManifest(baseInput([
      { file: "a.png", actions: [{ kind: "scroll", dy: 600, durationMs: D }], caption: "before scroll" },
      { file: "b.png", holdMs: 3000, caption: "after scroll" },
    ]));
    const tNext = m.frames[1].t;
    // Captions are anchored to frame start times, not shifted by the pre-cut visual.
    assert.equal(m.captions[0].start, m.frames[0].t);
    assert.equal(m.captions[1].start, tNext, "post-scroll caption still anchored at the settled timestamp");
    const ins = planInstructions(m);
    // The caption shown during the pre-cut scroll window still belongs to frame A.
    const scrolled = ins.filter((x) => x.isScroll && x.mix !== null);
    const firstScrollIdx = ins.indexOf(scrolled[0]);
    assert.equal(ins[firstScrollIdx].caption, "before scroll");
    // At the settled timestamp, the caption flips to frame B.
    const settledIdx = ins.findIndex((_, i) => (i * 1000) / FPS >= tNext);
    assert.equal(ins[settledIdx].caption, "after scroll");
  });

  it("10. determinism and parallel-worker statelessness hold", () => {
    const input = scrollInput(undefined, 600, D);
    const a = planInstructions(buildManifest(input));
    const b = planInstructions(buildManifest(input));
    assert.deepEqual(a, b, "planning must be deterministic across runs");
    for (const x of a.filter((x) => x.isScroll)) {
      // Every scroll frame names both images: a worker starting mid-scroll
      // can load both without relying on compositor page state.
      assert.ok(x.file, "file present");
      assert.ok(x.previousFile, "previousFile present for stateless workers");
      assert.ok(typeof x.mix === "number", "mix present");
      assert.ok(x.slide, "slide vector present");
    }
  });
});
