/**
 * Cases H–Y: reconstruction action model, timing, validation, QA, redaction.
 *
 * H: typing emits per-character key events; the burst is one camera focus; the HUD
 *    shows a growing text pill; showKeys/sensitive control visibility.
 * I: click -> next screenshot appears ~nextFrameAfterMs after mouseup (no lingering).
 * J: scroll emits a scroll event; the next frame auto-slides in the scroll direction.
 * K: hover leaves a marker event (never a click) and focuses the camera.
 * L: wait advances the timeline with no events.
 * M: validation catches missing files, bad coords, bad versions, dup basenames,
 *    bad source types, negative timing, bad action kinds; warns on ignored options.
 * X: explicit input.shots override the auto shot planner.
 * Y: screenshotsDir cannot escape the input directory.
 * N: redaction validation (modes, empty regions); applyRedactions alters pixels.
 * O: JSON Schema accepts a valid input and rejects an invalid one (ajv).
 * P: preClickMs delays mousedown after cursor arrival.
 * Q: builds are deterministic across runs.
 * R: Unicode typing: one key event per code point; emoji joins the text pill.
 * S: QA warns on lingering frames and mid-move clicks; happy path is clean.
 * T: source provenance (captureTool/capturedAt/viewport) is preserved verbatim.
 * U: per-frame transitionIn (cut/slide) reaches the manifest.
 * V: nextFrameAfterMs default (200ms) applies when unset.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveFfmpeg } from "../src/ffmpeg.js";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../src/config.js";
import {
  buildReconstructionManifest,
  writeReconstructionDir,
  type ReconstructionInput,
} from "../src/reconstruct/build.js";
import { validateReconstructionInput } from "../src/reconstruct/validate.js";
import { extractFocusEvents, planReconstructionCamera } from "../src/reconstruct/shots.js";
import { qaReconstruction } from "../src/reconstruct/qa.js";
import { applyRedactions } from "../src/reconstruct/redact.js";
import { planKeyToasts } from "../src/compositor/plan.js";
import type { RecordingManifest, ScenarioConfig } from "../src/types.js";

const cfg: ScenarioConfig = resolveConfig(RECONSTRUCTION_DEFAULTS);
const VW = 1280, VH = 800;

// 1x1 PNG (red). Content never matters for these tests, only existence.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "mt-test-"));
  mkdirSync(join(dir, "frames"));
  for (const f of ["a.png", "b.png", "c.png"]) writeFileSync(join(dir, "frames", f), PNG);
});

function baseInput(frames: ReconstructionInput["frames"]): ReconstructionInput {
  return { version: 1, viewport: { width: VW, height: VH }, screenshotsDir: "frames", frames };
}

function build(input: ReconstructionInput): RecordingManifest {
  return buildReconstructionManifest(input, cfg);
}

describe("H: reconstructed typing", () => {
  const input = baseInput([
    { file: "a.png", actions: [{ kind: "type", x: 600, y: 400, text: "hi" }] },
    { file: "b.png" },
  ]);
  const m = build(input);
  const keys = m.events.filter((e) => e.type === "key");
  it("emits one key event per character with source=type", () => {
    assert.equal(keys.length, 2);
    assert.deepEqual(keys.map((k) => (k as { key: string }).key), ["h", "i"]);
    for (const k of keys) assert.equal((k as { source: string }).source, "type");
  });
  it("the burst is a single camera focus", () => {
    const foci = extractFocusEvents(m);
    assert.equal(foci.length, 1);
    assert.deepEqual([foci[0].x, foci[0].y], [600, 400]);
  });
  it("the HUD renders a growing text pill", () => {
    const toasts = planKeyToasts(m.events, cfg);
    const text = toasts.filter((t) => t.kind === "text");
    assert.equal(text.length, 1);
    assert.deepEqual(text[0].chars.map((c) => c.ch), ["h", "i"]);
  });
  it("showKeys:false hides the pill; sensitive defaults to hidden", () => {
    const hidden = build(baseInput([
      { file: "a.png", actions: [{ kind: "type", x: 600, y: 400, text: "secret", showKeys: false }] },
      { file: "b.png" },
    ]));
    assert.equal(planKeyToasts(hidden.events, cfg).length, 0);
    const sens = build(baseInput([
      { file: "a.png", actions: [{ kind: "type", x: 600, y: 400, text: "s3cret", sensitive: true }] },
      { file: "b.png" },
    ]));
    assert.equal(planKeyToasts(sens.events, cfg).length, 0);
    const shown = build(baseInput([
      { file: "a.png", actions: [{ kind: "type", x: 600, y: 400, text: "ok", sensitive: true, showKeys: true }] },
      { file: "b.png" },
    ]));
    assert.equal(planKeyToasts(shown.events, cfg).length, 1);
  });
});

describe("I: action -> UI-state timing", () => {
  it("the next screenshot appears ~200ms after mouseup by default", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "click", x: 100, y: 100 }] },
      { file: "b.png" },
    ]));
    const up = m.events.find((e) => e.type === "mouseup")!;
    const cut = m.frames[1].t;
    assert.ok(cut - up.t >= 195 && cut - up.t <= 260, `cut ${cut - up.t}ms after mouseup`);
  });
  it("nextFrameAfterMs overrides the default", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "click", x: 100, y: 100, nextFrameAfterMs: 500 }] },
      { file: "b.png" },
    ]));
    const up = m.events.find((e) => e.type === "mouseup")!;
    assert.ok(m.frames[1].t - up.t >= 495 && m.frames[1].t - up.t <= 560);
  });
});

describe("J: scroll", () => {
  it("emits a scroll event and auto-slides into the next frame", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "scroll", x: 640, y: 400, dy: 700 }] },
      { file: "b.png" },
    ]));
    const sc = m.events.filter((e) => e.type === "scroll");
    assert.equal(sc.length, 1);
    assert.equal((sc[0] as { dy: number }).dy, 700);
    const ti = m.frames[1].transitionIn;
    assert.ok(ti && typeof ti === "object" && ti.kind === "slide", `got ${JSON.stringify(ti)}`);
    // Scrolling down pushes the old screenshot up.
    assert.ok((ti as { dy: number }).dy < 0);
  });
  it("an explicit transitionIn wins over the auto-slide", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "scroll", dy: 700 }] },
      { file: "b.png", transitionIn: "cut" },
    ]));
    assert.equal(m.frames[1].transitionIn, "cut");
  });
});

describe("K: hover", () => {
  it("leaves a hover marker, never a click, and focuses the camera", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "hover", x: 700, y: 300 }] },
      { file: "b.png", actions: [{ kind: "click", x: 100, y: 700 }] },
      { file: "c.png" },
    ]));
    assert.equal(m.events.filter((e) => e.type === "mousedown").length, 1);
    const hov = m.events.filter((e) => e.type === "hover");
    assert.equal(hov.length, 1);
    const foci = extractFocusEvents(m);
    assert.ok(foci.some((f) => f.x === 700 && f.y === 300), "hover is a camera focus");
  });
});

describe("L: wait", () => {
  it("advances the timeline with no cursor or click events", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "wait", durationMs: 900 }] },
      { file: "b.png" },
    ]));
    const frameEvents = m.events.filter((e) => e.t < m.frames[1].t);
    assert.ok(!frameEvents.some((e) => e.type === "mousedown" || e.type === "key"));
    assert.ok(m.frames[1].t - 0 >= 900, "the wait actually waits");
  });
});

describe("M: validation", () => {
  it("accepts a good input", () => {
    const r = validateReconstructionInput(
      baseInput([{ file: "a.png", actions: [{ kind: "click", x: 10, y: 10 }] }, { file: "b.png" }]),
      dir,
    );
    assert.ok(r.ok, JSON.stringify(r.errors));
  });
  it("catches missing files, bad coords, bad versions, dup basenames, bad sources, bad kinds, negative timing", () => {
    const r = validateReconstructionInput(
      {
        version: 2,
        viewport: { width: VW, height: VH },
        screenshotsDir: "frames",
        source: { type: "nope" },
        frames: [
          { file: "a.png", actions: [{ kind: "click", x: -5, y: 10, pauseMs: -1 }] },
          { file: "frames/a.png", actions: [{ kind: "dance", x: 1, y: 1 }] },
          { file: "missing.png" },
        ],
      },
      dir,
    );
    assert.ok(!r.ok);
    const msgs = r.errors.map((e) => e.message).join("\n");
    assert.match(msgs, /version 1/);
    assert.match(msgs, /outside the viewport/);
    assert.match(msgs, /pauseMs must be >= 0/);
    assert.match(msgs, /same base name/);
    assert.match(msgs, /must be one of click, type, scroll, hover, wait/);
    assert.match(msgs, /not found/);
    assert.match(msgs, /source.type must be one of/);
  });
  it("warns on ignored nextFrameAfterMs and showKeys+sensitive", () => {
    const r = validateReconstructionInput(
      baseInput([
        {
          file: "a.png",
          actions: [
            { kind: "click", x: 10, y: 10, nextFrameAfterMs: 50 },
            { kind: "type", x: 20, y: 20, text: "x", sensitive: true, showKeys: true },
          ],
        },
        { file: "b.png" },
      ]),
      dir,
    );
    assert.ok(r.ok);
    const msgs = r.warnings.map((w) => w.message).join("\n");
    assert.match(msgs, /nextFrameAfterMs is ignored/);
    assert.match(msgs, /marked sensitive but showKeys is true/);
  });
  it("warns when the last frame's action result is never shown", () => {
    const r = validateReconstructionInput(baseInput([{ file: "a.png", actions: [{ kind: "click", x: 10, y: 10 }] }]), dir);
    assert.ok(r.warnings.some((w) => w.message.includes("never shown")));
  });
});

describe("N: redaction", () => {
  it("applyRedactions blurs the region (pixels change, size kept)", () => {
    const src = join(dir, "frames", "a.png");
    const dest = join(dir, "redacted.png");
    // Make a.png bigger than 1x1 so regions are meaningful.
    execFileSync(resolveFfmpeg(), ["-y", "-f", "lavfi", "-i", "testsrc=size=200x120:rate=1", "-frames:v", "1", src], { stdio: "pipe" });
    applyRedactions(src, dest, [{ x: 10, y: 10, width: 50, height: 40, mode: "blur" }], { width: 200, height: 120 });
    assert.ok(existsSync(dest));
    assert.notDeepEqual(readFileSync(src), readFileSync(dest));
    // Solid + pixelate also run without errors.
    applyRedactions(src, dest, [{ x: 0, y: 0, width: 200, height: 120, mode: "solid" }], { width: 200, height: 120 });
    applyRedactions(src, dest, [{ x: 0, y: 0, width: 200, height: 120, mode: "pixelate" }], { width: 200, height: 120 });
  });
  it("validation rejects bad redaction modes and empty regions", () => {
    const r = validateReconstructionInput(
      { ...baseInput([{ file: "a.png" }]), redactions: [{ x: 0, y: 0, width: 0, height: 10, mode: "laser" }] },
      dir,
    );
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.message.includes("mode must be one of")));
    assert.ok(r.errors.some((e) => e.message.includes("width must be > 0")));
  });
});

describe("O: JSON Schema", () => {
  it("accepts a valid input and rejects an invalid one", async () => {
    const { default: Ajv } = await import("ajv");
    const schema = JSON.parse(readFileSync(new URL("../schema/reconstruction.schema.json", import.meta.url), "utf8"));
    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    assert.ok(validate(baseInput([{ file: "a.png", actions: [{ kind: "click", x: 1, y: 2 }] }, { file: "b.png" }])));
    assert.ok(!validate({ viewport: { width: 1, height: 1 }, frames: [{ file: "a.png", actions: [{ kind: "nope" }] }] }));
  });
});

describe("P: preClickMs", () => {
  it("mousedown lands preClickMs after cursor arrival", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "click", x: 100, y: 100, preClickMs: 300 }] },
      { file: "b.png" },
    ]));
    const down = m.events.find((e) => e.type === "mousedown")!;
    const before = m.events.filter((e) => e.type === "mouse" && e.t <= down.t);
    const arrival = before[before.length - 1].t;
    assert.ok(down.t - arrival >= 295 && down.t - arrival <= 340, `gap ${down.t - arrival}ms`);
  });
});

describe("Q: determinism", () => {
  it("two builds of the same input produce identical event streams", () => {
    const input = baseInput([
      { file: "a.png", actions: [{ kind: "click", x: 100, y: 100 }, { kind: "type", x: 200, y: 200, text: "deterministic 🎉" }] },
      { file: "b.png", actions: [{ kind: "scroll", dy: 500 }] },
      { file: "c.png" },
    ]);
    const a = build(input), b = build(input);
    assert.deepEqual(a.events, b.events);
    assert.deepEqual(a.frames, b.frames);
  });
});

describe("R: unicode typing", () => {
  it("emoji is one key event and joins the text pill", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "type", x: 100, y: 100, text: "a🎉b" }] },
      { file: "b.png" },
    ]));
    const keys = m.events.filter((e) => e.type === "key");
    assert.equal(keys.length, 3);
    const toasts = planKeyToasts(m.events, cfg);
    const text = toasts.find((t) => t.kind === "text")!;
    assert.deepEqual(text.chars.map((c) => c.ch), ["a", "🎉", "b"]);
  });
});

describe("S: QA", () => {
  it("the happy path has no warnings", () => {
    const input = baseInput([
      { file: "a.png", caption: "one", actions: [{ kind: "click", x: 300, y: 300 }] },
      { file: "b.png", caption: "two" },
    ]);
    const m = build(input);
    const qa = qaReconstruction(input, m);
    assert.deepEqual(qa.warnings, []);
    assert.equal(qa.metrics.clicks, 1);
    assert.equal(qa.metrics.screenshots, 2);
    assert.equal(qa.metrics.transitions, 1);
  });
  it("warns when a frame lingers after its action", () => {
    const input = baseInput([
      { file: "a.png", actions: [{ kind: "click", x: 300, y: 300 }], holdMs: 8000 },
      { file: "b.png" },
    ]);
    const qa = qaReconstruction(input, build(input));
    assert.ok(qa.warnings.some((w) => w.includes("lingers")), JSON.stringify(qa.warnings));
  });
});

describe("T: provenance", () => {
  it("source metadata is preserved verbatim in the manifest", () => {
    const source = {
      type: "muse-managed-browser",
      session: "main",
      captureTool: "muse",
      capturedAt: "2026-09-27T10:00:00+05:30",
      viewport: { width: VW, height: VH },
      note: "x",
    } as const;
    const m = build({ ...baseInput([{ file: "a.png" }]), source: { ...source } });
    assert.deepEqual(m.source, source);
  });
});

describe("U: transitionIn", () => {
  it("explicit cut/slide reach the manifest frames", () => {
    const m = build(baseInput([
      { file: "a.png" },
      { file: "b.png", transitionIn: "cut" },
      { file: "c.png", transitionIn: { kind: "slide", dx: 0, dy: -120 } },
    ]));
    assert.equal(m.frames[1].transitionIn, "cut");
    assert.deepEqual(m.frames[2].transitionIn, { kind: "slide", dx: 0, dy: -120 });
  });
});

describe("V: default cut timing", () => {
  it("an unset nextFrameAfterMs cuts ~200ms after the last action event", () => {
    const m = build(baseInput([
      { file: "a.png", actions: [{ kind: "hover", x: 50, y: 50 }] },
      { file: "b.png" },
    ]));
    const hov = m.events.find((e) => e.type === "hover")!;
    const gap = m.frames[1].t - hov.t;
    assert.ok(gap >= 195 && gap <= 260, `gap ${gap}ms`);
  });
});

describe("writeReconstructionDir", () => {
  it("copies frames and writes a manifest; --require-source passes on match", () => {
    const workDir = join(dir, "work");
    const { manifest } = writeReconstructionDir({
      input: { ...baseInput([{ file: "a.png" }, { file: "b.png" }]), source: { type: "muse-managed-browser" } },
      baseDir: dir,
      workDir,
      requireSource: "muse-managed-browser",
      log: () => {},
    });
    assert.ok(existsSync(join(workDir, "manifest.json")));
    assert.ok(existsSync(join(workDir, "frames", "a.png")));
    assert.equal(manifest.frames.length, 2);
  });
  it("--require-source fails loudly on mismatch", () => {
    assert.throws(
      () =>
        writeReconstructionDir({
          input: { ...baseInput([{ file: "a.png" }]), source: { type: "manual-screenshots" } },
          baseDir: dir,
          workDir: join(dir, "work2"),
          requireSource: "muse-managed-browser",
          log: () => {},
        }),
      /did not come from the expected capture browser/,
    );
  });

  it("W: frame.file cannot escape screenshotsDir via .. or absolute paths", () => {
    for (const bad of ["../a.png", "..\\a.png", "/etc/passwd", "sub/../../a.png"]) {
      const v = validateReconstructionInput(baseInput([{ file: bad }]), dir);
      assert.equal(v.ok, false, bad);
      assert.match(
        v.errors.map((e) => e.message).join("\n"),
        /must stay inside screenshotsDir/,
      );
    }
    const good = validateReconstructionInput(baseInput([{ file: "a.png" }, { file: "b.png" }]), dir);
    assert.equal(good.ok, true);
  });
});

describe("X: explicit shots override", () => {
  it("input.shots lands on the manifest and drives camera planning", () => {
    const input = baseInput([
      { file: "a.png", actions: [{ kind: "click", x: 100, y: 100 }] },
      { file: "b.png", actions: [{ kind: "click", x: 1100, y: 700 }] },
    ]);
    const auto = planReconstructionCamera(build(input), cfg);
    input.shots = [
      { start: 0, end: 4000, cx: 640, cy: 400, scale: 1.35 },
      { start: 4000, end: 9000, cx: 640, cy: 400, scale: 1 },
    ];
    const m = build(input);
    assert.deepEqual(m.shots, input.shots);
    const plan = planReconstructionCamera(m, cfg);
    assert.deepEqual(
      plan.shots.map((s) => ({ cx: s.cx, cy: s.cy, scale: s.scale })),
      [
        { cx: 640, cy: 400, scale: 1.35 },
        { cx: 640, cy: 400, scale: 1 },
      ],
    );
    assert.notDeepEqual(plan.shots, auto.shots, "explicit shots must replace the auto plan");
    assert.ok(plan.keys.length > 0, "explicit shots still produce camera keyframes");
  });

  it("validation accepts well-formed shots and rejects malformed ones", () => {
    const good = baseInput([{ file: "a.png" }]);
    good.shots = [{ start: 0, end: 4000, cx: 640, cy: 400, scale: 1.35 }];
    assert.equal(validateReconstructionInput(good, dir).ok, true);

    for (const badShots of [
      [{ start: 4000, end: 4000, cx: 1, cy: 1, scale: 1 }], // end <= start
      [{ start: 0, end: 4000, cx: 1, cy: 1, scale: 0 }], // scale <= 0
      [{ start: 0, end: 4000, cx: 1, cy: 1 }], // missing scale
      "nope",
      [],
    ]) {
      const inp = baseInput([{ file: "a.png" }]);
      (inp as Record<string, unknown>).shots = badShots;
      const v = validateReconstructionInput(inp, dir);
      assert.equal(v.ok, false, JSON.stringify(badShots));
    }
  });
});

describe("Y: screenshotsDir cannot escape the input directory", () => {
  it("rejects absolute paths and .. segments", () => {
    for (const bad of ["../x", "..\\x", "/etc", "a/../../x"]) {
      const inp = baseInput([{ file: "a.png" }]);
      inp.screenshotsDir = bad;
      const v = validateReconstructionInput(inp, dir);
      assert.equal(v.ok, false, bad);
      assert.match(
        v.errors.map((e) => e.message).join("\n"),
        /must stay inside the input directory/,
      );
    }
    const good = baseInput([{ file: "a.png" }]);
    good.screenshotsDir = "frames";
    assert.equal(validateReconstructionInput(good, dir).ok, true);
  });
});
