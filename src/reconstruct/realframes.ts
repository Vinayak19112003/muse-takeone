/**
 * Managed real-frame capture path — the PRIMARY visual path.
 *
 * When a trace carries dense real frames (consecutive states with
 * `capture.dense`, e.g. per-frame scroll positions or per-character typing
 * states from a managed browser), TraceReel renders those frames directly:
 * every page pixel in the interval comes from a real captured screenshot.
 * The following are NEVER invoked for a dense real-frame interval:
 * scrollplan, NCC displacement reconstruction, B-strip reconstruction,
 * synthetic document translation, sticky/fixed-region inference, scrollbar
 * synthesis, or crossfades between the interval's frames.
 *
 * This module is deliberately free of runtime imports from build.ts (types
 * only): build.ts imports the pure helpers from here, never the reverse.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import type {
  ReconstructionAction,
  ReconstructionFrame,
} from "./build.js";
import type { RealFrameCapture } from "../trace/types.js";
import type { VisualSource } from "../types.js";
import { resolveFfmpeg } from "../ffmpeg.js";

const require = createRequire(import.meta.url);

/** Maximal run of consecutive dense frames, as inclusive input-frame indices. */
export interface DenseRun {
  start: number;
  end: number;
}

/** True when this frame is one capture of a dense real-frame sequence. */
export function isDenseFrame(frame: { capture?: { dense?: boolean } | undefined }): boolean {
  return frame.capture?.dense === true;
}

/**
 * Find maximal runs of 2+ consecutive dense frames. A lone dense frame is not
 * a run — it renders like any other frame.
 *
 * Runs never span an action boundary: consecutive dense frames whose action
 * association differs (see `actionKey`) start a new run, so e.g. dense
 * typing frames immediately followed by dense scroll frames form two runs,
 * each with its own enclosing action, timing, and event synthesis.
 *
 * `actionKey` maps a frame index to the id of the action that produced the
 * capture (e.g. `capture.actionId`, or an inferred `link:<kind>:<from>><to>`
 * key). When either of two adjacent frames has no key, they merge — the
 * boundary cannot be told apart, so the old grouping is preserved.
 */
export function detectDenseRuns(
  frames: readonly { capture?: { dense?: boolean; actionId?: string } | undefined }[],
  actionKey: (index: number) => string | undefined = (i) => frames[i].capture?.actionId,
): DenseRun[] {
  const runs: DenseRun[] = [];
  let start = -1;
  for (let i = 0; i < frames.length; i++) {
    if (isDenseFrame(frames[i])) {
      if (start < 0) {
        start = i;
      } else {
        const prevKey = actionKey(i - 1);
        const key = actionKey(i);
        if (prevKey !== undefined && key !== undefined && key !== prevKey) {
          if (i - start >= 2) runs.push({ start, end: i - 1 });
          start = i;
        }
      }
    } else if (start >= 0) {
      if (i - start >= 2) runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start >= 0 && frames.length - start >= 2) runs.push({ start, end: frames.length - 1 });
  return runs;
}

/** Which visual path an input's frames select. Explicit and inspectable. */
export function visualSourceForFrames(frames: ReconstructionFrame[]): VisualSource {
  const runs = detectDenseRuns(frames);
  if (runs.length === 0) return "reconstructed-sparse";
  const denseCount = frames.filter(isDenseFrame).length;
  return denseCount === frames.length ? "managed-real-frames" : "mixed";
}

/**
 * Per-frame playback times for a dense run.
 *
 * `capture.timelineMs` (legacy `capture.t`) is INTENDED PLAYBACK time —
 * synthetic output-timeline time, never wall-clock capture time. When every
 * capture in the run carries a non-decreasing stamp, playback honors the
 * spacing: frame i starts at startMs + (timelineMs[i] - timelineMs[0]),
 * clamped so no two frames are closer than one output frame. The run then
 * spans exactly timelineMs[last] - timelineMs[0], mirroring the uniform
 * fallback where the run spans the enclosing action's duration from first
 * to last frame.
 *
 * Otherwise (no stamps, partial stamps, or a regression) the run spreads
 * `uniformRunDurationMs` evenly from first to last frame. This is what keeps
 * physical capture latency out of the video: captures taken seconds apart in
 * wall-clock time (`capturedAt`) but with no playback timeline play back
 * across the enclosing action's desired duration.
 *
 * Only deltas matter: the epoch of the stamps is irrelevant.
 */
export function denseRunFrameTimes(
  runFrames: ReconstructionFrame[],
  startMs: number,
  uniformRunDurationMs: number,
  frameMs: number,
): { times: number[]; runEnd: number } {
  const n = runFrames.length;
  const uniform = () => {
    const step = n > 1 ? uniformRunDurationMs / (n - 1) : 0;
    const times = runFrames.map((_, i) => startMs + step * i);
    return { times, runEnd: startMs + uniformRunDurationMs };
  };
  if (n > 1) {
    // Playback timeline only. `capturedAt` (wall-clock provenance) is
    // deliberately never read here — it must not affect video duration.
    const ts = runFrames.map((f) => f.capture?.timelineMs ?? f.capture?.t);
    if (ts.every((t): t is number => typeof t === "number")) {
      const times = [startMs];
      for (let i = 1; i < n; i++) {
        const d = (ts[i] as number) - (ts[i - 1] as number);
        if (!(d >= 0)) return uniform(); // regression or NaN: fall back
        times.push(times[i - 1] + Math.max(d, frameMs));
      }
      return { times, runEnd: times[n - 1] };
    }
  }
  return uniform();
}

/**
 * The action a dense run belongs to: the first scroll/type/click/hover action
 * on the run's first frame. Returns the action and its index among the
 * frame's actions (actions before it, e.g. cursor positioning, play first).
 */
export function denseRunEnclosingAction(
  runFirstFrame: ReconstructionFrame,
): { action: ReconstructionAction; index: number } | undefined {
  const actions = runFirstFrame.actions ?? [];
  const index = actions.findIndex(
    (a) => a.kind === "scroll" || a.kind === "type" || a.kind === "click" || a.kind === "hover",
  );
  if (index < 0) return undefined;
  return { action: actions[index], index };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RealFrameIssue {
  severity: "error" | "warning";
  /** Machine-readable code, e.g. "DIMENSION_MISMATCH". */
  code: string;
  message: string;
  /** Index into the validated frame list, when the issue is frame-specific. */
  frameIndex?: number;
}

export interface RealFrameValidationOptions {
  /** Expected final scroll position for a scroll run; enables endpoint checks. */
  expectedEndScrollY?: number;
  /** Tolerance for the endpoint check, in px. Default 2. */
  endpointTolerancePx?: number;
  /** A jump larger than this between consecutive frames warns. Default: viewport height. */
  maxJumpPx?: number;
  /** Viewport height, used as the default maxJumpPx. */
  viewportHeight?: number;
  /** Skip the blank/black-frame probe (needs ffmpeg). Default false. */
  skipBlankCheck?: boolean;
  /** Precomputed sha1 hashes of the frame files, aligned with `frames`. Enables duplicate detection without re-reading. */
  fileHashes?: (string | undefined)[];
}

export interface RealFrameValidation {
  ok: boolean;
  errors: RealFrameIssue[];
  warnings: RealFrameIssue[];
}

/**
 * Pure metadata validation: ordering, scroll progression, jumps, duplicates,
 * endpoint. File existence/decodability/dimensions/blankness are checked by
 * validateRealFrameSequence (needs the filesystem + ffmpeg).
 */
export function validateRealFrameMetadata(
  frames: { file: string; capture?: RealFrameCapture }[],
  opts: RealFrameValidationOptions = {},
): RealFrameValidation {
  const errors: RealFrameIssue[] = [];
  const warnings: RealFrameIssue[] = [];
  const err = (code: string, message: string, frameIndex?: number) =>
    errors.push({ severity: "error", code, message, frameIndex });
  const warn = (code: string, message: string, frameIndex?: number) =>
    warnings.push({ severity: "warning", code, message, frameIndex });

  const maxJumpPx = opts.maxJumpPx ?? opts.viewportHeight ?? 1080;

  let prevOrder: number | undefined;
  let prevScrollY: number | undefined;
  const seenFiles = new Map<string, number>();
  frames.forEach((f, i) => {
    const c = f.capture;
    if (c?.order !== undefined) {
      if (prevOrder !== undefined && c.order <= prevOrder) {
        err("OUT_OF_ORDER", `frame ${i} (${f.file}) has capture.order ${c.order}, not after ${prevOrder}; captures must be chronological`, i);
      }
      prevOrder = c.order;
    }
    if (c?.scrollY !== undefined) {
      if (prevScrollY !== undefined) {
        const d = c.scrollY - prevScrollY;
        if (d < 0) {
          warn("NON_MONOTONIC_SCROLL", `frame ${i} (${f.file}) scrollY goes ${prevScrollY} -> ${c.scrollY}; scroll metadata should not move backwards`, i);
        } else if (d > maxJumpPx) {
          warn("LARGE_DISPLACEMENT", `frame ${i} (${f.file}) jumps ${d}px (limit ${maxJumpPx}px); a capture may be missing — recapture the gap`, i);
        }
      }
      prevScrollY = c.scrollY;
    }
    const prev = seenFiles.get(f.file);
    if (prev !== undefined) {
      warn("DUPLICATE_FRAME", `frame ${i} (${f.file}) repeats frame ${prev}; harmless when the browser legitimately did not move`, i);
    } else {
      seenFiles.set(f.file, i);
    }
  });

  // Duplicate pixel content (different files, identical bytes).
  if (opts.fileHashes) {
    const seenHash = new Map<string, number>();
    opts.fileHashes.forEach((h, i) => {
      if (!h) return;
      const prev = seenHash.get(h);
      if (prev !== undefined) {
        warn("DUPLICATE_FRAME", `frame ${i} (${frames[i].file}) is pixel-identical to frame ${prev}; harmless when the browser legitimately did not move`, i);
      } else seenHash.set(h, i);
    });
  }

  if (opts.expectedEndScrollY !== undefined) {
    const lastY = [...frames].reverse().find((f) => f.capture?.scrollY !== undefined)?.capture
      ?.scrollY;
    if (lastY === undefined) {
      warn("ENDPOINT_UNKNOWN", "expectedEndScrollY was given but no frame carries scrollY metadata; cannot verify the endpoint");
    } else {
      const tol = opts.endpointTolerancePx ?? 2;
      if (Math.abs(lastY - opts.expectedEndScrollY) > tol) {
        err("ENDPOINT_MISMATCH", `last captured scrollY is ${lastY}, expected ${opts.expectedEndScrollY} (±${tol}px); the scroll did not reach its destination — recapture the tail`, frames.length - 1);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Resolve ffprobe (same strategy as the audio prober). */
function resolveFfprobe(): string {
  const fromEnv = process.env.FFPROBE_PATH ?? process.env.TRACEREEL_FFPROBE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`ffprobe not found at ${fromEnv}`);
    return fromEnv;
  }
  try {
    const mod: string | { path?: string } | null = require("ffprobe-static");
    const p = typeof mod === "string" ? mod : mod?.path;
    if (p && existsSync(p)) return p;
  } catch {}
  throw new Error("ffprobe not found. Install ffprobe (it ships with ffmpeg) or set FFPROBE_PATH.");
}

/** Image dimensions via ffprobe. Throws a descriptive Error when the file is missing or undecodable. */
export function probeImageDimensions(path: string): { width: number; height: number } {
  if (!existsSync(path)) throw new Error(`frame file not found: ${path}`);
  let raw: string;
  try {
    raw = execFileSync(
      resolveFfprobe(),
      ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
  } catch (e) {
    throw new Error(`frame is not a decodable image: ${path} (${(e as Error).message.split("\n")[0]})`);
  }
  const width = Number(/"width":\s*(\d+)/.exec(raw)?.[1] ?? NaN);
  const height = Number(/"height":\s*(\d+)/.exec(raw)?.[1] ?? NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`frame is not a decodable image: ${path} (ffprobe returned no dimensions)`);
  }
  return { width, height };
}

/**
 * Max luma (0-255) a frame may have and still count as blank. A fully black
 * frame has max 0; 16 leaves headroom for near-black compression noise while
 * staying far below any real screenshot content. Deterministic: the same
 * image always yields the same pixel stats.
 */
export const BLANK_MAX_LUMA = 16;

/**
 * True when the frame is entirely (near-)black.
 *
 * Decodes the single still image to raw grayscale pixels and checks the max
 * luma — deterministic for one image. (The old ffmpeg `blackdetect=d=0.05`
 * probe was duration-based: a PNG decodes as one ~0.04s frame, so ffmpeg
 * could finish before the 0.05s black-duration requirement was ever met,
 * making the result depend on filter timing instead of the pixels.)
 *
 * Throws on decode failure so callers report the error explicitly instead
 * of silently treating an unreadable file as non-blank.
 */
export async function isBlankImage(path: string): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
  const bin = resolveFfmpeg();
  const proc = spawnSync(
    bin,
    [
      "-hide_banner", "-v", "error", "-i", path,
      "-vf", "scale=64:64,format=gray",
      "-frames:v", "1", "-f", "rawvideo", "-",
    ],
    { maxBuffer: 1024 * 1024 },
  );
  if (proc.error) {
    throw new Error(`blank-frame probe failed for ${path}: ${(proc.error as Error).message}`);
  }
  if (proc.status !== 0) {
    const detail = (proc.stderr?.toString() ?? "").split("\n")[0];
    throw new Error(`blank-frame probe failed for ${path}: ffmpeg exited ${proc.status}${detail ? `: ${detail}` : ""}`);
  }
  const px = proc.stdout as Buffer;
  if (px.length === 0) {
    throw new Error(`blank-frame probe returned no pixels for ${path}`);
  }
  let max = 0;
  for (let i = 0; i < px.length; i++) if (px[i] > max) max = px[i];
  return max < BLANK_MAX_LUMA;
}

export function sha1File(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

/**
 * Full validation of one dense real-frame sequence: file existence,
 * decodability, identical dimensions, no blank frames, plus the metadata
 * checks from validateRealFrameMetadata.
 *
 * Never repairs page pixels synthetically: problems are reported as
 * errors/warnings so the agent can recapture the bad frames.
 */
export async function validateRealFrameSequence(
  frames: { file: string; capture?: RealFrameCapture }[],
  baseDir: string,
  opts: RealFrameValidationOptions = {},
): Promise<RealFrameValidation> {
  const errors: RealFrameIssue[] = [];
  const warnings: RealFrameIssue[] = [];
  if (frames.length < 2) {
    errors.push({
      severity: "error",
      code: "INSUFFICIENT_FRAMES",
      message: `dense real-frame sequence has ${frames.length} frame(s); need at least 2 to play motion`,
    });
    return { ok: false, errors, warnings };
  }

  let dims: { width: number; height: number } | undefined;
  const hashes: (string | undefined)[] = [];
  for (let i = 0; i < frames.length; i++) {
    const abs = resolve(baseDir, frames[i].file);
    try {
      const d = probeImageDimensions(abs);
      if (!dims) dims = d;
      else if (d.width !== dims.width || d.height !== dims.height) {
        errors.push({
          severity: "error",
          code: "DIMENSION_MISMATCH",
          message: `frame ${i} (${frames[i].file}) is ${d.width}x${d.height}, expected ${dims.width}x${dims.height}; all frames in a sequence must share dimensions — recapture at one viewport`,
          frameIndex: i,
        });
      }
    } catch (e) {
      const msg = (e as Error).message;
      errors.push({
        severity: "error",
        code: msg.startsWith("frame file not found") ? "MISSING_CAPTURE" : "INVALID_IMAGE",
        message: `${msg}; recapture this frame`,
        frameIndex: i,
      });
      hashes.push(undefined);
      continue;
    }
    try {
      hashes.push(sha1File(abs));
    } catch {
      hashes.push(undefined);
    }
    if (!opts.skipBlankCheck) {
      try {
        if (await isBlankImage(abs)) {
          errors.push({
            severity: "error",
            code: "BLANK_FRAME",
            message: `frame ${i} (${frames[i].file}) is blank/black; recapture it`,
            frameIndex: i,
          });
        }
      } catch {
        warnings.push({
          severity: "warning",
          code: "BLANK_CHECK_FAILED",
          message: `frame ${i} (${frames[i].file}): blank-frame probe failed; skipping that check`,
          frameIndex: i,
        });
      }
    }
  }

  const meta = validateRealFrameMetadata(frames, { ...opts, fileHashes: hashes });
  errors.push(...meta.errors);
  warnings.push(...meta.warnings);

  // Density: did the agent capture roughly one frame per viewport of travel?
  // Fewer frames than that looks steppy no matter the playback rate.
  const scrollY0 = frames[0].capture?.scrollY;
  const scrollY1 = frames[frames.length - 1].capture?.scrollY;
  if (scrollY0 !== undefined && scrollY1 !== undefined) {
    const dist = Math.abs(scrollY1 - scrollY0);
    const minFrames = Math.max(2, Math.ceil(dist / (opts.viewportHeight ?? 1080)));
    if (frames.length < minFrames) {
      warnings.push({
        severity: "warning",
        code: "INSUFFICIENT_DENSE_FRAMES",
        message: `scroll covers ${dist}px with only ${frames.length} dense frames (rule of thumb: ≥${minFrames}, about one per viewport of travel); motion may look steppy — capture more intermediate positions`,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// QA (post-build, runs on the manifest — no ffmpeg needed)
// ---------------------------------------------------------------------------

export interface RealFrameQaWarning {
  category: "real-frames";
  code: string;
  message: string;
}

/**
 * QA specifically for real-frame capture. Runs on the input + manifest after
 * build; complements validateRealFrameSequence (which runs pre-build on the
 * files). All checks are objective and machine-readable; none of them is
 * fatal — warnings tell the agent what to recapture.
 */
export function qaRealFrameCapture(
  inputFrames: ReconstructionFrame[],
  manifest: import("../types.js").RecordingManifest,
): RealFrameQaWarning[] {
  const warnings: RealFrameQaWarning[] = [];
  const warn = (code: string, message: string) => warnings.push({ category: "real-frames", code, message });
  const runs = detectDenseRuns(inputFrames);
  const vw = manifest.viewport.width;
  const vh = manifest.viewport.height;

  for (const run of runs) {
    const runFrames = inputFrames.slice(run.start, run.end + 1);
    const n = runFrames.length;
    const enc = denseRunEnclosingAction(runFrames[0]);

    if (!enc) {
      warn("NO_ENCLOSING_ACTION",
        `dense run frames[${run.start}..${run.end}] (${n} frames) has no enclosing scroll/type/click/hover action; ` +
          `it plays back in realtime — attach the action that produced these captures`,
      );
    }

    // Capture order must be chronological.
    const orders = runFrames.map((f) => f.capture?.order);
    for (let i = 1; i < orders.length; i++) {
      if (orders[i] !== undefined && orders[i - 1] !== undefined && orders[i]! <= orders[i - 1]!) {
        warn("NON_CHRONOLOGICAL_ORDER", `dense run frames[${run.start}..${run.end}]: capture.order goes ${orders[i - 1]} -> ${orders[i]} at run offset ${i}; captures must be chronological`);
        break;
      }
    }

    // Playback timeline stamps: honored only when present on every capture and
    // non-decreasing; otherwise timing silently falls back to uniform, so a
    // partial or regressed stamp set deserves a warning. `capturedAt`
    // (wall-clock) is never a timing source and is not checked here.
    const tStamps = runFrames.map((f) => f.capture?.timelineMs ?? f.capture?.t);
    const tCount = tStamps.filter((t) => typeof t === "number").length;
    if (tCount > 0 && tCount < n) {
      warn("PARTIAL_TIMELINE", `dense run frames[${run.start}..${run.end}]: only ${tCount}/${n} captures carry a playback timeline (timelineMs/t); timing falls back to uniform — set timelineMs on all captures or none`);
    } else if (tCount === n) {
      for (let i = 1; i < n; i++) {
        if (!((tStamps[i] as number) >= (tStamps[i - 1] as number))) {
          warn("NON_MONOTONIC_TIMELINE", `dense run frames[${run.start}..${run.end}]: playback timeline regresses ${(tStamps[i - 1] as number)} -> ${(tStamps[i] as number)} at run offset ${i}; timing falls back to uniform — captures must be chronological`);
          break;
        }
      }
    }

    // Scroll runs: metadata should progress sensibly and reach the endpoint.
    // Direction-aware: a downward scroll's scrollY increases, an upward
    // scroll's decreases. Direction comes from the enclosing scroll action's
    // dy when available, else from the run's endpoints when they show clear
    // movement. Jump sizes are checked by absolute delta in both directions.
    const scrollYs = runFrames.map((f) => f.capture?.scrollY);
    if (scrollYs.every((y) => y !== undefined)) {
      const ys = scrollYs as number[];
      const dy = enc?.action.kind === "scroll" ? (enc.action.dy ?? 0) : 0;
      let dir: 1 | -1 | 0 = 0;
      if (dy !== 0) dir = dy > 0 ? 1 : -1;
      else {
        const net = ys[ys.length - 1] - ys[0];
        dir = net > 0 ? 1 : net < 0 ? -1 : 0;
      }
      const dirName = dir > 0 ? "downward" : "upward";
      for (let i = 1; i < ys.length; i++) {
        const delta = ys[i] - ys[i - 1];
        if (dir !== 0 && delta !== 0 && Math.sign(delta) !== dir) {
          warn("NON_MONOTONIC_SCROLL", `dense run frames[${run.start}..${run.end}]: scrollY moves against the ${dirName} scroll ${ys[i - 1]} -> ${ys[i]} at run offset ${i}; capture metadata is suspect`);
          break;
        }
        if (Math.abs(delta) > vh) {
          warn("LARGE_SCROLL_JUMP", `dense run frames[${run.start}..${run.end}]: scrollY jumps ${delta}px (|delta| > viewport height ${vh}) at run offset ${i}; a capture is probably missing`);
        }
      }
      if (enc?.action.kind === "scroll") {
        const declared = Math.abs(enc.action.dy ?? 0);
        const actual = Math.abs(ys[ys.length - 1] - ys[0]);
        if (declared > 0 && Math.abs(actual - declared) > Math.max(4, declared * 0.25)) {
          warn("ENDPOINT_MISMATCH", `dense run frames[${run.start}..${run.end}]: captured scroll covers ${actual}px but the action declares dy=${enc.action.dy}; the browser may have clamped — trust the captures, fix the action`);
        }
      }
    }

    // Viewport consistency with the manifest.
    for (let i = 0; i < runFrames.length; i++) {
      const cv = runFrames[i].capture?.viewport;
      if (cv && (cv.width !== vw || cv.height !== vh)) {
        warn("VIEWPORT_MISMATCH", `dense run frames[${run.start}..${run.end}]: frame ${run.start + i} was captured at ${cv.width}x${cv.height}, manifest viewport is ${vw}x${vh}`);
        break;
      }
    }

    // Duplicate files inside a run.
    const files = runFrames.map((f, i) => ({ file: f.file, i }));
    const seen = new Map<string, number>();
    for (const { file, i } of files) {
      const prev = seen.get(file);
      if (prev !== undefined) {
        warn("DUPLICATE_CAPTURE", `dense run frames[${run.start}..${run.end}]: frame ${run.start + i} (${file}) duplicates run offset ${prev}; harmless only if the browser legitimately did not move`);
      } else seen.set(file, i);
    }
  }

  // Lone dense frames (not in a run) render as ordinary frames; flag them so
  // the agent knows the dense marker had no effect.
  inputFrames.forEach((f, i) => {
    if (isDenseFrame(f) && !runs.some((r) => i >= r.start && i <= r.end)) {
      warn("LONE_DENSE_FRAME", `frame ${i} (${f.file}) is marked dense but has no dense neighbour; it renders as an ordinary frame — mark 2+ consecutive captures dense to form an interval`);
    }
  });

  return warnings;
}
