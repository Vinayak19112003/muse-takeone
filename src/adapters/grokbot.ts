/**
 * GrokbotAdapter — the reference second integration.
 *
 * Accepts TraceReel Trace v1 with source.agent "grokbot" (states/actions or
 * frames). It performs no Grokbot-specific rendering logic: normalization is
 * the same agent-neutral path every adapter uses. Capabilities marked here
 * are expected, not yet verified — see `tracereel capabilities grokbot`.
 */
import type { AgentCapabilities } from "../trace/types.js";
import type { TraceReelAdapter, NormalizedTrace } from "./types.js";
import { asObject, normalized, withCapabilities } from "./normalize.js";
import { GROKBOT_CAPABILITIES } from "../capabilities.js";

export const GrokbotAdapter: TraceReelAdapter = {
  name: "grokbot",
  description: "Grokbot managed browser — planned reference integration (not yet verified).",
  capabilities: GROKBOT_CAPABILITIES,
  verified: false,

  normalize(input: unknown): NormalizedTrace {
    const raw = asObject(input, "Grokbot trace");
    const warnings: string[] = [];
    const src = (raw.source ?? {}) as Record<string, unknown>;
    const agent = (src.agent as string) || "grokbot";
    if (!src.agent) {
      warnings.push(
        'input has no source.agent; assumed "grokbot" because the grokbot adapter was selected. ' +
          "Declare the source explicitly so provenance stays honest.",
      );
    }
    const trace = raw as unknown as Parameters<typeof withCapabilities>[0];
    trace.source = {
      type: "agent-browser",
      agent,
      session: src.session as string | undefined,
      captureTool: (src.captureTool as string | undefined) ?? "grokbot",
      capturedAt: src.capturedAt as string | undefined,
      note: src.note as string | undefined,
    };
    return normalized(withCapabilities(trace, GROKBOT_CAPABILITIES), warnings);
  },
};
