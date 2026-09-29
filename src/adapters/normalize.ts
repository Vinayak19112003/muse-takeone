/**
 * Shared normalization helpers for adapters.
 *
 * Every adapter ends at the same place: a TraceReel Trace v1 whose
 * states/actions (or legacy frames) the reconstruction engine renders
 * without knowing which agent produced them.
 */
import type { AgentAction, AgentCapabilities, AgentState, TraceReelTrace } from "../trace/types.js";
import type {
  ReconstructionAction,
  ReconstructionFrame,
  ReconstructionInput,
} from "../reconstruct/build.js";
import type { NormalizedTrace } from "./types.js";
import { TraceReelError } from "./types.js";
import { detectDenseRuns } from "../reconstruct/realframes.js";

export function asObject(input: unknown, what: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceReelError("INVALID_TRACE", `${what} must be a JSON object`, {
      suggestion: "Pass the trace JSON object the agent produced (states/actions or frames).",
    });
  }
  return input as Record<string, unknown>;
}

/** Convert the state-first form (states/actions) into the frame form the engine renders. */

/** Action kinds whose dense captures form real-frame intervals. */
const DENSE_ACTION_KINDS = new Set(["scroll", "type", "click", "hover"]);

/**
 * Infer which action a dense capture belongs to from the trace's from/to
 * state links, when the author did not set `capture.actionId`.
 *
 * A dense-kind action covers the states from its `from` index through its
 * `to` index (a missing `to` covers only the `from` state). A dense frame
 * covered by several actions belongs to the one ending earliest — at a
 * junction where action A ends on frame i and action B starts on frame i,
 * frame i still belongs to A (it is A's result state), while frames after i
 * belong to B. Ties break by trace order, so the result is deterministic.
 *
 * Returns a `link:<kind>:<fromId>><toId>` key, or undefined when no
 * dense-kind action covers the frame. Generic: no agent-specific logic.
 */
function inferDenseLinkKey(
  actions: readonly AgentAction[],
  indexById: Map<string, number>,
  stateIndex: number,
): string | undefined {
  let best: { toIdx: number; key: string } | undefined;
  for (const a of actions) {
    if (!DENSE_ACTION_KINDS.has(a.kind)) continue;
    const fromIdx = indexById.get(a.from);
    if (fromIdx === undefined || fromIdx > stateIndex) continue;
    const toIdx = a.to === undefined ? fromIdx : indexById.get(a.to) ?? fromIdx;
    if (toIdx < stateIndex) continue;
    if (best === undefined || toIdx < best.toIdx) {
      best = { toIdx, key: `link:${a.kind}:${a.from}>${a.to ?? ""}` };
    }
  }
  return best?.key;
}
/**
 * Convert a Trace v1 states/actions trace into reconstruction frames.
 *
 * Dense real-frame canonicalization: a scroll/type/click/hover action whose
 * `from` is the state immediately before a dense run and whose `to` is the
 * run's last state *is* the run's enclosing action — it is moved onto the
 * run's first frame so the builder consumes it as the run's timing source
 * instead of synthesizing a slide transition for it. (Trace authors naturally
 * write `from: <state-before-scroll> -> to: <last-scroll-state>`; the builder
 * expects the action on the run's first frame. Both authoring styles produce
 * identical frames.) Only actions whose `to` matches the run's last state
 * move; everything else keeps its frame.
 */
export function statesToFrames(trace: TraceReelTrace): ReconstructionFrame[] {
  const states = trace.states ?? [];
  const actionsByFrom = new Map<string, NonNullable<TraceReelTrace["actions"]>>();
  for (const a of trace.actions ?? []) {
    const list = actionsByFrom.get(a.from) ?? [];
    list.push(a);
    actionsByFrom.set(a.from, list);
  }
  interface LinkedAction {
    out: ReconstructionAction;
    to?: string;
  }
  const linkedByState = new Map<string, LinkedAction[]>();
  for (const s of states) {
    const group = actionsByFrom.get(s.id) ?? [];
    linkedByState.set(
      s.id,
      group.map((a) => {
        const { from, to, stateDelayMs, ...rest } = a;
        const out = { ...rest } as ReconstructionAction;
        // The engine only honors nextFrameAfterMs on a frame's LAST action; the
        // transition delay belongs to the action that leads to the next state.
        if (to !== undefined && group.at(-1) === a && stateDelayMs !== undefined) {
          (out as unknown as Record<string, unknown>).nextFrameAfterMs = stateDelayMs;
        }
        return { out, to };
      }),
    );
  }
  // Style 2 -> style 1: move the run's enclosing action onto run[0].
  // Run detection is action-aware: dense frames whose action association
  // differs (explicit capture.actionId, else inferred from from/to links)
  // never merge into one run, so adjacent dense actions of different kinds
  // each get their own run, enclosing action, timing, and event synthesis.
  const indexById = new Map(states.map((s, i) => [s.id, i] as const));
  const traceActions = trace.actions ?? [];
  const denseActionKey = (idx: number): string | undefined =>
    states[idx].capture?.actionId ?? inferDenseLinkKey(traceActions, indexById, idx);
  const runs = detectDenseRuns(
    states.map((s) => ({ capture: s.capture })),
    denseActionKey,
  );
  for (const run of runs) {
    if (run.start === 0) continue;
    const preLinked = linkedByState.get(states[run.start - 1].id) ?? [];
    const lastId = states[run.end].id;
    const idx = preLinked.findIndex(
      (l) =>
        l.to === lastId &&
        (l.out.kind === "scroll" || l.out.kind === "type" || l.out.kind === "click" || l.out.kind === "hover"),
    );
    if (idx < 0) continue;
    const [moved] = preLinked.splice(idx, 1);
    const runLinked = linkedByState.get(states[run.start].id);
    if (runLinked) runLinked.unshift(moved);
    else linkedByState.set(states[run.start].id, [moved]);
  }
  // Backfill the inferred action association onto each dense capture that
  // lacks an explicit actionId, so downstream run detection (build, QA)
  // — which only sees frames, not from/to links — splits runs exactly the
  // same way. The inferred key only associates frames into runs; it never
  // affects timing or visuals.
  for (const run of runs) {
    for (let i = run.start; i <= run.end; i++) {
      const cap = states[i].capture;
      if (cap?.dense === true && cap.actionId === undefined) {
        const key = inferDenseLinkKey(traceActions, indexById, i);
        if (key !== undefined) cap.actionId = key;
      }
    }
  }
  return states.map((s): ReconstructionFrame => {
    const linked = linkedByState.get(s.id) ?? [];
    const frame: ReconstructionFrame = { file: s.screenshot };
    if (s.holdMs !== undefined) frame.holdMs = s.holdMs;
    if (s.caption !== undefined) frame.caption = s.caption;
    if (s.transitionIn !== undefined) frame.transitionIn = s.transitionIn;
    if (s.redactions !== undefined) frame.redactions = s.redactions;
    // Real-frame capture metadata survives normalization untouched: it is
    // what selects the managed real-frame visual path (never reconstructed).
    if (s.capture !== undefined) frame.capture = s.capture;
    if (linked.length) frame.actions = linked.map((l) => l.out);
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
