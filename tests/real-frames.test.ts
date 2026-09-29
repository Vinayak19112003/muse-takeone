/**
 * Managed real-frame capture tests (primary visual path).
 *
 * A. Dense real scroll frames
 * B. Click pre/post states
 * C. Per-character typing frames
 * D. Hover state
 * E. Navigation state
 * F. Mixed real-frame + fallback trace
 * G. Existing reconstruction traces unchanged
 * I. Deterministic output planning
 * J. Easing target generation
 *
 * Plus the hard invariants:
 * - dense real scroll never invokes scrollplan (and the sparse fallback still does)
 * - real-frame intervals never use slides/crossfades
 * - every page pixel in a dense interval is a real captured screenshot
 * - harmless duplicate captures are warnings, not fatal
 * - explicit capture.t timestamps drive dense-run playback timing
 * - K. on the primary (native) path, two real states with no captured
 *   intermediates default to CUT — never an implicit crossfade
 * (H. audio is covered by the untouched tests/audio.test.ts suite.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTrace } from "../src/adapters/index.js";
import { statesToFrames, traceToReconstructionInput } from "../src/adapters/normalize.js";
import { buildReconstructionManifest } from "../src/reconstruct/build.js";
import {
  denseRunFrameTimes,
  detectDenseRuns,
  qaRealFrameCapture,
  validateRealFrameSequence,
  visualSourceForFrames,
} from "../src/reconstruct/realframes.js";
import { planScrollCaptures } from "../src/reconstruct/scroll-capture-plan.js";
import { planFrameInstructions } from "../src/compositor/instructions.js";
import { collectScrollTransitions } from "../src/compositor/render.js";
import { resolveConfig, RECONSTRUCTION_DEFAULTS } from "../src/config.js";
import type { RecordingManifest } from "../src/types.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/managed-real-frames");
const loadTrace = (agent = "muse") => {
  const t = JSON.parse(readFileSync(join(fixtureDir, "trace.json"), "utf8"));
  t.source.agent = agent;
  return t;
};

function build(agent = "muse") {
  const { trace } = normalizeTrace(loadTrace(agent), { adapter: "generic" });
  const input = traceToReconstructionInput(trace);
  const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS);
  const manifest = buildReconstructionManifest(input, cfg);
  return { input, manifest, cfg };
}

/** Minimal-but-real instruction planning input, mirroring render()'s call. */
function instructionsFor(manifest: RecordingManifest) {
  const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS);
  const fps = 60;
  return planFrameInstructions({
    frames: manifest.frames,
    fps,
    ranges: [{ srcStart: 0, srcEnd: manifest.duration, outStart: 0, rate: 1 }],
    totalFrames: Math.ceil((manifest.duration / 1000) * fps),
    camAtOut: () => ({ cx: 959.5, cy: 496, scale: 1, follow: false }),
    samples: [],
    downs: [],
    keyToasts: [],
    captions: manifest.captions,
    content: { x: 0, y: 0, w: 1920, h: 1080 },
    vw: 1919,
    W: 1920,
    H: 1080,
    cfg,
    transitionMs: 300,
  });
}

const withoutCreatedAt = (m: RecordingManifest) => {
  const { createdAt: _c, ...rest } = m;
  return rest;
};

describe("managed real-frame capture", () => {
  it("A. dense scroll run emits one manifest frame per capture, cuts only, no slides", () => {
    const { input, manifest } = build();
    const runs = detectDenseRuns(input.frames);
    assert.equal(runs.length, 2);
    const scrollRun = runs[1];
    assert.deepEqual(
      input.frames.slice(scrollRun.start, scrollRun.end + 1).map((f) => f.file),
      ["s_scroll00.png", "s_scroll07.png", "s_scroll14.png", "s_scroll21.png", "s_scroll29.png"],
    );
    // The run occupies 5 consecutive manifest frames starting at the run's
    // input index (runs emit 1:1; earlier frames are 1:1 too here).
    const mFrames = manifest.frames.slice(scrollRun.start, scrollRun.end + 1);
    assert.deepEqual(
      mFrames.map((f) => f.file),
      ["s_scroll00.png", "s_scroll07.png", "s_scroll14.png", "s_scroll21.png", "s_scroll29.png"],
    );
    for (const f of mFrames) {
      const ti = f.transitionIn;
      assert.ok(ti === undefined || ti === "cut", `dense frame ${f.file} must never slide, got ${JSON.stringify(ti)}`);
    }
    // No crossfades/slides anywhere in either dense run.
    for (const r of runs) {
      for (let i = r.start; i <= r.end; i++) {
        const ti = manifest.frames[i].transitionIn;
        assert.ok(
          ti === undefined || ti === "cut" || (typeof ti === "object" && ti.kind !== "slide"),
          `run frame ${manifest.frames[i].file}: no slide allowed`,
        );
      }
    }
  });

  it("scrollplan is NOT invoked for the dense scroll interval (but still is for the sparse fallback)", () => {
    const { manifest } = build();
    const denseScrolls = collectScrollTransitions(instructionsFor(manifest));
    assert.equal(denseScrolls.size, 0, "dense real-frame scroll must not reach scrollplan");

    // Control: a sparse scroll trace still goes through scrollplan.
    const sparse = {
      version: 1,
      source: { type: "agent-browser", agent: "muse" },
      viewport: { width: 1280, height: 800 },
      screenshotsDir: ".",
      states: [
        { id: "a", screenshot: "s_focus.png" },
        { id: "b", screenshot: "s_graceland_top.png" },
      ],
      actions: [{ kind: "scroll", from: "a", to: "b", dx: 0, dy: 800, durationMs: 600, x: 640, y: 400 }],
    };
    const { trace } = normalizeTrace(sparse, { adapter: "generic" });
    const sparseManifest = buildReconstructionManifest(
      traceToReconstructionInput(trace),
      resolveConfig(RECONSTRUCTION_DEFAULTS),
    );
    const sparseScrolls = collectScrollTransitions(instructionsFor(sparseManifest));
    assert.ok(sparseScrolls.size >= 1, "sparse fallback scroll must still use scrollplan");
  });

  it("every page pixel in a dense interval is a real captured screenshot (0 synthetic)", () => {
    const { input, manifest } = build();
    for (const r of detectDenseRuns(input.frames)) {
      const captured = input.frames.slice(r.start, r.end + 1).map((f) => f.file);
      const rendered = manifest.frames.slice(r.start, r.end + 1).map((f) => f.file);
      assert.deepEqual(rendered, captured, "dense interval renders exactly the captured screenshots");
    }
  });

  it("B. click pre/post states produce mousedown/mouseup at the click point", () => {
    const { manifest } = build();
    const downs = manifest.events.filter((e) => e.type === "mousedown");
    const ups = manifest.events.filter((e) => e.type === "mouseup");
    assert.equal(downs.length, 2);
    assert.equal(ups.length, 2);
    // Suggestion click at the highlighted row.
    assert.deepEqual([downs[0].x, downs[0].y], [960, 320]);
    assert.ok(ups[0].t > downs[0].t);
  });

  it("C. per-character typing emits one key event per character", () => {
    const { manifest } = build();
    const keys = manifest.events.filter((e) => e.type === "key");
    assert.equal(keys.length, 9);
    assert.deepEqual(
      keys.map((k) => k.key),
      [..."Graceland"],
    );
    for (let i = 1; i < keys.length; i++) assert.ok(keys[i].t >= keys[i - 1].t);
    assert.ok(keys.every((k) => k.show === true));
  });

  it("D. hover states emit hover events at the hover point", () => {
    const { manifest } = build();
    const hovers = manifest.events.filter((e) => e.type === "hover");
    assert.equal(hovers.length, 3);
    // Suggestion hover, then the Memphis-link hover pair.
    assert.deepEqual([hovers[0].x, hovers[0].y], [960, 320]);
    assert.deepEqual([hovers[1].x, hovers[1].y], [700, 400]);
  });

  it("E. navigation states render as cuts with no slide", () => {
    const { manifest } = build();
    const idx = manifest.frames.findIndex((f) => f.file === "s_memphis_top.png");
    assert.ok(idx > 0);
    const ti = manifest.frames[idx].transitionIn;
    assert.ok(ti === undefined || ti === "cut");
  });

  it("F. mixed trace: visualSource is mixed, sparse intervals keep fallback timing", () => {
    const { input, manifest } = build();
    assert.equal(visualSourceForFrames(input.frames), "mixed");
    assert.equal(manifest.visualSource, "mixed");
    // Sparse intervals still behave: graceland holds 500ms before the scroll run.
    const g = manifest.frames.find((f) => f.file === "s_graceland_top.png")!;
    const s0 = manifest.frames.find((f) => f.file === "s_scroll00.png")!;
    assert.ok(s0.t - g.t >= 500);
  });

  it("G. traces without dense frames keep the reconstructed-sparse path", () => {
    const sparse = {
      version: 1,
      source: { type: "agent-browser", agent: "muse" },
      viewport: { width: 1280, height: 800 },
      screenshotsDir: ".",
      states: [
        { id: "a", screenshot: "s_focus.png" },
        { id: "b", screenshot: "s_graceland_top.png" },
      ],
      actions: [{ kind: "click", from: "a", to: "b", x: 640, y: 400 }],
    };
    const { trace } = normalizeTrace(sparse, { adapter: "generic" });
    const input = traceToReconstructionInput(trace);
    const manifest = buildReconstructionManifest(input, resolveConfig(RECONSTRUCTION_DEFAULTS));
    assert.equal(visualSourceForFrames(input.frames), "reconstructed-sparse");
    assert.equal(manifest.visualSource, "reconstructed-sparse");
    assert.equal(manifest.mode, "reconstructed");
  });

  it("I. manifest planning is deterministic", () => {
    const a = withoutCreatedAt(build().manifest);
    const b = withoutCreatedAt(build().manifest);
    assert.deepEqual(b, a);
  });

  it("J. scroll capture planner: 36 eased targets for 600ms@60fps, exact endpoints, monotonic", () => {
    const plan = planScrollCaptures({ from: 0, to: 3000, durationMs: 600, fps: 60 });
    const targets = plan.targets;
    assert.equal(targets.length, 36);
    assert.equal(targets[0].scrollPos, 0);
    assert.equal(targets[targets.length - 1].scrollPos, 3000);
    for (let i = 1; i < targets.length; i++) {
      assert.ok(targets[i].scrollPos >= targets[i - 1].scrollPos, "targets must be monotonic");
      assert.ok(targets[i].tMs >= targets[i - 1].tMs, "timestamps must be non-decreasing");
    }
    // Cubic-bezier(0.4, 0, 0.2, 1) is ease-out-ish: the midpoint target is
    // well past the linear halfway mark, and deltas shrink toward the end.
    const mid = targets[Math.floor(targets.length / 2)].scrollPos;
    assert.ok(mid > 1500 && mid < 3000, `eased midpoint ${mid} should lead linear`);
    assert.ok(targets[1].delta >= targets[targets.length - 1].delta);
  });

  it("adapter contract: capture metadata survives normalization; enclosing scroll canonicalized onto run[0]", () => {
    const { trace } = normalizeTrace(loadTrace(), { adapter: "generic" });
    const frames = statesToFrames(trace);
    assert.equal(frames[1].capture?.dense, true);
    assert.equal(frames[1].capture?.order, 1);
    // The scroll action authored as graceland -> scroll-4 now lives on scroll-0.
    assert.equal(frames[5].actions, undefined);
    assert.equal(frames[6].actions?.[0].kind, "scroll");
    // Sparse click/hover actions keep their frames.
    assert.equal(frames[4].actions?.[0].kind, "click");
  });

  it("agent neutrality: muse vs grokbot manifests are identical except source/createdAt", () => {
    const manifests = ["muse", "grokbot"].map((agent) => {
      const { trace } = normalizeTrace(loadTrace(agent), { adapter: "generic" });
      const m = buildReconstructionManifest(
        traceToReconstructionInput(trace),
        resolveConfig(RECONSTRUCTION_DEFAULTS),
      );
      const { source: _s, createdAt: _c, ...rest } = m;
      return rest;
    });
    assert.deepEqual(manifests[1], manifests[0]);
  });

  it("real-frame validation: harmless duplicate captures are warnings, not fatal", async () => {
    const { input } = build();
    const run = detectDenseRuns(input.frames)[1];
    const seq = input.frames.slice(run.start, run.end + 1);
    // Duplicate one capture file consecutively with its own chronological
    // order: the browser legitimately captures identical frames when the
    // page does not move.
    const duped = [...seq.slice(0, 2), seq[1], ...seq.slice(2)].map((f, i) => ({
      ...f,
      capture: { ...f.capture, order: i + 1 },
    }));
    const vr = await validateRealFrameSequence(duped, fixtureDir, { viewportHeight: 992 });
    assert.equal(vr.errors.length, 0);
    assert.ok(vr.warnings.some((w) => w.code === "DUPLICATE_FRAME"));
  });

  it("real-frame validation: missing capture file is fatal", async () => {
    const { input } = build();
    const run = detectDenseRuns(input.frames)[1];
    const seq = input.frames.slice(run.start, run.end + 1).map((f, i) =>
      i === 2 ? { ...f, file: "does-not-exist.png" } : f,
    );
    const vr = await validateRealFrameSequence(seq, fixtureDir, { viewportHeight: 992 });
    assert.ok(vr.errors.some((e) => e.code === "MISSING_CAPTURE"));
    assert.equal(vr.ok, false);
  });

  it("real-frame QA: monotonic scroll metadata passes; regressions warn", () => {
    const { input, manifest } = build();
    const clean = qaRealFrameCapture(input.frames, manifest);
    assert.ok(!clean.some((w) => w.code === "NON_MONOTONIC_SCROLL"));

    const regressed = input.frames.map((f, i) =>
      i === 8 ? { ...f, capture: { ...f.capture, scrollY: 100 } } : f,
    );
    const warned = qaRealFrameCapture(regressed, manifest);
    assert.ok(warned.some((w) => w.code === "NON_MONOTONIC_SCROLL"));
  });

  it("dense scroll run duration follows the enclosing action's durationMs", () => {
    const { manifest } = build();
    const s0 = manifest.frames.find((f) => f.file === "s_scroll00.png")!;
    const s4 = manifest.frames.find((f) => f.file === "s_scroll29.png")!;
    assert.ok(s4.t - s0.t >= 600, `scroll run should last >= 600ms, got ${s4.t - s0.t}`);
  });

  it("H1. explicit capture.t timestamps drive dense-run playback spacing", () => {
    const { trace } = normalizeTrace(loadTrace(), { adapter: "generic" });
    const input = traceToReconstructionInput(trace);
    const run = detectDenseRuns(input.frames)[1]; // the scroll run
    const stamped = input.frames.map((f, i) => {
      if (i < run.start || i > run.end || !f.capture) return f;
      // True capture spacing: bunched early, sparse late — nothing uniform.
      const t = [0, 60, 90, 400, 600][i - run.start];
      return { ...f, capture: { ...f.capture, t } };
    });
    const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS);
    const manifest = buildReconstructionManifest({ ...input, frames: stamped }, cfg);
    const s0 = manifest.frames.find((f) => f.file === "s_scroll00.png")!;
    const s4 = manifest.frames.find((f) => f.file === "s_scroll29.png")!;
    const times = ["s_scroll00.png", "s_scroll07.png", "s_scroll14.png", "s_scroll21.png", "s_scroll29.png"]
      .map((file) => manifest.frames.find((f) => f.file === file)!.t - s0.t);
    assert.deepEqual(times, [0, 60, 90, 400, 600]);
    assert.equal(s4.t - s0.t, 600); // run spans t[last] - t[0], not the 600ms action uniformly
    // No QA complaint about well-formed stamps.
    const warned = qaRealFrameCapture(stamped, manifest);
    assert.ok(!warned.some((w) => w.code === "PARTIAL_CAPTURE_T" || w.code === "NON_MONOTONIC_CAPTURE_T"));
  });

  it("H2. partial capture.t falls back to uniform timing and warns", () => {
    const { trace } = normalizeTrace(loadTrace(), { adapter: "generic" });
    const input = traceToReconstructionInput(trace);
    const run = detectDenseRuns(input.frames)[1];
    const partial = input.frames.map((f, i) =>
      i >= run.start && i <= run.end && f.capture
        ? { ...f, capture: { ...f.capture, t: (i - run.start) * 100 } }
        : f,
    );
    // Drop the stamp on one middle frame.
    const mid = run.start + 2;
    partial[mid] = { ...partial[mid], capture: { ...partial[mid].capture!, t: undefined } };
    const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS);
    const manifest = buildReconstructionManifest({ ...input, frames: partial }, cfg);
    const s0 = manifest.frames.find((f) => f.file === "s_scroll00.png")!;
    const s1 = manifest.frames.find((f) => f.file === "s_scroll07.png")!;
    const s4 = manifest.frames.find((f) => f.file === "s_scroll29.png")!;
    // Uniform fallback: 600ms spread over 4 steps.
    assert.equal(s1.t - s0.t, 150);
    assert.equal(s4.t - s0.t, 600);
    const warned = qaRealFrameCapture(partial, manifest);
    assert.ok(warned.some((w) => w.code === "PARTIAL_CAPTURE_T"));
  });

  it("H3. regressed capture.t falls back to uniform timing and warns", () => {
    const { trace } = normalizeTrace(loadTrace(), { adapter: "generic" });
    const input = traceToReconstructionInput(trace);
    const run = detectDenseRuns(input.frames)[1];
    const regressed = input.frames.map((f, i) => {
      if (i < run.start || i > run.end || !f.capture) return f;
      const t = [0, 100, 50, 300, 600][i - run.start]; // 50 < 100: regression
      return { ...f, capture: { ...f.capture, t } };
    });
    const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS);
    const manifest = buildReconstructionManifest({ ...input, frames: regressed }, cfg);
    const s0 = manifest.frames.find((f) => f.file === "s_scroll00.png")!;
    const s1 = manifest.frames.find((f) => f.file === "s_scroll07.png")!;
    assert.equal(s1.t - s0.t, 150); // uniform fallback, not the regressed stamps
    const warned = qaRealFrameCapture(regressed, manifest);
    assert.ok(warned.some((w) => w.code === "NON_MONOTONIC_CAPTURE_T"));
  });

  it("H4. denseRunFrameTimes unit: clamps sub-frame deltas, honors true spacing", () => {
    const frames = [0, 5, 100, 300].map((t, i) => ({
      file: `f${i}.png`,
      capture: { order: i, dense: true, t },
    })) as Parameters<typeof denseRunFrameTimes>[0];
    const { times, runEnd } = denseRunFrameTimes(frames, 1000, 900, 1000 / 60);
    // 5ms delta clamps to one output frame (16.67ms).
    assert.ok(Math.abs(times[1] - times[0] - 1000 / 60) < 0.01);
    assert.ok(Math.abs(times[2] - times[1] - 95) < 0.01);
    assert.ok(Math.abs(times[3] - times[2] - 200) < 0.01);
    assert.equal(runEnd, times[3]);
  });
});

describe("primary real-frame path: implicit CUT between real states", () => {
  // Native-mode fixture: two sparse real states around a dense click run.
  const nativeTrace = (extraStates: Record<string, unknown>[] = []) => ({
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    screenshotsDir: ".",
    states: [
      { id: "a", screenshot: "s_focus.png" },
      { id: "b", screenshot: "s_graceland_top.png", capture: { dense: true, order: 0 } },
      { id: "c", screenshot: "s_hover_sugg.png", capture: { dense: true, order: 1 } },
      { id: "d", screenshot: "s_memphis_top.png" },
      ...extraStates,
    ],
    actions: [{ kind: "click", from: "b", to: "c", x: 640, y: 400 }],
  });
  const buildNative = (trace: unknown = nativeTrace()) => {
    const { trace: t } = normalizeTrace(trace, { adapter: "generic" });
    const input = traceToReconstructionInput(t);
    return buildReconstructionManifest(input, resolveConfig(RECONSTRUCTION_DEFAULTS));
  };

  it("K1. real frame -> real frame defaults to cut on the primary path", () => {
    const m = buildNative();
    assert.equal(m.mode, "native");
    assert.equal(m.visualSource, "mixed");
    assert.deepEqual(
      m.frames.map((f) => f.file),
      ["s_focus.png", "s_graceland_top.png", "s_hover_sugg.png", "s_memphis_top.png"],
    );
    for (const f of m.frames) {
      assert.equal(f.transitionIn, "cut", `${f.file}: primary-path default must be cut, never an implicit crossfade`);
    }
  });

  it("K2. no implicit crossfade is generated: instructions never blend two screenshots", () => {
    const m = buildNative();
    for (const ins of instructionsFor(m)) {
      assert.equal(ins.mix, null, `${ins.file}: cut frames must never blend`);
      assert.equal(ins.previousFile, undefined, `${ins.file}: no outgoing screenshot may be loaded`);
      assert.equal(ins.isScroll, undefined, `${ins.file}: no scroll transition on the primary path`);
    }
    assert.equal(collectScrollTransitions(instructionsFor(m)).size, 0);
  });

  it("K3. dense real-frame sequences keep internal cuts, files, and timing", () => {
    const { input, manifest } = build();
    assert.ok(detectDenseRuns(input.frames).length >= 1);
    for (const r of detectDenseRuns(input.frames)) {
      const inFiles = input.frames.slice(r.start, r.end + 1).map((f) => f.file);
      const mFrames = manifest.frames.slice(r.start, r.end + 1);
      assert.deepEqual(mFrames.map((f) => f.file), inFiles, "dense run renders exactly its captures");
      for (const f of mFrames) assert.equal(f.transitionIn, "cut", `${f.file}: dense frames stay cuts`);
      for (let i = 2; i < mFrames.length; i++) {
        assert.equal(
          mFrames[i].t - mFrames[i - 1].t,
          mFrames[1].t - mFrames[0].t,
          "uniform capture spacing preserved inside the run",
        );
      }
    }
  });

  it("K4. reconstructed sparse traces keep existing transitions (no forced cut)", () => {
    // Click-only sparse trace: the arrival frame keeps the legacy default
    // (undefined => compositor crossfade), not a forced cut.
    const clickTrace = {
      ...nativeTrace(),
      states: [
        { id: "a", screenshot: "s_focus.png" },
        { id: "b", screenshot: "s_graceland_top.png" },
      ],
      actions: [{ kind: "click", from: "a", to: "b", x: 640, y: 400 }],
    };
    const { trace: t } = normalizeTrace(clickTrace, { adapter: "generic" });
    const m = buildReconstructionManifest(traceToReconstructionInput(t), resolveConfig(RECONSTRUCTION_DEFAULTS));
    assert.equal(m.mode, "reconstructed");
    assert.equal(m.visualSource, "reconstructed-sparse");
    assert.equal(m.frames[1].transitionIn, undefined, "fallback default transition is untouched");

    // Sparse scroll still synthesizes its slide into the scrollplan fallback.
    const scrollTrace = {
      ...nativeTrace(),
      states: [
        { id: "a", screenshot: "s_focus.png" },
        { id: "b", screenshot: "s_graceland_top.png" },
      ],
      actions: [{ kind: "scroll", from: "a", to: "b", dx: 0, dy: 800, durationMs: 600, x: 640, y: 400 }],
    };
    const { trace: t2 } = normalizeTrace(scrollTrace, { adapter: "generic" });
    const m2 = buildReconstructionManifest(traceToReconstructionInput(t2), resolveConfig(RECONSTRUCTION_DEFAULTS));
    const ti = m2.frames[1].transitionIn;
    assert.ok(typeof ti === "object" && ti.kind === "slide", "sparse scroll keeps its slide transition");
  });

  it("K5. explicit author transitions are preserved on the primary path, deterministically", () => {
    const explicit = nativeTrace([{ id: "e", screenshot: "s_tooltip.png", transitionIn: "crossfade" }]);
    const a = withoutCreatedAt(buildNative(explicit));
    const b = withoutCreatedAt(buildNative(explicit));
    assert.deepEqual(b, a, "explicit-transition manifests are deterministic");
    const e = a.frames.find((f) => f.file === "s_tooltip.png")!;
    assert.equal(e.transitionIn, "crossfade", "explicit author transition survives on the primary path");
    for (const f of a.frames) {
      if (f.file === "s_tooltip.png") continue;
      assert.equal(f.transitionIn, "cut", `${f.file}: implicit default stays cut`);
    }
  });
});
