/**
 * The TraceReel adapter contract.
 *
 * An adapter normalizes one agent's trace dialect into TraceReel Trace v1.
 * The reconstruction engine and renderer only ever see the normalized trace,
 * so supporting a new agent means writing an adapter — never touching core.
 */
import type { AgentCapabilities, TraceReelTrace } from "../trace/types.js";
import type { ValidationResult } from "../reconstruct/validate.js";

export interface NormalizedTrace {
  trace: TraceReelTrace;
  /** Non-fatal notes: deprecations, assumptions the adapter had to make. */
  warnings: string[];
}

export interface TraceReelAdapter {
  /** Agent id this adapter handles, e.g. "muse", "grokbot". */
  name: string;
  /** One-line description for `tracereel capabilities`. */
  description: string;
  /**
   * What captures from this agent are known to provide. `verified` is false
   * until the integration has actually been tested end to end.
   */
  capabilities: AgentCapabilities;
  /** True once this adapter's output has been rendered and reviewed for real. */
  verified: boolean;
  /**
   * Normalize any input this adapter accepts into TraceReel Trace v1.
   * Throws a TraceReelError (code INVALID_TRACE) when the input is not an
   * object at all; structural problems are reported by validate(), not here.
   */
  normalize(input: unknown): NormalizedTrace;
  /** Optional structural validation with machine-readable error codes. */
  validate?(input: unknown, baseDir?: string): ValidationResult;
}

/** Machine-readable failure. `path` is a JSON-ish pointer like "actions[4]". */
export class TraceReelError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly suggestion?: string;
  constructor(code: string, message: string, opts?: { path?: string; suggestion?: string }) {
    super(message);
    this.name = "TraceReelError";
    this.code = code;
    this.path = opts?.path;
    this.suggestion = opts?.suggestion;
  }
  toJSON() {
    return { ok: false, code: this.code, path: this.path, message: this.message, suggestion: this.suggestion };
  }
}
