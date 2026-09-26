/**
 * Build a reconstructed recording manifest from real screenshots plus an action script.
 *
 * This is the programmatic core of `muse-takeone reconstruct`. Muse (or anyone) captures
 * real screenshots in the source browser (normally Muse's own managed browser session),
 * notes where it clicked/typed/scrolled in each one, and this module synthesizes the
 * cursor and click event stream the compositor needs: 60Hz eased cursor glides along
 * curved paths, mousedown/mouseup pairs, per-character key events, and hover markers.
 * The manifest comes out with mode "reconstructed", so render() plans shot-level camera
 * work instead of click-driven auto-zoom.
 *
 * Input is deliberately general: no site-specific coordinates, text, or hacks live here.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { curvedPath, resolveEasing } from "../motion.js";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../config.js";
import { applyRedactions } from "./redact.js";
import type {
  CameraShot,
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
  /** Pause after the cursor arrives before mousedown, in ms. Default 120. */
  preClickMs?: number;
  /** How long the mouse button is held, in ms. Default 130. */
  clickHoldMs?: number;
  /** Pause after mouseup before the next action, in ms. Default 700. */
  pauseMs?: number;
  /**
   * How soon after mouseup the next screenshot appears, in ms. Default 200.
   * Only the frame's LAST action uses this; the ripple (450ms) keeps playing
   * across the cut because ripples are timeline-global, not frame-bound.
   */
  nextFrameAfterMs?: number;
}

/** One typing action inside a frame, at the given point. */
export interface ReconstructionType {
  x: number;
  y: number;
  text: string;
  /** Typing speed in characters per minute. Default 240. */
  cpm?: number;
  /** Pause after the last character before the next action, in ms. Default 700. */
  pauseMs?: number;
  /**
   * Show the typed text in the on-screen keyboard HUD (a growing pill, like live
   * typing). Default true. Set false for anything the viewer should not read.
   */
  showKeys?: boolean;
  /**
   * Mark this input as sensitive (a password, token, or secret). The keyboard HUD
   * is hidden by default for sensitive inputs. Never put real secrets in a demo.
   */
  sensitive?: boolean;
  /** How soon after the last character the next screenshot appears, in ms. Default 200. */
  nextFrameAfterMs?: number;
}

/** One scroll inside a frame. The next screenshot shows the post-scroll state. */
export interface ReconstructionScroll {
  /** Where the cursor rests during the scroll. Default: wherever it already is. */
  x?: number;
  y?: number;
  /** Scroll delta in CSS px. Default { dx: 0, dy: 700 }. */
  dx?: number;
  dy?: number;
  /** How long the scroll beat lasts, in ms. Default 600. */
  durationMs?: number;
  /** Pause after the scroll before the next action, in ms. Default 500. */
  pauseMs?: number;
  /** How soon after the scroll the next screenshot appears, in ms. Default 200. */
  nextFrameAfterMs?: number;
}

/** One hover inside a frame. A later screenshot can show the tooltip/menu state. */
export interface ReconstructionHover {
  x: number;
  y: number;
  /** Pause while hovering (lets the tooltip/menu appear) before the next action, in ms. Default 800. */
  pauseMs?: number;
  /** How soon after the hover beat the next screenshot appears, in ms. Default 200. */
  nextFrameAfterMs?: number;
}

/**
 * An explicit viewer pause: storytelling time, separate from the browser-state
 * transition delay. The cursor stays put; the timeline just waits.
 */
export interface ReconstructionWait {
  /** Pause duration in ms. */
  durationMs: number;
  /** How soon after the wait the next screenshot appears, in ms. Default 120. */
  nextFrameAfterMs?: number;
}

export type ReconstructionAction =
  | ({ kind: "click" } & ReconstructionClick)
  | ({ kind: "type" } & ReconstructionType)
  | ({ kind: "scroll" } & ReconstructionScroll)
  | ({ kind: "hover" } & ReconstructionHover)
  | ({ kind: "wait" } & ReconstructionWait);

/** How the video arrives at this frame from the previous one. */
export type ReconstructionTransitionIn =
  | "crossfade"
  | "cut"
  | { kind: "slide"; dx: number; dy: number };

/** One screenshot and the actions performed while it is (mostly) on screen. */
export interface ReconstructionFrame {
  file: string;
  /**
   * Minimum time the screenshot stays up, in ms. Default: 2600 when the frame has
   * no actions, 0 when it has actions (the action choreography drives the cut).
   * Use an explicit `wait` action for storytelling beats, not a long holdMs.
   */
  holdMs?: number;
  /** Ordered actions: the cursor glides to each target, clicks, types, scrolls, hovers. */
  actions?: ReconstructionAction[];
  /** Narrative caption shown while this frame is up. */
  caption?: string;
  /**
   * How the video arrives at THIS frame. Default "crossfade". "cut" is instant.
   * A slide moves the old screenshot while the new one fades in (used for scrolls).
   * When unset and the previous frame's last action was a scroll, a slide in the
   * scroll direction is used automatically.
   */
  transitionIn?: ReconstructionTransitionIn;
  /** Regions to redact (blur/solid/pixelate) in this frame before rendering. */
  redactions?: RedactionRegion[];
}

/** One region to redact from a screenshot before rendering. */
export interface RedactionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "blur" | "solid" | "pixelate";
}

/** Cursor glide tuning for reconstructed recordings. */
export interface ReconstructionMotion {
  /** Cursor speed in ms per px of travel. Default 0.55. */
  msPerPx?: number;
  /** Minimum glide duration in ms. Default 420. */
  minMs?: number;
  /** Maximum glide duration in ms. Default 1100. */
  maxMs?: number;
}

/** The `muse-takeone reconstruct` input file. */
export interface ReconstructionInput {
  /** Schema version. Currently 1; validation rejects anything else. */
  version?: number;
  /** Viewport CSS size the screenshots were taken at. */
  viewport: { width: number; height: number };
  /** Directory holding the screenshot files; resolved relative to the input file. Default ".". */
  screenshotsDir?: string;
  frames: ReconstructionFrame[];
  /**
   * Capture provenance: where the screenshots came from. Optional for backwards
   * compatibility. When the workflow runs in Muse's managed browser this must be
   * `{ "type": "muse-managed-browser" }`; use `--require-source` to enforce it.
   * Preserved verbatim in the generated manifest. Never affects rendering, and it
   * is declarative, not cryptographic: nothing in a PNG proves which tool wrote it.
   */
  source?: ReconstructionSource;
  /** Regions redacted from EVERY frame before rendering (see RedactionRegion). */
  redactions?: RedactionRegion[];
  /** Cursor glide tuning overrides. */
  motion?: ReconstructionMotion;
  /**
   * Explicit camera shots, overriding the automatic shot planner entirely.
   * Times are in source ms — the synthetic timeline `muse-takeone inspect` prints
   * (each frame's `@Ns` timestamp). Run inspect first, then author shots around
   * the frames you want reframed. Each shot: `{ start, end, cx, cy, scale }`
   * (centre in viewport CSS px, scale like 1.35), optional `transitionDuration`
   * (output ms) and `easing`.
   */
  shots?: CameraShot[];
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
const CUT_BREATHE_MS = 250; // let the cut's crossfade breathe before the cursor moves
const DEFAULT_HOLD_NO_ACTIONS = 2600;
const DEFAULT_CPM = 240;

const NEXT_FRAME_AFTER = {
  click: 200,
  type: 200,
  scroll: 200,
  hover: 200,
  wait: 120,
} as const;

/** Every known capture-source type. Kept in code so --require-source typos fail loudly. */
export const RECONSTRUCTION_SOURCE_TYPES: ReconstructionSource["type"][] = [
  "muse-managed-browser",
  "external-browser",
  "manual-screenshots",
];

/** Deterministic 0..1 hash: typing jitter must not change between runs. */
function hash01(seed: number): number {
  let h = Math.imul(seed | 0, 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export interface GlideOptions {
  msPerPx: number;
  minMs: number;
  maxMs: number;
}

/** Eased cursor samples from `from` to `to` starting at `t0`. Returns the arrival time. */
function glide(
  events: RecordedEvent[],
  from: Point,
  to: Point,
  t0: number,
  motion: GlideOptions,
): number {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 1) return t0;
  const dur = Math.min(motion.maxMs, Math.max(motion.minMs, dist * motion.msPerPx));
  const path = curvedPath(from, to, 0.12);
  const ease = resolveEasing("smooth");
  const n = Math.max(2, Math.round(dur / SAMPLE_DT));
  for (let i = 1; i <= n; i++) {
    const p = path(ease(i / n));
    events.push({ type: "mouse", t: t0 + (dur * i) / n, x: Math.round(p.x), y: Math.round(p.y) });
  }
  return t0 + dur;
}

interface SynthesizedAction {
  kind: ReconstructionAction["kind"];
  /** Timestamp of the action's last event (mouseup, last char, scroll end, ...). */
  eventEnd: number;
  /** How soon after eventEnd the next screenshot appears. */
  nextFrameAfterMs: number;
  /** Scroll deltas, for the automatic slide transition. */
  scrollDx?: number;
  scrollDy?: number;
}

/**
 * Synthesize the event stream for one frame's actions. The cursor starts where the
 * previous frame left it; between frames it stays put (no glide across a cut).
 * Returns the time after the final pause plus per-action timing for the cut.
 */
function synthesizeFrameEvents(
  frame: ReconstructionFrame,
  frameIndex: number,
  frameStart: number,
  cursor: Point,
  events: RecordedEvent[],
  motion: GlideOptions,
): { endT: number; actions: SynthesizedAction[] } {
  let t = frameStart + CUT_BREATHE_MS;
  const done: SynthesizedAction[] = [];
  const actions = frame.actions ?? [];
  actions.forEach((a, ai) => {
    if (a.kind === "wait") {
      t += a.durationMs;
      done.push({ kind: "wait", eventEnd: t, nextFrameAfterMs: a.nextFrameAfterMs ?? NEXT_FRAME_AFTER.wait });
      return;
    }
    const hasTarget = a.kind !== "scroll" || a.x !== undefined || a.y !== undefined;
    const target = {
      x: a.kind === "scroll" ? (a.x ?? cursor.x) : a.x,
      y: a.kind === "scroll" ? (a.y ?? cursor.y) : a.y,
    };
    if (hasTarget) {
      t = glide(events, cursor, target, t, motion);
      cursor.x = target.x;
      cursor.y = target.y;
    }
    if (a.kind === "click") {
      t += a.preClickMs ?? 120; // small settle: the cursor lands, then the click
      const hold = a.clickHoldMs ?? 130;
      events.push({ type: "mousedown", t, x: a.x, y: a.y, button: "left" });
      events.push({ type: "mouseup", t: t + hold, x: a.x, y: a.y, button: "left" });
      const eventEnd = t + hold;
      t = eventEnd + (a.pauseMs ?? 700);
      done.push({ kind: "click", eventEnd, nextFrameAfterMs: a.nextFrameAfterMs ?? NEXT_FRAME_AFTER.click });
    } else if (a.kind === "type") {
      // Per-character key events: the camera planner treats the burst as one focus,
      // and the keyboard HUD renders it as a growing text pill (like live typing).
      // Jitter is deterministic so the same input always renders the same video.
      const show = a.showKeys ?? (a.sensitive ? false : true);
      const perChar = 60000 / (a.cpm ?? DEFAULT_CPM);
      const chars = [...a.text]; // code points, so emoji survive
      chars.forEach((ch, i) => {
        if (i > 0) t += perChar * (0.85 + 0.3 * hash01(frameIndex * 100003 + ai * 1013 + i * 17 + 7));
        events.push({ type: "key", t, key: ch, x: a.x, y: a.y, source: "type", show });
      });
      const eventEnd = t;
      t = eventEnd + (a.pauseMs ?? 700);
      done.push({ kind: "type", eventEnd, nextFrameAfterMs: a.nextFrameAfterMs ?? NEXT_FRAME_AFTER.type });
    } else if (a.kind === "scroll") {
      const dx = a.dx ?? 0, dy = a.dy ?? 700;
      t += a.durationMs ?? 600; // the scroll beat; the next frame shows the result
      events.push({ type: "scroll", t, dx, dy });
      const eventEnd = t;
      t = eventEnd + (a.pauseMs ?? 500);
      done.push({ kind: "scroll", eventEnd, nextFrameAfterMs: a.nextFrameAfterMs ?? NEXT_FRAME_AFTER.scroll, scrollDx: dx, scrollDy: dy });
    } else {
      // hover: glide there, dwell, and leave a marker so the camera planner frames it.
      // Never a click: no mousedown/mouseup, no ripple.
      events.push({ type: "hover", t, x: a.x, y: a.y });
      const eventEnd = t;
      t = eventEnd + (a.pauseMs ?? 800);
      done.push({ kind: "hover", eventEnd, nextFrameAfterMs: a.nextFrameAfterMs ?? NEXT_FRAME_AFTER.hover });
    }
  });
  return { endT: t, actions: done };
}

export function buildReconstructionManifest(
  input: ReconstructionInput,
  cfg: ScenarioConfig,
): RecordingManifest {
  const vw = input.viewport.width, vh = input.viewport.height;
  if (!input.frames.length) throw new Error("Reconstruction input has no frames");
  const motion: GlideOptions = {
    msPerPx: input.motion?.msPerPx ?? 0.55,
    minMs: input.motion?.minMs ?? 420,
    maxMs: input.motion?.maxMs ?? 1100,
  };
  const frames: FrameIndexEntry[] = [];
  const events: RecordedEvent[] = [];
  const captions: { start: number; end: number; text: string }[] = [];
  const cursor: Point = { x: vw / 2, y: vh / 2 };
  let t = 0;
  let prevLastAction: SynthesizedAction | null = null;

  input.frames.forEach((frame, fi) => {
    const isLast = fi === input.frames.length - 1;
    // How we arrive at this frame. A scroll at the end of the previous frame
    // automatically becomes a directional slide so the movement reads on screen.
    let transitionIn: FrameIndexEntry["transitionIn"] = frame.transitionIn;
    if (transitionIn === undefined && prevLastAction?.kind === "scroll") {
      const k = 0.35;
      const maxDx = vw * 0.3, maxDy = vh * 0.3;
      const dx = Math.max(-maxDx, Math.min(maxDx, (prevLastAction.scrollDx ?? 0) * k));
      const dy = Math.max(-maxDy, Math.min(maxDy, (prevLastAction.scrollDy ?? 0) * k));
      // Content moves opposite the scroll gesture: scrolling down pushes the old
      // screenshot up while the new one fades in.
      if (dx !== 0 || dy !== 0) transitionIn = { kind: "slide", dx: -dx, dy: -dy };
    }
    frames.push({ t: Math.round(t), file: basename(frame.file), transitionIn });
    // Seed one cursor sample at the cut so a worker starting mid-video has a position.
    events.push({ type: "mouse", t: Math.round(t), x: Math.round(cursor.x), y: Math.round(cursor.y) });
    const syn = synthesizeFrameEvents(frame, fi, t, cursor, events, motion);
    const last = syn.actions[syn.actions.length - 1] ?? null;
    prevLastAction = last;
    let frameEnd: number;
    if (last && !isLast) {
      // The action that caused the UI change is immediately followed by the new
      // screenshot: click -> ripple -> ~200ms -> next state. No fake lingering.
      frameEnd = last.eventEnd + last.nextFrameAfterMs;
    } else if (last) {
      frameEnd = syn.endT + 400; // final frame: let the last beat land
    } else {
      frameEnd = t + (frame.holdMs ?? DEFAULT_HOLD_NO_ACTIONS);
    }
    // An explicit holdMs is always a floor, never shortened.
    if (frame.holdMs !== undefined) frameEnd = Math.max(frameEnd, t + frame.holdMs);
    if (frame.caption) {
      captions.push({ start: Math.round(t), end: Math.round(frameEnd), text: frame.caption });
    }
    t = frameEnd;
  });

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
    ...(input.shots ? { shots: input.shots } : {}),
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
 * Write a reconstruction working directory: copies the screenshots into frames/
 * (applying redactions), writes manifest.json with the reconstruction defaults,
 * and returns the manifest. `muse-takeone render <workDir>` on the result is
 * byte-identical to `muse-takeone reconstruct`.
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
  const globalRedactions = opts.input.redactions ?? [];
  for (const frame of opts.input.frames) {
    const src = resolve(shotsDir, frame.file);
    if (!existsSync(src)) throw new Error(`Screenshot not found: ${src}`);
    const dest = join(framesDir, basename(frame.file));
    if (!seen.has(dest)) {
      const regions = [...globalRedactions, ...(frame.redactions ?? [])];
      if (regions.length) {
        applyRedactions(src, dest, regions, opts.input.viewport, log);
      } else {
        copyFileSync(src, dest);
      }
      seen.add(dest);
    }
  }
  mkdirSync(dirname(join(workDir, "manifest.json")), { recursive: true });
  writeFileSync(join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const src = opts.input.source;
  log(`Capture source: ${src?.type ?? "unspecified (backwards compatible)"}`);
  log(`Frames: ${manifest.frames.length}, viewport: ${manifest.viewport.width}x${manifest.viewport.height}`);
  if (src?.session) log(`Source session: ${src.session}`);
  if (src?.captureTool) log(`Capture tool: ${src.captureTool}`);
  if (src?.capturedAt) log(`Captured at: ${src.capturedAt}`);
  log("Renderer: TakeOne compositor Chromium (local frames only)");
  log("Target-site navigation by renderer: none");
  log(`Reconstruction manifest: ${manifest.frames.length} frames, ${manifest.events.length} events -> ${workDir}`);
  return { workDir, manifest };
}
