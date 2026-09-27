/**
 * The TraceReel TypeScript SDK.
 *
 * ```ts
 * import { TraceBuilder } from "tracereel";
 *
 * const t = new TraceBuilder({ agent: "muse", viewport: { width: 1280, height: 800 } });
 * const s1 = t.state("s1", "frames/01-home.png", { caption: "The GitHub home page." });
 * const s2 = t.state("s2", "frames/02-search.png");
 * t.click({ from: s1, to: s2, x: 400, y: 120, stateDelayMs: 600 });
 * t.caption(s2, "Search results load.");
 * const trace = t.build(); // TraceReel Trace v1, ready to validate/render
 * ```
 *
 * Small on purpose: state, click, type, scroll, hover, wait, caption, redact.
 */
import type {
  AgentAction,
  AgentState,
  RedactionRegion,
  TraceReelTrace,
  TraceSource,
  TraceViewport,
} from "./trace/types.js";
import { TRACE_FORMAT_VERSION } from "./trace/types.js";

export interface TraceBuilderOptions {
  /** Agent name, e.g. "muse". Free-form. */
  agent: string;
  viewport: TraceViewport;
  session?: string;
  captureTool?: string;
  note?: string;
}

export interface StateOptions {
  caption?: string;
  holdMs?: number;
  transitionIn?: AgentState["transitionIn"];
  redactions?: RedactionRegion[];
}

export interface ClickOptions {
  from: string;
  to?: string;
  x: number;
  y: number;
  stateDelayMs?: number;
  preClickMs?: number;
  clickHoldMs?: number;
  pauseMs?: number;
}

export interface TypeOptions {
  from: string;
  to?: string;
  x: number;
  y: number;
  text: string;
  stateDelayMs?: number;
  cpm?: number;
  showKeys?: boolean;
  sensitive?: boolean;
  pauseMs?: number;
}

export interface ScrollOptions {
  from: string;
  to?: string;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  durationMs?: number;
  stateDelayMs?: number;
  pauseMs?: number;
}

export interface HoverOptions {
  from: string;
  to?: string;
  x: number;
  y: number;
  stateDelayMs?: number;
  pauseMs?: number;
}

export interface WaitOptions {
  from: string;
  durationMs: number;
  pauseMs?: number;
}

let actionSeq = 0;

/** Omit that distributes over unions, so action literals keep their kind's fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class TraceBuilder {
  private trace: TraceReelTrace;
  private states = new Map<string, AgentState>();

  constructor(opts: TraceBuilderOptions) {
    const source: TraceSource = { type: "agent-browser", agent: opts.agent };
    if (opts.session !== undefined) source.session = opts.session;
    if (opts.captureTool !== undefined) source.captureTool = opts.captureTool;
    if (opts.note !== undefined) source.note = opts.note;
    this.trace = {
      version: TRACE_FORMAT_VERSION,
      source,
      viewport: opts.viewport,
      states: [],
      actions: [],
    };
  }

  /** Declare a captured state (screenshot). Returns the state id. */
  state(id: string, screenshot: string, opts: StateOptions = {}): string {
    if (this.states.has(id)) {
      throw new Error(`TraceBuilder: duplicate state id "${id}"`);
    }
    const s: AgentState = { id, screenshot };
    if (opts.caption !== undefined) s.caption = opts.caption;
    if (opts.holdMs !== undefined) s.holdMs = opts.holdMs;
    if (opts.transitionIn !== undefined) s.transitionIn = opts.transitionIn;
    if (opts.redactions !== undefined) s.redactions = [...opts.redactions];
    this.trace.states!.push(s);
    this.states.set(id, s);
    return id;
  }

  /** Set or replace the caption of an existing state. */
  caption(stateId: string, caption: string): this {
    this.requireState(stateId).caption = caption;
    return this;
  }

  /** Redact a region on an existing state. */
  redact(stateId: string, region: RedactionRegion): this {
    const s = this.requireState(stateId);
    s.redactions = [...(s.redactions ?? []), region];
    return this;
  }

  /** Redact a region on every state (e.g. a persistent header showing an email). */
  redactEverywhere(region: RedactionRegion): this {
    this.trace.redactions = [...(this.trace.redactions ?? []), region];
    return this;
  }

  click(opts: ClickOptions): this {
    this.pushAction({
      kind: "click",
      from: opts.from,
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      x: opts.x,
      y: opts.y,
      ...(opts.stateDelayMs !== undefined ? { stateDelayMs: opts.stateDelayMs } : {}),
      ...(opts.preClickMs !== undefined ? { preClickMs: opts.preClickMs } : {}),
      ...(opts.clickHoldMs !== undefined ? { clickHoldMs: opts.clickHoldMs } : {}),
      ...(opts.pauseMs !== undefined ? { pauseMs: opts.pauseMs } : {}),
    });
    return this;
  }

  type(opts: TypeOptions): this {
    this.pushAction({
      kind: "type",
      from: opts.from,
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      x: opts.x,
      y: opts.y,
      text: opts.text,
      ...(opts.stateDelayMs !== undefined ? { stateDelayMs: opts.stateDelayMs } : {}),
      ...(opts.cpm !== undefined ? { cpm: opts.cpm } : {}),
      ...(opts.showKeys !== undefined ? { showKeys: opts.showKeys } : {}),
      ...(opts.sensitive !== undefined ? { sensitive: opts.sensitive } : {}),
      ...(opts.pauseMs !== undefined ? { pauseMs: opts.pauseMs } : {}),
    });
    return this;
  }

  scroll(opts: ScrollOptions): this {
    this.pushAction({
      kind: "scroll",
      from: opts.from,
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      ...(opts.dx !== undefined ? { dx: opts.dx } : {}),
      ...(opts.dy !== undefined ? { dy: opts.dy } : {}),
      ...(opts.x !== undefined ? { x: opts.x } : {}),
      ...(opts.y !== undefined ? { y: opts.y } : {}),
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      ...(opts.stateDelayMs !== undefined ? { stateDelayMs: opts.stateDelayMs } : {}),
      ...(opts.pauseMs !== undefined ? { pauseMs: opts.pauseMs } : {}),
    });
    return this;
  }

  hover(opts: HoverOptions): this {
    this.pushAction({
      kind: "hover",
      from: opts.from,
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      x: opts.x,
      y: opts.y,
      ...(opts.stateDelayMs !== undefined ? { stateDelayMs: opts.stateDelayMs } : {}),
      ...(opts.pauseMs !== undefined ? { pauseMs: opts.pauseMs } : {}),
    });
    return this;
  }

  wait(opts: WaitOptions): this {
    this.pushAction({ kind: "wait", from: opts.from, durationMs: opts.durationMs });
    return this;
  }

  /** The finished trace. Validate it before rendering. */
  build(): TraceReelTrace {
    return structuredClone(this.trace);
  }

  private requireState(id: string): AgentState {
    const s = this.states.get(id);
    if (!s) throw new Error(`TraceBuilder: unknown state id "${id}"`);
    return s;
  }

  private pushAction(a: DistributiveOmit<AgentAction, "id">): void {
    if (!this.states.has(a.from)) {
      throw new Error(`TraceBuilder: action from unknown state "${a.from}"`);
    }
    if (a.to !== undefined && !this.states.has(a.to)) {
      throw new Error(`TraceBuilder: action to unknown state "${a.to}"`);
    }
    const action = { ...a } as unknown as Record<string, unknown>;
    action.id = `a${++actionSeq}`;
    this.trace.actions!.push(action as unknown as AgentAction);
  }
}
