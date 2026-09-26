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
  let followOffset: Point = { x: 0, y: 0 };
  const k = 1 - Math.pow(0.001, 1 / fps / 0.35); // ~350ms time constant for follow easing
  for (let i = 0; i < totalFrames; i++) {
    const tOut = (i * 1000) / fps;
    const tSrc = outToSource(ranges, tOut);
    const fi = frameIndexAt(frames, tSrc);
    // A screenshot cut starts a crossfade measured in output time. transitionFrom names the
    // outgoing screenshot explicitly so parallel workers stay deterministic.
    if (fi !== prevFi) {
      transitionFrom = prevFi >= 0 ? frames[prevFi].file : undefined;
      cutOutT = tOut;
      prevFi = fi;
    }
    const mixAge = tOut - cutOutT;
    const mix = transitionFrom !== undefined && mixAge < transitionMs ? mixAge / transitionMs : null;
    if (mix === null) transitionFrom = undefined;
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
      file: frames[fi].file,
      previousFile: mix !== null ? transitionFrom : undefined,
      cam: { px, py, scale: s },
      cursor: cfg.cursor.enabled ? { ...toOut(cur), pressed, visible: samples.length > 0 } : null,
      ripples,
      uiScale: uiScale * Math.sqrt(s),
      hud: keyHudAt(keyToasts, tSrc),
      caption: captionAt(captions, tSrc),
      mix,
    });
  }
  return instructions;
}
