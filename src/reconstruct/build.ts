/**
 * Build a reconstructed recording manifest from real screenshots plus an action script.
 *
 * This is the programmatic core of `takeone reconstruct`. Muse (or anyone) captures
 * real screenshots in the source browser (normally Muse's own managed browser session),
 * notes where it clicked/typed in each one, and
 * this module synthesizes the cursor and click event stream the compositor needs:
 * 60Hz eased cursor glides along curved paths, mousedown/mouseup pairs, and key events.
 * The manifest comes out with mode "reconstructed", so render() plans shot-level camera
 * work instead of click-driven auto-zoom.
 *
 * Input is deliberately general: no site-specific coordinates, text, or hacks live here.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { curvedPath, resolveEasing } from "../motion.js";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../config.js";
import type {
  FrameIndexEntry,
  Point,
  RecordedEvent,
  RecordingManifest,
  ReconstructionSource,
  ScenarioConfig,
  UserScenarioConfig,
} from "../types.js";

/** One click inside a frame, in screenshot (viewport CSS px) coordinates. */
export interface ReconstructionClick {
  x: number;
  y: number;
  /** Pause after the click before the next action, in ms. Default 700. */
  pauseMs?: number;
}

/** One typing action inside a frame, at the given point. */
export interface ReconstructionType {
  x: number;
  y: number;
  text: string;
  /** WPM-ish pacing; only affects event spacing, not the visual result. Default 240 chars/min. */
  cpm?: number;
  /** Pause after typing before the next action, in ms. Default 700. */
  pauseMs?: number;
}

export type ReconstructionAction =
  | ({ kind: "click" } & ReconstructionClick)
  | ({ kind: "type" } & ReconstructionType);

/** One screenshot and the actions performed while it is (mostly) on screen. */
export interface ReconstructionFrame {
  file: string;
  /** How long the screenshot stays up before the next cut, in ms. Default 2600. */
  holdMs?: number;
  /** Ordered actions: the cursor glides to each target, clicks, or types. */
  actions?: ReconstructionAction[];
  /** Narrative caption shown while this frame is up. */
  caption?: string;
}

/** The `takeone reconstruct` input file. */
export interface ReconstructionInput {
  /** Viewport CSS size the screenshots were taken at. */
  viewport: { width: number; height: number };
  /** Directory holding the screenshot files; resolved relative to the input file. Default ".". */
  screenshotsDir?: string;
  frames: ReconstructionFrame[];
  /**
   * Capture provenance: where the screenshots came from. Optional for backwards
   * compatibility. When the workflow runs in Muse's managed browser this must be
   * `{ "type": "muse-managed-browser" }`; use `--require-source` to enforce it.
   * Preserved verbatim in the generated manifest. Never affects rendering.
   */
  source?: ReconstructionSource;
}

export interface BuildReconstructionOptions {
  input: ReconstructionInput;
  /** Directory of the input file; frame paths resolve against it. */
  baseDir: string;
  /** Working directory: gets frames/ plus manifest.json. Created if missing. */
  workDir: string;
  /** Extra config overrides on top of the reconstruction defaults. */
  config?: UserScenarioConfig;
  /**
   * Enforce capture provenance: throw unless `input.source.type` matches.
   * Makes an accidental capture fallback (e.g. screenshots from a fresh browser
   * when the workflow ran in the managed one) fail loudly instead of silently
   * producing a video from the wrong session.
   */
  requireSource?: ReconstructionSource["type"];
  log?: (msg: string) => void;
}

const SAMPLE_DT = 1000 / 60; // 60Hz cursor samples, like a real capture
const CLICK_HOLD = 130; // mousedown -> mouseup
const DEFAULT_PAUSE = 700;
const DEFAULT_HOLD = 2600;
const GLIDE_MS_PER_PX = 0.55;
const GLIDE_MIN = 420;
const GLIDE_MAX = 1100;

/** Every known capture-source type. Kept in code so --require-source typos fail loudly. */
export const RECONSTRUCTION_SOURCE_TYPES: ReconstructionSource["type"][] = [
  "muse-managed-browser",
  "external-browser",
  "manual-screenshots",
];

/** Eased cursor samples from `from` to `to` starting at `t0`. Returns the arrival time. */
function glide(
  events: RecordedEvent[],
  from: Point,
  to: Point,
  t0: number,
): number {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 1) return t0;
  const dur = Math.min(GLIDE_MAX, Math.max(GLIDE_MIN, dist * GLIDE_MS_PER_PX));
  const path = curvedPath(from, to, 0.12);
  const ease = resolveEasing("smooth");
  const n = Math.max(2, Math.round(dur / SAMPLE_DT));
  for (let i = 1; i <= n; i++) {
    const p = path(ease(i / n));
    events.push({ type: "mouse", t: t0 + (dur * i) / n, x: Math.round(p.x), y: Math.round(p.y) });
  }
  return t0 + dur;
}

/**
 * Synthesize the event stream for one frame's actions. The cursor starts where the
 * previous frame left it; between frames it stays put (no glide across a cut).
 */
function synthesizeFrameEvents(
  frame: ReconstructionFrame,
  frameStart: number,
  cursor: Point,
  events: RecordedEvent[],
): number {
  let t = frameStart + 250; // let the cut's crossfade breathe before the cursor moves
  for (const a of frame.actions ?? []) {
    const target = { x: a.x, y: a.y };
    t = glide(events, cursor, target, t);
    cursor.x = target.x;
    cursor.y = target.y;
    if (a.kind === "click") {
      events.push({ type: "mousedown", t, x: a.x, y: a.y, button: "left" });
      events.push({ type: "mouseup", t: t + CLICK_HOLD, x: a.x, y: a.y, button: "left" });
      t += CLICK_HOLD + (a.pauseMs ?? DEFAULT_PAUSE);
    } else {
      // Typing: one insertText event, paced like real typing so toasts stay sane.
      const cpm = a.cpm ?? 240;
      const perChar = 60000 / cpm;
      const chunks = Math.max(1, Math.ceil(a.text.length / 8));
      for (let i = 0; i < chunks; i++) {
        events.push({ type: "key", t: t + i * perChar * 8, key: "insertText", x: a.x, y: a.y, source: "type" });
      }
      t += chunks * perChar * 8 + (a.pauseMs ?? DEFAULT_PAUSE);
    }
  }
  return t;
}

export function buildReconstructionManifest(
  input: ReconstructionInput,
  cfg: ScenarioConfig,
): RecordingManifest {
  const vw = input.viewport.width, vh = input.viewport.height;
  if (!input.frames.length) throw new Error("Reconstruction input has no frames");
  const frames: FrameIndexEntry[] = [];
  const events: RecordedEvent[] = [];
  const captions: { start: number; end: number; text: string }[] = [];
  const cursor: Point = { x: vw / 2, y: vh / 2 };
  let t = 0;

  for (const frame of input.frames) {
    frames.push({ t: Math.round(t), file: basename(frame.file) });
    // Seed one cursor sample at the cut so a worker starting mid-video has a position.
    events.push({ type: "mouse", t: Math.round(t), x: Math.round(cursor.x), y: Math.round(cursor.y) });
    const actionsEnd = synthesizeFrameEvents(frame, t, cursor, events);
    const frameEnd = Math.max(t + (frame.holdMs ?? DEFAULT_HOLD), actionsEnd + 400);
    if (frame.caption) {
      captions.push({ start: Math.round(t), end: Math.round(frameEnd), text: frame.caption });
    }
    t = frameEnd;
  }

  events.sort((a, b) => a.t - b.t);
  const duration = Math.round(t);
  return {
    version: 1,
    mode: "reconstructed",
    source: input.source,
    createdAt: new Date().toISOString(),
    config: cfg,
    viewport: { width: vw, height: vh, deviceScaleFactor: 1 },
    frameSize: { width: vw, height: vh },
    frames,
    events,
    duration,
    captions,
  };
}

/** Fail loudly when the required capture source is not what the input claims. */
function checkSource(input: ReconstructionInput, requireSource?: ReconstructionSource["type"]): void {
  if (!requireSource) return;
  if (!RECONSTRUCTION_SOURCE_TYPES.includes(requireSource)) {
    throw new Error(
      `--require-source ${JSON.stringify(requireSource)} is not a known source type. ` +
        `Expected one of: ${RECONSTRUCTION_SOURCE_TYPES.join(", ")}.`,
    );
  }
  const actual = input.source?.type;
  if (actual !== requireSource) {
    throw new Error(
      `--require-source ${requireSource} but the input claims source ` +
        `${actual === undefined ? "(none)" : JSON.stringify(actual)}. ` +
        `Refusing to reconstruct: the screenshots did not come from the expected capture browser. ` +
        `Fix the capture source, or drop --require-source if you really mean to use these screenshots.`,
    );
  }
}

/**
 * Write a reconstruction working directory: copies the screenshots into frames/,
 * writes manifest.json with the reconstruction defaults, and returns the manifest.
 * `takeone render <workDir>` on the result is byte-identical to `takeone reconstruct`.
 */
export function writeReconstructionDir(opts: BuildReconstructionOptions): { workDir: string; manifest: RecordingManifest } {
  const log = opts.log ?? (() => {});
  checkSource(opts.input, opts.requireSource);
  const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS, opts.config);
  const manifest = buildReconstructionManifest(opts.input, cfg);
  const workDir = resolve(opts.workDir);
  const framesDir = join(workDir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const shotsDir = resolve(opts.baseDir, opts.input.screenshotsDir ?? ".");
  const seen = new Set<string>();
  for (const frame of opts.input.frames) {
    const src = resolve(shotsDir, frame.file);
    if (!existsSync(src)) throw new Error(`Screenshot not found: ${src}`);
    const dest = join(framesDir, basename(frame.file));
    if (!seen.has(dest)) {
      copyFileSync(src, dest);
      seen.add(dest);
    }
  }
  mkdirSync(dirname(join(workDir, "manifest.json")), { recursive: true });
  writeFileSync(join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const src = opts.input.source;
  log(`Capture source: ${src?.type ?? "unspecified (backwards compatible)"}`);
  log(`Frames: ${manifest.frames.length}, viewport: ${manifest.viewport.width}x${manifest.viewport.height}`);
  if (src?.session) log(`Source session: ${src.session}`);
  log("Renderer: TakeOne compositor Chromium (local frames only)");
  log("Target-site navigation by renderer: none");
  log(`Reconstruction manifest: ${manifest.frames.length} frames, ${manifest.events.length} events -> ${workDir}`);
  return { workDir, manifest };
}
