/**
 * Adapter registry.
 *
 * New agents plug in here without touching the reconstruction engine or the
 * renderer. Unknown agent names fall through to the GenericAdapter, which
 * preserves the declared name — so "future-agent" works on day one.
 */
import type { TraceReelAdapter, NormalizedTrace } from "./types.js";
import { MuseAdapter } from "./muse.js";
import { GrokbotAdapter } from "./grokbot.js";
import { GenericAdapter } from "./generic.js";

const ADAPTERS: TraceReelAdapter[] = [MuseAdapter, GrokbotAdapter, GenericAdapter];

export function listAdapters(): TraceReelAdapter[] {
  return [...ADAPTERS];
}

/** Find the adapter for an explicit name; unknown names get the generic one. */
export function getAdapter(name: string): TraceReelAdapter {
  const found = ADAPTERS.find((a) => a.name === name);
  return found ?? GenericAdapter;
}

/**
 * Normalize any trace input through the right adapter.
 *
 * Adapter selection: explicit `opts.adapter` wins; otherwise the input's own
 * source decides (legacy "muse-managed-browser" -> muse, an "agent-browser"
 * agent name -> that adapter, anything else -> generic).
 */
export function normalizeTrace(
  input: unknown,
  opts?: { adapter?: string },
): NormalizedTrace & { adapter: TraceReelAdapter } {
  const adapter = pickAdapter(input, opts);
  const { trace, warnings } = adapter.normalize(input);
  return { trace, warnings, adapter };
}

/** Choose the adapter without normalizing (for reporting / metadata). */
export function pickAdapter(input: unknown, opts?: { adapter?: string }): TraceReelAdapter {
  if (opts?.adapter) return getAdapter(opts.adapter);
  const src = (input as Record<string, unknown> | null)?.source as Record<string, unknown> | undefined;
  if (src?.type === "muse-managed-browser") return MuseAdapter;
  if (src?.type === "agent-browser" && typeof src.agent === "string") {
    return getAdapter(src.agent);
  }
  return GenericAdapter;
}

export { MuseAdapter, GrokbotAdapter, GenericAdapter };
export type { TraceReelAdapter, NormalizedTrace };
export { TraceReelError } from "./types.js";
