/**
 * Strong validation for TraceReel trace input.
 *
 * Every issue carries a machine-readable `code`, a `path` pointing at the
 * offending value, a human `message`, and a `suggestion` the capturing agent
 * can act on — so Muse/Grokbot can self-correct without reading the source.
 * Warnings cover things that render but look wrong (ignored options,
 * suspicious timing, missing post-action states).
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { RECONSTRUCTION_SOURCE_TYPES } from "./build.js";
import type { ReconstructionInput } from "./build.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  /** Machine-readable code, e.g. "COORD_OUTSIDE_VIEWPORT". Stable across versions. */
  code: string;
  /** JSON-ish pointer to the offending value, e.g. "frames[2].actions[0].x". */
  path?: string;
  message: string;
  /** Concrete fix the agent can apply. */
  suggestion?: string;
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
  const err = (code: string, message: string, opts?: { path?: string; suggestion?: string }) =>
    errors.push({ severity: "error", code, message, ...opts });
  const warn = (code: string, message: string, opts?: { path?: string; suggestion?: string }) =>
    warnings.push({ severity: "warning", code, message, ...opts });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    err("INVALID_INPUT_TYPE", "input must be a JSON object with viewport, frames, ...", {
      suggestion: "Pass the trace JSON object the agent produced (states/actions or frames).",
    });
    return { errors, warnings, ok: false };
  }
  const inp = input as Record<string, unknown>;

  if (inp.version !== undefined && inp.version !== 1) {
    err("UNSUPPORTED_VERSION", `input.version is ${JSON.stringify(inp.version)}; this TraceReel only understands version 1`, {
      path: "version",
      suggestion: "Set version to 1 or drop the field.",
    });
  }

  const vp = inp.viewport as Record<string, unknown> | undefined;
  let vw = 0, vh = 0, vpOk = false;
  if (!vp || typeof vp !== "object") {
    err("MISSING_VIEWPORT", "input.viewport is required, e.g. { \"width\": 1280, \"height\": 800 }", {
      path: "viewport",
      suggestion: "Add the viewport CSS size the screenshots were captured at.",
    });
  } else if (!isNum(vp.width) || !isNum(vp.height) || vp.width <= 0 || vp.height <= 0) {
    err("INVALID_VIEWPORT", `input.viewport.width/height must be positive numbers, got ${JSON.stringify(inp.viewport)}`, {
      path: "viewport",
      suggestion: "Use the real capture size, e.g. { \"width\": 1280, \"height\": 800 }.",
    });
  } else {
    vw = vp.width; vh = vp.height; vpOk = true;
    if (vw < 320 || vh < 240) warn("SUSPICIOUS_VIEWPORT", `viewport ${vw}x${vh} is unusually small; is this the real capture size?`, { path: "viewport" });
    if (vw > 7680 || vh > 4320) warn("SUSPICIOUS_VIEWPORT", `viewport ${vw}x${vh} is unusually large; is this the real capture size?`, { path: "viewport" });
  }

  const shotsDir = resolve(baseDir, typeof inp.screenshotsDir === "string" ? inp.screenshotsDir : ".");
  if (inp.screenshotsDir !== undefined && typeof inp.screenshotsDir !== "string") {
    err("INVALID_SCREENSHOTS_DIR", "input.screenshotsDir must be a string path", { path: "screenshotsDir" });
  } else if (typeof inp.screenshotsDir === "string" &&
             (isAbsolute(inp.screenshotsDir) || inp.screenshotsDir.split(/[\\/]/).includes(".."))) {
    err("PATH_ESCAPES_INPUT_DIR", `input.screenshotsDir must stay inside the input directory: no absolute paths or ".." segments (got "${inp.screenshotsDir}")`, {
      path: "screenshotsDir",
      suggestion: "Use a path relative to the trace file, e.g. \"frames\".",
    });
  } else if (!existsSync(shotsDir)) {
    err("SCREENSHOTS_DIR_MISSING", `screenshotsDir does not exist: ${shotsDir}`, {
      path: "screenshotsDir",
      suggestion: "Create the directory or fix the path relative to the trace file.",
    });
  }

  if (inp.shots !== undefined) {
    if (!Array.isArray(inp.shots) || inp.shots.length === 0) {
      err("INVALID_SHOTS", "input.shots must be a non-empty array of { start, end, cx, cy, scale } in source ms", { path: "shots" });
    } else {
      let prevEnd = -1;
      inp.shots.forEach((s: unknown, i: number) => {
        const w = `shots[${i}]`;
        if (!s || typeof s !== "object") { err("INVALID_SHOT", `${w} must be an object`, { path: w }); return; }
        const sh = s as Record<string, unknown>;
        for (const k of ["start", "end", "cx", "cy", "scale"]) {
          if (!isNum(sh[k])) err("INVALID_SHOT", `${w}.${k} must be a number, got ${JSON.stringify(sh[k])}`, { path: `${w}.${k}` });
        }
        if (isNum(sh.start) && isNum(sh.end) && sh.end <= sh.start) {
          err("INVALID_SHOT", `${w}.end (${sh.end}) must be after ${w}.start (${sh.start})`, { path: w });
        }
        if (isNum(sh.scale) && (sh.scale <= 0 || sh.scale > 8)) {
          err("INVALID_SHOT", `${w}.scale must be between 0 and 8, got ${sh.scale}`, {
            path: `${w}.scale`,
            suggestion: "Routine reframing uses ~1.35; 8 is the hard ceiling.",
          });
        }
        if (isNum(sh.start) && isNum(prevEnd) && sh.start < prevEnd) {
          warn("OVERLAPPING_SHOT", `${w}.start (${sh.start}) overlaps the previous shot (ends ${prevEnd}); shots should be sequential`, { path: w });
        }
        if (isNum(sh.end)) prevEnd = Math.max(prevEnd, sh.end as number);
      });
    }
  }

  const hasFrames = inp.frames !== undefined;
  const hasStates = inp.states !== undefined;
  if (hasFrames && hasStates) {
    err("MIXED_TRACE_FORMS", "input has both frames[] and states[]; pick one form", {
      suggestion: "Use states[]/actions[] for new traces; frames[] is the legacy form.",
    });
    return { errors, warnings, ok: false };
  }

  const seenBasenames = new Map<string, number>();
  const coord = (v: unknown, name: string, where: string, max: number) => {
    if (!isNum(v)) { err("INVALID_COORDINATE", `${where}: ${name} must be a number, got ${JSON.stringify(v)}`, { path: `${where}.${name}` }); return; }
    if (v < 0 || v > max) err("COORD_OUTSIDE_VIEWPORT", `${where}: ${name}=${v} is outside the viewport (0..${max})`, {
      path: `${where}.${name}`,
      suggestion: "Ground the target again from the state screenshot; coordinates are viewport CSS px.",
    });
  };
  const nonNeg = (v: unknown, name: string, where: string) => {
    if (v === undefined) return;
    if (!isNum(v) || v < 0) err("INVALID_DURATION", `${where}: ${name} must be >= 0, got ${JSON.stringify(v)}`, { path: `${where}.${name}` });
  };

  const checkRedactions = (rs: unknown, where: string) => {
    if (rs === undefined) return;
    if (!Array.isArray(rs)) { err("INVALID_REDACTIONS", `${where}: redactions must be an array`, { path: where }); return; }
    rs.forEach((r: unknown, i: number) => {
      const w = `${where}.redactions[${i}]`;
      if (!r || typeof r !== "object") { err("INVALID_REDACTION", `${w} must be an object`, { path: w }); return; }
      const rr = r as Record<string, unknown>;
      (["x", "y", "width", "height"] as const).forEach((k) => {
        if (!isNum(rr[k])) err("INVALID_REDACTION", `${w}.${k} must be a number`, { path: `${w}.${k}` });
      });
      if (!REDACTION_MODES.includes(rr.mode as string)) {
        err("INVALID_REDACTION", `${w}.mode must be one of ${REDACTION_MODES.join(", ")}, got ${JSON.stringify(rr.mode)}`, {
          path: `${w}.mode`,
          suggestion: `Use one of: ${REDACTION_MODES.join(", ")}.`,
        });
      }
      if (isNum(rr.width) && rr.width <= 0) err("INVALID_REDACTION", `${w}.width must be > 0`, { path: `${w}.width` });
      if (isNum(rr.height) && rr.height <= 0) err("INVALID_REDACTION", `${w}.height must be > 0`, { path: `${w}.height` });
      if (vpOk && isNum(rr.x) && isNum(rr.y) && isNum(rr.width) && isNum(rr.height)) {
        if (rr.x >= vw || rr.y >= vh || (rr.x as number) + (rr.width as number) <= 0 || (rr.y as number) + (rr.height as number) <= 0) {
          warn("REDACTION_OUTSIDE_VIEWPORT", `${w} lies completely outside the viewport and redacts nothing`, { path: w });
        }
      }
    });
  };

  checkRedactions(inp.redactions, "input");

  /** Shared per-frame checks; used by both the frames form and states converted to frames. */
  const checkFrameFile = (file: unknown, where: string, fi: number) => {
    if (typeof file !== "string" || !file) {
      err("INVALID_FRAME_FILE", `${where}.file must be a non-empty screenshot file name`, {
        path: `${where}.file`,
        suggestion: "Point at the screenshot relative to screenshotsDir.",
      });
      return;
    }
    const segments = file.split(/[\\/]/);
    if (isAbsolute(file) || segments.includes("..")) {
      err("PATH_ESCAPES_INPUT_DIR", `${where}.file must stay inside screenshotsDir: no absolute paths or ".." segments (got "${file}")`, {
        path: `${where}.file`,
        suggestion: "Keep every screenshot under the trace directory.",
      });
    }
    const base = basename(file);
    if (seenBasenames.has(base)) {
      err("DUPLICATE_FRAME_BASENAME", `${where}.file "${file}" has the same base name as frames[${seenBasenames.get(base)}].file: ` +
        `frames are copied by base name into the work dir and would overwrite each other. Rename one.`, {
        path: `${where}.file`,
      });
    } else {
      seenBasenames.set(base, fi);
    }
    if (!existsSync(resolve(shotsDir, file))) {
      err("FRAME_FILE_MISSING", `${where}.file not found: ${resolve(shotsDir, file)}`, {
        path: `${where}.file`,
        suggestion: "Capture the screenshot into screenshotsDir before validating.",
      });
    }
  };

  const checkActions = (actions: unknown, where: string, actionPath?: (localIndex: number) => string) => {
    if (actions === undefined) return 0;
    if (!Array.isArray(actions)) { err("INVALID_ACTIONS", `${where}.actions must be an array`, { path: `${where}.actions` }); return 0; }
    actions.forEach((a: unknown, ai: number) => {
      // Default: actions nested under the frame/state being checked. The
      // states-form passes actionPath so errors point at the original
      // top-level actions[n] the user wrote, not the derived grouping.
      const aw = actionPath ? actionPath(ai) : `${where}.actions[${ai}]`;
      if (!a || typeof a !== "object") { err("INVALID_ACTION", `${aw} must be an object`, { path: aw }); return; }
      const ac = a as Record<string, unknown>;
      if (!ACTION_KINDS.includes(ac.kind as string)) {
        err("UNKNOWN_ACTION_KIND", `${aw}.kind must be one of ${ACTION_KINDS.join(", ")}, got ${JSON.stringify(ac.kind)}`, {
          path: `${aw}.kind`,
          suggestion: `Use one of: ${ACTION_KINDS.join(", ")}.`,
        });
        return;
      }
      nonNeg(ac.pauseMs, "pauseMs", aw);
      nonNeg(ac.nextFrameAfterMs, "nextFrameAfterMs", aw);
      if (ac.nextFrameAfterMs !== undefined && ai !== actions.length - 1) {
        warn("IGNORED_NEXT_FRAME_AFTER", `${aw}.nextFrameAfterMs is ignored: only the frame's last action controls the cut to the next screenshot`, { path: `${aw}.nextFrameAfterMs` });
      }
      if (vpOk && (ac.kind === "click" || ac.kind === "type" || ac.kind === "hover")) {
        coord(ac.x, "x", aw, vw);
        coord(ac.y, "y", aw, vh);
      }
      if (ac.kind === "click") {
        nonNeg(ac.preClickMs, "preClickMs", aw);
        nonNeg(ac.clickHoldMs, "clickHoldMs", aw);
      } else if (ac.kind === "type") {
        if (typeof ac.text !== "string") err("INVALID_TYPE_TEXT", `${aw}.text must be a string`, { path: `${aw}.text` });
        else if (ac.text.length === 0) warn("EMPTY_TYPE_TEXT", `${aw}.text is empty: the action types nothing`, { path: `${aw}.text` });
        if (ac.cpm !== undefined && (!isNum(ac.cpm) || ac.cpm <= 0)) err("INVALID_DURATION", `${aw}.cpm must be > 0`, { path: `${aw}.cpm` });
        if (ac.showKeys !== undefined && typeof ac.showKeys !== "boolean") err("INVALID_TYPE_TEXT", `${aw}.showKeys must be a boolean`, { path: `${aw}.showKeys` });
        if (ac.sensitive !== undefined && typeof ac.sensitive !== "boolean") err("INVALID_TYPE_TEXT", `${aw}.sensitive must be a boolean`, { path: `${aw}.sensitive` });
        if (ac.showKeys === true && ac.sensitive === true) {
          warn("SENSITIVE_KEYS_SHOWN", `${aw} is marked sensitive but showKeys is true: the typed text will appear in the keyboard HUD`, {
            path: aw,
            suggestion: "Set showKeys to false for secrets.",
          });
        }
      } else if (ac.kind === "scroll") {
        if (vpOk) {
          if (ac.x !== undefined) coord(ac.x, "x", aw, vw);
          if (ac.y !== undefined) coord(ac.y, "y", aw, vh);
        }
        if (ac.dx !== undefined && !isNum(ac.dx)) err("INVALID_SCROLL", `${aw}.dx must be a number`, { path: `${aw}.dx` });
        if (ac.dy !== undefined && !isNum(ac.dy)) err("INVALID_SCROLL", `${aw}.dy must be a number`, { path: `${aw}.dy` });
        if ((ac.dx ?? 0) === 0 && (ac.dy ?? 700) === 0) warn("NOOP_SCROLL", `${aw} scrolls by (0, 0): it does nothing`, { path: aw });
        nonNeg(ac.durationMs, "durationMs", aw);
      } else if (ac.kind === "wait") {
        if (!isNum(ac.durationMs) || ac.durationMs <= 0) err("INVALID_DURATION", `${aw}.durationMs must be a positive number of ms`, { path: `${aw}.durationMs` });
      }
    });
    return actions.length;
  };

  // --- Trace v1 state-first form ---
  if (hasStates) {
    const states = inp.states as unknown;
    if (!Array.isArray(states) || states.length === 0) {
      err("EMPTY_STATES", "input.states must be a non-empty array of { id, screenshot, ... }", { path: "states" });
      return { errors, warnings, ok: false };
    }
    const ids = new Set<string>();
    states.forEach((s: unknown, si: number) => {
      const where = `states[${si}]`;
      if (!s || typeof s !== "object") { err("INVALID_STATE", `${where} must be an object`, { path: where }); return; }
      const st = s as Record<string, unknown>;
      if (typeof st.id !== "string" || !st.id) {
        err("INVALID_STATE", `${where}.id must be a non-empty string`, {
          path: `${where}.id`,
          suggestion: "Use short stable ids like \"s1\", \"s2\".",
        });
      } else if (ids.has(st.id)) {
        err("DUPLICATE_STATE_ID", `${where}.id "${st.id}" is used more than once`, { path: `${where}.id` });
      } else {
        ids.add(st.id);
      }
      checkFrameFile(st.screenshot, where, si);
      nonNeg(st.holdMs, "holdMs", where);
      if (st.caption !== undefined && typeof st.caption !== "string") err("INVALID_STATE", `${where}.caption must be a string`, { path: `${where}.caption` });
      const ti = st.transitionIn as unknown;
      if (ti !== undefined) {
        const okTransition =
          ti === "crossfade" || ti === "cut" ||
          (typeof ti === "object" && ti !== null && (ti as Record<string, unknown>).kind === "slide" &&
            isNum((ti as Record<string, unknown>).dx) && isNum((ti as Record<string, unknown>).dy));
        if (!okTransition) err("INVALID_TRANSITION", `${where}.transitionIn must be "crossfade", "cut", or { kind: "slide", dx, dy }`, { path: `${where}.transitionIn` });
        if (si === 0) warn("IGNORED_TRANSITION", `${where}.transitionIn has no effect on the first state (nothing to transition from)`, { path: `${where}.transitionIn` });
      }
      checkRedactions(st.redactions, where);
    });

    const actions = inp.actions as unknown;
    if (actions !== undefined) {
      if (!Array.isArray(actions)) {
        err("INVALID_ACTIONS", "input.actions must be an array", { path: "actions" });
      } else {
        // Group per state so per-action checks reuse the frame logic.
        const byFrom = new Map<string, { action: unknown; index: number }[]>();
        actions.forEach((a: unknown, ai: number) => {
          const ac = (a ?? {}) as Record<string, unknown>;
          if (typeof ac.from !== "string" || !ids.has(ac.from)) {
            err("UNKNOWN_ACTION_STATE", `actions[${ai}].from must name a state id, got ${JSON.stringify(ac.from)}`, {
              path: `actions[${ai}].from`,
              suggestion: `Use one of: ${[...ids].join(", ") || "(no states)"}.`,
            });
            return;
          }
          const list = byFrom.get(ac.from) ?? [];
          list.push({ action: a, index: ai });
          byFrom.set(ac.from, list);
        });
        for (const [fromId, group] of byFrom) {
          const si = states.findIndex((s) => (s as Record<string, unknown>).id === fromId);
          checkActions(
            group.map((g) => g.action),
            `states[${si}]`,
            (li) => `actions[${group[li].index}]`,
          );
        }
        // Actions that failed the from-check still need kind validation; do a light pass.
        actions.forEach((a: unknown, ai: number) => {
          const ac = (a ?? {}) as Record<string, unknown>;
          if (typeof ac.from === "string" && ids.has(ac.from)) return; // already checked
          if (!ACTION_KINDS.includes(ac.kind as string)) {
            err("UNKNOWN_ACTION_KIND", `actions[${ai}].kind must be one of ${ACTION_KINDS.join(", ")}, got ${JSON.stringify(ac.kind)}`, {
              path: `actions[${ai}].kind`,
            });
          }
        });
        const lastState = states[states.length - 1] as Record<string, unknown>;
        const lastGroup = byFrom.get(lastState.id as string) ?? [];
        const lastAction = lastGroup.length ? (lastGroup[lastGroup.length - 1].action as Record<string, unknown>) : undefined;
        if (lastAction && ["click", "type", "scroll", "hover"].includes(lastAction.kind as string) && !lastAction.to) {
          warn("MISSING_STATE_AFTER_ACTION", `the last action on the final state is a ${lastAction.kind} with no "to": its result is never shown`, {
            path: `actions[${lastGroup[lastGroup.length - 1].index}]`,
            suggestion: "Add the post-action state, or drop the action.",
          });
        }
      }
    }

    if (inp.videoSegments !== undefined) {
      if (!Array.isArray(inp.videoSegments)) {
        err("INVALID_VIDEO_SEGMENTS", "input.videoSegments must be an array", { path: "videoSegments" });
      } else {
        warn("VIDEO_SEGMENTS_NOT_RENDERED", `${(inp.videoSegments as unknown[]).length} video segment(s) declared: the v1 renderer accepts but does not yet render them; they are ignored`, {
          path: "videoSegments",
          suggestion: "Keep them for forward compatibility; cover the moment with screenshots for now.",
        });
      }
    }
  } else {
    // --- Legacy frame form ---
    const frames = inp.frames as unknown;
    if (!Array.isArray(frames) || frames.length === 0) {
      err("EMPTY_FRAMES", "input.frames must be a non-empty array of { file, actions?, ... }", {
        path: "frames",
        suggestion: "Add at least one frame pointing at a screenshot.",
      });
      return { errors, warnings, ok: false };
    }

    frames.forEach((f: unknown, fi: number) => {
      const where = `frames[${fi}]`;
      if (!f || typeof f !== "object") { err("INVALID_FRAME", `${where} must be an object`, { path: where }); return; }
      const fr = f as Record<string, unknown>;
      checkFrameFile(fr.file, where, fi);
      nonNeg(fr.holdMs, "holdMs", where);
      if (fr.caption !== undefined && typeof fr.caption !== "string") err("INVALID_FRAME", `${where}.caption must be a string`, { path: `${where}.caption` });
      const ti = fr.transitionIn as unknown;
      if (ti !== undefined) {
        const okTransition =
          ti === "crossfade" || ti === "cut" ||
          (typeof ti === "object" && ti !== null && (ti as Record<string, unknown>).kind === "slide" &&
            isNum((ti as Record<string, unknown>).dx) && isNum((ti as Record<string, unknown>).dy));
        if (!okTransition) err("INVALID_TRANSITION", `${where}.transitionIn must be "crossfade", "cut", or { kind: "slide", dx, dy }`, { path: `${where}.transitionIn` });
        if (fi === 0) warn("IGNORED_TRANSITION", `${where}.transitionIn has no effect on the first frame (nothing to transition from)`, { path: `${where}.transitionIn` });
      }
      checkRedactions(fr.redactions, where);

      const actions = fr.actions as unknown;
      if (actions === undefined) {
        if (fr.caption === undefined) warn("EMPTY_FRAME", `${where} has no actions and no caption: a pure ${(fr.holdMs as number) ?? 2600}ms hold. Add a caption or drop the frame.`, { path: where });
        return;
      }
      const n = checkActions(actions, where);
      void n;
      const last = (actions as Record<string, unknown>[])[(actions as unknown[]).length - 1];
      if (fi === frames.length - 1 && last && ["click", "type", "scroll", "hover"].includes(last.kind as string)) {
        warn("MISSING_STATE_AFTER_ACTION", `${where}: the last action is a ${last.kind} but there is no following frame, ` +
          `so its result is never shown. Add a frame with the post-action screenshot.`, {
          path: `${where}.actions[${(actions as unknown[]).length - 1}]`,
          suggestion: "Capture the post-action screenshot and append it as a frame.",
        });
      }
    });
  }

  const src = inp.source as Record<string, unknown> | undefined;
  if (src !== undefined) {
    if (typeof src !== "object" || Array.isArray(src)) {
      err("INVALID_SOURCE", "input.source must be an object", { path: "source" });
    } else {
      if (!RECONSTRUCTION_SOURCE_TYPES.includes(src.type as (typeof RECONSTRUCTION_SOURCE_TYPES)[number])) {
        err("UNKNOWN_SOURCE_TYPE", `input.source.type must be one of ${RECONSTRUCTION_SOURCE_TYPES.join(", ")}, got ${JSON.stringify(src.type)}`, {
          path: "source.type",
          suggestion: "Use { \"type\": \"agent-browser\", \"agent\": \"<name>\" } for agent captures.",
        });
      }
      if (src.type === "agent-browser" && (typeof src.agent !== "string" || !src.agent)) {
        err("MISSING_AGENT", "input.source.agent is required when source.type is \"agent-browser\"", {
          path: "source.agent",
          suggestion: "Name the agent that captured the trace, e.g. \"muse\", \"grokbot\".",
        });
      }
      for (const k of ["session", "captureTool", "note"] as const) {
        if (src[k] !== undefined && typeof src[k] !== "string") err("INVALID_SOURCE", `input.source.${k} must be a string`, { path: `source.${k}` });
      }
      if (src.capturedAt !== undefined) {
        if (typeof src.capturedAt !== "string" || Number.isNaN(Date.parse(src.capturedAt))) {
          warn("INVALID_SOURCE", `input.source.capturedAt is not a parseable date: ${JSON.stringify(src.capturedAt)}`, { path: "source.capturedAt" });
        }
      }
      const svp = src.viewport as Record<string, unknown> | undefined;
      if (svp !== undefined) {
        if (!isNum(svp.width) || svp.width <= 0 || !isNum(svp.height) || svp.height <= 0) {
          err("INVALID_SOURCE", "input.source.viewport must be { width, height } with positive numbers", { path: "source.viewport" });
        } else if (vpOk && (svp.width !== vw || svp.height !== vh)) {
          warn("SOURCE_VIEWPORT_MISMATCH", `input.source.viewport ${svp.width}x${svp.height} differs from input.viewport ${vw}x${vh}`, { path: "source.viewport" });
        }
      }
    }
  }

  if (inp.motion !== undefined) {
    const m = inp.motion as Record<string, unknown>;
    if (typeof m !== "object" || Array.isArray(m)) err("INVALID_MOTION", "input.motion must be an object", { path: "motion" });
    else for (const k of ["msPerPx", "minMs", "maxMs"] as const) {
      if (m[k] !== undefined && (!isNum(m[k]) || (m[k] as number) <= 0)) err("INVALID_MOTION", `input.motion.${k} must be a positive number`, { path: `motion.${k}` });
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** Validate an already-parsed input typed as ReconstructionInput. */
export function validateInputObject(input: ReconstructionInput, baseDir: string): ValidationResult {
  return validateReconstructionInput(input as unknown, baseDir);
}
