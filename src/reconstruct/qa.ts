/**
 * Post-build QA for reconstructed recordings: useful metrics plus warnings about
 * things that render but look wrong (aggressive zooms, lingering frames, clicks
 * landing mid-camera-move, ...). Runs on the manifest, so `validate` and
 * `inspect` get it without rendering.
 */
import { planReconstructionCamera } from "./shots.js";
import type { ReconstructionInput } from "./build.js";
import type { RecordingManifest } from "../types.js";

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

export interface ReconstructionQaReport {
  metrics: ReconstructionQaMetrics;
  warnings: string[];
}

export function qaReconstruction(input: ReconstructionInput, manifest: RecordingManifest): ReconstructionQaReport {
  const cfg = manifest.config;
  const events = manifest.events;
  const count = (t: string) => events.filter((e) => e.type === t).length;
  const typedChars = events.filter((e) => e.type === "key").length;

  const { shots, keys } = planReconstructionCamera(manifest, cfg);
  const warnings: string[] = [];

  // Aggressive zooms: the routine scale is ~1.35; anything near maxScale deserves a look.
  for (const s of shots) {
    if (s.scale > 2.5) {
      warnings.push(
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
      warnings.push(`rapid camera reversal at ${b.t}ms: the camera reverses direction ${gap}ms after arriving; consider one direct reframe`);
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
      warnings.push(
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
      warnings.push(
        `frame "${f.file}" lingers ${((end - lastT) / 1000).toFixed(1)}s after its last action: ` +
          `if the beat is intentional use a wait action, otherwise shorten holdMs`,
      );
    }
  });

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
  return { metrics, warnings };
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
