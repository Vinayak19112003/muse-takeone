/**
 * Shared normalization helpers for adapters.
 *
 * Every adapter ends at the same place: a TraceReel Trace v1 whose
 * states/actions (or legacy frames) the reconstruction engine renders
 * without knowing which agent produced them.
 */
import type { AgentCapabilities, AgentState, TraceReelTrace } from "../trace/types.js";
import type {
  ReconstructionAction,
  ReconstructionFrame,
  ReconstructionInput,
} from "../reconstruct/build.js";
import type { NormalizedTrace } from "./types.js";
import { TraceReelError } from "./types.js";

export function asObject(input: unknown, what: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceReelError("INVALID_TRACE", `${what} must be a JSON object`, {
      suggestion: "Pass the trace JSON object the agent produced (states/actions or frames).",
    });
  }
  return input as Record<string, unknown>;
}

/** Convert the state-first form (states/actions) into the frame form the engine renders. */
export function statesToFrames(trace: TraceReelTrace): ReconstructionFrame[] {
  const states = trace.states ?? [];
  const actionsByFrom = new Map<string, NonNullable<TraceReelTrace["actions"]>>();
  for (const a of trace.actions ?? []) {
    const list = actionsByFrom.get(a.from) ?? [];
    list.push(a);
    actionsByFrom.set(a.from, list);
  }
  return states.map((s): ReconstructionFrame => {
    const group = actionsByFrom.get(s.id) ?? [];
    const actions: ReconstructionAction[] = group.map((a) => {
      const { from, to, stateDelayMs, ...rest } = a;
      const out = { ...rest } as ReconstructionAction;
      // The engine only honors nextFrameAfterMs on a frame's LAST action; the
      // transition delay belongs to the action that leads to the next state.
      if (to !== undefined && group.at(-1) === a && stateDelayMs !== undefined) {
        (out as unknown as Record<string, unknown>).nextFrameAfterMs = stateDelayMs;
      }
      return out;
    });
    const frame: ReconstructionFrame = { file: s.screenshot };
    if (s.holdMs !== undefined) frame.holdMs = s.holdMs;
    if (s.caption !== undefined) frame.caption = s.caption;
    if (s.transitionIn !== undefined) frame.transitionIn = s.transitionIn;
    if (s.redactions !== undefined) frame.redactions = s.redactions;
    if (actions.length) frame.actions = actions;
    return frame;
  });
}

/**
 * Turn any normalized trace into the ReconstructionInput the engine renders.
 * Agent identity never reaches the renderer: two traces that differ only in
 * `source.agent` produce byte-identical manifests.
 */
export function traceToReconstructionInput(trace: TraceReelTrace): ReconstructionInput {
  const frames = trace.frames ?? statesToFrames(trace);
  const input: ReconstructionInput = {
    version: trace.version ?? 1,
    viewport: trace.viewport,
    frames,
  };
  if (trace.source) {
    // The engine's provenance type gains "agent-browser"; the agent name rides
    // along for tooling (validate/inspect) but never affects rendering.
    input.source = {
      type: "agent-browser",
      agent: trace.source.agent,
      session: trace.source.session,
      captureTool: trace.source.captureTool ?? trace.source.agent,
      note: trace.source.note ?? `agent: ${trace.source.agent}`,
    } as ReconstructionInput["source"];
    if (trace.source.capturedAt) input.source!.capturedAt = trace.source.capturedAt;
  }
  if (trace.redactions) input.redactions = trace.redactions;
  if (trace.motion) input.motion = trace.motion;
  if (trace.shots) input.shots = trace.shots;
  // Screenshots live relative to the trace file; the engine resolves this
  // against the trace's base directory. Dropping it breaks every trace that
  // keeps frames in a subdirectory.
  if (trace.screenshotsDir) input.screenshotsDir = trace.screenshotsDir;
  return input;
}

/** Merge adapter warnings into a NormalizedTrace. */
export function normalized(trace: TraceReelTrace, warnings: string[] = []): NormalizedTrace {
  return { trace, warnings };
}

/** Fill missing capability flags with adapter defaults (trace-declared wins). */
export function withCapabilities(
  trace: TraceReelTrace,
  defaults: AgentCapabilities,
): TraceReelTrace {
  return { ...trace, capabilities: { ...defaults, ...(trace.capabilities ?? {}) } };
}

/**
 * Enforce --require-source against a trace.
 *
 * --require-source pins the provenance the input file DECLARED. It matches
 * when the required value equals the raw declared source.type, or the
 * normalized (type, agent) pair. The legacy value "muse-managed-browser" keeps
 * working: it matches any trace the Muse adapter normalized
 * (agent-browser / agent "muse"). This preserves existing Muse workflows
 * through the v0.x deprecation period.
 */
export function assertRequireSource(
  required: string | undefined,
  trace: TraceReelTrace,
  engineInput: ReconstructionInput,
  rawSourceType?: string,
): void {
  if (!required) return;
  const actual = engineInput.source?.type;
  const agent = trace.source?.agent;
  const ok =
    actual === required ||
    rawSourceType === required ||
    (required === "muse-managed-browser" && actual === "agent-browser" && agent === "muse");
  if (!ok) {
    throw new TraceReelError(
      "SOURCE_MISMATCH",
      `--require-source ${JSON.stringify(required)} but the trace claims source ` +
        `${actual ? JSON.stringify(actual) : "none"}${agent ? ` (agent ${JSON.stringify(agent)})` : ""}. ` +
        `Refusing to render from the wrong capture source.`,
      { suggestion: "Drop --require-source, or capture the trace with the required source." },
    );
  }
}

export function stateList(trace: TraceReelTrace): AgentState[] {
  return trace.states ?? [];
}
