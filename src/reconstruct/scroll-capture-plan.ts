/**
 * Scroll capture planner for the managed real-frame path.
 *
 * Tells a browser agent which REAL scroll positions to capture so TraceReel
 * can play them back as dense real frames — approximately one capture per
 * output frame. The planner is deterministic: the same inputs always produce
 * the same targets.
 *
 * Default easing is cubic-bezier(0.4, 0, 0.2, 1), matching TakeOne's default
 * ("smooth"). The browser adapter performs the actual movements and captures
 * the real resulting state; requested scrollY is never assumed to equal
 * actual scrollY — capture metadata (RealFrameCapture.scrollY) is
 * authoritative and validated separately (see realframes.ts).
 */
import { resolveEasing } from "../motion.js";
import type { Easing } from "../types.js";

export interface ScrollCapturePlanOptions {
  /** Start scroll position in CSS px. */
  from: number;
  /** Destination scroll position in CSS px. */
  to: number;
  /** Desired playback duration of the scroll beat, in ms. */
  durationMs: number;
  /** Output frame rate. Default 60. */
  fps?: number;
  /**
   * Easing for the capture targets. Default [0.4, 0, 0.2, 1]
   * (cubic-bezier matching TakeOne's default "smooth" easing).
   */
  easing?: Easing;
  /** Minimum captures in the plan, even for very short scrolls. Default 2. */
  minCaptures?: number;
  /**
   * Maximum captures in the plan. Default 600 (10s at 60fps); longer scrolls
   * keep their duration but capture at a lower effective rate.
   */
  maxCaptures?: number;
}

export interface ScrollCaptureTarget {
  /** 0-based capture order; the agent captures in this order. */
  index: number;
  /** Target scroll position, integer CSS px. */
  scrollPos: number;
  /** scrollPos minus the previous target's scrollPos (0 for the first). */
  delta: number;
  /** Nominal output timestamp of this capture within the scroll beat, in ms. */
  tMs: number;
}

export interface ScrollCapturePlan {
  targets: ScrollCaptureTarget[];
  /** from, echoed. */
  from: number;
  /** to, echoed. */
  to: number;
  durationMs: number;
  fps: number;
  /** The easing tuple actually used, e.g. [0.4, 0, 0.2, 1]. */
  easing: [number, number, number, number];
}

/** The TakeOne default easing, as an explicit tuple. */
export const TAKEONE_DEFAULT_EASING: [number, number, number, number] = [0.4, 0, 0.2, 1];

function easingTuple(e: Easing | undefined): [number, number, number, number] {
  if (Array.isArray(e)) return e;
  switch (e) {
    case "linear": return [0, 0, 1, 1];
    case "snappy": return [0.2, 0.9, 0.3, 1];
    case "spring": return [0.34, 1.35, 0.64, 1];
    case "easeOut": return [0, 0, 0.2, 1];
    case "easeIn": return [0.4, 0, 1, 1];
    case "smooth":
    default:
      return TAKEONE_DEFAULT_EASING;
  }
}

/**
 * Deterministic capture targets for a real-frame scroll.
 *
 * For a 600ms scroll at 60fps this yields ~36 targets (one per output
 * frame). Positions are integer CSS px, monotonic (rounding can stall but
 * never reverses), and always end exactly on `to`.
 */
export function planScrollCaptures(opts: ScrollCapturePlanOptions): ScrollCapturePlan {
  const { from, to, durationMs } = opts;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(durationMs)) {
    throw new Error("planScrollCaptures: from, to and durationMs must be finite numbers");
  }
  if (durationMs <= 0) throw new Error("planScrollCaptures: durationMs must be positive");
  const fps = opts.fps ?? 60;
  if (fps <= 0) throw new Error("planScrollCaptures: fps must be positive");
  const minCaptures = Math.max(2, Math.floor(opts.minCaptures ?? 2));
  const maxCaptures = Math.max(minCaptures, Math.floor(opts.maxCaptures ?? 600));
  const easing = easingTuple(opts.easing);
  const ease = resolveEasing(opts.easing);

  let n = Math.round(durationMs / (1000 / fps));
  n = Math.min(maxCaptures, Math.max(minCaptures, n));

  const targets: ScrollCaptureTarget[] = [];
  const dir = to >= from ? 1 : -1;
  let prev = from;
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 1 : i / (n - 1);
    let pos = Math.round(from + (to - from) * ease(p));
    // Monotonic: rounding stalls are fine (the browser legitimately does not
    // move some frames), reversals are not.
    if (dir >= 0) pos = Math.max(pos, Math.round(prev));
    else pos = Math.min(pos, Math.round(prev));
    if (i === n - 1) pos = Math.round(to); // the endpoint is exact
    targets.push({
      index: i,
      scrollPos: pos,
      delta: i === 0 ? 0 : pos - Math.round(prev),
      tMs: n === 1 ? 0 : Math.round((durationMs * i) / (n - 1)),
    });
    prev = pos;
  }
  return { targets, from, to, durationMs, fps, easing };
}
