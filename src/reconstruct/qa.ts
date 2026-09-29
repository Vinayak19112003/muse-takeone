/**
 * Post-build QA for reconstructed recordings: useful metrics plus warnings about
 * things that render but look wrong (aggressive zooms, lingering frames, clicks
 * landing mid-camera-move, ...). Runs on the manifest, so `validate` and
 * `inspect` get it without rendering.
 */
import { planReconstructionCamera } from "./shots.js";
import type { ReconstructionInput } from "./build.js";
import type { RecordingManifest } from "../types.js";
import { detectDenseRuns, qaRealFrameCapture } from "./realframes.js";

export interface ReconstructionQaMetrics {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  screenshots: number;
  clicks: number;
  typedChars: number;
  scrolls: number;
  hovers: number;
  waits: number;
  cameraShots: number;
  transitions: number;
  captions: number;
  events: number;
}

/** Warning buckets. No global quality score: counts per bucket are the signal. */
export type QaWarningCategory = "camera" | "timing" | "missing-state" | "viewport" | "real-frames" | "other";

export interface CategorizedWarning {
  category: QaWarningCategory;
  message: string;
}

export interface ReconstructionQaReport {
  metrics: ReconstructionQaMetrics;
  /** Flat messages, kept for backward compatibility. */
  warnings: string[];
  categorized: CategorizedWarning[];
  warningCounts: Record<QaWarningCategory, number>;
}

const emptyCounts = (): Record<QaWarningCategory, number> => ({
  camera: 0,
  timing: 0,
  "missing-state": 0,
  viewport: 0,
  "real-frames": 0,
  other: 0,
});

export function qaReconstruction(input: ReconstructionInput, manifest: RecordingManifest): ReconstructionQaReport {
  const cfg = manifest.config;
  const events = manifest.events;
  const count = (t: string) => events.filter((e) => e.type === t).length;
  const typedChars = events.filter((e) => e.type === "key").length;

  const { shots, keys } = planReconstructionCamera(manifest, cfg);
  const categorized: CategorizedWarning[] = [];
  const warn = (category: QaWarningCategory, message: string) => categorized.push({ category, message });

  // Aggressive zooms: the routine scale is ~1.35; anything near maxScale deserves a look.
  for (const s of shots) {
    if (s.scale > 2.5) {
      warn("camera",
        `aggressive zoom at ${s.start}ms: scale ${s.scale.toFixed(2)} is far above the routine 1.35x; ` +
          `check the target is really that small`,
      );
    }
  }

  // Rapid camera reversals: the camera goes one way, then immediately back.
  const moves = keys.filter((k) => k.target.scale > 1.01);
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i];
    const gap = b.t - (a.t + a.duration);
    if (gap < 0 || gap > 900) continue;
    // Compare against the key before a for a real direction change.
    const prev = moves[i - 2] ?? { target: { cx: manifest.viewport.width / 2, cy: manifest.viewport.height / 2 } };
    const v1x = a.target.cx - prev.target.cx, v1y = a.target.cy - prev.target.cy;
    const v2x = b.target.cx - a.target.cx, v2y = b.target.cy - a.target.cy;
    const dot = v1x * v2x + v1y * v2y;
    if (dot < 0 && Math.hypot(v1x, v1y) > 60 && Math.hypot(v2x, v2y) > 60) {
      warn("camera", `rapid camera reversal at ${b.t}ms: the camera reverses direction ${gap}ms after arriving; consider one direct reframe`);
    }
  }

  // Excessive camera changes: more reframing than the story needs.
  const zoomShots = shots.filter((s) => s.scale > 1.01);
  const zoomBudget = Math.max(4, Math.ceil(manifest.duration / 15000));
  if (zoomShots.length > zoomBudget) {
    warn("camera",
      `excessive camera changes: ${zoomShots.length} zoom shots in ${(manifest.duration / 1000).toFixed(1)}s ` +
        `(budget ~${zoomBudget}); the video may feel restless. Group nearby actions so one reframe covers them`,
    );
  }

  // Abrupt zoom jumps: the scale more than doubles between consecutive shots with no breathing room.
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1], b = shots[i];
    const gap = b.start - a.end;
    if (gap < 400 && a.scale > 1.01 && b.scale > 1.01 && (b.scale / a.scale > 2 || a.scale / b.scale > 2)) {
      warn("camera",
        `abrupt zoom jump at ${b.start}ms: scale goes ${a.scale.toFixed(2)}x -> ${b.scale.toFixed(2)}x ` +
          `${gap}ms after the previous shot ends; ease it with a longer transition or an intermediate reframe`,
      );
    }
  }

  // Unnecessary reset: zoom in, back to full frame, zoom in again — the middle
  // reset usually adds motion without meaning.
  for (let i = 2; i < shots.length; i++) {
    const a = shots[i - 2], b = shots[i - 1], c = shots[i];
    if (a.scale > 1.2 && b.scale <= 1.01 && c.scale > 1.2 && c.start - a.end < 8000) {
      warn("camera",
        `unnecessary camera reset at ${b.start}ms: the camera returns to full frame between two close-up shots; ` +
          `consider cutting directly from one reframe to the next`,
      );
    }
  }

  // Camera shots aimed outside the viewport: they frame empty space.
  const vw = manifest.viewport.width, vh = manifest.viewport.height;
  for (const s of shots) {
    if (s.cx < 0 || s.cx > vw || s.cy < 0 || s.cy > vh) {
      warn("viewport",
        `camera shot at ${s.start}ms is centred at (${Math.round(s.cx)}, ${Math.round(s.cy)}), ` +
          `outside the ${vw}x${vh} viewport; it will frame empty space`,
      );
    }
  }

  // Clicks landing while the camera is still moving. Ease-out moves are perceptually
  // settled in their last quarter, so only the first 75% of a zoom-in counts as "moving".
  const moving = keys
    .filter((k) => k.target.scale > 1.01)
    .map((k) => [k.t, k.t + k.duration * 0.75] as [number, number]);
  for (const e of events) {
    if (e.type !== "mousedown") continue;
    if (moving.some(([s, en]) => e.t > s && e.t < en)) {
      warn("camera",
        `camera still moving at click (${e.x}, ${e.y}) t=${e.t}ms: ` +
          `the click lands mid-reframe, which reads as jitter. Increase settle time or move the shot earlier.`,
      );
    }
  }

  // Frames that linger long after their last action with no explicit wait.
  const frames = manifest.frames;
  input.frames.forEach((f, fi) => {
    if (fi >= frames.length - 1) return;
    const start = frames[fi].t, end = frames[fi + 1].t;
    const hasWait = (f.actions ?? []).some((a) => a.kind === "wait");
    if (hasWait) return;
    let lastT = -1;
    for (const e of events) {
      if (e.t < start || e.t >= end) continue;
      if (e.type === "mousedown" || e.type === "key" || e.type === "scroll" || e.type === "hover") lastT = Math.max(lastT, e.t);
    }
    if (lastT >= 0 && end - lastT > 2500) {
      warn("timing",
        `frame "${f.file}" lingers ${((end - lastT) / 1000).toFixed(1)}s after its last action: ` +
          `if the beat is intentional use a wait action, otherwise shorten holdMs`,
      );
    }
  });

  // Very short states: a frame with actions that is on screen for less than a
  // beat — the viewer never settles before the cut. Dense real frames are
  // exempt: their short dwell IS the motion.
  const denseIdx = new Set<number>();
  for (const r of detectDenseRuns(input.frames)) {
    for (let i = r.start; i <= r.end; i++) denseIdx.add(i);
  }
  input.frames.forEach((f, fi) => {
    if (fi >= frames.length - 1) return;
    if (denseIdx.has(fi)) return;
    const visibleMs = frames[fi + 1].t - frames[fi].t;
    const nActions = (f.actions ?? []).length;
    if (nActions > 0 && visibleMs < 700) {
      warn("timing",
        `frame "${f.file}" is on screen only ${Math.round(visibleMs)}ms with ${nActions} action(s): ` +
          `too short to read. Lengthen holdMs or merge it with a neighbour`,
      );
    }
  });

  // Scroll visual continuity: a scroll action declares durationMs, and the visual
  // scroll into the next frame should play over approximately that long. These
  // are objective, measurable checks — no quality scores.
  const fps = cfg.output.fps > 0 ? cfg.output.fps : 60;
  const frameMs = 1000 / fps;
  input.frames.forEach((f, fi) => {
    if (fi >= frames.length - 1) return;
    // Dense real-frame intervals are the visual scroll: the slide-transition
    // continuity checks below do not apply to them.
    if (denseIdx.has(fi) && denseIdx.has(fi + 1)) return;
    const actions = f.actions ?? [];
    const last = actions[actions.length - 1];
    if (!last || last.kind !== "scroll") return;
    const sdx = last.dx ?? 0, sdy = last.dy ?? 700;
    const dist = Math.hypot(sdx, sdy);
    if (dist === 0) return;
    const declaredMs = last.durationMs ?? 600;
    const nextTi = frames[fi + 1]?.transitionIn as unknown;
    const isSlide = typeof nextTi === "object" && nextTi !== null &&
      (nextTi as Record<string, unknown>).kind === "slide";
    const slideMs = isSlide ? (nextTi as Record<string, unknown>).durationMs : undefined;
    // The visual scroll duration: a timed slide plays over its own durationMs,
    // a legacy slide (or crossfade) over the generic transition duration.
    const visualMs = isSlide && typeof slideMs === "number" && slideMs > 0
      ? slideMs
      : cfg.transition.duration;
    if (visualMs < declaredMs * 0.9) {
      warn("timing",
        `SCROLL_VISUAL_TOO_SHORT: frame "${f.file}" declares a ${declaredMs}ms scroll ` +
          `of ${Math.round(dist)}px, but the visual transition lasts only ${Math.round(visualMs)}ms; ` +
          `the scroll will read as a jump. Give the slide a durationMs matching the scroll.`,
      );
    }
    if (visualMs < 2 * frameMs) {
      warn("timing",
        `SCROLL_DISCONTINUITY: frame "${f.file}" scroll transition lasts ${visualMs.toFixed(1)}ms ` +
          `(< 2 frames at ${fps}fps); the scroll happens within a single frame. Lengthen durationMs.`,
      );
    }
    const perFramePx = dist / Math.max(1, visualMs / frameMs);
    if (perFramePx > 100) {
      warn("timing",
        `SCROLL_LARGE_FRAME_JUMP: frame "${f.file}" scrolls ${Math.round(dist)}px in ` +
          `${Math.round(visualMs)}ms (${perFramePx.toFixed(0)}px per frame at ${fps}fps); ` +
          `a single frame moves the whole distance. Reduce the distance or lengthen the duration.`,
      );
    }
  });

  // Missing final state: the last thing the viewer sees is an action whose
  // result never appears (validate flags this too; QA repeats it post-build
  // because it is the single most common broken-demo shape).
  const lastInputFrame = input.frames[input.frames.length - 1];
  const lastActions = lastInputFrame?.actions ?? [];
  const lastMeaningful = [...lastActions].reverse().find((a) => a.kind !== "wait");
  if (lastMeaningful && ["click", "type", "scroll", "hover"].includes(lastMeaningful.kind)) {
    warn("missing-state",
      `the video ends on a ${lastMeaningful.kind} whose result is never shown: ` +
        `capture the post-action screenshot and append it as a final state`,
    );
  }

  // Managed real-frame capture QA: missing captures, dimension/provenance
  // mismatches, non-monotonic scroll metadata, large displacements,
  // duplicates, endpoint mismatches, insufficient dense frames.
  for (const w of qaRealFrameCapture(input.frames, manifest)) {
    categorized.push(w);
  }

  const warningCounts = emptyCounts();
  for (const w of categorized) warningCounts[w.category] += 1;
  const metrics: ReconstructionQaMetrics = {
    durationMs: manifest.duration,
    width: cfg.output.width,
    height: cfg.output.height,
    fps: cfg.output.fps,
    screenshots: frames.length,
    clicks: count("mousedown"),
    typedChars,
    scrolls: count("scroll"),
    hovers: count("hover"),
    waits: (input.frames.flatMap((f) => f.actions ?? []).filter((a) => a.kind === "wait") as unknown[]).length,
    cameraShots: shots.length,
    transitions: Math.max(0, frames.length - 1),
    captions: manifest.captions?.length ?? 0,
    events: events.length,
  };
  return { metrics, warnings: categorized.map((w) => w.message), categorized, warningCounts };
}

/** One-line human-readable summary of the metrics, for CLI output. */
export function formatQaMetrics(m: ReconstructionQaMetrics): string {
  return [
    `duration ${(m.durationMs / 1000).toFixed(1)}s, ${m.width}x${m.height}@${m.fps}`,
    `${m.screenshots} screenshots, ${m.transitions} transitions, ${m.cameraShots} camera shots`,
    `${m.clicks} clicks, ${m.typedChars} typed chars, ${m.scrolls} scrolls, ${m.hovers} hovers, ${m.waits} waits`,
    `${m.captions} captions, ${m.events} timeline events`,
  ].join(" | ");
}

/** One-line summary of warning counts by bucket, e.g. "2 camera, 1 timing". */
export function formatWarningCounts(counts: Record<QaWarningCategory, number>): string {
  const parts = (Object.keys(counts) as QaWarningCategory[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`);
  return parts.length ? parts.join(", ") : "no warnings";
}
