/**
 * TraceReel Trace Format v1 — the versioned, agent-neutral capture protocol.
 *
 * An AI browser agent (Muse, Grokbot, or any future managed-browser agent)
 * operates a browser, then hands TraceReel a trace: the browser STATES it saw
 * (screenshots) and the ACTIONS it performed between them. TraceReel
 * reconstructs a smooth professional video from that trace.
 *
 * The format is deliberately independent of any single agent: new agent names
 * work without renderer changes. See docs/TRACE_FORMAT.md for the full spec.
 */
import type {
  ReconstructionClick,
  ReconstructionHover,
  ReconstructionScroll,
  ReconstructionTransitionIn,
  ReconstructionType,
  ReconstructionWait,
  RedactionRegion,
} from "../reconstruct/build.js";

/** Trace format version this build understands. */
export const TRACE_FORMAT_VERSION = 1;

/** Re-exported for SDK consumers: one region to redact from a screenshot. */
export type { RedactionRegion };

/** Agent-neutral capture provenance. `agent` is a free-form id: "muse", "grokbot", "future-agent", ... */
export interface TraceSource {
  type: "agent-browser";
  /** Which agent produced the trace. New names need no core changes. */
  agent: string;
  /** Which browser session the screenshots came from, e.g. "main". */
  session?: string;
  /** What captured the screenshots, e.g. "muse", "grokbot-manual". Declarative, not verified. */
  captureTool?: string;
  /** ISO 8601 timestamp of the capture session. */
  capturedAt?: string;
  /** Free-form note, e.g. how the screenshots were materialized. */
  note?: string;
}

export interface TraceViewport {
  width: number;
  height: number;
}

/**
 * What the capturing agent could actually provide. TraceReel uses this to
 * decide what can be reconstructed accurately — it never pretends unsupported
 * data exists.
 */
export interface AgentCapabilities {
  /** Real screenshots per state. */
  screenshots: boolean;
  /** Click targets as viewport coordinates. */
  clickCoordinates: boolean;
  /** Typing targets as viewport coordinates. */
  typingCoordinates: boolean;
  /** Scroll gestures with deltas. */
  scrollEvents: boolean;
  /** Hover positions. */
  hoverEvents: boolean;
  /** Short real-motion clips for drags, canvas, WebGL, ... (roadmap). */
  videoSegments: boolean;
  /** Screenshots captured without the OS cursor baked in. */
  cursorFreeScreenshots: boolean;
}

/** One observed browser state: a real screenshot. */
export interface AgentState {
  /** Stable id referenced by actions, e.g. "s1". */
  id: string;
  /** Screenshot file, relative to the trace file (or the bundle's frames/). */
  screenshot: string;
  /** ms since trace start; informational, does not drive the timeline. */
  capturedAt?: number;
  /** Minimum time the state stays up, in ms. Default 2600 for terminal states. */
  holdMs?: number;
  /** Narrative caption shown while this state is up. */
  caption?: string;
  /** How the video arrives at this state. Default "crossfade". */
  transitionIn?: ReconstructionTransitionIn;
  /** Regions redacted from this state's screenshot before rendering. */
  redactions?: RedactionRegion[];
}

/** Links an action to the states around it. */
export interface ActionStateLink {
  /** Id of the state visible while the action plays. */
  from: string;
  /** Id of the state showing the action's result. */
  to?: string;
  /**
   * How soon after the action ends the `to` state appears, in ms.
   * Default 200. Only meaningful when `to` is set.
   */
  stateDelayMs?: number;
}

export type AgentAction =
  | ({ kind: "click" } & ReconstructionClick & ActionStateLink)
  | ({ kind: "type" } & ReconstructionType & ActionStateLink)
  | ({ kind: "scroll" } & ReconstructionScroll & ActionStateLink)
  | ({ kind: "hover" } & ReconstructionHover & ActionStateLink)
  | ({ kind: "wait" } & ReconstructionWait & ActionStateLink);

/**
 * STATE -> ACTION -> STATE, made explicit. Derived from actions (each action
 * already carries from/to); kept as a first-class concept so agents and
 * tooling can reason about the timeline without re-deriving it.
 */
export interface StateTransition {
  from: string;
  action: string;
  to?: string;
  stateDelayMs?: number;
}

/**
 * A real-motion clip supplied by the agent (roadmap). Accepted by TraceReel
 * Trace v1 so the format never blocks future support; the current renderer
 * warns and skips video segments.
 */
export interface TraceVideoSegment {
  id: string;
  file: string;
  /** Where the clip sits on the synthetic timeline, in ms. */
  start: number;
  duration: number;
  from?: string;
  to?: string;
}

/**
 * TraceReel Trace v1.
 *
 * Two shapes are accepted and mean the same thing:
 *  - states[] + actions[]  (the state-first form; preferred for new traces)
 *  - frames[]               (the legacy frame form; kept for compatibility)
 */
export interface TraceReelTrace {
  version?: number;
  source?: TraceSource;
  viewport: TraceViewport;
  /** Capabilities the capturing agent declared; adapter defaults fill gaps. */
  capabilities?: Partial<AgentCapabilities>;
  states?: AgentState[];
  actions?: AgentAction[];
  /** Frame form (legacy). Equivalent to states/actions; do not mix with them. */
  frames?: import("../reconstruct/build.js").ReconstructionFrame[];
  /** Regions redacted from every state's screenshot. */
  redactions?: RedactionRegion[];
  /** Cursor glide tuning overrides. */
  motion?: import("../reconstruct/build.js").ReconstructionMotion;
  /** Explicit camera shots, overriding the shot planner (see inspect output). */
  shots?: import("../types.js").CameraShot[];
  /** Real-motion clips (accepted, not yet rendered). */
  videoSegments?: TraceVideoSegment[];
  /**
   * Directory holding the screenshots, relative to the trace file.
   * Default "." (screenshots sit next to the trace).
   */
  screenshotsDir?: string;
}

/** The state-first timeline derived from a trace: states, actions, and the transitions between them. */
export interface TraceTimeline {
  states: AgentState[];
  actions: AgentAction[];
  transitions: StateTransition[];
}
