/**
 * Shot-level camera planning for reconstructed recordings.
 *
 * Native TakeOne recordings use click-driven auto-zoom (see planCamera in
 * ../compositor/plan.ts): every click gets its own zoom-in, then the camera falls back
 * to 1x. That philosophy breaks on sparse reconstructions, where interactions are
 * seconds apart: the viewer gets zoom-in, click, zoom-out, zoom-in, click, zoom-out.
 *
 * Reconstructed mode instead plans in SHOTS. One shot is a settled camera framing that
 * covers several related interactions. The camera moves once into the shot (arriving
 * settled just before the first interaction), stays put while the cursor does the work,
 * and only moves again when the next important target leaves the shot's useful visual
 * region. No automatic return to 1x between nearby interactions.
 */
import type { CameraShot, CameraTarget, Easing, Point, RecordingManifest, ScenarioConfig } from "../types.js";
import { clamp } from "../motion.js";
import type { CameraKeyframe } from "../compositor/plan.js";

/** An interaction that deserves the viewer's visual attention. */
export interface FocusEvent {
  t: number;
  x: number;
  y: number;
}

/**
 * Clicks, typing bursts, and hovers, in source-time order.
 *
 * Typing emits one key event per character; only the first character of a burst
 * becomes a focus event (a burst is >1.2s or >3px away from the previous focus).
 * Without the dedupe, a 40-character field would plan 40 identical shots.
 * Hovers are real interactions the viewer must see (tooltips, menus), so they
 * focus the camera — but they are never treated as clicks downstream.
 */
export function extractFocusEvents(manifest: RecordingManifest): FocusEvent[] {
  const foci: FocusEvent[] = [];
  const isNewBurst = (t: number, x: number, y: number) => {
    const last = foci[foci.length - 1];
    return !last || t - last.t > 1200 || Math.hypot(x - last.x, y - last.y) > 3;
  };
  for (const ev of manifest.events) {
    if (ev.type === "mousedown") foci.push({ t: ev.t, x: ev.x, y: ev.y });
    else if (ev.type === "hover") foci.push({ t: ev.t, x: ev.x, y: ev.y });
    else if (ev.type === "key" && ev.x !== undefined && ev.y !== undefined && isNewBurst(ev.t, ev.x, ev.y)) {
      foci.push({ t: ev.t, x: ev.x, y: ev.y });
    }
  }
  foci.sort((a, b) => a.t - b.t);
  return foci;
}

interface FocusGroup {
  points: FocusEvent[];
  cx: number;
  cy: number;
}

/**
 * Group focus events into shots. Two interactions share a shot when they happen within
 * `groupGap` ms of each other AND the new target falls inside the current shot's useful
 * visual region (the inner ~70% of the routine-scale view). A far-away target starts a
 * new shot even when it arrives quickly: that becomes a smooth reframe, never a
 * zoom-out/zoom-in pair.
 */
export function groupFocusEvents(foci: FocusEvent[], cfg: ScenarioConfig, vw: number, vh: number): FocusGroup[] {
  const r = cfg.reconstruction;
  const groups: FocusGroup[] = [];
  const viewW = vw / r.routineScale, viewH = vh / r.routineScale;
  for (const f of foci) {
    const g = groups[groups.length - 1];
    const last = g?.points[g.points.length - 1];
    const nearby =
      g !== undefined &&
      last !== undefined &&
      f.t - last.t <= r.groupGap &&
      Math.abs(f.x - g.cx) < viewW * 0.35 &&
      Math.abs(f.y - g.cy) < viewH * 0.35;
    if (nearby && g && last) {
      g.points.push(f);
      g.cx = g.points.reduce((s, p) => s + p.x, 0) / g.points.length;
      g.cy = g.points.reduce((s, p) => s + p.y, 0) / g.points.length;
    } else {
      groups.push({ points: [f], cx: f.x, cy: f.y });
    }
  }
  return groups;
}

/** Framing for one group: fit its bounding box, capped at the routine scale. */
function frameGroup(g: FocusGroup, cfg: ScenarioConfig, vw: number, vh: number): CameraTarget {
  const r = cfg.reconstruction;
  const pad = Math.min(vw, vh) * 0.08;
  const xs = g.points.map((p) => p.x), ys = g.points.map((p) => p.y);
  const x0 = Math.max(0, Math.min(...xs) - pad), x1 = Math.min(vw, Math.max(...xs) + pad);
  const y0 = Math.max(0, Math.min(...ys) - pad), y1 = Math.min(vh, Math.max(...ys) + pad);
  // Scale so the whole region fits; a single point gets the full routine scale, a wide
  // region pulls back toward 1x instead of cropping.
  let scale = Math.min(r.routineScale, vw / Math.max(1, x1 - x0), vh / Math.max(1, y1 - y0), cfg.zoom.maxScale);
  if (scale < 1.05) scale = 1;
  const viewW = vw / scale, viewH = vh / scale;
  return {
    cx: clamp((x0 + x1) / 2, viewW / 2, vw - viewW / 2),
    cy: clamp((y0 + y1) / 2, viewH / 2, vh - viewH / 2),
    scale,
  };
}

/**
 * Turn focus groups into camera shots. The move into a shot starts early enough that the
 * camera is settled `settleMs` before the first interaction; the shot holds `releaseMs`
 * past its final interaction so the viewer sees the result.
 */
export function planShots(manifest: RecordingManifest, cfg: ScenarioConfig): CameraShot[] {
  const r = cfg.reconstruction;
  const { width: vw, height: vh } = manifest.viewport;
  const groups = groupFocusEvents(extractFocusEvents(manifest), cfg, vw, vh);
  return groups.map((g) => {
    const first = g.points[0].t, last = g.points[g.points.length - 1].t;
    const target = frameGroup(g, cfg, vw, vh);
    return {
      start: Math.max(0, first - r.transitionMs - r.settleMs),
      end: last + r.releaseMs,
      cx: target.cx,
      cy: target.cy,
      scale: target.scale,
      transitionDuration: r.transitionMs,
      easing: cfg.zoom.easing,
    };
  });
}

const FULL_TARGET = (vw: number, vh: number): CameraTarget => ({ cx: vw / 2, cy: vh / 2, scale: 1 });

/**
 * Shots to camera keyframes (source-time). Consecutive shots reframe directly into each
 * other: only the final shot releases back to the full overview, and a release is skipped
 * when the next shot already starts before it (the next shot simply takes over).
 */
export function shotsToKeyframes(shots: CameraShot[], cfg: ScenarioConfig, vw: number, vh: number): CameraKeyframe[] {
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  const keys: CameraKeyframe[] = [];
  sorted.forEach((s, i) => {
    keys.push({
      t: s.start,
      target: { cx: s.cx, cy: s.cy, scale: s.scale },
      duration: s.transitionDuration ?? cfg.reconstruction.transitionMs,
      easing: (s.easing ?? cfg.zoom.easing) as Easing,
      follow: false,
    });
    const next = sorted[i + 1];
    if (!next || next.start >= s.end) {
      keys.push({
        t: s.end,
        target: FULL_TARGET(vw, vh),
        duration: s.transitionDuration ?? cfg.reconstruction.transitionMs,
        easing: cfg.zoom.easing,
        follow: false,
      });
    }
  });
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

const isFull = (t: CameraTarget) => t.scale <= 1.01;

/**
 * Remove redundant transitions from a camera plan:
 * - a return-to-full that is quickly followed by a zoom into (nearly) the region we just
 *   left becomes a direct reframe;
 * - consecutive keys aimed at (nearly) the same target collapse into one.
 * Conservative by design: it only drops moves that add no new information.
 */
export function optimizeCameraKeys(keys: CameraKeyframe[]): CameraKeyframe[] {
  const out: CameraKeyframe[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const prev = out[out.length - 1];
    const next = keys[i + 1];
    if (isFull(k.target) && prev && next && !isFull(next.target)) {
      const gap = next.t - (k.t + k.duration);
      const d = Math.hypot(next.target.cx - prev.target.cx, next.target.cy - prev.target.cy);
      if (gap < 900 && d < 220 && Math.abs(next.target.scale - prev.target.scale) < 0.2) continue;
    }
    if (prev && !isFull(prev.target) && !isFull(k.target)) {
      const d = Math.hypot(k.target.cx - prev.target.cx, k.target.cy - prev.target.cy);
      if (d < 40 && Math.abs(k.target.scale - prev.target.scale) < 0.05 && k.t - prev.t < 1500) continue;
    }
    out.push(k);
  }
  return out;
}

export interface CameraPlanAudit {
  warnings: string[];
}

/**
 * QA checks over a camera plan. Run on the pre-optimization keys to catch redundant
 * resets; run again after optimization to confirm the plan is clean.
 */
export function auditCameraPlan(keys: CameraKeyframe[]): CameraPlanAudit {
  const warnings: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const prev = keys[i - 1];
    const next = keys[i + 1];
    if (isFull(k.target) && prev && next && !isFull(prev.target) && !isFull(next.target)) {
      const gap = next.t - (k.t + k.duration);
      const d = Math.hypot(next.target.cx - prev.target.cx, next.target.cy - prev.target.cy);
      if (gap < 1500 && d < 250) {
        warnings.push(
          `redundant reset at ${k.t}ms: zoom-out followed ${gap}ms later by a zoom ${d.toFixed(0)}px from the previous framing; reframe directly instead`,
        );
      }
    }
    if (prev && !isFull(prev.target) && !isFull(k.target)) {
      const d = Math.hypot(k.target.cx - prev.target.cx, k.target.cy - prev.target.cy);
      if (d < 40 && Math.abs(k.target.scale - prev.target.scale) < 0.05) {
        warnings.push(`dead key at ${k.t}ms: target is ${d.toFixed(0)}px from the previous keyframe`);
      }
    }
    if (!isFull(k.target) && k.target.scale < 1.15) {
      warnings.push(`micro-zoom at ${k.t}ms: scale ${k.target.scale.toFixed(2)} is barely above 1x; use the overview instead`);
    }
  }
  return { warnings };
}

/** Source-time windows the timeline must not cut inside: every shot move plus a margin. */
export function shotBusyWindows(keys: CameraKeyframe[], margin = 120): [number, number][] {
  return keys
    .map((k) => [k.t - margin, k.t + k.duration + margin] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/** Convenience: plan, convert, optimize and audit in one go. */
export function planReconstructionCamera(
  manifest: RecordingManifest,
  cfg: ScenarioConfig,
): { shots: CameraShot[]; keys: CameraKeyframe[]; audit: CameraPlanAudit } {
  const { width: vw, height: vh } = manifest.viewport;
  const shots = manifest.shots ?? planShots(manifest, cfg);
  const keys = optimizeCameraKeys(shotsToKeyframes(shots, cfg, vw, vh));
  return { shots, keys, audit: auditCameraPlan(keys) };
}
