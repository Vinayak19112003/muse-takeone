/**
 * Pure frame-instruction planning for the compositor.
 *
 * render.ts used to build these instructions inline. Extracting them here keeps the
 * render loop thin and makes the timeline logic unit-testable — in particular the
 * crossfade bookkeeping, which must be deterministic across parallel render workers.
 *
 * Transition model (stateless by design): each instruction carries everything its worker
 * needs. When the screenshot changes, the frames inside the crossfade window name
 * `previousFile` explicitly, so a worker that starts mid-transition can load both images
 * itself instead of depending on what a previous worker left in the compositor page.
 * Crossfade progress is measured in OUTPUT time so the duration stays correct under
 * trimming and time-lapse.
 */
import type { FrameIndexEntry, Point, ScenarioConfig } from "../types.js";
import { clamp, lerp } from "../motion.js";
import {
  crossesCut,
  cursorAt,
  frameIndexAt,
  keyHudAt,
  outToSource,
  sourceToOutput,
  type CameraState,
  type CursorSample,
  type KeptRange,
  type KeyHud,
  type KeyToast,
} from "./plan.js";

export interface FrameInstruction {
  file: string;
  /**
   * Screenshot shown before `file` when this frame is inside a crossfade after a cut.
   * Present exactly on the frames where `mix` is not null, so every worker can load both
   * images deterministically without relying on compositor page state.
   */
  previousFile?: string;
  cam: { px: number; py: number; scale: number };
  cursor: { x: number; y: number; pressed: boolean; visible: boolean } | null;
  ripples: { x: number; y: number; p: number }[];
  uiScale: number;
  hud: KeyHud | null;
  caption: string | null;
  /**
   * Crossfade progress right after a screenshot cut: 0 = previous screenshot fully
   * visible, 1 = new screenshot fully visible. Null when no cut happened in the last
   * transition window, so stills hold without blending. Measured in output ms.
   */
  mix: number | null;
  /**
   * Directional slide applied to the previous screenshot during a transition, in
   * composition px at mix = 1 (scaled by eased mix progress). Used for scrolls so
   * the direction of movement reads on screen. Undefined for plain crossfades.
   */
  slide?: { x: number; y: number };
  /**
   * True when this frame is inside a true scroll transition (a slide carrying
   * durationMs): both screenshots translate so overlapping content stays aligned,
   * over the scroll's own duration, with no crossfade. Timed scrolls render in
   * the pre-cut window [nextFrameStart - durationMs, nextFrameStart], so a D-ms
   * scroll occupies ~D ms of visual time, not 2D. The renderer uses this to
   * pick the scroll drawing path instead of the crossfade-slide path.
   */
  isScroll?: boolean;
}

export interface ClickDown {
  t: number;
  up: number;
  x: number;
  y: number;
}

export interface InstructionPlanInput {
  frames: FrameIndexEntry[];
  fps: number;
  ranges: KeptRange[];
  totalFrames: number;
  /** Camera state evaluated at OUTPUT time (native: wrapped so it still evaluates source time). */
  camAtOut: (tOut: number) => CameraState;
  samples: CursorSample[];
  downs: ClickDown[];
  keyToasts: KeyToast[];
  captions?: { start: number; end: number; text: string }[];
  content: { x: number; y: number; w: number; h: number };
  /** Viewport CSS width, for the content-to-viewport scale. */
  vw: number;
  W: number;
  H: number;
  cfg: ScenarioConfig;
  /** Crossfade duration after a screenshot cut, in output ms. */
  transitionMs: number;
}

/**
 * Duration of a timed scroll transition, or undefined. A slide carrying a
 * positive durationMs is a true scroll: it renders in the pre-cut window
 * [nextFrameStart - durationMs, nextFrameStart], not after the cut.
 */
function timedScrollDurationMs(ti: FrameIndexEntry["transitionIn"]): number | undefined {
  if (ti !== undefined && ti !== null && typeof ti === "object" && ti.kind === "slide" &&
      typeof ti.durationMs === "number" && ti.durationMs > 0) {
    return ti.durationMs;
  }
  return undefined;
}

/** Active narrative caption at source time t, or null. */
function captionAt(captions: { start: number; end: number; text: string }[] | undefined, t: number): string | null {
  if (!captions) return null;
  for (const c of captions) if (t >= c.start && t < c.end) return c.text;
  return null;
}

export function planFrameInstructions(input: InstructionPlanInput): FrameInstruction[] {
  const { frames, fps, ranges, totalFrames, camAtOut, samples, downs, keyToasts, captions, content, vw, W, H, cfg, transitionMs } = input;
  const uiScale = content.w / vw;
  const instructions: FrameInstruction[] = [];
  // Camera works in composition space (output px at scale 1): the whole canvas, padding and
  // background included, scales about the target the way Screen Studio does.
  const toComp = (p: Point) => ({ x: content.x + p.x * uiScale, y: content.y + p.y * uiScale });
  let prevSrc = -1;
  let prevFi = -1;
  let cutOutT = 0;
  // The outgoing screenshot of an active crossfade. Kept in a persistent variable so every
  // frame in the transition window names `previousFile` — a loop-local would only name it
  // on the cut frame and kill the blend after one frame.
  let transitionFrom: string | undefined;
  // Slide vector for the active transition, in composition px at mix = 1.
  let activeSlide: { x: number; y: number } | undefined;
  // Per-cut transition duration in output ms; "cut" transitions use 0 (instant).
  // Timed scrolls render in the pre-cut window, so they use 0 post-cut duration.
  // Untimed slides and crossfades use the generic transition duration.
  let activeTransitionMs = transitionMs;
  let followOffset: Point = { x: 0, y: 0 };
  const k = 1 - Math.pow(0.001, 1 / fps / 0.35); // ~350ms time constant for follow easing
  for (let i = 0; i < totalFrames; i++) {
    const tOut = (i * 1000) / fps;
    const tSrc = outToSource(ranges, tOut);
    const fi = frameIndexAt(frames, tSrc);
    // Pre-cut timed scroll: if the NEXT frame carries a slide with durationMs,
    // the visual scroll renders in [nextFrameStart - durationMs, nextFrameStart],
    // not after the cut. This keeps a D-ms scroll to ~D ms of visual time instead
    // of paying the duration twice (once as the action beat, once as the animation).
    let preCutScroll: { progress: number; slide: { x: number; y: number }; nextFile: string } | null = null;
    if (fi + 1 < frames.length) {
      const nextDurationMs = timedScrollDurationMs(frames[fi + 1].transitionIn);
      if (nextDurationMs !== undefined) {
        const tNextOut = sourceToOutput(ranges, frames[fi + 1].t);
        const windowStart = tNextOut - nextDurationMs;
        if (tOut >= windowStart && tOut < tNextOut) {
          const ti = frames[fi + 1].transitionIn;
          preCutScroll = {
            progress: (tOut - windowStart) / nextDurationMs,
            slide: {
              x: (ti as { dx: number }).dx * uiScale,
              y: (ti as { dy: number }).dy * uiScale,
            },
            nextFile: frames[fi + 1].file,
          };
        }
      }
    }
    // A screenshot cut starts a crossfade measured in output time. transitionFrom names the
    // outgoing screenshot explicitly so parallel workers stay deterministic.
    // Timed scrolls are excluded: their transition already ran in the pre-cut window,
    // so the cut lands on a settled frame with no post-cut animation.
    if (fi !== prevFi) {
      transitionFrom = prevFi >= 0 ? frames[prevFi].file : undefined;
      cutOutT = tOut;
      prevFi = fi;
      const ti = frames[fi].transitionIn;
      const slideDurationMs = timedScrollDurationMs(ti);
      // Timed scrolls use 0 post-cut duration: the scroll already played pre-cut.
      // Untimed slides and crossfades keep the generic transition duration.
      activeTransitionMs = ti === "cut" ? 0 : slideDurationMs !== undefined ? 0 : transitionMs;
      activeSlide =
        ti !== undefined && ti !== null && typeof ti === "object" && ti.kind === "slide" && slideDurationMs === undefined
          ? { x: ti.dx * uiScale, y: ti.dy * uiScale }
          : undefined;
    }
    const mixAge = tOut - cutOutT;
    const mix = transitionFrom !== undefined && mixAge < activeTransitionMs ? mixAge / activeTransitionMs : null;
    if (mix === null) { transitionFrom = undefined; activeSlide = undefined; }
    // Pre-cut scroll overrides the file/mix/slide for the transition window.
    const effFile = preCutScroll !== null ? preCutScroll.nextFile : frames[fi].file;
    const effPreviousFile = preCutScroll !== null ? frames[fi].file : (mix !== null ? transitionFrom : undefined);
    const effMix = preCutScroll !== null ? preCutScroll.progress : mix;
    const effSlide = preCutScroll !== null ? preCutScroll.slide : activeSlide;
    const effIsScroll = preCutScroll !== null ? true : undefined;
    const cam = camAtOut(tOut);
    const s = cam.scale;
    const cur = toComp(cursorAt(samples, tSrc));
    const target = toComp({ x: cam.cx, y: cam.cy });
    if (prevSrc >= 0 && crossesCut(ranges, prevSrc, tSrc)) followOffset = { x: 0, y: 0 };
    const visW = W / s, visH = H / s;
    if (cam.follow && s > 1.01 && cfg.zoom.followCursor) {
      const cx = target.x + followOffset.x, cy = target.y + followOffset.y;
      const inX = visW * 0.35, inY = visH * 0.35;
      let tx = followOffset.x, ty = followOffset.y;
      if (cur.x > cx + inX) tx += cur.x - (cx + inX);
      if (cur.x < cx - inX) tx -= cx - inX - cur.x;
      if (cur.y > cy + inY) ty += cur.y - (cy + inY);
      if (cur.y < cy - inY) ty -= cy - inY - cur.y;
      followOffset = { x: lerp(followOffset.x, tx, k), y: lerp(followOffset.y, ty, k) };
    } else {
      followOffset = { x: lerp(followOffset.x, 0, k), y: lerp(followOffset.y, 0, k) };
    }
    // Keep the visible window inside the composition so no empty edges appear.
    const px = clamp(target.x + followOffset.x, visW / 2, W - visW / 2);
    const py = clamp(target.y + followOffset.y, visH / 2, H - visH / 2);
    prevSrc = tSrc;
    const toOut = (p: Point) => ({ x: W / 2 + (p.x - px) * s, y: H / 2 + (p.y - py) * s });
    const pressed = downs.some((d) => tSrc >= d.t && tSrc <= d.up);
    const ripples = cfg.cursor.clickRipple
      ? downs.filter((d) => tSrc >= d.t && tSrc - d.t < 450).map((d) => ({ ...toOut(toComp(d)), p: (tSrc - d.t) / 450 }))
      : [];
    instructions.push({
      file: effFile,
      previousFile: effPreviousFile,
      cam: { px, py, scale: s },
      cursor: cfg.cursor.enabled ? { ...toOut(cur), pressed, visible: samples.length > 0 } : null,
      ripples,
      uiScale: uiScale * Math.sqrt(s),
      hud: keyHudAt(keyToasts, tSrc),
      caption: captionAt(captions, tSrc),
      mix: effMix,
      slide: effSlide,
      isScroll: effIsScroll,
    });
  }
  return instructions;
}
