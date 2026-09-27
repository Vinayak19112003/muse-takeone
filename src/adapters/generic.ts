/**
 * GenericAdapter — the fallback for any agent, including ones that do not
 * exist yet. It accepts any TraceReel Trace v1 (or legacy frame input) and
 * preserves the declared agent name untouched. No core changes are ever
 * needed for a new agent name.
 */
import type { TraceReelAdapter, NormalizedTrace } from "./types.js";
import { asObject, normalized, withCapabilities } from "./normalize.js";
import { GENERIC_CAPABILITIES } from "../capabilities.js";
import type { TraceReelTrace } from "../trace/types.js";

export const GenericAdapter: TraceReelAdapter = {
  name: "generic",
  description: "Fallback for any agent, including future ones. Preserves the declared agent name.",
  capabilities: GENERIC_CAPABILITIES,
  verified: false,

  normalize(input: unknown): NormalizedTrace {
    const raw = asObject(input, "trace");
    const warnings: string[] = [];
    const trace = raw as unknown as TraceReelTrace;
    const src = (raw.source ?? {}) as Record<string, unknown>;

    if (src.type === "muse-managed-browser") {
      warnings.push(
        'source.type "muse-managed-browser" is deprecated; migrated to { "type": "agent-browser", "agent": "muse" }.',
      );
      trace.source = {
        type: "agent-browser",
        agent: "muse",
        session: src.session as string | undefined,
        captureTool: (src.captureTool as string | undefined) ?? "muse",
        capturedAt: src.capturedAt as string | undefined,
        note: src.note as string | undefined,
      };
    } else if (src.type === "agent-browser" || src.type === undefined) {
      const agent = (src.agent as string) || "unknown";
      if (!src.agent) {
        warnings.push(
          "input declares no agent; kept as \"unknown\". Set source.agent so provenance stays honest.",
        );
      }
      trace.source = {
        type: "agent-browser",
        agent,
        session: src.session as string | undefined,
        captureTool: src.captureTool as string | undefined,
        capturedAt: src.capturedAt as string | undefined,
        note: src.note as string | undefined,
      };
    } else {
      warnings.push(
        `source.type "${String(src.type)}" is not part of TraceReel Trace v1; kept as agent-browser with the declared agent.`,
      );
      trace.source = {
        type: "agent-browser",
        agent: (src.agent as string) || "unknown",
        session: src.session as string | undefined,
        captureTool: src.captureTool as string | undefined,
        capturedAt: src.capturedAt as string | undefined,
        note: src.note as string | undefined,
      };
    }

    return normalized(withCapabilities(trace, GENERIC_CAPABILITIES), warnings);
  },
};
