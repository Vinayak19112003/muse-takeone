/**
 * Cases A–G: reconstruction camera and transition correctness.
 *
 * A: nearby + time-close interactions share one shot.
 * B: far + time-close interactions reframe directly (no zoom-out/zoom-in pair).
 * C: a long final gap releases back to the overview.
 * D: a screenshot cut never moves the camera.
 * E: every frame in a crossfade window names previousFile (stateless workers).
 * F: crossfade duration is measured in output time (stable under time-lapse).
 * G: camera move durations are output-time under time-lapse.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../src/config.js";
import { planReconstructionCamera } from "../src/reconstruct/shots.js";
import {
  buildTimeline,
  cameraBusyWindows,
  extractCursor,
  planKeyToasts,
  sourceToOutput,
  type KeptRange,
} from "../src/compositor/plan.js";
import { planFrameInstructions } from "../src/compositor/instructions.js";
import { makeCamAtOut, planCameraKeys } from "../src/compositor/render.js";
import type { RecordingManifest, ScenarioConfig } from "../src/types.js";

const VW = 1920, VH = 1080, FPS = 60;
const cfg: ScenarioConfig = resolveConfig(RECONSTRUCTION_DEFAULTS);

function makeManifest(opts: {
  clicks: { t: number; x: number; y: number }[];
  frames?: { file: string; t: number }[];
  duration?: number;
}): RecordingManifest {
  const events: RecordingManifest["events"] = [];
  for (const c of opts.clicks) {
    events.push({ type: "mouse", t: c.t - 300, x: c.x - 40, y: c.y - 20 });
    events.push({ type: "mousedown", t: c.t, x: c.x, y: c.y, button: "left" });
    events.push({ type: "mouseup", t: c.t + 130, x: c.x, y: c.y, button: "left" });
  }
  events.sort((a, b) => a.t - b.t);
  const lastClick = Math.max(0, ...opts.clicks.map((c) => c.t));
  return {
    version: 1,
    mode: "reconstructed",
    createdAt: new Date().toISOString(),
    config: cfg,
    viewport: { width: VW, height: VH, deviceScaleFactor: 1 },
    frameSize: { width: VW, height: VH },
    frames: opts.frames ?? [{ file: "f01.png", t: 0 }],
    events,
    duration: opts.duration ?? lastClick + 4000,
  };
}

const isFull = (scale: number) => scale <= 1.01;

describe("A: nearby time-close interactions share one shot", () => {
  it("like then repost: one shot, no return to full view between them", () => {
    const m = makeManifest({ clicks: [{ t: 2000, x: 300, y: 700 }, { t: 3500, x: 360, y: 700 }] });
    const { shots, keys, audit } = planReconstructionCamera(m, cfg);
    assert.equal(shots.length, 1, `expected 1 shot, got ${shots.length}`);
    // Only the final release may target the full view.
    const fullKeys = keys.filter((k) => isFull(k.target.scale));
    assert.equal(fullKeys.length, 1, `expected exactly one full-view key (the release), got ${fullKeys.length}`);
    assert.ok(fullKeys[0].t > 3500, "the release comes after the last interaction");
    assert.deepEqual(audit.warnings, [], `unexpected warnings: ${audit.warnings.join("; ")}`);
  });
});

describe("B: far time-close interactions reframe directly", () => {
  it("two shots with a direct reframe, never a zoom-out/zoom-in pair", () => {
    const m = makeManifest({ clicks: [{ t: 2000, x: 300, y: 700 }, { t: 2800, x: 1500, y: 700 }] });
    const { shots, keys, audit } = planReconstructionCamera(m, cfg);
    assert.equal(shots.length, 2, `expected 2 shots, got ${shots.length}`);
    const fullBetween = keys.filter(
      (k, i) => isFull(k.target.scale) && i > 0 && i < keys.length - 1,
    );
    assert.equal(fullBetween.length, 0, "no return-to-full between the two shots");
    assert.ok(
      !audit.warnings.some((w) => w.includes("redundant reset")),
      `redundant reset warned: ${audit.warnings.join("; ")}`,
    );
  });
});

describe("C: long final gap releases to the overview", () => {
  it("the last key returns to full view after releaseMs", () => {
    const m = makeManifest({ clicks: [{ t: 2000, x: 300, y: 700 }] });
    const { keys } = planReconstructionCamera(m, cfg);
    const last = keys[keys.length - 1];
    assert.ok(isFull(last.target.scale), `last key should be full view, got scale ${last.target.scale}`);
    assert.ok(
      Math.abs(last.t - (2000 + cfg.reconstruction.releaseMs)) < 1,
      `release at last+releaseMs, got t=${last.t}`,
    );
  });
});

describe("D: screenshot cuts never move the camera", () => {
  it("no camera keyframe near the cut; the shot holds through the crossfade", () => {
    const m = makeManifest({
      clicks: [{ t: 1000, x: 300, y: 700 }, { t: 4000, x: 350, y: 700 }],
      frames: [{ file: "f01.png", t: 0 }, { file: "f02.png", t: 2700 }],
      duration: 8000,
    });
    const { keys } = planCameraKeys(m, cfg);
    const nearCut = keys.filter((k) => Math.abs(k.t - 2700) < 400);
    assert.equal(nearCut.length, 0, `camera keys near the cut: ${JSON.stringify(nearCut)}`);
  });
});

function instructionInput(m: RecordingManifest, ranges: KeptRange[], outDuration: number) {
  const totalFrames = Math.max(1, Math.ceil((outDuration / 1000) * FPS));
  const { keys } = planCameraKeys(m, cfg);
  const camAtOut = makeCamAtOut(m, cfg, ranges, keys);
  const { samples, downs } = extractCursor(m.events);
  const content = { x: 0, y: 0, w: VW, h: VH };
  return {
    frames: m.frames,
    fps: FPS,
    ranges,
    totalFrames,
    camAtOut,
    samples,
    downs,
    keyToasts: planKeyToasts(m.events, cfg),
    captions: m.captions,
    content,
    vw: VW,
    W: VW,
    H: VH,
    cfg,
    transitionMs: cfg.transition.duration,
  };
}

describe("E: crossfades are stateless", () => {
  it("every frame in the window names previousFile; none outside it do", () => {
    const m = makeManifest({
      clicks: [{ t: 1000, x: 300, y: 700 }],
      frames: [{ file: "f01.png", t: 0 }, { file: "f02.png", t: 2700 }],
      duration: 6000,
    });
    const { keys } = planCameraKeys(m, cfg);
    const { ranges, outDuration } = buildTimeline(m, cfg, cameraBusyWindows(keys));
    const ins = planFrameInstructions(instructionInput(m, ranges, outDuration));
    const blended = ins.filter((x) => x.mix !== null);
    assert.ok(blended.length > 1, "the crossfade spans multiple frames");
    for (const b of blended) {
      assert.equal(b.previousFile, "f01.png", "every blended frame names the outgoing screenshot");
      assert.ok(b.mix! >= 0 && b.mix! < 1, `mix in [0,1), got ${b.mix}`);
    }
    // Progress runs 0 -> 1 across the window.
    assert.ok(blended[0].mix! < 0.2, `starts near 0, got ${blended[0].mix}`);
    assert.ok(blended[blended.length - 1].mix! > 0.7, `ends near 1, got ${blended[blended.length - 1].mix}`);
    for (const x of ins) {
      if (x.mix === null) assert.equal(x.previousFile, undefined, "no previousFile outside the window");
    }
  });
});

describe("F: crossfade duration is output-time", () => {
  it("a 2x time-lapse does not change the number of blended frames", () => {
    const frames = [{ file: "f01.png", t: 0 }, { file: "f02.png", t: 2700 }];
    const m = makeManifest({ clicks: [{ t: 1000, x: 300, y: 700 }], frames, duration: 6000 });
    const { keys } = planCameraKeys(m, cfg);
    const { ranges, outDuration } = buildTimeline(m, cfg, cameraBusyWindows(keys));
    const plain = planFrameInstructions(instructionInput(m, ranges, outDuration)).filter((x) => x.mix !== null).length;

    const lapsed: KeptRange[] = [{ srcStart: 0, srcEnd: 6000, outStart: 0, rate: 2 }];
    const lapsedOut = 3000;
    const lapsedCount = planFrameInstructions(instructionInput(m, lapsed, lapsedOut)).filter((x) => x.mix !== null).length;

    assert.ok(plain > 1, "baseline crossfade spans frames");
    assert.equal(lapsedCount, plain, `2x lapse changed blended frame count: ${plain} -> ${lapsedCount}`);
  });
});

describe("G: camera durations are output-time under time-lapse", () => {
  it("a move completes in duration/rate output ms, choreographed with the action", () => {
    const m = makeManifest({ clicks: [{ t: 2000, x: 300, y: 700 }], duration: 8000 });
    const { keys } = planCameraKeys(m, cfg);
    const move = keys[0];
    assert.ok(!isFull(move.target.scale), "first key zooms into the shot");
    const lapsed: KeptRange[] = [{ srcStart: 0, srcEnd: 8000, outStart: 0, rate: 2 }];
    const camAtOut = makeCamAtOut(m, cfg, lapsed, keys);
    const tOut0 = sourceToOutput(lapsed, move.t);
    const expectedOut = move.duration / 2;
    const done = camAtOut(tOut0 + expectedOut);
    assert.ok(
      Math.abs(done.scale - move.target.scale) < 0.02,
      `move should complete in ${expectedOut} output ms; scale=${done.scale.toFixed(3)} vs target ${move.target.scale}`,
    );
    const mid = camAtOut(tOut0 + expectedOut / 2);
    assert.ok(mid.scale > 1.01 && mid.scale < move.target.scale, `mid-move scale ${mid.scale.toFixed(3)} should be between 1 and target`);
  });
});

/**
 * Cases H–K: capture-source provenance.
 *
 * H: input.source is preserved verbatim in the generated manifest.
 * I: --require-source fails clearly when the input source does not match (or is missing).
 * J: no source metadata at all stays backwards compatible.
 * K: source metadata never changes rendering output: identical screenshots/actions
 *    with different source metadata plan identical frame instructions.
 */
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReconstructionManifest,
  writeReconstructionDir,
  type ReconstructionInput,
} from "../src/reconstruct/build.js";

function makeReconstructionInput(source?: ReconstructionInput["source"]): ReconstructionInput {
  return {
    viewport: { width: 1280, height: 800 },
    screenshotsDir: "shots",
    source,
    frames: [
      { file: "a.png", holdMs: 2000, actions: [{ kind: "click", x: 640, y: 400 }], caption: "tour" },
      { file: "b.png", holdMs: 2000 },
    ],
  };
}

/** Materialize two tiny screenshots so writeReconstructionDir has real files to copy. */
function materializeShots(dir: string): void {
  const fixture = join(import.meta.dirname, "fixtures", "qa", "frames");
  mkdirSync(join(dir, "shots"), { recursive: true });
  copyFileSync(join(fixture, "01-post.png"), join(dir, "shots", "a.png"));
  copyFileSync(join(fixture, "02-liked.png"), join(dir, "shots", "b.png"));
}

describe("H: manifest preserves input.source", () => {
  it("muse-managed-browser provenance survives into manifest.json on disk", () => {
    const base = mkdtempSync(join(tmpdir(), "takeone-src-h-"));
    materializeShots(base);
    const input = makeReconstructionInput({ type: "muse-managed-browser", session: "main" });
    const { workDir } = writeReconstructionDir({ input, baseDir: base, workDir: join(base, "work") });
    const onDisk = JSON.parse(readFileSync(join(workDir, "manifest.json"), "utf8"));
    assert.deepEqual(onDisk.source, { type: "muse-managed-browser", session: "main" });
  });
});

describe("I: --require-source enforcement", () => {
  it("fails clearly when the input source does not match", () => {
    const base = mkdtempSync(join(tmpdir(), "takeone-src-i-"));
    materializeShots(base);
    const input = makeReconstructionInput({ type: "external-browser" });
    assert.throws(
      () => writeReconstructionDir({ input, baseDir: base, workDir: join(base, "work"), requireSource: "muse-managed-browser" }),
      /--require-source muse-managed-browser but the input claims source "external-browser"/,
    );
  });
  it("fails clearly when the input has no source at all", () => {
    const base = mkdtempSync(join(tmpdir(), "takeone-src-i2-"));
    materializeShots(base);
    const input = makeReconstructionInput(undefined);
    assert.throws(
      () => writeReconstructionDir({ input, baseDir: base, workDir: join(base, "work"), requireSource: "muse-managed-browser" }),
      /claims source \(none\)/,
    );
  });
  it("rejects an unknown required source type", () => {
    const base = mkdtempSync(join(tmpdir(), "takeone-src-i3-"));
    materializeShots(base);
    const input = makeReconstructionInput({ type: "muse-managed-browser" });
    assert.throws(
      () => writeReconstructionDir({ input, baseDir: base, workDir: join(base, "work"), requireSource: "managed-browser" as any }),
      /not a known source type/,
    );
  });
});

describe("J: backwards compatibility", () => {
  it("input without source and without requireSource still builds; manifest.source is undefined", () => {
    const base = mkdtempSync(join(tmpdir(), "takeone-src-j-"));
    materializeShots(base);
    const { manifest } = writeReconstructionDir({ input: makeReconstructionInput(undefined), baseDir: base, workDir: join(base, "work") });
    assert.equal(manifest.source, undefined);
    assert.equal(manifest.frames.length, 2);
  });
  it("matching requireSource passes and preserves the source", () => {
    const base = mkdtempSync(join(tmpdir(), "takeone-src-j2-"));
    materializeShots(base);
    const { manifest } = writeReconstructionDir({
      input: makeReconstructionInput({ type: "muse-managed-browser", session: "main" }),
      baseDir: base,
      workDir: join(base, "work"),
      requireSource: "muse-managed-browser",
    });
    assert.deepEqual(manifest.source, { type: "muse-managed-browser", session: "main" });
  });
});

describe("K: source metadata does not change rendering", () => {
  it("identical frames/actions with different source metadata plan identical output", () => {
    const a = buildReconstructionManifest(makeReconstructionInput({ type: "muse-managed-browser", session: "main" }), cfg);
    const b = buildReconstructionManifest(makeReconstructionInput({ type: "manual-screenshots" }), cfg);
    const c = buildReconstructionManifest(makeReconstructionInput(undefined), cfg);
    for (const [x, y] of [[a, b], [a, c]] as const) {
      const strip = (m: typeof a) => {
        const { source: _s, createdAt: _c, ...rest } = m as any;
        return rest;
      };
      assert.deepEqual(strip(x), strip(y), "manifests must differ only in source/createdAt");
      // Every pure-function stage of the render pipeline must see no difference:
      // the shot plan (camera keys), the output-time mapping, and the cursor stream.
      assert.deepEqual(planCameraKeys(x, cfg), planCameraKeys(y, cfg), "camera keys must be identical regardless of source");
      assert.deepEqual(buildTimeline(x, cfg), buildTimeline(y, cfg), "output timeline must be identical regardless of source");
      assert.deepEqual(extractCursor(x.events), extractCursor(y.events), "cursor stream must be identical regardless of source");
    }
  });
});
