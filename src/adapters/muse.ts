/**
 * MuseAdapter — the first/reference integration.
 *
 * Accepts:
 *  - TraceReel Trace v1 with source.agent "muse" (states/actions or frames)
 *  - the legacy muse-takeone frame input, including
 *    source.type "muse-managed-browser" (migrated with a deprecation warning)
 *  - legacy frame input with no source at all (assumed Muse, warned)
 */
import type { AgentCapabilities, TraceReelTrace } from "../trace/types.js";
import type { TraceReelAdapter, NormalizedTrace } from "./types.js";
import { asObject, normalized, withCapabilities } from "./normalize.js";
import { MUSE_CAPABILITIES } from "../capabilities.js";

const LEGACY_SOURCE = "muse-managed-browser";

export const MuseAdapter: TraceReelAdapter = {
  name: "muse",
  description: "Muse managed browser — the first and reference integration (verified).",
  capabilities: MUSE_CAPABILITIES,
  verified: true,

  normalize(input: unknown): NormalizedTrace {
    const raw = asObject(input, "Muse trace");
    const warnings: string[] = [];
    const trace = raw as unknown as TraceReelTrace;

    const src = (raw.source ?? {}) as Record<string, unknown>;
    if (src.type === LEGACY_SOURCE) {
      warnings.push(
        `source.type "${LEGACY_SOURCE}" is deprecated; it was migrated to ` +
          `{ "type": "agent-browser", "agent": "muse" }. The old form still works through the v0.x series.`,
      );
      trace.source = {
        type: "agent-browser",
        agent: "muse",
        session: src.session as string | undefined,
        captureTool: (src.captureTool as string | undefined) ?? "muse",
        capturedAt: src.capturedAt as string | undefined,
        note: src.note as string | undefined,
      };
    } else if (src.type === "agent-browser") {
      trace.source = { ...(src as object), agent: (src.agent as string) || "muse" } as TraceReelTrace["source"];
    } else if (src.type !== undefined) {
      // Unknown legacy source types (external-browser, manual-screenshots):
      // keep rendering, attribute to Muse only if the adapter was chosen.
      warnings.push(
        `source.type "${String(src.type)}" is not part of TraceReel Trace v1; ` +
          `treated as { "type": "agent-browser", "agent": "muse" }.`,
      );
      trace.source = { type: "agent-browser", agent: "muse" };
    } else {
      warnings.push(
        "input has no source; assumed { \"type\": \"agent-browser\", \"agent\": \"muse\" }. " +
          "Declare the source explicitly so provenance stays honest.",
      );
      trace.source = { type: "agent-browser", agent: "muse" };
    }

    return normalized(withCapabilities(trace, MUSE_CAPABILITIES), warnings);
  },
};
