/**
 * TraceReel agent-neutrality and adapter tests.
 *
 * A. Muse normalization (legacy muse-managed-browser -> agent-browser/muse + deprecation warning)
 * B. Grokbot-style trace normalizes through the grokbot adapter
 * C. Unknown "future-agent" works through the generic adapter
 * D. Legacy muse-managed-browser input builds a manifest end to end
 * E. Agent identity does not alter render output
 * Plus: state-first conversion, structured error codes, TraceBuilder, bundles,
 * and --require-source semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeTrace,
  getAdapter,
  listAdapters,
  traceToReconstructionInput,
  statesToFrames,
  assertRequireSource,
  TraceBuilder,
  writeBundle,
  loadBundle,
  MUSE_CAPABILITIES,
} from "../src/index.js";
import { validateReconstructionInput } from "../src/reconstruct/validate.js";
import { buildReconstructionManifest } from "../src/reconstruct/build.js";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureFrames = join(here, "fixtures", "qa", "frames");

/** Copy two real fixture PNGs into a temp dir; return the dir. */
function shotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracereel-test-"));
  copyFileSync(join(fixtureFrames, "01-post.png"), join(dir, "a.png"));
  copyFileSync(join(fixtureFrames, "02-liked.png"), join(dir, "b.png"));
  return dir;
}

function legacyMuseInput() {
  return {
    version: 1,
    source: { type: "muse-managed-browser", session: "main", captureTool: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [
      { file: "a.png", actions: [{ kind: "click", x: 100, y: 100 }], caption: "home" },
      { file: "b.png" },
    ],
  };
}

function grokbotStateInput() {
  return {
    version: 1,
    source: { type: "agent-browser", agent: "grokbot", session: "s-1" },
    viewport: { width: 1280, height: 800 },
    states: [
      { id: "s1", screenshot: "a.png", caption: "home" },
      { id: "s2", screenshot: "b.png", caption: "liked" },
    ],
    actions: [
      { kind: "click", from: "s1", to: "s2", x: 100, y: 100, stateDelayMs: 600 },
    ],
  };
}

test("A: legacy muse-managed-browser normalizes to agent-browser/muse with a deprecation warning", () => {
  const { trace, warnings, adapter } = normalizeTrace(legacyMuseInput());
  assert.equal(adapter.name, "muse");
  assert.equal(trace.source?.type, "agent-browser");
  assert.equal(trace.source?.agent, "muse");
  assert.equal(trace.source?.session, "main");
  assert.ok(warnings.some((w) => w.includes("deprecated")), `expected a deprecation warning, got: ${warnings.join("; ")}`);
});

test("A2: explicit --adapter muse on a sourceless legacy input assumes muse (warned)", () => {
  const { trace, warnings, adapter } = normalizeTrace(
    { viewport: { width: 1280, height: 800 }, frames: [{ file: "a.png" }] },
    { adapter: "muse" },
  );
  assert.equal(adapter.name, "muse");
  assert.equal(trace.source?.agent, "muse");
  assert.ok(warnings.length > 0);
});

test("B: grokbot-style states/actions trace normalizes with the agent preserved", () => {
  const { trace, warnings, adapter } = normalizeTrace(grokbotStateInput());
  assert.equal(adapter.name, "grokbot");
  assert.equal(adapter.verified, false);
  assert.equal(trace.source?.agent, "grokbot");
  assert.equal(trace.states?.length, 2);
  assert.equal(trace.actions?.length, 1);
  assert.ok(warnings.length === 0, `unexpected warnings: ${warnings.join("; ")}`);
});

test("C: unknown future-agent works through the generic adapter, name preserved", () => {
  const input = {
    version: 1,
    source: { type: "agent-browser", agent: "future-agent" },
    viewport: { width: 1280, height: 800 },
    frames: [{ file: "a.png" }, { file: "b.png" }],
  };
  const { trace, adapter } = normalizeTrace(input);
  assert.equal(adapter.name, "generic");
  assert.equal(trace.source?.agent, "future-agent");
});

test("C2: getAdapter falls back to generic for unknown names", () => {
  assert.equal(getAdapter("definitely-not-an-agent").name, "generic");
  assert.deepEqual(listAdapters().map((a) => a.name), ["muse", "grokbot", "generic"]);
});

test("D: legacy muse-managed-browser input converts to an engine input and builds a manifest", () => {
  const { trace } = normalizeTrace(legacyMuseInput());
  const engineInput = traceToReconstructionInput(trace);
  assert.equal(engineInput.frames.length, 2);
  assert.equal(engineInput.frames[0].actions?.length, 1);
  assert.equal(engineInput.source?.type, "agent-browser");
  const manifest = buildReconstructionManifest(engineInput, resolveConfig(RECONSTRUCTION_DEFAULTS));
  assert.equal(manifest.frames.length, 2);
  assert.ok(manifest.events.some((e) => (e as { type?: string }).type === "mousedown"));
});

test("E: agent identity does not alter render output", () => {
  const base = grokbotStateInput();
  const forAgents = ["muse", "grokbot", "future-agent"].map((agent) => {
    const input = { ...base, source: { ...base.source, agent } };
    const { trace } = normalizeTrace(input, { adapter: "generic" });
    return traceToReconstructionInput(trace);
  });
  const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS);
  const manifests = forAgents.map((ei) => {
    const m = buildReconstructionManifest(ei, cfg);
    // createdAt is wall-clock; source carries the agent name by design.
    // Everything else must be identical across agents.
    const { source: _s, createdAt: _c, ...rest } = m as Record<string, unknown>;
    return rest;
  });
  assert.deepEqual(manifests[1], manifests[0]);
  assert.deepEqual(manifests[2], manifests[0]);
});

test("F: states/actions convert to frames; stateDelayMs becomes nextFrameAfterMs", () => {
  const { trace } = normalizeTrace(grokbotStateInput());
  const frames = statesToFrames(trace);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].file, "a.png");
  assert.equal(frames[0].caption, "home");
  assert.equal(frames[0].actions?.length, 1);
  assert.equal((frames[0].actions?.[0] as Record<string, unknown>).nextFrameAfterMs, 600);
  assert.equal(frames[1].file, "b.png");
});

test("G: structured error codes with paths and suggestions", () => {
  const dir = shotDir();
  const bad = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [{ file: "a.png", actions: [{ kind: "click", x: 2000, y: 100 }] }, { file: "b.png" }],
  };
  const v = validateReconstructionInput(bad, dir);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, "COORD_OUTSIDE_VIEWPORT");
  assert.equal(v.errors[0].path, "frames[0].actions[0].x");
  assert.ok(v.errors[0].message.includes("2000"));
  assert.ok((v.errors[0].suggestion ?? "").length > 0);
});

test("G2: mixed states[] and frames[] is a hard error", () => {
  const dir = shotDir();
  const mixed = {
    version: 1,
    viewport: { width: 1280, height: 800 },
    states: [{ id: "s1", screenshot: "a.png" }],
    frames: [{ file: "a.png" }],
  };
  const v = validateReconstructionInput(mixed, dir);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "MIXED_TRACE_FORMS"));
});

test("G3: missing post-action state warns with a code", () => {
  const dir = shotDir();
  const dangling = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [{ file: "a.png", actions: [{ kind: "click", x: 100, y: 100 }] }],
  };
  const v = validateReconstructionInput(dangling, dir);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.code === "MISSING_STATE_AFTER_ACTION"));
});

test("H: TraceBuilder produces a valid trace", () => {
  const dir = shotDir();
  const t = new TraceBuilder({ agent: "muse", viewport: { width: 1280, height: 800 }, session: "demo" });
  const s1 = t.state("s1", "a.png", { caption: "Home." });
  const s2 = t.state("s2", "b.png");
  t.click({ from: s1, to: s2, x: 640, y: 400, stateDelayMs: 500 });
  t.caption(s2, "Liked.");
  t.redact(s2, { x: 0, y: 0, width: 200, height: 40, mode: "blur" });
  const trace = t.build();
  assert.equal(trace.source?.agent, "muse");
  assert.equal(trace.states?.length, 2);
  const { trace: normalized } = normalizeTrace(trace, { adapter: "muse" });
  const v = validateReconstructionInput(traceToReconstructionInput(normalized), dir);
  assert.equal(v.ok, true);
  assert.deepEqual(normalized.capabilities?.screenshots, MUSE_CAPABILITIES.screenshots);
});

test("I: bundle round-trip preserves the trace and frames", () => {
  const dir = shotDir();
  const t = new TraceBuilder({ agent: "muse", viewport: { width: 1280, height: 800 } });
  t.state("s1", "a.png");
  t.state("s2", "b.png");
  t.click({ from: "s1", to: "s2", x: 10, y: 10 });
  const { trace, adapter } = normalizeTrace(t.build(), { adapter: "muse" });
  const outDir = mkdtempSync(join(tmpdir(), "tracereel-bundle-"));
  const { dir: bundleDir, metadata } = writeBundle(join(outDir, "demo"), trace, {
    framesSourceDir: dir,
    adapter: adapter.name,
    warnings: [],
  });
  assert.ok(bundleDir.endsWith(".tracereel"));
  assert.equal(metadata.agent, "muse");
  assert.equal(metadata.traceForm, "states");
  const loaded = loadBundle(bundleDir);
  assert.equal(loaded.trace.states?.length, 2);
  assert.equal(loaded.frameFiles.length, 2);
  for (const f of loaded.frameFiles) {
    readFileSync(f); // throws if missing
  }
});

test("J: --require-source semantics across the normalization boundary", () => {
  const muse = normalizeTrace(legacyMuseInput());
  const museEngine = traceToReconstructionInput(muse.trace);
  // Legacy value keeps working for Muse traces.
  assertRequireSource("muse-managed-browser", muse.trace, museEngine);
  assertRequireSource("agent-browser", muse.trace, museEngine);
  const grok = normalizeTrace(grokbotStateInput());
  const grokEngine = traceToReconstructionInput(grok.trace);
  // A grokbot trace must NOT pass a muse-only gate.
  assert.throws(() => assertRequireSource("muse-managed-browser", grok.trace, grokEngine), (e: unknown) => {
    assert.equal((e as { code?: string }).code, "SOURCE_MISMATCH");
    return true;
  });
  assertRequireSource("agent-browser", grok.trace, grokEngine);
  // Unknown required type is still rejected by the engine's own gate (unchanged behavior).
  assert.throws(
    () => assertRequireSource("nope", grok.trace, grokEngine),
    /--require-source "nope"/,
  );
});
