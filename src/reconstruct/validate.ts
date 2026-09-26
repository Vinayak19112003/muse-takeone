/**
 * Strong validation for `muse-takeone reconstruct` input.
 *
 * Every error message says exactly what to fix: which frame, which action, and
 * what the bad value was. Warnings cover things that render but look wrong
 * (ignored options, suspicious timing, missing post-action states).
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { RECONSTRUCTION_SOURCE_TYPES } from "./build.js";
import type { ReconstructionInput } from "./build.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** True when there are no errors (warnings are fine). */
  ok: boolean;
}

const ACTION_KINDS = ["click", "type", "scroll", "hover", "wait"];
const REDACTION_MODES = ["blur", "solid", "pixelate"];

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateReconstructionInput(input: unknown, baseDir: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (message: string) => errors.push({ severity: "error", message });
  const warn = (message: string) => warnings.push({ severity: "warning", message });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    err("input must be a JSON object with viewport, frames, ...");
    return { errors, warnings, ok: false };
  }
  const inp = input as Record<string, unknown>;

  if (inp.version !== undefined && inp.version !== 1) {
    err(`input.version is ${JSON.stringify(inp.version)}; this muse-takeone only understands version 1`);
  }

  const vp = inp.viewport as Record<string, unknown> | undefined;
  let vw = 0, vh = 0, vpOk = false;
  if (!vp || typeof vp !== "object") {
    err("input.viewport is required, e.g. { \"width\": 1280, \"height\": 800 }");
  } else if (!isNum(vp.width) || !isNum(vp.height) || vp.width <= 0 || vp.height <= 0) {
    err(`input.viewport.width/height must be positive numbers, got ${JSON.stringify(inp.viewport)}`);
  } else {
    vw = vp.width; vh = vp.height; vpOk = true;
    if (vw < 320 || vh < 240) warn(`viewport ${vw}x${vh} is unusually small; is this the real capture size?`);
    if (vw > 7680 || vh > 4320) warn(`viewport ${vw}x${vh} is unusually large; is this the real capture size?`);
  }

  const shotsDir = resolve(baseDir, typeof inp.screenshotsDir === "string" ? inp.screenshotsDir : ".");
  if (inp.screenshotsDir !== undefined && typeof inp.screenshotsDir !== "string") {
    err("input.screenshotsDir must be a string path");
  } else if (typeof inp.screenshotsDir === "string" &&
             (isAbsolute(inp.screenshotsDir) || inp.screenshotsDir.split(/[\\/]/).includes(".."))) {
    err(`input.screenshotsDir must stay inside the input directory: no absolute paths or ".." segments (got "${inp.screenshotsDir}")`);
  } else if (!existsSync(shotsDir)) {
    err(`screenshotsDir does not exist: ${shotsDir}`);
  }

  if (inp.shots !== undefined) {
    if (!Array.isArray(inp.shots) || inp.shots.length === 0) {
      err("input.shots must be a non-empty array of { start, end, cx, cy, scale } in source ms");
    } else {
      let prevEnd = -1;
      inp.shots.forEach((s: unknown, i: number) => {
        const w = `input.shots[${i}]`;
        if (!s || typeof s !== "object") { err(`${w} must be an object`); return; }
        const sh = s as Record<string, unknown>;
        for (const k of ["start", "end", "cx", "cy", "scale"]) {
          if (!isNum(sh[k])) err(`${w}.${k} must be a number, got ${JSON.stringify(sh[k])}`);
        }
        if (isNum(sh.start) && isNum(sh.end) && sh.end <= sh.start) {
          err(`${w}.end (${sh.end}) must be after ${w}.start (${sh.start})`);
        }
        if (isNum(sh.scale) && (sh.scale <= 0 || sh.scale > 8)) {
          err(`${w}.scale must be between 0 and 8, got ${sh.scale}`);
        }
        if (isNum(sh.start) && isNum(prevEnd) && sh.start < prevEnd) {
          warn(`${w}.start (${sh.start}) overlaps the previous shot (ends ${prevEnd}); shots should be sequential`);
        }
        if (isNum(sh.end)) prevEnd = Math.max(prevEnd, sh.end as number);
      });
    }
  }

  const frames = inp.frames as unknown;
  if (!Array.isArray(frames) || frames.length === 0) {
    err("input.frames must be a non-empty array of { file, actions?, ... }");
    return { errors, warnings, ok: false };
  }

  const seenBasenames = new Map<string, number>();
  const coord = (v: unknown, name: string, where: string, max: number) => {
    if (!isNum(v)) { err(`${where}: ${name} must be a number, got ${JSON.stringify(v)}`); return; }
    if (v < 0 || v > max) err(`${where}: ${name}=${v} is outside the viewport (0..${max})`);
  };
  const nonNeg = (v: unknown, name: string, where: string) => {
    if (v === undefined) return;
    if (!isNum(v) || v < 0) err(`${where}: ${name} must be >= 0, got ${JSON.stringify(v)}`);
  };

  const checkRedactions = (rs: unknown, where: string) => {
    if (rs === undefined) return;
    if (!Array.isArray(rs)) { err(`${where}: redactions must be an array`); return; }
    rs.forEach((r: unknown, i: number) => {
      const w = `${where}: redactions[${i}]`;
      if (!r || typeof r !== "object") { err(`${w} must be an object`); return; }
      const rr = r as Record<string, unknown>;
      (["x", "y", "width", "height"] as const).forEach((k) => {
        if (!isNum(rr[k])) err(`${w}.${k} must be a number`);
      });
      if (!REDACTION_MODES.includes(rr.mode as string)) {
        err(`${w}.mode must be one of ${REDACTION_MODES.join(", ")}, got ${JSON.stringify(rr.mode)}`);
      }
      if (isNum(rr.width) && rr.width <= 0) err(`${w}.width must be > 0`);
      if (isNum(rr.height) && rr.height <= 0) err(`${w}.height must be > 0`);
      if (vpOk && isNum(rr.x) && isNum(rr.y) && isNum(rr.width) && isNum(rr.height)) {
        if (rr.x >= vw || rr.y >= vh || (rr.x as number) + (rr.width as number) <= 0 || (rr.y as number) + (rr.height as number) <= 0) {
          warn(`${w} lies completely outside the viewport and redacts nothing`);
        }
      }
    });
  };

  checkRedactions(inp.redactions, "input");

  frames.forEach((f: unknown, fi: number) => {
    const where = `frames[${fi}]`;
    if (!f || typeof f !== "object") { err(`${where} must be an object`); return; }
    const fr = f as Record<string, unknown>;
    if (typeof fr.file !== "string" || !fr.file) {
      err(`${where}.file must be a non-empty screenshot file name`);
    } else {
      const segments = fr.file.split(/[\\/]/);
      if (isAbsolute(fr.file) || segments.includes("..")) {
        err(`${where}.file must stay inside screenshotsDir: no absolute paths or ".." segments (got "${fr.file}")`);
      }
      const base = basename(fr.file);
      if (seenBasenames.has(base)) {
        err(`${where}.file "${fr.file}" has the same base name as frames[${seenBasenames.get(base)}].file: ` +
          `frames are copied by base name into the work dir and would overwrite each other. Rename one.`);
      } else {
        seenBasenames.set(base, fi);
      }
      if (!existsSync(resolve(shotsDir, fr.file))) err(`${where}.file not found: ${resolve(shotsDir, fr.file)}`);
    }
    nonNeg(fr.holdMs, "holdMs", where);
    if (fr.caption !== undefined && typeof fr.caption !== "string") err(`${where}.caption must be a string`);
    const ti = fr.transitionIn as unknown;
    if (ti !== undefined) {
      const okTransition =
        ti === "crossfade" || ti === "cut" ||
        (typeof ti === "object" && ti !== null && (ti as Record<string, unknown>).kind === "slide" &&
          isNum((ti as Record<string, unknown>).dx) && isNum((ti as Record<string, unknown>).dy));
      if (!okTransition) err(`${where}.transitionIn must be "crossfade", "cut", or { kind: "slide", dx, dy }`);
      if (fi === 0) warn(`${where}.transitionIn has no effect on the first frame (nothing to transition from)`);
    }
    checkRedactions(fr.redactions, where);

    const actions = fr.actions as unknown;
    if (actions === undefined) {
      if (fr.caption === undefined) warn(`${where} has no actions and no caption: a pure ${(fr.holdMs as number) ?? 2600}ms hold. Add a caption or drop the frame.`);
      return;
    }
    if (!Array.isArray(actions)) { err(`${where}.actions must be an array`); return; }
    actions.forEach((a: unknown, ai: number) => {
      const aw = `${where}.actions[${ai}]`;
      if (!a || typeof a !== "object") { err(`${aw} must be an object`); return; }
      const ac = a as Record<string, unknown>;
      if (!ACTION_KINDS.includes(ac.kind as string)) {
        err(`${aw}.kind must be one of ${ACTION_KINDS.join(", ")}, got ${JSON.stringify(ac.kind)}`);
        return;
      }
      nonNeg(ac.pauseMs, "pauseMs", aw);
      nonNeg(ac.nextFrameAfterMs, "nextFrameAfterMs", aw);
      if (ac.nextFrameAfterMs !== undefined && ai !== actions.length - 1) {
        warn(`${aw}.nextFrameAfterMs is ignored: only the frame's last action controls the cut to the next screenshot`);
      }
      if (vpOk && (ac.kind === "click" || ac.kind === "type" || ac.kind === "hover")) {
        coord(ac.x, "x", aw, vw);
        coord(ac.y, "y", aw, vh);
      }
      if (ac.kind === "click") {
        nonNeg(ac.preClickMs, "preClickMs", aw);
        nonNeg(ac.clickHoldMs, "clickHoldMs", aw);
      } else if (ac.kind === "type") {
        if (typeof ac.text !== "string") err(`${aw}.text must be a string`);
        else if (ac.text.length === 0) warn(`${aw}.text is empty: the action types nothing`);
        if (ac.cpm !== undefined && (!isNum(ac.cpm) || ac.cpm <= 0)) err(`${aw}.cpm must be > 0`);
        if (ac.showKeys !== undefined && typeof ac.showKeys !== "boolean") err(`${aw}.showKeys must be a boolean`);
        if (ac.sensitive !== undefined && typeof ac.sensitive !== "boolean") err(`${aw}.sensitive must be a boolean`);
        if (ac.showKeys === true && ac.sensitive === true) {
          warn(`${aw} is marked sensitive but showKeys is true: the typed text will appear in the keyboard HUD`);
        }
      } else if (ac.kind === "scroll") {
        if (vpOk) {
          if (ac.x !== undefined) coord(ac.x, "x", aw, vw);
          if (ac.y !== undefined) coord(ac.y, "y", aw, vh);
        }
        if (ac.dx !== undefined && !isNum(ac.dx)) err(`${aw}.dx must be a number`);
        if (ac.dy !== undefined && !isNum(ac.dy)) err(`${aw}.dy must be a number`);
        if ((ac.dx ?? 0) === 0 && (ac.dy ?? 700) === 0) warn(`${aw} scrolls by (0, 0): it does nothing`);
        nonNeg(ac.durationMs, "durationMs", aw);
      } else if (ac.kind === "wait") {
        if (!isNum(ac.durationMs) || ac.durationMs <= 0) err(`${aw}.durationMs must be a positive number of ms`);
      }
    });
    const last = (actions as Record<string, unknown>[])[actions.length - 1];
    if (fi === frames.length - 1 && last && ["click", "type", "scroll", "hover"].includes(last.kind as string)) {
      warn(`${where}: the last action is a ${last.kind} but there is no following frame, ` +
        `so its result is never shown. Add a frame with the post-action screenshot.`);
    }
  });

  const src = inp.source as Record<string, unknown> | undefined;
  if (src !== undefined) {
    if (typeof src !== "object" || Array.isArray(src)) {
      err("input.source must be an object");
    } else {
      if (!RECONSTRUCTION_SOURCE_TYPES.includes(src.type as (typeof RECONSTRUCTION_SOURCE_TYPES)[number])) {
        err(`input.source.type must be one of ${RECONSTRUCTION_SOURCE_TYPES.join(", ")}, got ${JSON.stringify(src.type)}`);
      }
      for (const k of ["session", "captureTool", "note"] as const) {
        if (src[k] !== undefined && typeof src[k] !== "string") err(`input.source.${k} must be a string`);
      }
      if (src.capturedAt !== undefined) {
        if (typeof src.capturedAt !== "string" || Number.isNaN(Date.parse(src.capturedAt))) {
          warn(`input.source.capturedAt is not a parseable date: ${JSON.stringify(src.capturedAt)}`);
        }
      }
      const svp = src.viewport as Record<string, unknown> | undefined;
      if (svp !== undefined) {
        if (!isNum(svp.width) || svp.width <= 0 || !isNum(svp.height) || svp.height <= 0) {
          err("input.source.viewport must be { width, height } with positive numbers");
        } else if (vpOk && (svp.width !== vw || svp.height !== vh)) {
          warn(`input.source.viewport ${svp.width}x${svp.height} differs from input.viewport ${vw}x${vh}`);
        }
      }
    }
  }

  if (inp.motion !== undefined) {
    const m = inp.motion as Record<string, unknown>;
    if (typeof m !== "object" || Array.isArray(m)) err("input.motion must be an object");
    else for (const k of ["msPerPx", "minMs", "maxMs"] as const) {
      if (m[k] !== undefined && (!isNum(m[k]) || (m[k] as number) <= 0)) err(`input.motion.${k} must be a positive number`);
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** Validate an already-parsed input typed as ReconstructionInput. */
export function validateInputObject(input: ReconstructionInput, baseDir: string): ValidationResult {
  return validateReconstructionInput(input as unknown, baseDir);
}
